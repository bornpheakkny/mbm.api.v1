/**
 * Sends SMS through Twilio's REST API (HTTPS — works on Render's free plan).
 * Without Twilio settings: printed to the console in development, refused (503) in production.
 */
import { env } from '../config/env';
import { HttpError } from '../lib/http';

export const SMS_FAILED_MESSAGE = "We couldn't send the text message right now. Please try again in a few minutes.";

export const smsConfigured = () => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

export async function sendSms(to: string, body: string) {
  if (!smsConfigured()) {
    if (env.NODE_ENV === 'production') {
      console.error(`❌ SMS to ${to} not sent: Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM)`);
      throw new HttpError(503, 'Text messages are not available right now. Please use email instead.');
    }
    console.log(`\n📱 [SMS not sent — Twilio is not configured]\nTo: ${to}\n\n${body}\n`);
    return;
  }

  const from = env.TWILIO_FROM!;
  const form = new URLSearchParams({ To: to, Body: body, ...(from.startsWith('MG') ? { MessagingServiceSid: from } : { From: from }) });
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  } catch (err) {
    console.error(`❌ SMS to ${to} failed: could not reach Twilio`, err);
    throw new HttpError(503, SMS_FAILED_MESSAGE);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let reason = detail;
    try {
      reason = (JSON.parse(detail) as { message?: string }).message ?? detail;
    } catch {
      // keep raw text
    }
    console.error(`❌ SMS to ${to} rejected by Twilio (${res.status}): ${reason}`);
    if (/unverified/i.test(reason)) {
      console.error('   → Twilio trial accounts can only text numbers verified in the Twilio console.');
    }
    if (env.NODE_ENV !== 'production') console.log(`\n📱 [SMS not sent — Twilio refused it]\nTo: ${to}\n\n${body}\n`);
    throw new HttpError(503, SMS_FAILED_MESSAGE);
  }
  if (env.NODE_ENV !== 'production') console.log(`📱 Sent SMS to ${to}`);
}
