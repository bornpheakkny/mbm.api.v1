/**
 * Two-step verification settings for the signed-in user (mounted at /api/auth/mfa behind requireAuth).
 * Turning a method on, regenerating backup codes and turning MFA off all require the current password.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { badRequest, notFound } from '../lib/http';
import { decrypt, encrypt, sha256 } from '../lib/crypto';
import { generateTotpSecret, totpUri, verifyTotp } from '../lib/totp';
import { publicUser } from '../lib/users';
import { uid } from '../middleware/auth';
import { authLimiter, emailLimiter } from '../middleware/rateLimit';
import {
  assertCooldown,
  clearMfa,
  codeMatches,
  failCode,
  findLiveCodeToken,
  generateRecoveryCodes,
  issueToken,
  markUsed,
  remainingRecoveryCodes,
} from '../services/authTokens';
import { mfaCodeMessage, sendEmail } from '../services/email';

const router = Router();

const PasswordConfirm = z.object({ password: z.string().min(1) });
const EnableSchema = PasswordConfirm.extend({ code: z.string().trim().min(6).max(10) });

async function currentUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound('User');
  return user;
}

async function assertPassword(hash: string, password: string) {
  if (!(await bcrypt.compare(password, hash))) throw badRequest('Password is incorrect');
}

/** GET /api/auth/mfa — current status */
router.get('/', async (req, res) => {
  const user = await currentUser(uid(req));
  res.json({
    method: user.mfaMethod,
    recoveryCodesLeft: user.mfaMethod ? await remainingRecoveryCodes(user.id) : 0,
    emailVerified: Boolean(user.emailVerifiedAt),
  });
});

// ---------- Authenticator app ----------

/** Starts setup: returns a QR code and the key for manual entry. Nothing changes until /totp/enable. */
router.post('/totp/setup', async (req, res) => {
  const user = await currentUser(uid(req));
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpPendingSecret: encrypt(secret) } });

  const otpauthUrl = totpUri(secret, user.email);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  res.json({ secret, otpauthUrl, qrDataUrl });
});

/** Confirms the first code from the app and turns the authenticator method on */
router.post('/totp/enable', authLimiter, async (req, res) => {
  const body = EnableSchema.parse(req.body);
  const user = await currentUser(uid(req));
  await assertPassword(user.passwordHash, body.password);
  if (!user.totpPendingSecret) throw badRequest('Start the authenticator setup again');

  const secret = decrypt(user.totpPendingSecret);
  if (!verifyTotp(secret, body.code)) {
    throw badRequest('That code is not correct. Check the time on your phone and try the newest code.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { mfaMethod: 'TOTP', totpSecret: encrypt(secret), totpPendingSecret: null },
  });
  const recoveryCodes = await generateRecoveryCodes(user.id);
  res.json({ user: publicUser(updated), recoveryCodes });
});

// ---------- Email codes ----------

/** Emails a 6-digit code to confirm email-based two-step verification */
router.post('/email/setup', emailLimiter, async (req, res) => {
  const user = await currentUser(uid(req));
  if (!user.emailVerifiedAt) throw badRequest('Verify your email address first');
  await assertCooldown(user.id, 'MFA_EMAIL_SETUP');
  const { token, code } = await issueToken(user.id, 'MFA_EMAIL_SETUP', { withCode: true });
  try {
    await sendEmail(mfaCodeMessage(user.email, user.name, code!, 'setup'));
  } catch (err) {
    await prisma.authToken.deleteMany({ where: { tokenHash: sha256(token) } }); // allow an immediate retry
    throw err;
  }
  res.json({ ok: true });
});

router.post('/email/enable', authLimiter, async (req, res) => {
  const body = EnableSchema.parse(req.body);
  const user = await currentUser(uid(req));
  await assertPassword(user.passwordHash, body.password);

  const row = await findLiveCodeToken(user.id, 'MFA_EMAIL_SETUP');
  if (!row) throw badRequest('The code expired. Send a new one.');
  if (!codeMatches(row, body.code)) await failCode(row);

  await markUsed(row.id);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { mfaMethod: 'EMAIL', totpSecret: null, totpPendingSecret: null },
  });
  const recoveryCodes = await generateRecoveryCodes(user.id);
  res.json({ user: publicUser(updated), recoveryCodes });
});

// ---------- Backup codes & turning off ----------

router.post('/recovery-codes', authLimiter, async (req, res) => {
  const body = PasswordConfirm.parse(req.body);
  const user = await currentUser(uid(req));
  await assertPassword(user.passwordHash, body.password);
  if (!user.mfaMethod) throw badRequest('Two-step verification is off');
  res.json({ recoveryCodes: await generateRecoveryCodes(user.id) });
});

router.post('/disable', authLimiter, async (req, res) => {
  const body = PasswordConfirm.parse(req.body);
  const user = await currentUser(uid(req));
  await assertPassword(user.passwordHash, body.password);
  await clearMfa(user.id);
  res.json({ user: publicUser(await currentUser(user.id)) });
});

export default router;
