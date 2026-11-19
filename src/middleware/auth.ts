import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../lib/http';
import { prisma } from '../lib/prisma';
import type { Role } from '../generated/prisma/client';

export interface JwtPayload {
  sub: string;
  /** Not used for auth; kept for older tokens */
  email?: string;
  /** user.tokenVersion when issued; bumped on password change/reset to end other sessions */
  ver?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    userRole?: Role;
  }
}

/** Issue a session token for this user */
export function sessionToken(user: { id: string; tokenVersion: number }): string {
  return signToken({ sub: user.id, ver: user.tokenVersion });
}

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verifies the bearer token and re-checks the account on every request,
 * so disabling or deleting a user (or changing their role) takes effect immediately.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized('Missing bearer token'));

  let payload: JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_SECRET) as JwtPayload;
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, active: true, tokenVersion: true },
    });
    if (!user) return next(unauthorized('Account no longer exists'));
    if (!user.active) return next(unauthorized('Account is disabled'));
    if ((payload.ver ?? 0) !== user.tokenVersion) return next(unauthorized('Session expired. Please log in again.'));
    req.userId = user.id;
    req.userRole = user.role;
    next();
  } catch (err) {
    next(err);
  }
}

/** Use after requireAuth */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.userRole !== 'ADMIN') return next(forbidden('Admin access required'));
  next();
}

/** Use inside handlers behind requireAuth */
export function uid(req: Request): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
