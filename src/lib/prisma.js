import { PrismaClient } from '@prisma/client';

// Singleton — import this everywhere instead of `new PrismaClient()` per file,
// to avoid exhausting Postgres' connection pool (especially under `node --watch`
// hot reloads during dev).
export const prisma = new PrismaClient();
