import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

// Singleton — import this everywhere instead of `new PrismaClient()` per file,
// to avoid exhausting Postgres' connection pool (especially under `node --watch`
// hot reloads during dev).
//
// `warn`/`error` are surfaced as events and forwarded to our logger so a
// connection blip is visible in normal logs without DEBUG=prisma:* — the
// errorHandler already maps the resulting P1001/init errors to a 503.
export const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('warn', (e) => logger.warn(`prisma: ${e.message}`));
prisma.$on('error', (e) => logger.error(`prisma: ${e.message}`));
