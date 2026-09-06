// Phase 4 — background polling job.
//
// A BullMQ repeatable job polls the cricket API every 30–60s, diffs the result
// against the last snapshot in Redis, and — only when something meaningful
// changed — writes the new snapshot and emits `matchUpdated` on the shared
// `notifier` (Phase 7 consumes it). The job is designed to be boring: a flaky
// upstream is retried with backoff and logged (never crashes the process), and
// an overlapping / retried / second-instance run can never double-emit.
//
// Public surface:
//   startPolling()  — called from src/server.js after fastify.listen; builds the
//                     Queue + Worker + QueueEvents and upserts the scheduler.
//   stopPolling()   — teardown, idempotent, safe if polling never started.
//   runPollOnce()   — the pure-ish job body (fetch → diff → maybe update+emit).
//                     Free of BullMQ types so tests drive it directly.
//
// ── Idempotency / overlap safety ──────────────────────────────────────────────
//   1. Worker `concurrency: 1` — two poll bodies never run in one process.
//   2. `poll:lock` (`SET NX PX`, token-checked Lua release) guards the critical
//      section across processes / a stuck-then-resumed job. Lock contention logs
//      `poll skipped (locked)` and returns success — it is not an error.
//   3. The diff is computed against the *stored snapshot*, so re-running the same
//      poll data after a partial success yields `0 changed` — a harmless no-op.
//   4. One scheduler with a stable id (`poll-scores`) — restarting the app
//      re-uses it instead of stacking a new repeatable each boot.
//   5. Snapshot is written *before* the emit: a missed emit self-heals on the
//      next poll; a double emit does not, so we bias toward the recoverable side.
//
// TODO (later issues, deliberately not built here):
//   - Multi-process / horizontal scaling of the worker.
//   - Bull Board (or similar) dashboard for the queue.
//   - Circuit breaker on the cricket provider (Phase 3 left this as a TODO too).

import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue, Worker, QueueEvents, UnrecoverableError } from 'bullmq';

import { redisClient, cacheSet, cacheTtlSeconds, CACHE_KEYS } from '../cache/redisClient.js';
import { notifier } from '../events/notifier.js';
import { getLiveMatches } from '../lib/cricketApiClient.js';
import { sleep } from '../lib/retry.js';
import { ApiParseError } from '../errors.js';
import { logger } from '../utils/logger.js';

// One name for the queue, the scheduler, and the job — a stable id is what makes
// `upsertJobScheduler` dedupe on restart instead of stacking.
const QUEUE_NAME = 'poll-scores';
const SCHEDULER_ID = 'poll-scores';
const JOB_NAME = 'poll-scores';

const SNAPSHOT_SUFFIX = 'snapshot';
const LOCK_SUFFIX = 'lock';

// Release the lock only if we still own it. A blind DEL could drop a lock a
// different run acquired after ours expired.
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Fields that count as a "meaningful" change on a match already present in both
// snapshots. `wickets` is derived from the `score` map (see diffMatch).
const COMPARED_FIELDS = ['status', 'overs', 'score', 'wickets'];

const WORKER_CLOSE_TIMEOUT_MS = 10_000;

// ── Module state (single worker per process) ─────────────────────────────────
let queue;
let worker;
let queueEvents;
let bullConnections = [];
let started = false;
let pollCount = 0;

const nowIso = () => new Date().toISOString();

// Read env at call time (mirrors readConfig() in cricketApiClient.js) so tests
// can vi.stubEnv between cases and so a reload picks up changes.
function readPollConfig() {
  return {
    enabled: (process.env.POLL_ENABLED ?? 'true') !== 'false',
    // POLL_INTERVAL_MS default 45s, clamped to the 30–60s the issue allows.
    intervalMs: Math.min(60_000, Math.max(30_000, Number(process.env.POLL_INTERVAL_MS) || 45_000)),
    lockTtlMs: Number(process.env.POLL_LOCK_TTL_MS) || 30_000,
  };
}

// A dedicated ioredis connection for BullMQ — it requires `maxRetriesPerRequest:
// null`, which the shared `redisClient` is not built with. Each of Queue /
// Worker / QueueEvents gets its own so teardown can close them independently.
function makeBullConnection() {
  const conn = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  conn.on('error', (err) => logger.error(`BullMQ Redis error: ${err.message}`));
  bullConnections.push(conn);
  return conn;
}

// ── Diffing ─────────────────────────────────────────────────────────────────

// Wickets aren't a top-level field on a normalized match — they live inside the
// `score` map as the "runs/wkts" string per team (src/lib/cricketSchemas.js).
// Pull them out so a wicket falling is reported as its own `fields` entry.
function wicketsOf(match) {
  const score = match?.score;
  if (!score || typeof score !== 'object') return {};
  const out = {};
  for (const [team, val] of Object.entries(score)) {
    out[team] = Number(String(val).split('/')[1]) || 0;
  }
  return out;
}

// Sibling of wicketsOf: the runs half of each team's "runs/wkts" score string.
function runsOf(match) {
  const score = match?.score;
  if (!score || typeof score !== 'object') return {};
  const out = {};
  for (const [team, val] of Object.entries(score)) {
    out[team] = Number(String(val).split('/')[0]) || 0;
  }
  return out;
}

// Order-independent stringify: sort object keys so `{a,b}` and `{b,a}` compare
// equal. Good enough for the small, flat score/wickets maps here.
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function fieldValue(match, field) {
  return field === 'wickets' ? wicketsOf(match) : match?.[field];
}

// Which of COMPARED_FIELDS differ between two versions of the same match id.
function changedFields(before, after) {
  return COMPARED_FIELDS.filter((f) => stable(fieldValue(before, f)) !== stable(fieldValue(after, f)));
}

/**
 * Diff two normalized `Match[]` snapshots, keyed by `id` (so array order is
 * irrelevant). Returns a `changes[]` of `{ id, type, before, after, fields }`
 * where `type` is `'added' | 'removed' | 'changed'` and `fields` names the
 * meaningful fields that moved (empty for added/removed).
 */
export function diffMatches(before = [], after = []) {
  const prev = new Map(before.filter((m) => m?.id != null).map((m) => [String(m.id), m]));
  const next = new Map(after.filter((m) => m?.id != null).map((m) => [String(m.id), m]));
  const changes = [];

  for (const [id, m] of next) {
    if (!prev.has(id)) {
      changes.push({ id, type: 'added', before: null, after: m, fields: [] });
      continue;
    }
    const fields = changedFields(prev.get(id), m);
    if (fields.length > 0) {
      changes.push({ id, type: 'changed', before: prev.get(id), after: m, fields });
    }
  }

  for (const [id, m] of prev) {
    if (!next.has(id)) {
      changes.push({ id, type: 'removed', before: m, after: null, fields: [] });
    }
  }

  return changes;
}

// ── Semantic events (Phase 7) ───────────────────────────────────────────────

/**
 * Turn a raw `changes[]` (from diffMatches) into semantic events the
 * notification handlers react to. Pure — no side effects, exported only so the
 * unit tests can drive it directly.
 *
 * Limitation: the normalized match shape (src/lib/cricketSchemas.js) has no
 * per-batter data, so `wicketFallen` cannot name the dismissed player
 * (Notification.playerId stays null) and `milestoneReached` is a team-total
 * runs figure at 50-run steps, not an individual fifty/century.
 *
 * @param {{ polledAt: string, changes: object[] }} input
 * @returns {{ name: string, payload: object }[]}
 */
export function deriveMatchEvents({ polledAt, changes }) {
  const events = [];
  for (const c of changes ?? []) {
    // matchStarted: status moved into 'live' (or a brand-new match already live).
    if (
      (c.type === 'changed' && c.fields.includes('status') && c.after?.status === 'live') ||
      (c.type === 'added' && c.after?.status === 'live')
    ) {
      events.push({
        name: 'matchStarted',
        payload: { matchId: c.id, teams: c.after.teams, polledAt },
      });
    }
    if (c.type !== 'changed') continue;

    // wicketFallen: a team's wicket count increased (wickets is derived from the
    // score map — see wicketsOf).
    if (c.fields.includes('wickets')) {
      const before = wicketsOf(c.before);
      const after = wicketsOf(c.after);
      for (const [team, w] of Object.entries(after)) {
        if (w > (before[team] ?? 0)) {
          events.push({
            name: 'wicketFallen',
            payload: { matchId: c.id, teamName: team, wickets: w, delta: w - (before[team] ?? 0), polledAt },
          });
        }
      }
    }

    // milestoneReached: a team's run total crossed a multiple of 50.
    if (c.fields.includes('score')) {
      const prev = runsOf(c.before);
      for (const [team, runs] of Object.entries(runsOf(c.after))) {
        const prevRuns = prev[team] ?? 0;
        const crossed = Math.floor(runs / 50) * 50;
        if (crossed >= 50 && Math.floor(prevRuns / 50) < Math.floor(runs / 50)) {
          events.push({
            name: 'milestoneReached',
            payload: { matchId: c.id, teamName: team, runs, milestone: crossed, polledAt },
          });
        }
      }
    }
  }
  return events;
}

// ── The job body ────────────────────────────────────────────────────────────

/**
 * One poll: acquire the lock, fetch, diff against `poll:snapshot`, and on a real
 * change write the snapshot then emit `matchUpdated`. Exported so tests can call
 * it without a running Worker.
 *
 * @param {object}  [opts]
 * @param {import('ioredis').Redis} [opts.redis]     snapshot/lock client (default: shared redisClient)
 * @param {string}  [opts.keyPrefix='poll:']         namespace for the snapshot + lock keys
 * @param {number}  [opts.lockTtlMs]                 lock TTL (default: POLL_LOCK_TTL_MS)
 * @param {number}  [opts.pollNumber]               override the poll counter (log lines only)
 * @returns {Promise<{skipped?:true, firstRun?:true, changes:object[]}>}
 */
export async function runPollOnce({
  redis = redisClient,
  keyPrefix = 'poll:',
  lockTtlMs = readPollConfig().lockTtlMs,
  pollNumber,
} = {}) {
  const n = pollNumber ?? (pollCount += 1);
  const snapshotKey = `${keyPrefix}${SNAPSHOT_SUFFIX}`;
  const lockKey = `${keyPrefix}${LOCK_SUFFIX}`;
  const token = randomUUID();

  // Phase 5: the job is the ONLY writer of the `match:*` read cache. Written
  // after the snapshot and before the emit (snapshot → cache → emit). Never
  // throws — a Redis write blip must not fail the poll or skip the emit.
  const warmCache = async (list) => {
    try {
      const ttl = cacheTtlSeconds();
      await cacheSet(CACHE_KEYS.liveList, list, ttl);
      for (const mm of list) await cacheSet(CACHE_KEYS.detail(mm.id), mm, ttl);
      logger.debug(`poll #${n}: cache write: 1 list + ${list.length} detail keys (ttl ${ttl}s)`);
    } catch (err) {
      logger.warn(`poll #${n}: cache write failed (swallowed): ${err.message}`);
    }
  };

  const locked = await redis.set(lockKey, token, 'PX', lockTtlMs, 'NX');
  if (locked !== 'OK') {
    logger.info(`poll #${n}: skipped (locked)`);
    return { skipped: true, changes: [] };
  }

  try {
    // Client errors (ApiUnavailableError / ApiRateLimitError / ApiParseError)
    // propagate — BullMQ decides whether to retry (see the worker processor).
    const matches = await getLiveMatches();
    const raw = await redis.get(snapshotKey);

    // First ever run: seed the snapshot and emit nothing (documented choice).
    // The cache is still warmed — a fresh deploy has a usable cache after one
    // poll cycle, not only after the first *change*.
    if (!raw) {
      await redis.set(snapshotKey, JSON.stringify({ polledAt: nowIso(), matches }));
      await warmCache(matches);
      logger.info(`poll #${n}: ${matches.length} matches, first run (snapshot seeded)`);
      return { firstRun: true, changes: [] };
    }

    const prev = JSON.parse(raw).matches ?? [];
    const changes = diffMatches(prev, matches);

    if (changes.length === 0) {
      // Nothing to emit, but keep the cache warm so its TTL only bites when the
      // job is actually down/stalled — not during a quiet spell in the match.
      await warmCache(matches);
      logger.debug(`poll #${n}: ${matches.length} matches, 0 changed`);
      return { changes: [] };
    }

    const polledAt = nowIso();
    await redis.set(snapshotKey, JSON.stringify({ polledAt, matches }));
    await warmCache(matches);
    notifier.emit('matchUpdated', { polledAt, matches, changes });
    // Fan the same diff out as semantic events. `emit` is synchronous — the
    // handlers start their own async work and settle on their own; nothing to
    // await here. Idempotency is inherited: a retried/overlapping poll yields
    // `0 changed` above and this loop runs zero times.
    for (const e of deriveMatchEvents({ polledAt, changes })) notifier.emit(e.name, e.payload);
    logger.info(`poll #${n}: ${matches.length} matches, ${changes.length} changed`);
    return { changes };
  } finally {
    // Token-checked release; swallow errors so a Redis blip here can't mask the
    // real outcome (the lock will expire on its own anyway).
    await redis.eval(RELEASE_LUA, 1, lockKey, token).catch(() => {});
  }
}

// The BullMQ processor is a thin wrapper: it owns the retry policy that
// runPollOnce deliberately knows nothing about. A malformed upstream body
// (ApiParseError) fails identically on every attempt, so we short-circuit the
// remaining retries with UnrecoverableError instead of burning all 3.
export async function pollProcessor() {
  try {
    return await runPollOnce();
  } catch (err) {
    if (err instanceof ApiParseError) {
      logger.error(`poll job parse error, not retrying: ${err.name}: ${err.message}`);
      throw new UnrecoverableError(`${err.name}: ${err.message}`);
    }
    throw err; // transient → let BullMQ retry with backoff
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function startPolling() {
  if (started) return;

  const { enabled, intervalMs } = readPollConfig();
  if (!enabled) {
    logger.info('polling disabled');
    return;
  }

  // The cache TTL is a safety net for a stalled job; it must comfortably outlast
  // one poll interval or a single slow poll would let the cache expire.
  if (cacheTtlSeconds() * 1000 <= intervalMs) {
    logger.warn(
      `CACHE_TTL_SECONDS (${cacheTtlSeconds()}s) is not safely larger than POLL_INTERVAL_MS (${intervalMs}ms) — cache may expire between polls`,
    );
  }

  queue = new Queue(QUEUE_NAME, { connection: makeBullConnection() });
  queue.on('error', (err) => logger.error(`poll queue error: ${err.message}`));

  worker = new Worker(QUEUE_NAME, pollProcessor, {
    connection: makeBullConnection(),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    logger.error(
      `poll job failed after ${job?.attemptsMade ?? '?'} attempts: ${err?.name}: ${err?.message}`,
    );
  });
  worker.on('error', (err) => logger.error(`poll worker error: ${err.message}`));

  queueEvents = new QueueEvents(QUEUE_NAME, { connection: makeBullConnection() });
  queueEvents.on('error', (err) => logger.error(`poll queueEvents error: ${err.message}`));

  // One scheduler, stable id, deterministic interval. `override: true` (BullMQ's
  // default for upsert) means a re-run just updates the existing entry.
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { every: intervalMs },
    {
      name: JOB_NAME,
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      },
    },
  );

  // Surface "Redis unreachable" as a rejection here so server.js exits non-zero.
  await queue.waitUntilReady();
  await worker.waitUntilReady();

  started = true;
  logger.info(`polling started (every ${intervalMs}ms)`);
}

export async function stopPolling() {
  if (!started && !queue && !worker && bullConnections.length === 0) return;

  try {
    if (worker) {
      // worker.close() drains the active job; a hard timeout stops a wedged job
      // from blocking shutdown forever.
      let closed = false;
      await Promise.race([
        worker.close().then(() => {
          closed = true;
        }),
        sleep(WORKER_CLOSE_TIMEOUT_MS),
      ]);
      if (!closed) await worker.close(true).catch(() => {});
    }
    if (queueEvents) await queueEvents.close().catch(() => {});
    if (queue) await queue.close().catch(() => {});
    for (const conn of bullConnections) {
      await conn.quit().catch(() => {});
    }
  } finally {
    queue = undefined;
    worker = undefined;
    queueEvents = undefined;
    bullConnections = [];
    started = false;
    pollCount = 0;
  }
}

// Test-only: reset the poll counter between cases (mirrors __resetClientState()).
export function __resetPollState() {
  pollCount = 0;
}
