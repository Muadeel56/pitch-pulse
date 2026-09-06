import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

// Thin working client — docker-compose brings up Redis so this connects for
// real. The typed JSON helpers below are Phase 5's read cache; the background
// poll job is the ONLY writer of the `match:*` keys (see src/jobs/pollScores.js).
//
// Phase 8 resilience: a Redis outage must never 500 a request. The options
// below make commands fail fast instead of queueing forever, and the helpers
// swallow connection errors (an outage is treated as a cache miss — the routes
// then fall back to the cricket API directly). ioredis still auto-reconnects
// in the background, so reads go fast again once Redis returns.
export const redisClient = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1, // don't pile up commands while Redis is unreachable
  // Reject a command outright when the socket is down rather than buffering it
  // forever — the cache helpers below turn that into a clean miss. Left ON
  // under vitest so a suite's first command doesn't lose the race with the
  // initial connect (tests still require a live Redis).
  enableOfflineQueue: process.env.NODE_ENV === 'test',
  retryStrategy: (times) => Math.min(times * 200, 5000), // reconnect w/ backoff, cap 5s
});

// Tracks whether Redis is currently usable, for /ready and for logging the
// lost/reconnected transitions exactly once per edge (ioredis fires `error`
// on every failed reconnect attempt — we don't want that in the log every 5s).
let redisReady = false;
let everConnected = false;

function markDown(reason) {
  if (!redisReady) return;
  redisReady = false;
  logger.warn(`Redis connection lost (${reason}) — routes will fall back to the API`);
}

function markUp() {
  if (redisReady) return;
  redisReady = true;
  // Only the RE-connect is newsworthy; the first connect is logged below.
  if (everConnected) logger.info('Redis reconnected');
  everConnected = true;
}

redisClient.on('ready', markUp);
redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('error', (err) => {
  markDown(err.message);
});
redisClient.on('end', () => markDown('connection ended'));
redisClient.on('close', () => markDown('connection closed'));

/**
 * Whether the cache is currently reachable. Used by GET /ready. A `false` here
 * means reads are being served via the direct-API fallback, not that the app
 * is broken.
 * @returns {boolean}
 */
export function isRedisReady() {
  return redisReady || redisClient.status === 'ready';
}

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
 * GET + JSON.parse. Returns null on a missing key, on a corrupt value, AND on a
 * Redis connection error — a corrupt entry or an outage must both degrade to a
 * cache miss, never 500 a request.
 * @param {string} key
 * @returns {Promise<any | null>}
 */
export async function cacheGet(key) {
  let raw;
  try {
    raw = await redisClient.get(key);
  } catch (err) {
    logger.warn(`cache: Redis GET ${key} failed (${err.message}) — treating as miss`);
    return null;
  }
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
 * be a positive number — throws otherwise (a programming error, not an outage).
 * A Redis connection error is logged and swallowed: a failed cache write is not
 * a failed request.
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 * @returns {Promise<void>}
 */
export async function cacheSet(key, value, ttlSeconds) {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError(`cacheSet(${key}): ttlSeconds must be a positive number, got ${ttlSeconds}`);
  }
  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn(`cache: Redis SET ${key} failed (${err.message}) — write skipped`);
  }
}

/**
 * DEL — used by tests and manual cache-busting. Connection errors swallowed.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function cacheDel(key) {
  try {
    await redisClient.del(key);
  } catch (err) {
    logger.warn(`cache: Redis DEL ${key} failed (${err.message}) — skipped`);
  }
}
