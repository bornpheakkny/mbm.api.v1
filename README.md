# mbm.api.v1 — Monthly Budget Management API

REST API for the Monthly Budget Management System.
**Stack:** Node.js · Express 5 · TypeScript · Prisma 7 (`@prisma/adapter-pg`) · PostgreSQL (Neon) · JWT auth · Zod · ESLint
**Hosting:** Render (API) + Neon (database)

## Data model

| Model | Purpose |
| --- | --- |
| `User` | Account, password hash (bcrypt), currency, `role` (`USER` / `ADMIN`), `active`, `lastLoginAt` |
| `Category` | Income sources and expense categories (`INCOME` / `EXPENSE`), color, archived |
| `Budget` | Budgeted amount per category per month (`month = "YYYY-MM"`) |
| `Transaction` | Actual income / expense entries (date, description, amount, note) |

New users get default categories: Salary, Freelance, Other (income) and Rent, Utilities, Groceries, Transport, Phone & internet, Eating out, Health & insurance, Entertainment, Savings, Other (expenses).

## Accounts & roles

- **Sign-up** needs a **username** plus an **email or phone number**. A 6-digit code is sent there (email via Brevo/Resend, SMS via Twilio); **no account is created until the code is entered**: the details wait in `PendingSignup` (`POST /api/auth/register`), and `POST /api/auth/verify` creates the account and signs in. Nothing is stored if the code can't be delivered; unconfirmed sign-ups expire after 30 minutes and are cleaned up automatically. Two people may start a sign-up with the same username; whoever confirms first gets it.
- **Phone / SMS** needs Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`). Until it is set, `GET /api/config` returns `{ "sms": false }` in production and the app hides phone sign-up, phone recovery and adding a phone. `/api/health` shows which email/SMS provider is active.
- **Login** accepts username, email or phone + password. Accounts that never verified get a code at login first.
- **Forgot username**: `POST /api/auth/forgot-username` sends it to the email/phone. **Forgot password**: `POST /api/auth/forgot-password` sends a code; `POST /api/auth/reset-password` sets the new password. Both reply the same whether or not the account exists.
- Users can change their username and add/change/remove a phone number (verified by SMS) in My account.

- Anyone can sign up (`/api/auth/register`). Every account is a `USER` with its **own private budget**: categories, budgets and entries are scoped by `userId`.
- **Root admin**: on startup the API creates the account in `ADMIN_EMAIL` / `ADMIN_PASSWORD` if it doesn't exist (an existing user with that email is promoted). The root admin can't be demoted, disabled or deleted, and only they can reset their own password.
- **Admins** manage accounts (create, edit, change role, enable/disable, reset password, delete). They cannot see other users' budget data.
- Each request re-checks the account, so disabling or deleting a user logs them out immediately.
- **Email verification**: sign-up sends a verification link (24 h). Unverified users can use the app; verifying proves the address for password recovery.
- **Change email / fix a typo**: `POST /api/auth/change-email` sends a link to the new address; the account switches only after it's confirmed, and the old address gets a notice. An admin changing someone's email also requires the new address to be verified.
- **Unverified addresses don't stay taken**: a new sign-up can take over an address whose account is unverified, older than 24 h and has no entries. Unverified accounts with no entries and no login for 30 days are deleted (checked on start and every 12 h). Accounts with entries are never removed — the owner can claim them with "Forgot password".
- **Forgot password**: `/forgot-password` emails a reset link (1 h). Resetting signs out every session and marks the email verified. Two-step verification stays on.
- **Two-step verification (optional, per user)**: authenticator app (TOTP, QR code) or a 6-digit email code, plus 10 one-time backup codes. 5 wrong codes end the login attempt. Admins can reset a user's 2FA.
- **Emails** go through [Resend](https://resend.com) (HTTPS, works on Render's free plan). Without `RESEND_API_KEY` they're printed to the console. The default sender `onboarding@resend.dev` can only deliver to your own Resend account email — verify a domain in Resend and set `EMAIL_FROM` to send to anyone.
- Login, code and email endpoints are rate-limited per IP.

## API

All routes except `/api/auth/register`, `/api/auth/login` and `/api/health` need `Authorization: Bearer <token>`. `/api/admin/*` also needs the `ADMIN` role.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ name, email, password, currency? }` → `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }`, or `{ mfaRequired, method, mfaToken, emailHint }` |
| GET / PATCH | `/api/auth/me` | Current user / update `name`, `currency` |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` → new `token` (other sessions signed out) |
| POST | `/api/auth/login/mfa` | `{ mfaToken, code }` (authenticator, emailed or backup code) → `{ token, user }` |
| POST | `/api/auth/login/mfa/resend` | `{ mfaToken }` email a new sign-in code → new `mfaToken` |
| POST | `/api/auth/verify-email` | `{ token }` from the emailed link |
| POST | `/api/auth/resend-verification` | Send the verification email again |
| POST / DELETE | `/api/auth/change-email` | `{ newEmail, password }` start a change / cancel it |
| POST | `/api/auth/change-email/resend` | Resend the confirmation link to the pending address |
| POST | `/api/auth/forgot-password` | `{ email }` — same reply whether or not the account exists |
| POST | `/api/auth/reset-password` | `{ token, password }` |
| GET | `/api/auth/mfa` | `{ method, recoveryCodesLeft, emailVerified }` |
| POST | `/api/auth/mfa/totp/setup` · `/totp/enable` | QR + key, then `{ code, password }` → backup codes |
| POST | `/api/auth/mfa/email/setup` · `/email/enable` | Email a code, then `{ code, password }` → backup codes |
| POST | `/api/auth/mfa/recovery-codes` · `/disable` | `{ password }` |
| POST | `/api/admin/users/:id/reset-mfa` | Admin: turn a user's 2FA off |
| GET | `/api/admin/users?q=&role=&status=` | Admin: list accounts + `stats { total, admins, disabled }` |
| POST | `/api/admin/users` | Admin: `{ name, email, password, currency?, role? }` |
| PATCH | `/api/admin/users/:id` | Admin: `{ name?, email?, currency?, role?, active? }` |
| POST | `/api/admin/users/:id/reset-password` | Admin: `{ password }` |
| DELETE | `/api/admin/users/:id` | Admin: delete the account and all its data |
| GET | `/api/categories?type=&includeArchived=` | List categories |
| POST | `/api/categories` | `{ name, type, color? }` |
| PATCH | `/api/categories/:id` | `{ name?, color?, sortOrder?, archived? }` |
| DELETE | `/api/categories/:id` | Only when it has no transactions (otherwise archive) |
| GET | `/api/budgets?month=YYYY-MM` | Budgeted amounts for a month |
| PUT | `/api/budgets` | `{ month, items: [{ categoryId, amount }] }` bulk upsert |
| POST | `/api/budgets/copy` | `{ to, from?, overwrite? }` copy a month's plan (default: previous month) |
| GET | `/api/transactions?month=&type=&categoryId=&q=&page=&pageSize=` | List + `total` + `totalAmount` |
| POST | `/api/transactions` | `{ categoryId, date: "YYYY-MM-DD", description, amount, note? }` |
| PUT / DELETE | `/api/transactions/:id` | Update / delete |
| GET | `/api/summary?month=YYYY-MM` | Totals, income & expense tables (budgeted / actual / difference) |
| GET | `/api/summary/trend?end=YYYY-MM&months=6` | Income vs expenses per month |
| GET | `/api/health` | Health check |

## Local development

```bash
npm install
cp .env.example .env          # fill DATABASE_URL, DIRECT_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npx prisma migrate deploy     # create tables
npm run db:seed               # optional demo user: demo@mbm.app / demo12345
npm start                     # dev server with reload, http://localhost:4000 (same as npm run dev)
```

Other scripts: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run db:migrate` (create a new migration after editing `prisma/schema.prisma`), `npm run db:studio`.

> The Prisma client is generated into `src/generated/prisma` (git-ignored). `npm run build` and `npx prisma generate` recreate it.

## Deploy

### 1. Neon (database)
1. Create a project at [console.neon.tech](https://console.neon.tech) (region: AWS Singapore is closest to Phnom Penh), database name `mbm`.
2. **Connect** → copy two connection strings:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (pooling toggle off) → `DIRECT_URL`

### 2. Render (API)
1. Push this repo to GitHub as `mbm.api.v1`.
2. Render → **New → Blueprint** → pick the repo (uses `render.yaml`), or **New → Web Service** with:
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `npm run start:prod` (runs `prisma migrate deploy`, then starts the server)
   - Health check path: `/api/health`
3. Environment variables: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (long random string), `JWT_EXPIRES_IN=7d`, `NODE_ENV=production`, `CORS_ORIGIN=https://<your-app>.vercel.app` (comma-separate several origins; `*` is a wildcard, e.g. `https://<your-app>-*.vercel.app` for preview deployments; blocked origins are logged as `CORS: blocked request from …`), `ADMIN_EMAIL` and `ADMIN_PASSWORD` (root admin, created on first start — change the password after logging in). For email: `APP_URL` (your Vercel URL, used in links), `RESEND_API_KEY`, `EMAIL_FROM`. `MFA_ENCRYPTION_KEY` is generated by the blueprint.
4. After the first deploy, optionally seed: Render → Shell → `npm run db:seed`.

> Render's free plan sleeps after ~15 min idle; the first request then takes ~30–60 s. The frontend uses a 30 s timeout and shows a friendly message.
