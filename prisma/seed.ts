/**
 * Seeds a demo user with the November 2026 data from the "Budget" reference sheet.
 *   email: demo@mbm.app   password: demo12345
 * Run: npm run db:seed
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { defaultCategoryData } from '../src/services/defaultCategories';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const MONTH = '2026-11';

const budgets: Record<string, Record<string, number>> = {
  INCOME: { Salary: 1500, Freelance: 400, Other: 0 },
  EXPENSE: {
    Rent: 450, Utilities: 80, Groceries: 250, Transport: 90, 'Phone & internet': 35,
    'Eating out': 120, 'Health & insurance': 60, Entertainment: 70, Savings: 300, Other: 50,
  },
};

const income: [string, string, string, number][] = [
  ['2026-11-01', 'Salary', 'Monthly salary', 1500],
  ['2026-11-10', 'Freelance', 'Website project', 200],
  ['2026-11-15', 'Other', 'Sold old monitor', 50],
  ['2026-11-17', 'Freelance', 'Logo design', 150],
];

const expenses: [string, string, string, number][] = [
  ['2026-11-01', 'Rent', 'November rent', 450],
  ['2026-11-01', 'Savings', 'Transfer to savings', 300],
  ['2026-11-02', 'Groceries', 'Weekly groceries', 58],
  ['2026-11-03', 'Transport', 'Fuel', 40],
  ['2026-11-04', 'Eating out', 'Dinner with friends', 42],
  ['2026-11-05', 'Phone & internet', 'Home internet + mobile plan', 35],
  ['2026-11-05', 'Health & insurance', 'Health insurance', 60],
  ['2026-11-07', 'Entertainment', 'Cinema', 12],
  ['2026-11-08', 'Utilities', 'Electricity bill', 62],
  ['2026-11-09', 'Groceries', 'Weekly groceries', 64],
  ['2026-11-10', 'Eating out', 'Lunch', 28],
  ['2026-11-11', 'Transport', 'Ride-hailing', 34],
  ['2026-11-12', 'Other', 'Haircut', 8],
  ['2026-11-13', 'Utilities', 'Water bill', 30],
  ['2026-11-14', 'Entertainment', 'Concert ticket', 40],
  ['2026-11-15', 'Eating out', 'Birthday dinner', 55],
  ['2026-11-16', 'Groceries', 'Weekly groceries', 47],
  ['2026-11-16', 'Transport', 'Fuel', 30],
  ['2026-11-17', 'Other', 'Gift', 30],
  ['2026-11-17', 'Eating out', 'Coffee', 23],
  ['2026-11-18', 'Groceries', 'Market run', 62],
];

async function main() {
  const email = 'demo@mbm.app';
  await prisma.user.deleteMany({ where: { email } });

  const user = await prisma.user.create({
    data: { email, name: 'Demo User', passwordHash: await bcrypt.hash('demo12345', 10), emailVerifiedAt: new Date() },
  });
  await prisma.category.createMany({ data: defaultCategoryData(user.id) });
  const cats = await prisma.category.findMany({ where: { userId: user.id } });
  const catId = (type: string, name: string) => cats.find((c) => c.type === type && c.name === name)!.id;

  for (const [type, map] of Object.entries(budgets)) {
    await prisma.budget.createMany({
      data: Object.entries(map).map(([name, amount]) => ({
        userId: user.id, categoryId: catId(type, name), month: MONTH, amount,
      })),
    });
  }

  const tx = (type: 'INCOME' | 'EXPENSE', rows: typeof income) =>
    rows.map(([date, cat, description, amount]) => ({
      userId: user.id, type, categoryId: catId(type, cat), description, amount,
      date: new Date(`${date}T00:00:00Z`),
    }));

  await prisma.transaction.createMany({ data: [...tx('INCOME', income), ...tx('EXPENSE', expenses)] });
  console.log(`✅ Seeded ${email} / demo12345 with ${income.length + expenses.length} transactions for ${MONTH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
