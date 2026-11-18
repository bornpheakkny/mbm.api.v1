import type { CategoryType, Prisma } from '../generated/prisma/client';

/** Default categories created for every new user (matches the Budget sheet). */
export const DEFAULT_CATEGORIES: { name: string; type: CategoryType; color: string }[] = [
  { name: 'Salary', type: 'INCOME', color: 'green' },
  { name: 'Freelance', type: 'INCOME', color: 'blue' },
  { name: 'Other', type: 'INCOME', color: 'gray' },

  { name: 'Rent', type: 'EXPENSE', color: 'purple' },
  { name: 'Utilities', type: 'EXPENSE', color: 'yellow' },
  { name: 'Groceries', type: 'EXPENSE', color: 'green' },
  { name: 'Transport', type: 'EXPENSE', color: 'blue' },
  { name: 'Phone & internet', type: 'EXPENSE', color: 'teal' },
  { name: 'Eating out', type: 'EXPENSE', color: 'orange' },
  { name: 'Health & insurance', type: 'EXPENSE', color: 'red' },
  { name: 'Entertainment', type: 'EXPENSE', color: 'magenta' },
  { name: 'Savings', type: 'EXPENSE', color: 'green' },
  { name: 'Other', type: 'EXPENSE', color: 'gray' },
];

export function defaultCategoryData(userId: string): Prisma.CategoryCreateManyInput[] {
  return DEFAULT_CATEGORIES.map((c, i) => ({ ...c, userId, sortOrder: i }));
}
