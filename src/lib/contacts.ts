/**
 * Usernames, phone numbers and "username, email or phone" login identifiers.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from './prisma';

/** 3–30 characters: starts with a letter; letters, digits, dot, underscore. Stored lowercase. */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._]{2,29}$/, 'Username must be 3–30 characters: start with a letter, then letters, numbers, . or _');

/** Normalises a phone number to E.164 (+85512345678). Numbers without +code use DEFAULT_PHONE_COUNTRY. */
export function normalizePhone(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), env.DEFAULT_PHONE_COUNTRY as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

export const PhoneSchema = z
  .string()
  .trim()
  .min(6)
  .max(24)
  .transform((v, ctx) => {
    const phone = normalizePhone(v);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number, e.g. 012 345 678 or +855 12 345 678' });
      return z.NEVER;
    }
    return phone;
  });

export type Channel = 'email' | 'sms';

/** What a login / recovery identifier looks like */
export function identifierKind(value: string): 'email' | 'phone' | 'username' {
  const v = value.trim();
  if (v.includes('@')) return 'email';
  if (/^\+?[\d\s\-().]{6,}$/.test(v)) return 'phone';
  return 'username';
}

/** Finds a user by username, email or phone (as typed by the user) */
export async function findUserByIdentifier(value: string) {
  const v = value.trim();
  switch (identifierKind(v)) {
    case 'email':
      return prisma.user.findUnique({ where: { email: v.toLowerCase() } });
    case 'phone': {
      const phone = normalizePhone(v);
      return phone ? prisma.user.findUnique({ where: { phone } }) : null;
    }
    default:
      return prisma.user.findUnique({ where: { username: v.toLowerCase() } });
  }
}

/** "jo***@gmail.com" */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** "+855 ••• ••• 678" */
export const maskPhone = (phone: string) => `${phone.slice(0, 4)} ••• ••• ${phone.slice(-3)}`;

export const isVerified = (u: { emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null }) =>
  Boolean(u.emailVerifiedAt || u.phoneVerifiedAt);
