import type { User } from '../generated/prisma/client';

type UserFields = Pick<
  User,
  'id' | 'email' | 'name' | 'currency' | 'role' | 'active' | 'lastLoginAt' | 'createdAt' | 'emailVerifiedAt' | 'mfaMethod' | 'pendingEmail'
>;

/** Strip secrets (password hash, MFA secrets, token version) before sending a user to the client */
export function publicUser(u: UserFields) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    currency: u.currency,
    role: u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    emailVerified: Boolean(u.emailVerifiedAt),
    mfaMethod: u.mfaMethod,
    pendingEmail: u.pendingEmail,
  };
}
