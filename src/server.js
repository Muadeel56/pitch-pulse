import 'dotenv/config';
import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import authenticatePlugin from './plugins/authenticate.js';
import authRoutes from './routes/auth.js';
import matchesRoutes from './routes/matches.js';
import followsRoutes from './routes/follows.js';

const fastify = Fastify({ logger: false }); // using our own logger.js instead of pino's default

// Called directly (not via fastify.register) so the `authenticate` decorator
// lands on the root instance instead of being scoped to a child encapsulation
// context — otherwise sibling plugins like authRoutes can't see it.
await authenticatePlugin(fastify);
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
}

async function shutdown() {
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
