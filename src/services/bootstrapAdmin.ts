import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { Prisma } from '../generated/prisma/client';
import { defaultCategoryData } from './defaultCategories';

/**
 * Ensures the root admin from ADMIN_EMAIL exists.
 * - Missing → created with ADMIN_PASSWORD and default categories.
 * - Exists  → promoted to ADMIN and re-enabled; the password is never overwritten.
 */
export async function bootstrapAdmin() {
  const email = env.ADMIN_EMAIL?.toLowerCase();
  if (!email) {
    console.warn('⚠️  ADMIN_EMAIL is not set — no root admin account will be created.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'ADMIN' || !existing.active) {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', active: true } });
      console.log(`👑 Promoted ${email} to root admin`);
    }
    return;
  }

  if (!env.ADMIN_PASSWORD) {
    console.warn(`⚠️  ADMIN_PASSWORD is not set — cannot create root admin ${email}.`);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          username: await freeUsername(env.ADMIN_USERNAME.toLowerCase()),
          name: env.ADMIN_NAME,
          passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD!, 10),
          role: 'ADMIN',
          emailVerifiedAt: new Date(),
        },
      });
      await tx.category.createMany({ data: defaultCategoryData(user.id) });
    });
    console.log(`👑 Created root admin ${email}`);
  } catch (err) {
    // Another instance (or a quick restart) created it at the same moment — that's fine.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
    throw err;
  }
}

/** `wanted`, or wanted2, wanted3… if it's already taken */
async function freeUsername(wanted: string) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? wanted : `${wanted}${n}`;
    if (!(await prisma.user.findUnique({ where: { username: candidate } }))) return candidate;
  }
}

/** The root admin (ADMIN_EMAIL) can't be demoted, disabled or deleted through the API. */
export function isRootAdmin(email: string | null | undefined) {
  return Boolean(env.ADMIN_EMAIL && email) && email!.toLowerCase() === env.ADMIN_EMAIL!.toLowerCase();
}
