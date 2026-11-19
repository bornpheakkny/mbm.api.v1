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
  ADMIN_USERNAME: z.string().default('admin'),
  // Frontend base URL, used in email links (verify email, reset password)
  APP_URL: z.string().default('http://localhost:5173'),
  // Email: Brevo (https://brevo.com) if BREVO_API_KEY is set, else Resend, else printed to the console.
  // EMAIL_FROM must be a sender verified in that provider (Brevo: a single verified address works, e.g. your Gmail).
  BREVO_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  RESEND_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  EMAIL_FROM: z.string().default('Budget Manager <onboarding@resend.dev>'),
  // SMS via Twilio. TWILIO_FROM is your Twilio number (+1...) or a Messaging Service SID (MG...).
  // Without these, SMS are printed to the console in development and refused in production.
  TWILIO_ACCOUNT_SID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Country assumed for phone numbers typed without +country code (ISO code, e.g. KH, US)
  DEFAULT_PHONE_COUNTRY: z.string().length(2).toUpperCase().default('KH'),
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
