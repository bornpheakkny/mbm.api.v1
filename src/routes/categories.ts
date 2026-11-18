import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { conflict, notFound } from '../lib/http';
import { uid } from '../middleware/auth';
import { ColorSchema } from '../lib/preferences';

const router = Router();

const TypeSchema = z.enum(['INCOME', 'EXPENSE']);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: TypeSchema,
  color: ColorSchema.optional(),
  sortOrder: z.number().int().optional(),
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: ColorSchema.optional(),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
});

router.get('/', async (req, res) => {
  const q = z
    .object({ type: TypeSchema.optional(), includeArchived: z.enum(['true', 'false']).optional() })
    .parse(req.query);

  const categories = await prisma.category.findMany({
    where: {
      userId: uid(req),
      ...(q.type && { type: q.type }),
      ...(q.includeArchived !== 'true' && { archived: false }),
    },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({ categories });
});

router.post('/', async (req, res) => {
  const body = CreateSchema.parse(req.body);
  const userId = uid(req);
  const max = await prisma.category.aggregate({ where: { userId, type: body.type }, _max: { sortOrder: true } });
  const category = await prisma.category.create({
    data: { ...body, userId, sortOrder: body.sortOrder ?? (max._max.sortOrder ?? 0) + 1 },
  });
  res.status(201).json({ category });
});

router.patch('/:id', async (req, res) => {
  const body = UpdateSchema.parse(req.body);
  const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId: uid(req) } });
  if (!existing) throw notFound('Category');
  const category = await prisma.category.update({ where: { id: existing.id }, data: body });
  res.json({ category });
});

router.delete('/:id', async (req, res) => {
  const existing = await prisma.category.findFirst({
    where: { id: req.params.id, userId: uid(req) },
    include: { _count: { select: { transactions: true } } },
  });
  if (!existing) throw notFound('Category');
  if (existing._count.transactions > 0) {
    throw conflict('Category has transactions — archive it instead of deleting');
  }
  await prisma.category.delete({ where: { id: existing.id } });
  res.status(204).end();
});

export default router;
