/**
 * Sign-ups waiting for their 6-digit code. Nothing is added to the User table until the code
 * is confirmed, so an unconfirmed sign-up never shows up as an account and never blocks anyone.
 */
import { HttpError, badRequest } from '../lib/http';
import type { Channel } from '../lib/contacts';
import { randomCode, randomToken, safeEqual, sha256 } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import type { PendingSignup } from '../generated/prisma/client';
import { MAX_CODE_ATTEMPTS, TTL } from './authTokens';
import { deliverCode, hintFor } from './contactCodes';

const RESEND_COOLDOWN_MS = 60 * 1000;
/** Expired pending sign-ups are kept a day (so "expired" messages stay accurate), then deleted */
const KEEP_EXPIRED_MS = 24 * 60 * 60 * 1000;

export type SignupDetails = {
  name: string;
  username: string;
  email?: string;
  phone?: string;
  passwordHash: string;
  currency?: string;
};

const destinationOf = (p: { email: string | null; phone: string | null }, channel: Channel) =>
  (channel === 'email' ? p.email : p.phone)!;

/**
 * Sends the code first and stores the pending sign-up only once it was delivered.
 * Earlier pending sign-ups for the same email/phone (the same person trying again) are replaced.
 */
export async function startPendingSignup(details: SignupDetails) {
  const channel: Channel = details.email ? 'email' : 'sms';
  const destination = (details.email ?? details.phone)!;
  const token = randomToken();
  const code = randomCode();

  await deliverCode('signup', channel, destination, details.name, code); // throws 503 → nothing saved

  await prisma.$transaction([
    prisma.pendingSignup.deleteMany({ where: details.email ? { email: details.email } : { phone: details.phone } }),
    prisma.pendingSignup.create({
      data: {
        name: details.name,
        username: details.username,
        email: details.email ?? null,
        phone: details.phone ?? null,
        passwordHash: details.passwordHash,
        currency: details.currency ?? 'USD',
        channel,
        tokenHash: sha256(token),
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + TTL.SIGNUP_VERIFY),
      },
    }),
  ]);
  return { token, channel, hint: hintFor(channel, destination) };
}

/** The pending sign-up for a verifyToken, or null if the token isn't one (e.g. a first-login token) */
export const findPendingSignup = (rawToken: string) =>
  prisma.pendingSignup.findUnique({ where: { tokenHash: sha256(rawToken) } });

export function assertPendingLive(p: PendingSignup) {
  if (p.expiresAt.getTime() < Date.now()) throw badRequest('This code has expired. Please sign up again.');
  if (p.attempts >= MAX_CODE_ATTEMPTS) throw badRequest('Too many wrong attempts. Please sign up again.');
}

/** Checks the code; on a wrong code records the attempt and throws 400 with the tries left */
export async function checkPendingCode(p: PendingSignup, code: string) {
  const clean = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(clean) && safeEqual(p.codeHash, sha256(clean))) return;
  const { attempts } = await prisma.pendingSignup.update({ where: { id: p.id }, data: { attempts: { increment: 1 } } });
  const left = Math.max(0, MAX_CODE_ATTEMPTS - attempts);
  throw badRequest(
    left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please sign up again.',
  );
}

/** Sends a new code. The old code keeps working until the new one is delivered. Returns the new verifyToken. */
export async function resendPendingCode(p: PendingSignup) {
  const since = Date.now() - p.sentAt.getTime();
  if (since < RESEND_COOLDOWN_MS) {
    throw new HttpError(429, `Please wait ${Math.ceil((RESEND_COOLDOWN_MS - since) / 1000)}s before requesting another code`);
  }
  const channel = p.channel as Channel;
  const destination = destinationOf(p, channel);
  const token = randomToken();
  const code = randomCode();
  await deliverCode('signup', channel, destination, p.name, code);
  await prisma.pendingSignup.update({
    where: { id: p.id },
    data: {
      tokenHash: sha256(token),
      codeHash: sha256(code),
      attempts: 0,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + TTL.SIGNUP_VERIFY),
    },
  });
  return { token, channel, hint: hintFor(channel, destination) };
}

/** Deletes pending sign-ups that expired more than a day ago */
export async function deleteExpiredPendingSignups() {
  const { count } = await prisma.pendingSignup.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - KEEP_EXPIRED_MS) } } });
  return count;
}
