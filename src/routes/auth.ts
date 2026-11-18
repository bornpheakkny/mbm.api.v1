import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { conflict, notFound, unauthorized } from '../lib/http';
import { requireAuth, signToken, uid } from '../middleware/auth';
import { defaultCategoryData } from '../services/defaultCategories';

const router = Router();

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  currency: z.string().length(3).toUpperCase().optional(),
});

const LoginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1),
});

const UpdateMeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
});

const publicUser = (u: { id: string; email: string; name: string; currency: string; createdAt: Date }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  currency: u.currency,
  createdAt: u.createdAt,
});

router.post('/register', async (req, res) => {
  const body = RegisterSchema.parse(req.body);

  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw conflict('Email is already registered');

  const passwordHash = await bcrypt.hash(body.password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash, currency: body.currency ?? 'USD' },
    });
    await tx.category.createMany({ data: defaultCategoryData(created.id) });
    return created;
  });

  const token = signToken({ sub: user.id, email: user.email });
  res.status(201).json({ token, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const body = LoginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw unauthorized('Invalid email or password');
  }
  const token = signToken({ sub: user.id, email: user.email });
  res.json({ token, user: publicUser(user) });
});

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

export default router;
