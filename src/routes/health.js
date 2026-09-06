import { prisma } from '../lib/prisma.js';
import { isRedisReady } from '../cache/redisClient.js';
import { isPollingStarted } from '../jobs/pollScores.js';

// Liveness vs readiness, kept deliberately separate:
//
//   GET /health  — "is the process up?" Always 200. Cheap. This is what a
//                  process supervisor / container `restart` policy watches.
//   GET /ready   — "can it actually serve?" Probes each dependency.
//
// Status rule for /ready:
//   postgres down            → 503  (nothing works without it)
//   redis down, postgres up  → 200  "degraded" — reads fall back to the API
//   poller down, postgres up → 200  "degraded" — may be POLL_ENABLED=false
//
// Both routes are unauthenticated and are allow-listed from the rate limiter
// (see server.js) so a monitor hitting them once a second is never throttled.
export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.get('/ready', async (_request, reply) => {
    const checks = { postgres: 'down', redis: 'down', poller: 'down' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'up';
    } catch {
      // left as 'down'
    }

    checks.redis = isRedisReady() ? 'up' : 'down';
    checks.poller = isPollingStarted() ? 'up' : 'down';

    const allUp = Object.values(checks).every((v) => v === 'up');
    const status = checks.postgres === 'down' ? 'unavailable' : allUp ? 'ok' : 'degraded';
    const code = checks.postgres === 'up' ? 200 : 503;

    return reply.code(code).send({ status, checks });
  });
}
