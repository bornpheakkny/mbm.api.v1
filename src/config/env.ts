import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Root admin, created on startup if no user with this email exists
  ADMIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.email().optional()),
  ADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  ADMIN_NAME: z.string().default('Administrator'),
  // Frontend base URL, used in email links (verify email, reset password)
  APP_URL: z.string().default('http://localhost:5173'),
  // Email via Resend (https://resend.com). Without a key, emails are printed to the console.
  RESEND_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  EMAIL_FROM: z.string().default('Budget Manager <onboarding@resend.dev>'),
  // Key for encrypting authenticator-app secrets. Defaults to JWT_SECRET; set it if you may rotate JWT_SECRET.
  MFA_ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
