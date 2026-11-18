import { Router } from 'express';
import type { Prisma } from '../generated/prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { badRequest, notFound } from '../lib/http';
import { MonthSchema, monthRange, toNumber } from '../lib/month';
import { uid } from '../middleware/auth';

const router = Router();

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const BodySchema = z.object({
  categoryId: z.string().min(1),
  date: DateSchema,
  description: z.string().trim().min(1).max(200),
  amount: z.number().positive().max(1_000_000_000),
  note: z.string().trim().max(500).nullish(),
});

const QuerySchema = z.object({
  month: MonthSchema.optional(),
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  categoryId: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

const select = {
  id: true,
  type: true,
  date: true,
  description: true,
  amount: true,
  note: true,
  categoryId: true,
  createdAt: true,
  category: { select: { id: true, name: true, color: true } },
} satisfies Prisma.TransactionSelect;

type Row = Prisma.TransactionGetPayload<{ select: typeof select }>;

const serialize = (t: Row) => ({
  ...t,
  date: t.date.toISOString().slice(0, 10),
  amount: toNumber(t.amount),
});

async function ownedCategory(userId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw badRequest('Invalid category');
  return category;
}

/** GET /api/transactions?month=&type=&categoryId=&q= */
router.get('/', async (req, res) => {
  const q = QuerySchema.parse(req.query);
  const where: Prisma.TransactionWhereInput = {
    userId: uid(req),
    ...(q.month && { date: monthRange(q.month) }),
    ...(q.type && { type: q.type }),
    ...(q.categoryId && { categoryId: q.categoryId }),
    ...(q.q && {
      OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { note: { contains: q.q, mode: 'insensitive' } }],
    }),
  };

  const [rows, total, sum] = await prisma.$transaction([
    prisma.transaction.findMany({
      where,
      select,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({ where, _sum: { amount: true } }),
  ]);

  res.json({
    transactions: rows.map(serialize),
    total,
    totalAmount: toNumber(sum._sum.amount),
    page: q.page,
    pageSize: q.pageSize,
  });
});

router.post('/', async (req, res) => {
  const body = BodySchema.parse(req.body);
  const userId = uid(req);
  const category = await ownedCategory(userId, body.categoryId);

  const tx = await prisma.transaction.create({
    data: { ...body, userId, type: category.type, date: new Date(`${body.date}T00:00:00Z`) },
    select,
  });
  res.status(201).json({ transaction: serialize(tx) });
});

router.put('/:id', async (req, res) => {
  const body = BodySchema.parse(req.body);
  const userId = uid(req);
  const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, userId } });
  if (!existing) throw notFound('Transaction');
  const category = await ownedCategory(userId, body.categoryId);

  const tx = await prisma.transaction.update({
    where: { id: existing.id },
    data: { ...body, type: category.type, date: new Date(`${body.date}T00:00:00Z`) },
    select,
  });
  res.json({ transaction: serialize(tx) });
});

router.delete('/:id', async (req, res) => {
  const result = await prisma.transaction.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  if (result.count === 0) throw notFound('Transaction');
  res.status(204).end();
});

export default router;
