# Issue #4: Background Polling Job (Phase 4 — BullMQ)

**Labels:** `backend`, `jobs`, `redis`
**Milestone:** PitchPulse — Live Data
**Estimated effort:** 1–2 days

## Summary

Stand up a **BullMQ queue + worker backed by Redis** that polls live cricket
matches on a repeating schedule (every 30–60s), diffs each poll against the last
snapshot, and — only when something actually changed — updates the snapshot in
Redis and emits a `matchUpdated` event on the shared `notifier`.

After this issue the app does useful work on its own: start it, watch the logs,
and every 30–60s a line like `poll #12: 6 matches, 2 changed` appears with no
request from anyone. The job must survive a flaky external API (BullMQ retry +
backoff, failures logged not thrown), must not double-emit if a run overlaps or
repeats, and must stop cleanly on `SIGTERM`/`SIGINT`.

This is **Phase 4** from `pitchpulse-project-docs.md`. It builds directly on the
Phase 3 client (`src/lib/cricketApiClient.js`) and the Phase 0 stubs
`src/jobs/pollScores.js`, `src/cache/redisClient.js`, `src/events/notifier.js`.

---

## Background / Context

- **Data comes from `cricketApiClient`.** `getLiveMatches()` returns
  `Match[]` where each match is `{ id, teams, status, score, overs }` (see
  `normalizeMatch` in `src/lib/cricketSchemas.js`). The default provider is the
  evolving mock (no `CRICKET_API_KEY`), which changes scores between calls — so
  the diff will find real changes to report during local dev.
- **Typed client errors already exist** (`ApiUnavailableError`,
  `ApiRateLimitError`, `ApiParseError` in `src/errors.js`). The job treats them
  as non-fatal: log and let BullMQ retry / move on.
- **`notifier`** (`src/events/notifier.js`) is a singleton `EventEmitter`.
  Phase 7 adds the real listeners; this issue only needs to `emit` correctly and
  prove it with a temporary debug listener + a test.
- **`redisClient`** (`src/cache/redisClient.js`) is a live `ioredis` instance.
  Phase 5 owns the general caching strategy; this issue may use Redis directly
  for the poll snapshot + lock, but keep those keys namespaced (`poll:*`) and
  documented so Phase 5 doesn't collide.
- **`server.js`** already has a `shutdown()` wired to `SIGINT`/`SIGTERM` that
  closes Fastify + Prisma. The worker/queue teardown hooks into that same
  function.
- BullMQ is already a dependency. **Check the installed version's API**
  (`node -e "console.log(require('bullmq/package.json').version)"`) before
  writing repeatable-job code — the modern API is `Queue.upsertJobScheduler()`;
  older lines use `queue.add(name, data, { repeat: { every } })`. Use whichever
  the installed version documents; don't mix both.

---

## Scope

### 1. `src/jobs/pollScores.js` — queue + worker setup

Replace the stub. Export at least:

- `startPolling()` — called from `server.js` on startup. Creates the `Queue`,
  the `Worker`, and any `QueueEvents`; registers the repeatable/scheduled job;
  returns a handle (or stores module state) for shutdown.
- `stopPolling()` — closes worker, queue, queueEvents (in that order),
  idempotent, safe to call when polling never started.
- `runPollOnce()` — the pure-ish job body (fetch → diff → maybe update+emit),
  exported separately so tests can call it without a running worker.

Requirements:

- **Separate Redis connections for BullMQ.** BullMQ needs its own `ioredis`
  connection(s) with `maxRetriesPerRequest: null`. Do **not** reuse the shared
  `redisClient` for the `Queue`/`Worker` connection — create a dedicated one
  from `REDIS_URL` (a small helper is fine). The shared `redisClient` is still
  fine for reading/writing the `poll:*` snapshot keys.
- **Worker `concurrency: 1`** — one poll at a time.
- Everything logs through `src/utils/logger.js`. No `console.*`.

### 2. Repeatable job, scheduled on startup

- Interval from `POLL_INTERVAL_MS` env (default `45000`, clamp to 30_000–60_000).
- A **stable job name / scheduler id** (e.g. `"poll-scores"`) so restarting the
  app re-uses the same scheduler instead of stacking a new one each boot. On
  startup, upsert the scheduler (or remove-then-add the repeatable) so there is
  never more than one.
- `POLL_ENABLED` env (default `true`) — when `false`, `startPolling()` logs
  `polling disabled` and returns without creating the worker. Useful for tests
  and for running a second app instance that shouldn't poll.

### 3. Diffing logic — what actually changed?

- Snapshot key: `poll:snapshot` in Redis, holding the last full normalized
  `Match[]` as JSON (plus a `polledAt` timestamp). First run: no snapshot →
  treat **every** match as "new", store snapshot, emit accordingly (or,
  simpler and acceptable: on the very first run just seed the snapshot and emit
  nothing — document whichever you pick).
- Compute a diff keyed by match `id`:
  - `added` — id present now, absent before
  - `removed` — id present before, absent now
  - `changed` — id in both, but a **meaningful field differs**: `score`,
    `overs`, `status`, or team wickets. Ignore fields that churn without
    meaning. Do a stable comparison (e.g. compare a normalized subset, not
    `JSON.stringify` of the whole object with key-order risk).
- Produce a `changes` array of `{ id, type, before, after, fields }` describing
  each change. This payload is what the event carries and what Phase 7 will turn
  into notifications — design it to be useful, not just a boolean.

### 4. On change: update cache + emit

- If `changes.length === 0`: log `poll #N: X matches, 0 changed` at `debug`,
  do **not** write the snapshot (or write only `polledAt`), do **not** emit.
- If there are changes:
  1. Write the new `poll:snapshot`.
  2. `notifier.emit('matchUpdated', { polledAt, matches, changes })`.
  3. Log `poll #N: X matches, Y changed` at `info`.
- **Order matters for idempotency:** decide and document whether you write the
  snapshot before or after emitting, and what happens if the process dies
  between the two. Recommended: write snapshot first, then emit — a missed emit
  is recoverable next poll; a double emit is not.

### 5. Idempotency / overlap safety

Spell this out in a comment block in `pollScores.js`. At minimum:

- **`concurrency: 1`** on the worker prevents two poll bodies running in one
  process.
- **A Redis lock** (`SET poll:lock <token> NX PX <POLL_LOCK_TTL_MS>`, default
  TTL a bit over one poll's worst case, e.g. `30000`) guards the critical
  section so a second app instance / a stuck-then-resumed job can't double-emit.
  Release with a check-token-then-del (Lua or `GET`+`DEL` with token compare);
  never blind `DEL`. If the lock can't be acquired, log `poll skipped (locked)`
  and return success — not an error.
- The diff itself is **idempotent against the stored snapshot**: re-running the
  same poll data against an already-updated snapshot yields `0 changed`, so a
  retry after a partial success is harmless.
- Use a **deterministic job id** for the repeatable job so BullMQ dedupes
  duplicate scheduled entries.

### 6. Failure handling — log, don't crash

- Job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`,
  `removeOnComplete: { count: 50 }`, `removeOnFail: { count: 100 }`.
- Inside `runPollOnce`, let `cricketApiClient` errors propagate to BullMQ so it
  retries. After the final attempt, the `Worker`'s `'failed'` event handler
  logs one clean line (`poll job failed after 3 attempts: <ErrorName>: <msg>`)
  via `logger.error` — the process stays up.
- Add a `Worker` `'error'` handler and an `'error'` handler on the BullMQ Redis
  connection so an infra blip is logged, not an unhandled rejection.
- A malformed body (`ApiParseError`) is **not** worth 3 retries — it'll fail
  identically each time. Either set `attempts: 1` for that class (catch,
  inspect, `throw` a non-retryable) or just accept the 3 quick failures and
  document it. Prefer failing fast.

### 7. Graceful shutdown

- Extend `server.js`'s existing `shutdown()`: call `stopPolling()` **before**
  `prisma.$disconnect()`, so in-flight poll work finishes or is abandoned
  cleanly and no snapshot is left half-written.
- `worker.close()` waits for the active job to finish (BullMQ default) — good.
  Add a hard timeout so a wedged job can't block shutdown forever
  (e.g. `Promise.race([worker.close(), timeout(10_000)])`, then `worker.close(true)`).
- Closing order: worker → queueEvents → queue → dedicated BullMQ Redis
  connection(s). The shared `redisClient` can stay as-is (Phase 5/10 owns its
  lifecycle) or be quit last — pick one and be consistent.
- Verify no `Error: Connection is closed` spam on Ctrl-C.

### 8. Wire into `server.js`

- In `start()`, after `fastify.listen` succeeds, `await startPolling()` inside
  its own try/catch: if the queue can't connect to Redis, log an error and
  **exit non-zero** (same pattern as the Postgres connect block) — a score app
  that can't poll is not "up".
- Keep the import list and registration style consistent with the existing file.

### 9. Config / `.env.example`

Add, with comments:

```
# --- Background polling job (Phase 4) ---
POLL_ENABLED=true
POLL_INTERVAL_MS=45000        # clamped to 30000–60000
POLL_LOCK_TTL_MS=30000
```

### 10. README

Add a "Background polling job" section: what it does, the `poll:snapshot` /
`poll:lock` Redis keys and their shapes, the `matchUpdated` event payload shape,
the retry/backoff config, and how to watch it work (start app, tail logs). Match
the existing README section style.

### 11. Tests — `vitest`

Add `src/jobs/__tests__/pollScores.test.js`. Drive `runPollOnce()` directly with
a stubbed `cricketApiClient` and a fake/real Redis (ioredis-mock or a test key
prefix + flush). Cover:

- **first run** seeds the snapshot; emits per the documented first-run rule.
- **no change**: same data twice → second call emits nothing, snapshot write
  skipped (or only `polledAt`).
- **score change**: `changes` contains one `{ type: 'changed', fields: ['score'] }`
  entry; `matchUpdated` emitted once with that payload.
- **added / removed** matches are detected.
- **idempotent retry**: run the same poll data against an already-updated
  snapshot → `0 changed`, no emit.
- **lock held**: pre-set `poll:lock` → `runPollOnce` returns without emitting,
  logs "skipped".
- **client throws `ApiUnavailableError`**: `runPollOnce` rejects (so BullMQ
  retries); no snapshot write, no emit.
- **`ApiParseError`**: fails fast (no 3 retries) per whatever rule you chose.
- diff comparison is order-insensitive (shuffled match array → `0 changed`).

Keep the suite fast: fake timers for any backoff assertions, no real 45s waits,
don't start an actual `Worker` in unit tests.

---

## Acceptance Criteria

- [ ] `src/jobs/pollScores.js` exports `startPolling()`, `stopPolling()`,
      `runPollOnce()`; stub is gone
- [ ] BullMQ `Queue` + `Worker` (`concurrency: 1`) on a **dedicated** ioredis
      connection (`maxRetriesPerRequest: null`), not the shared `redisClient`
- [ ] One repeatable/scheduled job, stable id, interval from `POLL_INTERVAL_MS`
      (default 45s, clamped 30–60s); restarting the app does **not** stack
      duplicate schedulers
- [ ] `POLL_ENABLED=false` cleanly skips worker creation
- [ ] Each poll diffs against `poll:snapshot`; `changes[]` distinguishes
      `added` / `removed` / `changed` and names the changed fields
      (`score` / `overs` / `status` / wickets)
- [ ] On change (and only on change): snapshot updated **then**
      `notifier.emit('matchUpdated', { polledAt, matches, changes })`; on no
      change: no emit, no meaningful snapshot write
- [ ] Overlap/repeat safe: `concurrency: 1` + `poll:lock` (`SET NX PX`,
      token-checked release) + snapshot-relative diff — a second instance or a
      retried job never double-emits; lock contention logs "skipped", not an error
- [ ] Retry configured (`attempts: 3`, exponential backoff); final failure
      logged as one clean line by the `Worker` `'failed'` handler; process
      stays up. `Worker` `'error'` and BullMQ connection `'error'` handled
- [ ] `ApiParseError` does not consume all 3 retries (fails fast) — documented
- [ ] `server.js` `start()` calls `startPolling()` (exits non-zero if the queue
      can't reach Redis); `shutdown()` calls `stopPolling()` before Prisma
      disconnect, with a hard timeout; Ctrl-C produces no connection-closed spam
- [ ] `.env.example` + README updated (keys, event payload shape, how to watch it)
- [ ] `npm test` green: first-run, no-change, score-change, added/removed,
      idempotent-retry, lock-held, client-error-rejects, parse-error-fast-fail,
      order-insensitive diff
- [ ] **Checkpoint:** `docker compose up -d` then `npm run dev` — with **no**
      manual requests, `info` logs show `poll #N: X matches, Y changed` every
      30–60s, continuously. Kill Redis mid-run → failures are logged and retried,
      app does not crash; bring Redis back → polling resumes. Ctrl-C → worker
      closes cleanly, process exits 0.

## Out of scope (later issues)

- General Redis caching strategy / TTLs for `/matches` responses → Phase 5
- WebSocket rooms and pushing `matchUpdated` to clients → Phase 6
- Real `notifier` listeners (`wicketFallen`, `milestoneReached`, `matchStarted`)
  and notification fan-out → Phase 7
- Multi-process / horizontal scaling of the worker, a Bull Board dashboard,
  circuit breaker on the provider — leave as TODO comments, don't build

## Notes

- The mock provider evolves scores on its own, so the diff will fire regularly
  in local dev — good for the checkpoint. If it's too quiet, drop
  `POLL_INTERVAL_MS` to 30000 while testing.
- Keep `runPollOnce()` free of BullMQ types so it's trivially unit-testable and
  Phase 5/7 can reason about it in isolation.
- Namespace every Redis key this issue introduces under `poll:` and list them in
  the README so Phase 5 doesn't collide.
- Reuse the Phase 3 mental model: transient → retry with capped backoff,
  deterministic-failure (bad shape / bad key) → fail fast.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
