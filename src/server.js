import 'dotenv/config';
import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import authenticatePlugin from './plugins/authenticate.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authRoutes from './routes/auth.js';
import matchesRoutes from './routes/matches.js';
import followsRoutes from './routes/follows.js';
import { startPolling, stopPolling } from './jobs/pollScores.js';

const fastify = Fastify({ logger: false }); // using our own logger.js instead of pino's default

// Called directly (not via fastify.register) so the `authenticate` decorator
// and the error handler land on the root instance instead of being scoped to
// a child encapsulation context — otherwise sibling plugins like authRoutes
// can't see them. Must be registered before the routes below so every route
// throw (Zod, Prisma, NotFoundError, ...) is caught centrally.
await authenticatePlugin(fastify);
await errorHandlerPlugin(fastify);
await fastify.register(authRoutes);
await fastify.register(matchesRoutes, { prefix: '/matches' });
await fastify.register(followsRoutes, { prefix: '/follows' });

const port = Number(process.env.PORT) || 3000;

async function start() {
  try {
    await prisma.$connect();
    logger.info('Connected to Postgres via Prisma');
  } catch (err) {
    logger.error(`Failed to connect to Postgres: ${err.message}`);
    process.exit(1);
  }

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${port}`);
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }

  // A score app that can't poll isn't "up" — treat a queue that can't reach
  // Redis the same as a failed Postgres connect (same pattern as above).
  try {
    await startPolling();
  } catch (err) {
    logger.error(`Failed to start polling job: ${err.message}`);
    process.exit(1);
  }
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await fastify.close();
    // Stop polling before Prisma disconnects so no in-flight poll writes a
    // half-baked snapshot or hits a closed connection.
    await stopPolling();
    await prisma.$disconnect();
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
