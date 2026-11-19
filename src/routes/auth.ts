import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http';
import { publicUser } from '../lib/users';
import {
  PhoneSchema,
  UsernameSchema,
  findUserByIdentifier,
  identifierKind,
  isVerified,
  maskEmail,
  type Channel,
} from '../lib/contacts';
import { randomToken, sha256 } from '../lib/crypto';
import { requireAuth, sessionToken, uid } from '../middleware/auth';
import { authLimiter, emailLimiter } from '../middleware/rateLimit';
import { defaultCategoryData } from '../services/defaultCategories';
import { isRootAdmin } from '../services/bootstrapAdmin';
import { canReclaim } from '../services/unverifiedAccounts';
import {
  assertCooldown,
  checkSecondFactor,
  codeMatches,
  failCode,
  findLiveCodeToken,
  findLiveToken,
  issueToken,
  markUsed,
  remainingRecoveryCodes,
} from '../services/authTokens';
import { pickChannel, sendContactCode, sendUsernameReminder } from '../services/contactCodes';
import {
  EMAIL_FAILED_MESSAGE,
  confirmEmailChangeMessage,
  emailChangedNotice,
  mfaCodeMessage,
  sendEmail,
  sendEmailInBackground,
  verifyEmailMessage,
} from '../services/email';
import type { PendingSignup, Prisma, User } from '../generated/prisma/client';
import { PreferencesPatchSchema, normalizePreferences } from '../lib/preferences';
import { assertPendingLive, checkPendingCode, findPendingSignup, resendPendingCode, startPendingSignup } from '../services/pendingSignups';

const router = Router();

export const PasswordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);
export const EmailSchema = z.email().transform((e) => e.toLowerCase());
export const NameSchema = z.string().trim().min(1).max(80);
export const CurrencySchema = z.string().length(3).toUpperCase();
const TokenSchema = z.string().min(20).max(200);
const CodeSchema = z.string().trim().min(6).max(20);
const IdentifierSchema = z.string().trim().min(1, 'Enter your username, email or phone').max(120);

const RegisterSchema = z
  .object({
    name: NameSchema,
    username: UsernameSchema,
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    password: PasswordSchema,
    currency: CurrencySchema.optional(),
  })
  .refine((b) => Boolean(b.email) !== Boolean(b.phone), { message: 'Enter an email or a phone number', path: ['email'] });

const LoginSchema = z.object({ identifier: IdentifierSchema, password: z.string().min(1) });
const VerifySchema = z.object({ verifyToken: TokenSchema, code: CodeSchema });
const MfaLoginSchema = z.object({ mfaToken: TokenSchema, code: CodeSchema });
const UpdateMeSchema = z.object({
  name: NameSchema.optional(),
  username: UsernameSchema.optional(),
  currency: CurrencySchema.optional(),
  preferences: PreferencesPatchSchema.optional(),
});
const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: PasswordSchema });

/** Deletes a just-issued token when its email couldn't be sent, so the user can retry right away (no cooldown) */
const discardToken = (token: string) => prisma.authToken.deleteMany({ where: { tokenHash: sha256(token) } });

/** Completes a login: records it and returns the session */
async function finishLogin(userId: string) {
  const user = await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { token: sessionToken(user), user: publicUser(user) };
}

/** Starts two-step verification for a user whose password (and contact) is confirmed */
async function mfaChallenge(user: User) {
  const emailMethod = user.mfaMethod === 'EMAIL' && Boolean(user.email);
  const { token: mfaToken, code } = await issueToken(user.id, 'MFA_CHALLENGE', { withCode: emailMethod });
  let emailFailed = false;
  if (code && user.email) {
    try {
      await sendEmail(mfaCodeMessage(user.email, user.name, code, 'login'));
    } catch {
      emailFailed = true; // the code screen explains this and offers backup codes
    }
  }
  return { mfaRequired: true, method: user.mfaMethod, mfaToken, emailHint: user.email ? maskEmail(user.email) : '', emailFailed };
}

/** After the password is accepted: verify the contact first, then two-step, then sign in */
async function continueLogin(user: User, res: Response) {
  if (!isVerified(user)) {
    const channel = pickChannel(user);
    if (!channel) throw forbidden('This account has no email or phone to verify. Contact an administrator.');
    const sent = await sendContactCode(user, 'signup', channel);
    return res.json({ verificationRequired: true, verifyToken: sent.token, channel: sent.channel, hint: sent.hint });
  }
  if (user.mfaMethod) return res.json(await mfaChallenge(user));
  return res.json(await finishLogin(user.id));
}

/** Which existing accounts block this sign-up, and which abandoned ones can be replaced */
async function checkSignupConflicts(body: { username: string; email?: string; phone?: string }) {
  const clashes = await prisma.user.findMany({
    where: {
      OR: [{ username: body.username }, ...(body.email ? [{ email: body.email }] : []), ...(body.phone ? [{ phone: body.phone }] : [])],
    },
  });
  const replace: string[] = [];
  for (const u of clashes) {
    const sameContact = Boolean((body.email && u.email === body.email) || (body.phone && u.phone === body.phone));
    if (await canReclaim(u, { sameContact })) {
      replace.push(u.id);
      continue;
    }
    if (u.username === body.username) throw conflict('That username is taken');
    if (body.email && u.email === body.email) throw conflict('That email is already registered. Forgot your password? Reset it from the login page.');
    throw conflict('That phone number is already registered. Forgot your password? Reset it from the login page.');
  }
  return replace;
}

// ---------- Sign up (verified before the account can be used) ----------

/**
 * Sends a 6-digit code to the email or phone given. No account is created yet: the details wait
 * in PendingSignup and the account only exists once POST /verify confirms the code.
 */
router.post('/register', emailLimiter, async (req, res) => {
  const body = RegisterSchema.parse(req.body);
  await checkSignupConflicts(body); // early, friendly 409; checked again when the code is confirmed
  const passwordHash = await bcrypt.hash(body.password, 10);
  const sent = await startPendingSignup({ ...body, passwordHash }); // 503 if the code can't be delivered
  res.status(201).json({ verificationRequired: true, verifyToken: sent.token, channel: sent.channel, hint: sent.hint });
});

/** Creates the account for a confirmed pending sign-up (replacing abandoned unverified accounts it clashes with) */
async function createAccountFromPending(p: PendingSignup) {
  const contact = { username: p.username, email: p.email ?? undefined, phone: p.phone ?? undefined };
  const replace = await checkSignupConflicts(contact); // 409 if someone else took it meanwhile
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      if (replace.length) await tx.user.deleteMany({ where: { id: { in: replace } } });
      const created = await tx.user.create({
        data: {
          name: p.name,
          username: p.username,
          email: p.email,
          phone: p.phone,
          passwordHash: p.passwordHash,
          currency: p.currency,
          ...(p.channel === 'sms' ? { phoneVerifiedAt: now } : { emailVerifiedAt: now }),
        },
      });
      await tx.category.createMany({ data: defaultCategoryData(created.id) });
      // this sign-up and any other pending ones for the same username / email / phone
      await tx.pendingSignup.deleteMany({
        where: {
          OR: [{ id: p.id }, { username: p.username }, ...(p.email ? [{ email: p.email }] : []), ...(p.phone ? [{ phone: p.phone }] : [])],
        },
      });
      return created;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw conflict('That username, email or phone was just registered. Please sign up again.');
    throw err;
  }
}

/** Confirms the sign-up code (creating the account) or a first-login code, then signs in */
router.post('/verify', authLimiter, async (req, res) => {
  const body = VerifySchema.parse(req.body);

  const pending = await findPendingSignup(body.verifyToken);
  if (pending) {
    assertPendingLive(pending);
    await checkPendingCode(pending, body.code);
    const created = await createAccountFromPending(pending);
    return res.json(await finishLogin(created.id));
  }

  // An existing account that never verified, signing in for the first time
  const row = await findLiveToken(body.verifyToken, 'SIGNUP_VERIFY', 'This code is no longer valid. Please sign up or log in again.');
  if (!codeMatches(row, body.code)) await failCode(row);

  const now = new Date();
  const user = await prisma.user.update({
    where: { id: row.userId },
    data: row.channel === 'sms' ? { phoneVerifiedAt: now } : { emailVerifiedAt: now },
  });
  await markUsed(row.id);
  if (user.mfaMethod) return res.json(await mfaChallenge(user));
  res.json(await finishLogin(user.id));
});

/** Sends a new sign-up code. Returns a new verifyToken (the old code keeps working if sending fails). */
router.post('/verify/resend', emailLimiter, async (req, res) => {
  const { verifyToken } = z.object({ verifyToken: TokenSchema }).parse(req.body);
  const pending = await findPendingSignup(verifyToken);
  if (pending) {
    assertPendingLive(pending);
    const sent = await resendPendingCode(pending);
    return res.json({ verifyToken: sent.token, channel: sent.channel, hint: sent.hint });
  }
  const row = await findLiveToken(verifyToken, 'SIGNUP_VERIFY', 'This sign-up expired. Please log in or sign up again.');
  await assertCooldown(row.userId, 'SIGNUP_VERIFY');
  const sent = await sendContactCode(row.user, 'signup', (row.channel as Channel) ?? 'email');
  res.json({ verifyToken: sent.token, channel: sent.channel, hint: sent.hint });
});

// ---------- Login ----------

/**
 * Step 1: username, email or phone + password.
 *  - not verified yet  → { verificationRequired, verifyToken, channel, hint } (code sent)
 *  - two-step enabled  → { mfaRequired, method, mfaToken, emailHint }
 *  - otherwise         → { token, user }
 */
router.post('/login', authLimiter, async (req, res) => {
  const body = LoginSchema.parse(req.body);
  const user = await findUserByIdentifier(body.identifier);
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw unauthorized('Wrong username, email, phone or password');
  }
  if (!user.active) throw forbidden('This account has been disabled. Contact an administrator.');
  await continueLogin(user, res);
});

/** Step 2: the authenticator / emailed code, or a backup code */
router.post('/login/mfa', authLimiter, async (req, res) => {
  const body = MfaLoginSchema.parse(req.body);
  const challenge = await findLiveToken(body.mfaToken, 'MFA_CHALLENGE', 'Your sign-in attempt expired. Please log in again.');
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
  if (user.mfaMethod !== 'EMAIL' || !user.email) throw badRequest('This account uses an authenticator app');

  await assertCooldown(user.id, 'MFA_CHALLENGE');
  const { token, code } = await issueToken(user.id, 'MFA_CHALLENGE', { withCode: true });
  try {
    await sendEmail(mfaCodeMessage(user.email, user.name, code!, 'login'));
  } catch {
    // The new challenge replaced the old one, so hand it back even though the email failed
    return res.status(503).json({ error: EMAIL_FAILED_MESSAGE, mfaToken: token });
  }
  res.json({ mfaToken: token });
});

// ---------- Forgot username / password ----------

const GENERIC_USERNAME = 'If an account uses that email or phone, we sent its username there.';
const GENERIC_RESET = 'If an account matches, we sent a 6-digit code to its email or phone.';

/** Sends the username to the account's email or phone. Same reply either way (doesn't reveal accounts). */
router.post('/forgot-username', emailLimiter, async (req, res) => {
  const { contact } = z.object({ contact: IdentifierSchema }).parse(req.body);
  const kind = identifierKind(contact);
  if (kind === 'username') throw badRequest('Enter the email or phone number on your account');
  const user = await findUserByIdentifier(contact);
  if (user?.active) {
    sendUsernameReminder(user, kind === 'email' ? 'email' : 'sms').catch(() => undefined); // failures are logged
  }
  res.json({ ok: true, message: GENERIC_USERNAME });
});

/**
 * Sends a password reset code to the account's email or phone.
 * Always returns a resetToken and the same message, so it can't reveal whether an account exists.
 */
router.post('/forgot-password', emailLimiter, async (req, res) => {
  const { identifier } = z.object({ identifier: IdentifierSchema }).parse(req.body);
  const user = await findUserByIdentifier(identifier);
  let resetToken = randomToken(); // decoy for unknown accounts

  if (user?.active) {
    const kind = identifierKind(identifier);
    const channel = kind === 'email' ? 'email' : kind === 'phone' ? 'sms' : pickChannel(user);
    if (channel) {
      try {
        await assertCooldown(user.id, 'PASSWORD_RESET');
        resetToken = (await sendContactCode(user, 'reset', channel)).token;
      } catch (err) {
        // Cooldown or delivery problems must look the same as "no account" (both are logged)
        if (!(err instanceof HttpError)) throw err;
      }
    }
  }
  res.json({ ok: true, resetToken, message: GENERIC_RESET });
});

/** Sets a new password with the emailed/texted code. Signs out every session; two-step stays on. */
router.post('/reset-password', authLimiter, async (req, res) => {
  const body = z.object({ resetToken: TokenSchema, code: CodeSchema, password: PasswordSchema }).parse(req.body);
  const row = await findLiveToken(body.resetToken, 'PASSWORD_RESET', 'This code is wrong or has expired. Request a new one.');
  if (!codeMatches(row, body.code)) await failCode(row);

  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: {
        passwordHash: await bcrypt.hash(body.password, 10),
        tokenVersion: { increment: 1 },
        // The code reached them, so that email/phone is proven
        ...(row.channel === 'sms' ? { phoneVerifiedAt: row.user.phoneVerifiedAt ?? now } : { emailVerifiedAt: row.user.emailVerifiedAt ?? now }),
      },
    }),
    prisma.authToken.updateMany({ where: { userId: row.userId, type: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: now } }),
  ]);
  res.json({ ok: true, username: row.user.username });
});

// ---------- Email verification links (change email / admin-set email) ----------

async function sendVerification(user: Pick<User, 'id' | 'email' | 'name'>) {
  if (!user.email) throw badRequest('This account has no email address');
  const { token } = await issueToken(user.id, 'EMAIL_VERIFY');
  try {
    await sendEmail(verifyEmailMessage(user.email, user.name, token));
  } catch (err) {
    await discardToken(token);
    throw err;
  }
}

/** Confirms an email link: EMAIL_VERIFY (admin-set address) or EMAIL_CHANGE (new address) */
router.post('/verify-email', authLimiter, async (req, res) => {
  const { token } = z.object({ token: TokenSchema }).parse(req.body);
  const invalid = 'This verification link is invalid or has expired.';
  const kind = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, select: { type: true } });

  if (kind?.type === 'EMAIL_CHANGE') {
    const row = await findLiveToken(token, 'EMAIL_CHANGE', invalid);
    const user = row.user;
    const newEmail = user.pendingEmail;
    if (!newEmail) throw badRequest('This email change was cancelled.');

    const taken = await prisma.user.findUnique({ where: { email: newEmail } });
    if (taken && taken.id !== user.id && !(await canReclaim(taken, { sameContact: true }))) {
      throw conflict(`${newEmail} is already used by another account.`);
    }

    await prisma.$transaction(async (tx) => {
      if (taken && taken.id !== user.id) await tx.user.delete({ where: { id: taken.id } });
      await tx.user.update({ where: { id: user.id }, data: { email: newEmail, pendingEmail: null, emailVerifiedAt: new Date() } });
      await tx.authToken.updateMany({
        where: { userId: user.id, type: { in: ['EMAIL_CHANGE', 'EMAIL_VERIFY'] }, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
    if (user.email) sendEmailInBackground(emailChangedNotice(user.email, user.name, newEmail));
    return res.json({ ok: true, email: newEmail, changed: true });
  }

  const row = await findLiveToken(token, 'EMAIL_VERIFY', invalid);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() } }),
    prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  res.json({ ok: true, email: row.user.email, changed: false });
});

router.post('/resend-verification', requireAuth, emailLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!user.email) throw badRequest('Add an email address first');
  if (user.emailVerifiedAt) throw badRequest('Your email is already verified');
  await assertCooldown(user.id, 'EMAIL_VERIFY');
  await sendVerification(user);
  res.json({ ok: true });
});

// ---------- Change / add email ----------

async function sendEmailChange(user: Pick<User, 'id' | 'name'>, newEmail: string) {
  const { token } = await issueToken(user.id, 'EMAIL_CHANGE');
  try {
    await sendEmail(confirmEmailChangeMessage(newEmail, user.name, token));
  } catch (err) {
    await discardToken(token);
    throw err;
  }
}

/** Adds or changes the email: the new address gets a confirmation link and only applies once confirmed */
router.post('/change-email', requireAuth, emailLimiter, async (req, res) => {
  const body = z.object({ newEmail: EmailSchema, password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (isRootAdmin(user.email)) throw forbidden('The root admin email is set by ADMIN_EMAIL on the server');
  if (!(await bcrypt.compare(body.password, user.passwordHash))) throw badRequest('Password is incorrect');
  if (body.newEmail === user.email) throw badRequest('That is already your email');

  const taken = await prisma.user.findUnique({ where: { email: body.newEmail } });
  if (taken && !(await canReclaim(taken, { sameContact: true }))) throw conflict('Email is already registered');

  await assertCooldown(user.id, 'EMAIL_CHANGE');
  await sendEmailChange(user, body.newEmail); // throws 503 if the email can't be sent; nothing is changed then
  const updated = await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: body.newEmail } });
  res.json({ user: publicUser(updated) });
});

router.post('/change-email/resend', requireAuth, emailLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!user.pendingEmail) throw badRequest('There is no email change waiting for confirmation');
  await assertCooldown(user.id, 'EMAIL_CHANGE');
  await sendEmailChange(user, user.pendingEmail);
  res.json({ ok: true });
});

router.delete('/change-email', requireAuth, async (req, res) => {
  const userId = uid(req);
  const [updated] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } }),
    prisma.authToken.updateMany({ where: { userId, type: 'EMAIL_CHANGE', usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  res.json({ user: publicUser(updated) });
});

// ---------- Phone number ----------

/** Adds or changes the phone: texts a code to the new number; it applies after POST /phone/verify */
router.post('/phone', requireAuth, emailLimiter, async (req, res) => {
  const body = z.object({ phone: PhoneSchema, password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!(await bcrypt.compare(body.password, user.passwordHash))) throw badRequest('Password is incorrect');
  if (body.phone === user.phone) throw badRequest('That is already your phone number');

  const taken = await prisma.user.findUnique({ where: { phone: body.phone } });
  if (taken && !(await canReclaim(taken, { sameContact: true }))) throw conflict('That phone number is used by another account');

  await assertCooldown(user.id, 'PHONE_CHANGE');
  const sent = await sendContactCode(user, 'phone', 'sms', body.phone);
  const updated = await prisma.user.update({ where: { id: user.id }, data: { pendingPhone: body.phone } });
  res.json({ user: publicUser(updated), hint: sent.hint });
});

router.post('/phone/verify', requireAuth, authLimiter, async (req, res) => {
  const { code } = z.object({ code: CodeSchema }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!user.pendingPhone) throw badRequest('There is no phone number waiting for a code');

  const row = await findLiveCodeToken(user.id, 'PHONE_CHANGE');
  if (!row) throw badRequest('The code expired. Send a new one.');
  if (!codeMatches(row, code)) await failCode(row);

  const taken = await prisma.user.findUnique({ where: { phone: user.pendingPhone } });
  if (taken && taken.id !== user.id && !(await canReclaim(taken, { sameContact: true }))) {
    throw conflict('That phone number is used by another account');
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (taken && taken.id !== user.id) await tx.user.delete({ where: { id: taken.id } });
    await tx.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return tx.user.update({
      where: { id: user.id },
      data: { phone: user.pendingPhone, phoneVerifiedAt: new Date(), pendingPhone: null },
    });
  });
  res.json({ user: publicUser(updated) });
});

/** Cancels a phone number that is waiting for its code */
router.delete('/phone/pending', requireAuth, async (req, res) => {
  const updated = await prisma.user.update({ where: { id: uid(req) }, data: { pendingPhone: null } });
  res.json({ user: publicUser(updated) });
});

/** Removes the phone number (only if a verified email remains for sign-in and recovery) */
router.delete('/phone', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  if (!user.email || !user.emailVerifiedAt) throw badRequest('Add and verify an email before removing your phone number');
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { phone: null, phoneVerifiedAt: null, pendingPhone: null },
  });
  res.json({ user: publicUser(updated) });
});

// ---------- Current user ----------

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: uid(req) } });
  if (!user) throw notFound('User');
  res.json({ user: publicUser(user) });
});

/** Update name, username, currency and/or display preferences (preferences are merged) */
router.patch('/me', requireAuth, async (req, res) => {
  const { preferences, ...rest } = UpdateMeSchema.parse(req.body);
  const userId = uid(req);
  if (rest.username) {
    const taken = await prisma.user.findUnique({ where: { username: rest.username } });
    if (taken && taken.id !== userId) throw conflict('That username is taken');
  }
  const data: Prisma.UserUpdateInput = { ...rest };
  if (preferences) {
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
    data.preferences = { ...normalizePreferences(current?.preferences), ...preferences };
  }
  const user = await prisma.user.update({ where: { id: userId }, data });
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
