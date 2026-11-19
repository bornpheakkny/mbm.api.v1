/**
 * Rules for accounts that never verified their email or phone (abandoned sign-ups),
 * so a mistyped or someone-else's username, email or phone doesn't stay taken.
 * Accounts with income/expense entries are never removed automatically.
 */
import { env } from '../config/env';
import { isVerified } from '../lib/contacts';
import { prisma } from '../lib/prisma';
import type { Prisma, User } from '../generated/prisma/client';

const HOUR = 60 * 60 * 1000;
/** Another sign-up can take an unverified account's username after this long */
export const RECLAIM_AFTER_MS = HOUR;
/** Unverified accounts with no activity are deleted after this long */
const DELETE_AFTER_MS = 7 * 24 * HOUR;
const CLEANUP_INTERVAL_MS = 12 * HOUR;

const notRootAdmin = (): Prisma.UserWhereInput =>
  env.ADMIN_EMAIL ? { OR: [{ email: null }, { email: { not: env.ADMIN_EMAIL.toLowerCase() } }] } : {};

/**
 * Can a new sign-up replace this existing account?
 * Only never-verified USER accounts with no entries. If the new sign-up uses the same email or
 * phone (the same person trying again) it can replace it right away; otherwise after an hour.
 */
export async function canReclaim(user: User, opts: { sameContact?: boolean } = {}) {
  if (isVerified(user) || user.role !== 'USER') return false;
  if (env.ADMIN_EMAIL && user.email === env.ADMIN_EMAIL.toLowerCase()) return false;
  if (!opts.sameContact && Date.now() - user.createdAt.getTime() < RECLAIM_AFTER_MS) return false;
  const entries = await prisma.transaction.count({ where: { userId: user.id } });
  return entries === 0;
}

/** Deletes never-verified USER accounts with no entries and no login for 7 days */
export async function deleteStaleUnverified() {
  const cutoff = new Date(Date.now() - DELETE_AFTER_MS);
  const { count } = await prisma.user.deleteMany({
    where: {
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      role: 'USER',
      createdAt: { lt: cutoff },
      AND: [{ OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: cutoff } }] }, notRootAdmin()],
      transactions: { none: {} },
    },
  });
  if (count > 0) console.log(`🧹 Deleted ${count} unverified account(s) older than 7 days`);
  return count;
}

/** Runs the cleanup now and every 12 hours while the server is up */
export function scheduleUnverifiedCleanup() {
  const run = () => deleteStaleUnverified().catch((err) => console.error('❌ Unverified cleanup failed:', err));
  void run();
  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
