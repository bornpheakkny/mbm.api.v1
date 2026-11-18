import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http';
import { publicUser } from '../lib/users';
import { requireAuth, sessionToken, uid } from '../middleware/auth';
import { authLimiter, emailLimiter } from '../middleware/rateLimit';
import { defaultCategoryData } from '../services/defaultCategories';
import {
  assertCooldown,
  checkSecondFactor,
  failCode,
  findLiveToken,
  issueToken,
  markUsed,
  remainingRecoveryCodes,
} from '../services/authTokens';
import {
  mfaCodeMessage,
  resetPasswordMessage,
  sendEmail,
  sendEmailInBackground,
  verifyEmailMessage,
} from '../services/email';
import type { User } from '../generated/prisma/client';

const router = Router();

export const PasswordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);
export const EmailSchema = z.email().transform((e) => e.toLowerCase());
export const NameSchema = z.string().trim().min(1).max(80);
export const CurrencySchema = z.string().length(3).toUpperCase();
const TokenSchema = z.string().min(20).max(200);
const CodeSchema = z.string().trim().min(6).max(20);

const RegisterSchema = z.object({
  name: NameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  currency: CurrencySchema.optional(),
});

const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1) });
const MfaLoginSchema = z.object({ mfaToken: TokenSchema, code: CodeSchema });
const UpdateMeSchema = z.object({ name: NameSchema.optional(), currency: CurrencySchema.optional() });
const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: PasswordSchema });

/** "jo***@gmail.com" — shown on the code screen without revealing the full address */
const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};

async function sendVerification(user: Pick<User, 'id' | 'email' | 'name'>) {
  const { token } = await issueToken(user.id, 'EMAIL_VERIFY');
  sendEmailInBackground(verifyEmailMessage(user.email, user.name, token));
}

/** Completes a login: records it and returns the session */
async function finishLogin(userId: string) {
  const user = await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { token: sessionToken(user), user: publicUser(user) };
}

// ---------- Register & login ----------

/** Public sign-up: a USER with its own budget and default categories. A verification email is sent. */
router.post('/register', emailLimiter, async (req, res) => {
  const body = RegisterSchema.parse(req.body);

  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw conflict('Email is already registered');

  const passwordHash = await bcrypt.hash(body.password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash, currency: body.currency ?? 'USD', lastLoginAt: new Date() },
    });
    await tx.category.createMany({ data: defaultCategoryData(created.id) });
    return created;
  });

  await sendVerification(user);
  res.status(201).json({ token: sessionToken(user), user: publicUser(user) });
});

/**
 * Step 1: email + password.
 * Without two-step verification → { token, user }.
 * With it → { mfaRequired: true, method, mfaToken, emailHint } and (EMAIL method) a code is emailed.
 */
router.post('/login', authLimiter, async (req, res) => {
  const body = LoginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw unauthorized('Invalid email or password');
  }
  if (!user.active) throw forbidden('This account has been disabled. Contact an administrator.');

  if (!user.mfaMethod) return res.json(await finishLogin(user.id));

  const { token: mfaToken, code } = await issueToken(user.id, 'MFA_CHALLENGE', { withCode: user.mfaMethod === 'EMAIL' });
  if (code) await sendEmail(mfaCodeMessage(user.email, user.name, code, 'login'));

  res.json({ mfaRequired: true, method: user.mfaMethod, mfaToken, emailHint: maskEmail(user.email) });
});

/** Step 2: the authenticator / emailed code, or a backup code */
router.post('/login/mfa', authLimiter, async (req, res) => {
  const body = MfaLoginSchema.parse(req.body);
  const challenge = await findLiveToken(
    body.mfaToken,
    'MFA_CHALLENGE',
    'Your sign-in attempt expired. Please log in again.',
  );
  const user = challenge.user;

  const kind = user.mfaMethod ? await checkSecondFactor(user, body.code, challenge) : 'none';
  if (!kind) await failCode(challenge);

  await markUsed(challenge.id);
  const session = await finishLogin(user.id);
  const recoveryCodesLeft = kind === 'recovery' ? await remainingRecoveryCodes(user.id) : undefined;
  res.json({ ...session, recoveryCodesLeft });
});

/** Email a fresh sign-in code (EMAIL method). Returns a new mfaToken. */
router.post('/login/mfa/resend', emailLimiter, async (req, res) => {
  const { mfaToken } = z.object({ mfaToken: TokenSchema }).parse(req.body);
  const challenge = await findLiveToken(mfaToken, 'MFA_CHALLENGE', 'Your sign-in attempt expired. Please log in again.');
  const user = challenge.user;
  if (user.mfaMethod !== 'EMAIL') throw badRequest('This account uses an authenticator app');

  await assertCooldown(user.id, 'MFA_CHALLENGE');
  const { token, code } = await issueToken(user.id, 'MFA_CHALLENGE', { withCode: true });
  await sendEmail(mfaCodeMessage(user.email, user.name, code!, 'login'));
  res.json({ mfaToken: token });
});

// ---------- Email verification ----------

router.post('/verify-email', authLimiter, async (req, res) => {
  const { token } = z.object({ token: TokenSchema }).parse(req.body);
  const row = await findLiveToken(token, 'EMAIL_VERIFY', 'This verification link is invalid or has expired.');
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() } }),
    prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  res.json({ ok: true, email: row.user.email });
});

router.post('/resend-verification', requireAuth, emailLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (user.emailVerifiedAt) throw badRequest('Your email is already verified');
  await assertCooldown(user.id, 'EMAIL_VERIFY');
  await sendVerification(user);
  res.json({ ok: true });
});

// ---------- Forgot / reset password ----------

/** Always answers the same way so it can't be used to find out which emails have accounts */
router.post('/forgot-password', emailLimiter, async (req, res) => {
  const { email } = z.object({ email: EmailSchema }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });

  if (user?.active) {
    try {
      await assertCooldown(user.id, 'PASSWORD_RESET');
      const { token } = await issueToken(user.id, 'PASSWORD_RESET');
      sendEmailInBackground(resetPasswordMessage(user.email, user.name, token));
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 429)) throw err;
    }
  }
  res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
});

/** Sets a new password from an emailed link. Signs out every session; two-step verification stays on. */
router.post('/reset-password', authLimiter, async (req, res) => {
  const body = z.object({ token: TokenSchema, password: PasswordSchema }).parse(req.body);
  const row = await findLiveToken(body.token, 'PASSWORD_RESET', 'This reset link is invalid or has expired.');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: {
        passwordHash: await bcrypt.hash(body.password, 10),
        tokenVersion: { increment: 1 },
        // The link reached their inbox, so the address is proven
        emailVerifiedAt: row.user.emailVerifiedAt ?? new Date(),
      },
    }),
    prisma.authToken.updateMany({
      where: { userId: row.userId, type: 'PASSWORD_RESET', usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
  res.json({ ok: true, email: row.user.email });
});

// ---------- Current user ----------

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  res.json({ user: publicUser(user) });
});

router.patch('/me', requireAuth, async (req, res) => {
  const body = UpdateMeSchema.parse(req.body);
  const user = await prisma.user.update({ where: { id: uid(req) }, data: body });
  res.json({ user: publicUser(user) });
});

/** Changes the password and signs out other sessions; returns a fresh token for this one */
router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const body = ChangePasswordSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
    throw badRequest('Current password is incorrect');
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(body.newPassword, 10), tokenVersion: { increment: 1 } },
  });
  res.json({ ok: true, token: sessionToken(updated) });
});

export default router;
