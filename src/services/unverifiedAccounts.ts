/**
 * Rules for accounts whose email was never verified, so a mistyped or someone-else's
 * address doesn't stay taken forever. Accounts with income/expense entries are never
 * removed automatically — their owner can still claim them with "Forgot password".
 */
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import type { Prisma, User } from '../generated/prisma/client';

const HOUR = 60 * 60 * 1000;
/** A new sign-up can take over an unverified address after this long */
export const RECLAIM_AFTER_MS = 24 * HOUR;
/** Unverified accounts with no activity are deleted after this long */
const DELETE_AFTER_MS = 30 * 24 * HOUR;
const CLEANUP_INTERVAL_MS = 12 * HOUR;

const notRootAdmin = (): Prisma.UserWhereInput =>
  env.ADMIN_EMAIL ? { email: { not: env.ADMIN_EMAIL.toLowerCase() } } : {};

/**
 * Can a new sign-up replace this existing account?
 * Only unverified USER accounts older than 24 h with no entries.
 */
export async function canReclaim(user: User) {
  if (user.emailVerifiedAt || user.role !== 'USER') return false;
  if (env.ADMIN_EMAIL && user.email === env.ADMIN_EMAIL.toLowerCase()) return false;
  if (Date.now() - user.createdAt.getTime() < RECLAIM_AFTER_MS) return false;
  const entries = await prisma.transaction.count({ where: { userId: user.id } });
  return entries === 0;
}

/** Deletes unverified USER accounts with no entries and no login for 30 days. */
export async function deleteStaleUnverified() {
  const cutoff = new Date(Date.now() - DELETE_AFTER_MS);
  const { count } = await prisma.user.deleteMany({
    where: {
      emailVerifiedAt: null,
      role: 'USER',
      createdAt: { lt: cutoff },
      OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: cutoff } }],
      transactions: { none: {} },
      ...notRootAdmin(),
    },
  });
  if (count > 0) console.log(`🧹 Deleted ${count} unverified account(s) inactive for 30+ days`);
  return count;
}

/** Runs the cleanup now and every 12 hours while the server is up */
export function scheduleUnverifiedCleanup() {
  const run = () => deleteStaleUnverified().catch((err) => console.error('❌ Unverified cleanup failed:', err));
  void run();
  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
