import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

// Thin working client — docker-compose brings up Redis so this connects for
// real. The typed JSON helpers below are Phase 5's read cache; the background
// poll job is the ONLY writer of the `match:*` keys (see src/jobs/pollScores.js).
export const redisClient = new Redis(process.env.REDIS_URL);

redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('error', (err) => logger.error(`Redis error: ${err.message}`));

// Cache key strings live in one place so the writer (the job) and the readers
// (the routes) can never drift. Disjoint from the job's private `poll:*` keys.
export const CACHE_KEYS = {
  liveList: 'match:live:list', // the GET /matches/live payload (Match[])
  detail: (id) => `match:detail:${id}`, // one match's GET /matches/:id payload
};

// TTL (seconds) applied to every cached key. Read at call time (mirrors
// readConfig() in cricketApiClient.js) so tests can vi.stubEnv between cases.
// Clamped to a 30s floor — there is no "cache forever" in this app; the TTL is a
// safety net so a stalled poll job can't serve infinitely stale data silently.
export function cacheTtlSeconds() {
  return Math.max(30, Number(process.env.CACHE_TTL_SECONDS) || 120);
}

/**
 * GET + JSON.parse. Returns null on a missing key AND on a corrupt value (a
 * corrupt cache entry must degrade to a miss, never 500 a request).
 * @param {string} key
 * @returns {Promise<any | null>}
 */
export async function cacheGet(key) {
  const raw = await redisClient.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn(`cache: corrupt JSON at ${key}, treating as miss`);
    return null;
  }
}

/**
 * JSON.stringify + SET key val EX ttlSeconds. `ttlSeconds` is required and must
 * be a positive number — throws otherwise.
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 * @returns {Promise<void>}
 */
export async function cacheSet(key, value, ttlSeconds) {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError(`cacheSet(${key}): ttlSeconds must be a positive number, got ${ttlSeconds}`);
  }
  await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * DEL — used by tests and manual cache-busting.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function cacheDel(key) {
  await redisClient.del(key);
}
