import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import authenticatePlugin from './plugins/authenticate.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import matchesRoutes from './routes/matches.js';
import followsRoutes from './routes/follows.js';
import notificationsRoutes from './routes/notifications.js';
import referenceRoutes from './routes/reference.js';
import { startPolling, stopPolling } from './jobs/pollScores.js';
import { initSocket, closeSocket } from './realtime/socket.js';
import {
  initNotificationHandlers,
  closeNotificationHandlers,
} from './events/notificationHandlers.js';

// Fail loudly at boot if a required secret/URL is missing, rather than as a
// confusing per-request 401/500 much later. Checked before we build anything.
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  logger.error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
  process.exit(1);
}

const fastify = Fastify({ logger: false }); // using our own logger.js instead of pino's default

// Browser CORS for the React client (client/). Registered before every route so
// the preflight (OPTIONS) is answered for all of them. CORS_ORIGIN is a
// comma-separated allow-list; defaults to the Vite dev server origin. The
// Socket.io server has its own CORS knob (SOCKET_CORS_ORIGIN).
await fastify.register(import('@fastify/cors'), {
  origin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  credentials: true,
});

// Our own API rate limit (Phase 10). Registered before any route so it wraps
// all of them. Keyed by user id once authenticated, else by IP. /health and
// /ready are allow-listed so monitors are never throttled. A throttled request
// returns the app's standard error envelope, not rate-limit's default shape.
await fastify.register(import('@fastify/rate-limit'), {
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
  keyGenerator: (req) => req.user?.id ?? req.ip,
  allowList: (req) => req.url === '/health' || req.url === '/ready',
  errorResponseBuilder: (_req, context) => ({
    error: {
      message: `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)}s`,
      code: 'RATE_LIMITED',
    },
  }),
});

// Called directly (not via fastify.register) so the `authenticate` decorator
// and the error handler land on the root instance instead of being scoped to
// a child encapsulation context — otherwise sibling plugins like authRoutes
// can't see them. Must be registered before the routes below so every route
// throw (Zod, Prisma, NotFoundError, ...) is caught centrally.
await authenticatePlugin(fastify);
await errorHandlerPlugin(fastify);
await fastify.register(healthRoutes);
await fastify.register(authRoutes);
await fastify.register(matchesRoutes, { prefix: '/matches' });
await fastify.register(followsRoutes, { prefix: '/follows' });
await fastify.register(notificationsRoutes, { prefix: '/notifications' });
// Read-only reference lists (seeded teams / players) so the client can offer a
// "browse and follow" view — the follow endpoints need a Team/Player UUID that
// isn't otherwise discoverable. No prefix: paths are /teams and /players.
await fastify.register(referenceRoutes);

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
