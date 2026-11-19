import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { requireAdmin, requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import budgetRoutes from './routes/budgets';
import transactionRoutes from './routes/transactions';
import summaryRoutes from './routes/summary';
import adminRoutes from './routes/admin';
import mfaRoutes from './routes/mfa';

/** CORS_ORIGIN entries may use * as a wildcard, e.g. https://mbm-app-v1-*.vercel.app for Vercel previews */
const originPatterns = env.corsOrigins.map((o) =>
  o === '*' ? /^.*$/ : new RegExp('^' + o.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]*') + '$'),
);
const isAllowedOrigin = (origin: string) => originPatterns.some((re) => re.test(origin));

const warned = new Set<string>();
function warnRejectedOrigin(origin: string) {
  if (warned.has(origin) || warned.size > 50) return;
  warned.add(origin);
  console.warn(`CORS: blocked request from ${origin}. Add it to CORS_ORIGIN (comma-separated) if it is your app.`);
}

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind a proxy
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // allow non-browser clients (curl, health checks) and whitelisted origins
        if (!origin || isAllowedOrigin(origin)) return cb(null, true);
        // Refuse without throwing: the browser gets no CORS headers and blocks the call (not a 500)
        warnRejectedOrigin(origin);
        cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.get('/', (_req, res) => res.json({ name: 'mbm.api.v1', status: 'ok' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.use('/api/auth/mfa', requireAuth, mfaRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/categories', requireAuth, categoryRoutes);
  app.use('/api/budgets', requireAuth, budgetRoutes);
  app.use('/api/transactions', requireAuth, transactionRoutes);
  app.use('/api/summary', requireAuth, summaryRoutes);
  app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
