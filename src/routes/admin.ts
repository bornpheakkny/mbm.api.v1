/**
 * Account management for ADMIN users (mounted behind requireAuth + requireAdmin).
 * Admins manage accounts only — they never see another user's budget data.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { publicUser } from '../lib/users';
import { uid } from '../middleware/auth';
import { defaultCategoryData } from '../services/defaultCategories';
import { clearMfa } from '../services/authTokens';
import { isRootAdmin } from '../services/bootstrapAdmin';
import { CurrencySchema, EmailSchema, NameSchema, PasswordSchema } from './auth';
import type { Prisma } from '../generated/prisma/client';

const router = Router();

const RoleSchema = z.enum(['USER', 'ADMIN']);

const ListQuery = z.object({
  q: z.string().trim().optional(),
  role: RoleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const CreateSchema = z.object({
  name: NameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  currency: CurrencySchema.optional(),
  role: RoleSchema.optional(),
});

const UpdateSchema = z.object({
  name: NameSchema.optional(),
  email: EmailSchema.optional(),
  currency: CurrencySchema.optional(),
  role: RoleSchema.optional(),
  active: z.boolean().optional(),
});

const ResetPasswordSchema = z.object({ password: PasswordSchema });

const withStats = {
  _count: { select: { transactions: true, categories: true } },
} satisfies Prisma.UserInclude;

type UserWithStats = Prisma.UserGetPayload<{ include: typeof withStats }>;

const adminView = (u: UserWithStats) => ({
  ...publicUser(u),
  isRoot: isRootAdmin(u.email),
  transactionCount: u._count.transactions,
  categoryCount: u._count.categories,
});

async function findUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound('User');
  return user;
}

/** GET /api/admin/users?q=&role=&status= */
router.get('/users', async (req, res) => {
  const q = ListQuery.parse(req.query);
  const users = await prisma.user.findMany({
    where: {
      ...(q.q && {
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
        ],
      }),
      ...(q.role && { role: q.role }),
      ...(q.status && { active: q.status === 'active' }),
    },
    include: withStats,
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
  });

  const [total, admins, disabled] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.user.count({ where: { active: false } }),
  ]);

  res.json({ users: users.map(adminView), stats: { total, admins, disabled } });
});

/** POST /api/admin/users — create an account (gets its own default categories) */
router.post('/users', async (req, res) => {
  const body = CreateSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: body.email } })) {
    throw conflict('Email is already registered');
  }
  const passwordHash = await bcrypt.hash(body.password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash,
        currency: body.currency ?? 'USD',
        role: body.role ?? 'USER',
      },
    });
    await tx.category.createMany({ data: defaultCategoryData(created.id) });
    return tx.user.findUniqueOrThrow({ where: { id: created.id }, include: withStats });
  });

  res.status(201).json({ user: adminView(user) });
});

/** PATCH /api/admin/users/:id — profile, role, enable/disable */
router.patch('/users/:id', async (req, res) => {
  const body = UpdateSchema.parse(req.body);
  const target = await findUser(req.params.id);
  const self = target.id === uid(req);

  const demoting = body.role === 'USER' && target.role === 'ADMIN';
  const disabling = body.active === false && target.active;
  const changingEmail = body.email !== undefined && body.email !== target.email;

  if (isRootAdmin(target.email) && (demoting || disabling || changingEmail)) {
    throw forbidden('The root admin account cannot be demoted, disabled or have its email changed');
  }
  if (self && (demoting || disabling)) {
    throw forbidden('You cannot remove your own admin access or disable your own account');
  }
  if (changingEmail && (await prisma.user.findUnique({ where: { email: body.email } }))) {
    throw conflict('Email is already registered');
  }

  const user = await prisma.user.update({ where: { id: target.id }, data: body, include: withStats });
  res.json({ user: adminView(user) });
});

/** POST /api/admin/users/:id/reset-password */
router.post('/users/:id/reset-password', async (req, res) => {
  const body = ResetPasswordSchema.parse(req.body);
  const target = await findUser(req.params.id);
  if (isRootAdmin(target.email) && target.id !== uid(req)) {
    throw forbidden('Only the root admin can change the root admin password');
  }
  await prisma.user.update({
    where: { id: target.id },
    // Signs the user out everywhere
    data: { passwordHash: await bcrypt.hash(body.password, 10), tokenVersion: { increment: 1 } },
  });
  res.json({ ok: true });
});

/** POST /api/admin/users/:id/reset-mfa — turns two-step verification off (user lost phone and backup codes) */
router.post('/users/:id/reset-mfa', async (req, res) => {
  const target = await findUser(req.params.id);
  if (isRootAdmin(target.email) && target.id !== uid(req)) {
    throw forbidden("Only the root admin can reset the root admin's two-step verification");
  }
  await clearMfa(target.id);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: withStats });
  res.json({ user: adminView(user) });
});

/** DELETE /api/admin/users/:id — removes the account and all of its budget data */
router.delete('/users/:id', async (req, res) => {
  const target = await findUser(req.params.id);
  if (target.id === uid(req)) throw badRequest('You cannot delete your own account');
  if (isRootAdmin(target.email)) throw forbidden('The root admin account cannot be deleted');

  // Transactions reference categories with onDelete: Restrict, so remove them first.
  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { userId: target.id } }),
    prisma.user.delete({ where: { id: target.id } }),
  ]);
  res.status(204).end();
});

export default router;
