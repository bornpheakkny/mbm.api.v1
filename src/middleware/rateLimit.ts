import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

/** Strict in production; looser locally so testing isn't blocked */
const scale = env.NODE_ENV === 'production' ? 1 : 10;

const message = (what: string) => ({ error: `Too many ${what}. Please wait a few minutes and try again.` });

/** Login, MFA code and password-reset attempts per IP */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30 * scale,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: message('attempts'),
});

/** Endpoints that send email (register, forgot password, resend) per IP */
export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15 * scale,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: message('email requests'),
});
