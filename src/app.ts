import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import budgetRoutes from './routes/budgets';
import transactionRoutes from './routes/transactions';
import summaryRoutes from './routes/summary';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind a proxy
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // allow non-browser clients (curl, health checks) and whitelisted origins
        if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.get('/', (_req, res) => res.json({ name: 'mbm.api.v1', status: 'ok' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/categories', requireAuth, categoryRoutes);
  app.use('/api/budgets', requireAuth, budgetRoutes);
  app.use('/api/transactions', requireAuth, transactionRoutes);
  app.use('/api/summary', requireAuth, summaryRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
