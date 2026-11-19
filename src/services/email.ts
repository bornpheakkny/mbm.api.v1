/**
 * Sends transactional email through Resend's HTTP API (works on Render's free plan,
 * which may block SMTP ports). Without RESEND_API_KEY the email is printed to the console.
 */
import { env } from '../config/env';
import { HttpError } from '../lib/http';

interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Shown to users when an email they are waiting for could not be sent */
export const EMAIL_FAILED_MESSAGE = "We couldn't send the email right now. Please try again in a few minutes.";

const printToConsole = (email: Email, why: string) =>
  console.log(`\n📧 [email not sent — ${why}]\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);

/**
 * Sends an email, or throws HttpError 503 (EMAIL_FAILED_MESSAGE) if the provider refuses it.
 * In development a refused email is also printed to the console so its link/code can still be used.
 */
/** "Budget Manager <me@gmail.com>" → { name, email } */
function parseFrom(from: string) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'Budget Manager', email: m[2] } : { name: 'Budget Manager', email: from.trim() };
}

/** Which provider sends email: Brevo if configured, else Resend, else none (console) */
export const emailProvider = (): 'brevo' | 'resend' | null =>
  env.BREVO_API_KEY ? 'brevo' : env.RESEND_API_KEY ? 'resend' : null;

function providerRequest(provider: 'brevo' | 'resend', email: Email) {
  if (provider === 'brevo') {
    return fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY!, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: parseFrom(env.EMAIL_FROM),
        to: [{ email: email.to }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      }),
    });
  }
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
  });
}

export async function sendEmail(email: Email) {
  const provider = emailProvider();
  if (!provider) return printToConsole(email, 'no email provider configured (BREVO_API_KEY / RESEND_API_KEY)');
  const label = provider === 'brevo' ? 'Brevo' : 'Resend';

  let res: Response;
  try {
    res = await providerRequest(provider, email);
  } catch (err) {
    console.error(`❌ Email to ${email.to} failed: could not reach ${label}`, err);
    if (env.NODE_ENV !== 'production') printToConsole(email, `${label} unreachable`);
    throw new HttpError(503, EMAIL_FAILED_MESSAGE);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let reason = body;
    try {
      reason = (JSON.parse(body) as { message?: string }).message ?? body;
    } catch {
      // not JSON — keep the raw text
    }
    console.error(`❌ Email "${email.subject}" to ${email.to} rejected by ${label} (${res.status}): ${reason}`);
    if (/testing emails|verify a domain/i.test(reason)) {
      console.error('   → The resend.dev test sender only delivers to your Resend account email. Use Brevo or verify a domain.');
    }
    if (provider === 'brevo' && /sender/i.test(reason)) {
      console.error('   → EMAIL_FROM must be a sender you verified in Brevo (Senders, domains & dedicated IPs → Senders).');
    }
    if (env.NODE_ENV !== 'production') printToConsole(email, `${label} refused it (${res.status})`);
    throw new HttpError(503, EMAIL_FAILED_MESSAGE);
  }
  if (env.NODE_ENV !== 'production') console.log(`📧 Sent "${email.subject}" to ${email.to} via ${label}`);
}

/** Send without failing the request (the user isn't waiting on it); failures are logged */
export function sendEmailInBackground(email: Email) {
  sendEmail(email).catch(() => undefined); // sendEmail already logged the reason
}

// ---------- Templates ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
<div style="font-weight:700;color:#0f766e;margin-bottom:16px">Budget Manager</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${body}
</div></body></html>`;
}

const button = (url: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(label)}</a></p>
<p style="font-size:13px;color:#64748b">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(url)}</span></p>`;

const codeBox = (code: string) =>
  `<p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:20px 0;font-family:Consolas,monospace">${code}</p>`;

const footer = (why: string) => `<p style="font-size:13px;color:#64748b;margin-top:24px">${esc(why)}</p>`;

export function verifyEmailMessage(to: string, name: string, token: string): Email {
  const url = `${env.APP_URL}/verify-email?token=${token}`;
  return {
    to,
    subject: 'Verify your email address',
    text: `Hi ${name},\n\nConfirm this is your email so you can recover your account if you forget your password:\n${url}\n\nThe link expires in 24 hours.`,
    html: layout(
      'Verify your email',
      `<p>Hi ${esc(name)},</p><p>Confirm this is your email so you can recover your account if you forget your password.</p>${button(url, 'Verify email')}${footer('The link expires in 24 hours. If you did not create an account, ignore this email.')}`,
    ),
  };
}

export function confirmEmailChangeMessage(to: string, name: string, token: string): Email {
  const url = `${env.APP_URL}/verify-email?token=${token}`;
  return {
    to,
    subject: 'Confirm your new email address',
    text: `Hi ${name},

Confirm ${to} as the new email for your Budget Manager account:
${url}

The link expires in 24 hours. Until you confirm, your account keeps its current email.`,
    html: layout(
      'Confirm your new email',
      `<p>Hi ${esc(name)},</p><p>Confirm <strong>${esc(to)}</strong> as the new email for your account.</p>${button(url, 'Confirm new email')}${footer('The link expires in 24 hours. Until you confirm, your account keeps its current email. If you did not ask for this, ignore this email.')}`,
    ),
  };
}

export function emailChangedNotice(to: string, name: string, newEmail: string): Email {
  return {
    to,
    subject: 'Your account email was changed',
    text: `Hi ${name},

The email for your Budget Manager account was changed to ${newEmail}. You won't receive account emails at this address any more.

If you didn't do this, contact your administrator right away.`,
    html: layout(
      'Your account email was changed',
      `<p>Hi ${esc(name)},</p><p>The email for your account was changed to <strong>${esc(newEmail)}</strong>. You won't receive account emails at this address any more.</p>${footer("If you didn't do this, contact your administrator right away.")}`,
    ),
  };
}

export function resetPasswordMessage(to: string, name: string, token: string): Email {
  const url = `${env.APP_URL}/reset-password?token=${token}`;
  return {
    to,
    subject: 'Reset your password',
    text: `Hi ${name},\n\nUse this link to choose a new password:\n${url}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email — your password stays the same.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${esc(name)},</p><p>Someone (hopefully you) asked to reset your password.</p>${button(url, 'Choose a new password')}${footer('The link expires in 1 hour. If you did not ask for this, ignore this email — your password stays the same.')}`,
    ),
  };
}

export function mfaCodeMessage(to: string, name: string, code: string, purpose: 'login' | 'setup'): Email {
  const intro =
    purpose === 'login' ? 'Here is your sign-in code:' : 'Enter this code to turn on two-step verification by email:';
  return {
    to,
    subject: purpose === 'login' ? `Your sign-in code: ${code}` : `Your verification code: ${code}`,
    text: `Hi ${name},\n\n${intro} ${code}\n\nIt expires in 10 minutes. If this wasn't you, change your password.`,
    html: layout(
      purpose === 'login' ? 'Your sign-in code' : 'Your verification code',
      `<p>Hi ${esc(name)},</p><p>${esc(intro)}</p>${codeBox(code)}${footer("It expires in 10 minutes. If this wasn't you, change your password.")}`,
    ),
  };
}

/** 6-digit code to finish signing up, or to confirm the account before the first sign-in */
export function signupCodeMessage(to: string, name: string, code: string): Email {
  return {
    to,
    subject: `Your verification code: ${code}`,
    text: `Hi ${name},\n\nYour Budget Manager verification code is ${code}\n\nIt expires in 30 minutes. If you did not create an account, ignore this email.`,
    html: layout(
      'Confirm your account',
      `<p>Hi ${esc(name)},</p><p>Enter this code to finish creating your account:</p>${codeBox(code)}${footer('It expires in 30 minutes. If you did not create an account, ignore this email.')}`,
    ),
  };
}

/** 6-digit code to choose a new password */
export function resetCodeMessage(to: string, name: string, code: string): Email {
  return {
    to,
    subject: `Your password reset code: ${code}`,
    text: `Hi ${name},\n\nYour password reset code is ${code}\n\nIt expires in 30 minutes. If you did not ask for this, ignore this email; your password stays the same.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${esc(name)},</p><p>Enter this code to choose a new password:</p>${codeBox(code)}${footer('It expires in 30 minutes. If you did not ask for this, ignore this email; your password stays the same.')}`,
    ),
  };
}

/** Reminds the user of their username */
export function usernameReminderMessage(to: string, name: string, username: string): Email {
  return {
    to,
    subject: 'Your Budget Manager username',
    text: `Hi ${name},\n\nYour username is: ${username}\n\nYou can log in with it, or with this email address.`,
    html: layout(
      'Your username',
      `<p>Hi ${esc(name)},</p><p>Your username is:</p>${codeBox(esc(username))}${footer('You can log in with it, or with this email address. If you did not ask for this, you can ignore this email.')}`,
    ),
  };
}
