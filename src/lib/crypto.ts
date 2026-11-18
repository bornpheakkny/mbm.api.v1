import crypto from 'node:crypto';
import { env } from '../config/env';

/** URL-safe random token for links and MFA challenges */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Tokens and codes are stored hashed, never in plain text */
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** 6-digit numeric code for email MFA */
export const randomCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

/** Backup code like "K7QP-M2XD" (no 0/O/1/I to avoid confusion) */
export function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** Normalise user-typed backup codes: "k7qp m2xd" → "K7QP-M2XD" */
export function normaliseRecoveryCode(input: string) {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** Constant-time comparison of two hex digests */
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const key = crypto
  .createHash('sha256')
  .update(`mfa:${env.MFA_ENCRYPTION_KEY ?? env.JWT_SECRET}`)
  .digest();

/** AES-256-GCM: returns "iv.tag.ciphertext" (base64url) */
export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string) {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
