import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { MonthSchema, currentMonth, monthRange, shiftMonth, toNumber } from '../lib/month';
import { uid } from '../middleware/auth';

const router = Router();

/**
 * GET /api/summary?month=YYYY-MM
 * Same shape as the "Budget" sheet: totals + income/expense tables (budgeted vs actual).
 */
router.get('/', async (req, res) => {
  const month = MonthSchema.default(currentMonth()).parse(req.query.month);
  const userId = uid(req);

  const [categories, budgets, actuals] = await Promise.all([
    prisma.category.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.budget.findMany({ where: { userId, month } }),
    prisma.transaction.groupBy({
      by: ['categoryId'],
      where: { userId, date: monthRange(month) },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  const budgetBy = new Map(budgets.map((b) => [b.categoryId, toNumber(b.amount)]));
  const actualBy = new Map(actuals.map((a) => [a.categoryId, { sum: toNumber(a._sum.amount), count: a._count }]));

  const rowsFor = (type: 'INCOME' | 'EXPENSE') =>
    categories
      .filter((c) => c.type === type)
      // hide archived categories unless they have data this month
      .filter((c) => !c.archived || budgetBy.has(c.id) || actualBy.has(c.id))
      .map((c) => {
        const budgeted = budgetBy.get(c.id) ?? 0;
        const actual = actualBy.get(c.id)?.sum ?? 0;
        return {
          categoryId: c.id,
          name: c.name,
          color: c.color,
          budgeted,
          actual,
          // Income: Difference = actual - budgeted. Expense: Remaining = budgeted - actual
          difference: round(type === 'INCOME' ? actual - budgeted : budgeted - actual),
          count: actualBy.get(c.id)?.count ?? 0,
        };
      });

  const income = rowsFor('INCOME');
  const expenses = rowsFor('EXPENSE');
  const sum = (rows: typeof income, key: 'budgeted' | 'actual' | 'difference') =>
    round(rows.reduce((s, r) => s + r[key], 0));

  const totalIncome = sum(income, 'actual');
  const totalExpenses = sum(expenses, 'actual');

  res.json({
    month,
    totals: {
      totalIncome,
      totalExpenses,
      leftOver: round(totalIncome - totalExpenses),
      shareSpent: totalIncome > 0 ? Math.round((totalExpenses / totalIncome) * 10000) / 10000 : 0,
      budgetedIncome: sum(income, 'budgeted'),
      budgetedExpenses: sum(expenses, 'budgeted'),
    },
    income: {
      rows: income,
      totals: { budgeted: sum(income, 'budgeted'), actual: totalIncome, difference: sum(income, 'difference') },
    },
    expenses: {
      rows: expenses,
      totals: { budgeted: sum(expenses, 'budgeted'), actual: totalExpenses, difference: sum(expenses, 'difference') },
    },
  });
});

/** GET /api/summary/trend?months=6&end=YYYY-MM — income vs expenses per month */
router.get('/trend', async (req, res) => {
  const q = z
    .object({ months: z.coerce.number().int().min(1).max(24).default(6), end: MonthSchema.default(currentMonth()) })
    .parse(req.query);
  const userId = uid(req);
  const start = shiftMonth(q.end, -(q.months - 1));

  const rows = await prisma.transaction.findMany({
    where: { userId, date: { gte: monthRange(start).gte, lt: monthRange(q.end).lt } },
    select: { date: true, type: true, amount: true },
  });

  const months = Array.from({ length: q.months }, (_, i) => shiftMonth(start, i));
  const map = new Map(months.map((m) => [m, { month: m, income: 0, expenses: 0 }]));
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 7);
    const bucket = map.get(key);
    if (!bucket) continue;
    if (r.type === 'INCOME') bucket.income += toNumber(r.amount);
    else bucket.expenses += toNumber(r.amount);
  }
  res.json({
    trend: months.map((m) => ({
      ...map.get(m)!,
      income: round(map.get(m)!.income),
      expenses: round(map.get(m)!.expenses),
    })),
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}

export default router;
