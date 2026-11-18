# mbm.api.v1 — Monthly Budget Management API

REST API for the Monthly Budget Management System.
**Stack:** Node.js · Express 5 · TypeScript · Prisma 7 (`@prisma/adapter-pg`) · PostgreSQL (Neon) · JWT auth · Zod · ESLint
**Hosting:** Render (API) + Neon (database)

## Data model

| Model | Purpose |
| --- | --- |
| `User` | Account, password hash (bcrypt), currency |
| `Category` | Income sources and expense categories (`INCOME` / `EXPENSE`), color, archived |
| `Budget` | Budgeted amount per category per month (`month = "YYYY-MM"`) |
| `Transaction` | Actual income / expense entries (date, description, amount, note) |

New users get default categories: Salary, Freelance, Other (income) and Rent, Utilities, Groceries, Transport, Phone & internet, Eating out, Health & insurance, Entertainment, Savings, Other (expenses).

## API

All routes except `/api/auth/register`, `/api/auth/login` and `/api/health` need `Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ name, email, password, currency? }` → `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET / PATCH | `/api/auth/me` | Current user / update `name`, `currency` |
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
cp .env.example .env          # fill DATABASE_URL, DIRECT_URL, JWT_SECRET
npx prisma migrate deploy     # create tables
npm run db:seed               # optional demo user: demo@mbm.app / demo12345
npm run dev                   # http://localhost:4000
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
3. Environment variables: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (long random string), `JWT_EXPIRES_IN=7d`, `NODE_ENV=production`, `CORS_ORIGIN=https://<your-app>.vercel.app` (comma-separate several origins).
4. After the first deploy, optionally seed: Render → Shell → `npm run db:seed`.

> Render's free plan sleeps after ~15 min idle; the first request then takes ~30–60 s. The frontend uses a 30 s timeout and shows a friendly message.
