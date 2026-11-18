import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI config (migrate, studio, seed).
 * Migrations use the Neon *direct* connection (DIRECT_URL); the app runtime
 * uses the pooled DATABASE_URL (see src/lib/prisma.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});
