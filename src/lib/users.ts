import type { User } from '../generated/prisma/client';
import { normalizePreferences } from './preferences';

type UserFields = Pick<
  User,
  | 'id'
  | 'username'
  | 'email'
  | 'phone'
  | 'name'
  | 'currency'
  | 'role'
  | 'active'
  | 'lastLoginAt'
  | 'createdAt'
  | 'emailVerifiedAt'
  | 'phoneVerifiedAt'
  | 'mfaMethod'
  | 'pendingEmail'
  | 'pendingPhone'
  | 'preferences'
>;

/** Strip secrets (password hash, MFA secrets, token version) before sending a user to the client */
export function publicUser(u: UserFields) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    name: u.name,
    currency: u.currency,
    role: u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    emailVerified: Boolean(u.emailVerifiedAt),
    phoneVerified: Boolean(u.phoneVerifiedAt),
    mfaMethod: u.mfaMethod,
    pendingEmail: u.pendingEmail,
    pendingPhone: u.pendingPhone,
    preferences: normalizePreferences(u.preferences),
  };
}
