/**
 * One-time links (email verification, password reset), MFA login challenges,
 * emailed 6-digit codes and backup (recovery) codes. Only hashes are stored.
 */
import { prisma } from '../lib/prisma';
import { HttpError, badRequest } from '../lib/http';
import { decrypt, normaliseRecoveryCode, randomCode, randomToken, recoveryCode, safeEqual, sha256 } from '../lib/crypto';
import { verifyTotp } from '../lib/totp';
import type { AuthToken, AuthTokenType, User } from '../generated/prisma/client';

export const TTL = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  EMAIL_CHANGE: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  MFA_CHALLENGE: 10 * 60 * 1000,
  MFA_EMAIL_SETUP: 10 * 60 * 1000,
} satisfies Record<AuthTokenType, number>;

/** Wrong codes allowed per challenge before the user has to start again */
export const MAX_CODE_ATTEMPTS = 5;
/** Minimum gap between emails of the same kind */
const RESEND_COOLDOWN_MS = 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

const tooMany = (msg: string) => new HttpError(429, msg);

/** Throws 429 if an email of this type was sent less than a minute ago */
export async function assertCooldown(userId: string, type: AuthTokenType) {
  const last = await prisma.authToken.findFirst({
    where: { userId, type },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 1000);
    throw tooMany(`Please wait ${wait}s before requesting another email`);
  }
}

/**
 * Creates a token (and optionally a 6-digit code) of the given type.
 * Earlier unused tokens of the same type are invalidated.
 */
export async function issueToken(userId: string, type: AuthTokenType, opts: { withCode?: boolean } = {}) {
  const token = randomToken();
  const code = opts.withCode ? randomCode() : undefined;
  await prisma.$transaction([
    prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.authToken.create({
      data: {
        userId,
        type,
        tokenHash: sha256(token),
        codeHash: code ? sha256(code) : null,
        expiresAt: new Date(Date.now() + TTL[type]),
      },
    }),
  ]);
  return { token, code };
}

/** Finds a live (unused, unexpired, attempts left) token or throws 400 */
export async function findLiveToken(rawToken: string, type: AuthTokenType, message: string) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { user: true } });
  if (
    !row ||
    row.type !== type ||
    row.usedAt ||
    row.expiresAt.getTime() < Date.now() ||
    row.attempts >= MAX_CODE_ATTEMPTS ||
    !row.user.active
  ) {
    throw badRequest(message);
  }
  return row;
}

export const markUsed = (id: string) => prisma.authToken.update({ where: { id }, data: { usedAt: new Date() } });

/** Latest live code-based token for a user (used for the email-MFA setup step) */
export async function findLiveCodeToken(userId: string, type: AuthTokenType) {
  return prisma.authToken.findFirst({
    where: { userId, type, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_CODE_ATTEMPTS } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Records a wrong attempt; returns how many tries remain */
async function recordFailure(row: AuthToken) {
  const updated = await prisma.authToken.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
  return Math.max(0, MAX_CODE_ATTEMPTS - updated.attempts);
}

export function codeMatches(row: AuthToken, code: string) {
  const clean = code.replace(/\s/g, '');
  return Boolean(row.codeHash) && /^\d{6}$/.test(clean) && safeEqual(row.codeHash!, sha256(clean));
}

/** Throws a helpful 400 after a wrong code, including remaining attempts */
export async function failCode(row: AuthToken, what = 'code'): Promise<never> {
  const left = await recordFailure(row);
  throw badRequest(
    left > 0
      ? `That ${what} is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`
      : `Too many wrong attempts. Please start again.`,
  );
}

// ---------- Second factor ----------

/**
 * Checks an authenticator / email / backup code for this user.
 * Returns which kind matched (a matching backup code is used up), or null.
 */
export async function checkSecondFactor(
  user: User,
  code: string,
  challenge: AuthToken,
): Promise<'totp' | 'email' | 'recovery' | null> {
  const trimmed = code.trim();

  if (user.mfaMethod === 'TOTP' && user.totpSecret && verifyTotp(decrypt(user.totpSecret), trimmed)) return 'totp';
  if (user.mfaMethod === 'EMAIL' && codeMatches(challenge, trimmed)) return 'email';
  return (await redeemRecoveryCode(user.id, trimmed)) ? 'recovery' : null;
}

// ---------- Recovery codes ----------

/** Replaces any existing backup codes; returns the new codes (shown to the user once) */
export async function generateRecoveryCodes(userId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(c) })) }),
  ]);
  return codes;
}

export async function redeemRecoveryCode(userId: string, input: string) {
  const code = normaliseRecoveryCode(input);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return false;
  // updateMany with usedAt: null makes this atomic — a code can only be used once
  const res = await prisma.recoveryCode.updateMany({
    where: { userId, codeHash: sha256(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return res.count > 0;
}

export const remainingRecoveryCodes = (userId: string) =>
  prisma.recoveryCode.count({ where: { userId, usedAt: null } });

/** Turns MFA off and removes secrets and backup codes */
export async function clearMfa(userId: string) {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { mfaMethod: null, totpSecret: null, totpPendingSecret: null },
    }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.authToken.updateMany({
      where: { userId, type: { in: ['MFA_CHALLENGE', 'MFA_EMAIL_SETUP'] }, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
}
