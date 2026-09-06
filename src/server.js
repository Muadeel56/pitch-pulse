import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import authenticatePlugin from './plugins/authenticate.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authRoutes from './routes/auth.js';
import matchesRoutes from './routes/matches.js';
import followsRoutes from './routes/follows.js';
import notificationsRoutes from './routes/notifications.js';
import { startPolling, stopPolling } from './jobs/pollScores.js';
import { initSocket, closeSocket } from './realtime/socket.js';
import {
  initNotificationHandlers,
  closeNotificationHandlers,
} from './events/notificationHandlers.js';

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
await fastify.register(notificationsRoutes, { prefix: '/notifications' });

// Phase 6 — a single static diagnostic page for the WebSocket push. One file
// doesn't justify pulling in @fastify/static, so it's a one-off route that
// reads and returns the HTML. The Socket.io client itself is served by the
// Socket.io server at /socket.io/socket.io.js once initSocket() has run.
const clientHtmlPath = fileURLToPath(new URL('../public/match-client.html', import.meta.url));
fastify.get('/client', async (_request, reply) => {
  reply.type('text/html').send(await readFile(clientHtmlPath, 'utf8'));
});

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

  // Socket.io attaches to the raw http.Server that fastify.listen() just
  // created, so it must come after listen. Real-time push is a headline feature
  // — a failure here is fatal, same as the Postgres / polling blocks.
  try {
    initSocket(fastify.server);
    logger.info('Socket.io attached');
  } catch (err) {
    logger.error(`Failed to attach Socket.io: ${err.message}`);
    process.exit(1);
  }

  // A score app that can't poll isn't "up" — treat a queue that can't reach
  // Redis the same as a failed Postgres connect (same pattern as above). Socket
  // is up first so the first `matchUpdated` emit has somewhere to go.
  try {
    await startPolling();
  } catch (err) {
    logger.error(`Failed to start polling job: ${err.message}`);
    process.exit(1);
  }

  // Reactive notification listeners on the shared notifier. Attaching them is
  // sync and can only fail on a programming error, but treat that as fatal for
  // consistency with the blocks above.
  try {
    initNotificationHandlers();
    logger.info('Notification handlers attached');
  } catch (err) {
    logger.error(`Failed to attach notification handlers: ${err.message}`);
    process.exit(1);
  }
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await fastify.close();
    // Close Socket.io before the poller: a late `matchUpdated` emit then finds
    // no listener attached rather than emitting into a half-closed `io`.
    await closeSocket();
    // Detach the notification listeners before stopping the poller, so a late
    // `matchUpdated`/semantic emit finds nothing attached.
    closeNotificationHandlers();
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
