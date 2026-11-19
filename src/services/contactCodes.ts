/**
 * 6-digit codes sent to a user's email or phone: finishing sign-up, resetting a password,
 * confirming a new phone number. Also the "forgot username" reminder.
 */
import { badRequest } from '../lib/http';
import { maskEmail, maskPhone, type Channel } from '../lib/contacts';
import { sha256 } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import type { User } from '../generated/prisma/client';
import { issueToken, retireOthers } from './authTokens';
import { resetCodeMessage, sendEmail, signupCodeMessage, usernameReminderMessage } from './email';
import { sendSms } from './sms';

export type CodePurpose = 'signup' | 'reset' | 'phone';

const TOKEN_TYPE = { signup: 'SIGNUP_VERIFY', reset: 'PASSWORD_RESET', phone: 'PHONE_CHANGE' } as const;

const SMS_TEXT: Record<CodePurpose, (code: string) => string> = {
  signup: (c) => `Budget Manager: your verification code is ${c}. It expires in 30 minutes.`,
  reset: (c) => `Budget Manager: your password reset code is ${c}. It expires in 30 minutes. Didn't ask? Ignore this.`,
  phone: (c) => `Budget Manager: your code to add this phone number is ${c}. It expires in 15 minutes.`,
};

type CodeUser = Pick<User, 'id' | 'name' | 'email' | 'phone' | 'emailVerifiedAt' | 'phoneVerifiedAt'>;

export const hintFor = (channel: Channel, to: string) => (channel === 'email' ? maskEmail(to) : maskPhone(to));

/**
 * Best channel to reach a user: a verified email, then a verified phone,
 * then any email / phone on the account (e.g. a brand-new sign-up).
 */
export function pickChannel(user: CodeUser, prefer?: Channel): Channel | null {
  if (prefer === 'email' && user.email) return 'email';
  if (prefer === 'sms' && user.phone) return 'sms';
  if (user.email && user.emailVerifiedAt) return 'email';
  if (user.phone && user.phoneVerifiedAt) return 'sms';
  if (user.email) return 'email';
  if (user.phone) return 'sms';
  return null;
}

/**
 * Creates a code token and delivers it. If delivery fails the token is deleted
 * (so the user can retry immediately) and the 503 error is re-thrown.
 */
export async function sendContactCode(user: CodeUser, purpose: CodePurpose, channel: Channel, to?: string) {
  const destination = to ?? (channel === 'email' ? user.email : user.phone);
  if (!destination) throw badRequest(channel === 'email' ? 'This account has no email address' : 'This account has no phone number');

  // Earlier codes stay valid until this one is actually delivered
  const { token, code } = await issueToken(user.id, TOKEN_TYPE[purpose], { withCode: true, channel, keepOthers: true });
  try {
    if (channel === 'email') {
      if (purpose === 'phone') throw badRequest('Phone codes are sent by SMS');
      const message = purpose === 'signup' ? signupCodeMessage : resetCodeMessage;
      await sendEmail(message(destination, user.name, code!));
    } else {
      await sendSms(destination, SMS_TEXT[purpose](code!));
    }
  } catch (err) {
    await prisma.authToken.deleteMany({ where: { tokenHash: sha256(token) } });
    throw err;
  }
  await retireOthers(user.id, TOKEN_TYPE[purpose], token);
  return { token, channel, hint: hintFor(channel, destination) };
}

/** Sends the username to the given email or phone (used by "Forgot username") */
export async function sendUsernameReminder(user: CodeUser & { username: string }, channel: Channel) {
  if (channel === 'email' && user.email) {
    await sendEmail(usernameReminderMessage(user.email, user.name, user.username));
  } else if (channel === 'sms' && user.phone) {
    await sendSms(user.phone, `Budget Manager: your username is ${user.username}`);
  }
}
