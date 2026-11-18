import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { badRequest } from '../lib/http';
import { MonthSchema, currentMonth, shiftMonth, toNumber } from '../lib/month';
import { uid } from '../middleware/auth';

const router = Router();

const UpsertSchema = z.object({
  month: MonthSchema,
  items: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        amount: z.number().min(0).max(1_000_000_000),
      }),
    )
    .max(200),
});

const CopySchema = z.object({
  from: MonthSchema.optional(),
  to: MonthSchema,
  overwrite: z.boolean().default(false),
});

/** GET /api/budgets?month=YYYY-MM — budgeted amount for each category in a month */
router.get('/', async (req, res) => {
  const month = MonthSchema.default(currentMonth()).parse(req.query.month);
  const budgets = await prisma.budget.findMany({
    where: { userId: uid(req), month },
    include: { category: { select: { name: true, type: true } } },
  });
  res.json({
    month,
    budgets: budgets.map((b) => ({
      id: b.id,
      categoryId: b.categoryId,
      month: b.month,
      amount: toNumber(b.amount),
      category: b.category,
    })),
  });
});

/** PUT /api/budgets — bulk upsert budgeted amounts for one month */
router.put('/', async (req, res) => {
  const { month, items } = UpsertSchema.parse(req.body);
  const userId = uid(req);

  const ids = [...new Set(items.map((i) => i.categoryId))];
  const owned = await prisma.category.count({ where: { userId, id: { in: ids } } });
  if (owned !== ids.length) throw badRequest('One or more categories are invalid');

  await prisma.$transaction(
    items.map((i) =>
      prisma.budget.upsert({
        where: { categoryId_month: { categoryId: i.categoryId, month } },
        update: { amount: i.amount },
        create: { userId, categoryId: i.categoryId, month, amount: i.amount },
      }),
    ),
  );
  res.json({ ok: true, month, count: items.length });
});

/** POST /api/budgets/copy — copy budget plan from one month (default: previous) to another */
router.post('/copy', async (req, res) => {
  const body = CopySchema.parse(req.body);
  const userId = uid(req);
  const from = body.from ?? shiftMonth(body.to, -1);

  const source = await prisma.budget.findMany({ where: { userId, month: from } });
  if (source.length === 0) throw badRequest(`No budget found for ${from}`);

  if (body.overwrite) {
    await prisma.$transaction(
      source.map((b) =>
        prisma.budget.upsert({
          where: { categoryId_month: { categoryId: b.categoryId, month: body.to } },
          update: { amount: b.amount },
          create: { userId, categoryId: b.categoryId, month: body.to, amount: b.amount },
        }),
      ),
    );
  } else {
    await prisma.budget.createMany({
      data: source.map((b) => ({ userId, categoryId: b.categoryId, month: body.to, amount: b.amount })),
      skipDuplicates: true,
    });
  }
  res.json({ ok: true, from, to: body.to, count: source.length });
});

export default router;
