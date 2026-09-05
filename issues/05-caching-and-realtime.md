# Issue #5: Caching Layer + Real-Time Push (Phases 5 & 6 — Redis cache + WebSockets)

**Labels:** `backend`, `redis`, `cache`, `websockets`, `realtime`
**Milestone:** PitchPulse — Live Data
**Estimated effort:** 2–3 days

## Summary

Two tightly-related phases in one issue, because they share the same data path
and the same source of truth (the Phase 4 polling job):

1. **Phase 5 — Caching Layer.** `GET /matches/live` and `GET /matches/:id` stop
   hitting `cricketApiClient` on every request. They read from Redis instead.
   The **background job is the only writer** of fresh data into the cache; the
   HTTP layer is read-only against it. A short TTL is a safety net so a stalled
   job can't serve infinitely stale data silently.

2. **Phase 6 — Real-Time Push.** A Socket.io server rides on Fastify's
   underlying HTTP server. Clients `join-match` to sit in a `match:{id}` room.
   When the Phase 4 job emits `matchUpdated`, the changed matches are pushed to
   exactly the rooms that care, as `scoreUpdate` events. A minimal static HTML
   client proves it: two tabs on the same match both update within seconds, no
   refresh.

After this issue: `/matches/live` is near-instant on a warm cache and visibly
slower only on a cold miss; and a score change discovered by the poller shows up
in an open browser tab on its own.

This is **Phases 5 and 6** from `pitchpulse-project-docs.md`. It builds on the
Phase 4 job (`src/jobs/pollScores.js`), the live `redisClient`
(`src/cache/redisClient.js`), the `notifier` singleton
(`src/events/notifier.js`), and the stub `src/realtime/socket.js`.

---

## Background / Context

- **The poller already owns a Redis snapshot.** Phase 4 writes `poll:snapshot`
  (a JSON `Match[]` + `polledAt`) whenever a poll finds changes, and emits
  `notifier.emit('matchUpdated', { polledAt, matches, changes })` where each
  `changes[]` entry is `{ id, type: 'added'|'removed'|'changed', before, after,
  fields }`. **That `poll:*` namespace is the job's private working state — do
  not repurpose it as the read cache.** Phase 5 introduces its own `match:*`
  keys, written by the job right after (or instead of) the snapshot, and read by
  the routes. Keeping them separate keeps the two concerns debuggable in
  isolation, exactly as issue #4 asked Phase 5 to do.
- **`Match` shape** is `{ id, teams, status, score, overs }` (see
  `normalizeMatch` in `src/lib/cricketSchemas.js`). Unchanged by this issue.
- **`redisClient`** (`src/cache/redisClient.js`) is a live `ioredis` instance
  with `connect` / `error` logging already wired. This issue adds typed
  `get`/`set`/`del` JSON helpers to that module — it does **not** create a
  second app-level client. (BullMQ's dedicated connections from Phase 4 are
  unrelated and stay as they are.)
- **Routes today** (`src/routes/matches.js`) call `getLiveMatches()` /
  `getMatchDetail(id)` directly and let typed client errors
  (`ApiUnavailableError` / `ApiRateLimitError` / `ApiParseError`) bubble to
  `errorHandler.js`, which degrades them to 502/503. That error path stays as
  the fallback behaviour for a cold cache miss on `/matches/:id`.
- **`server.js`** builds `const fastify = Fastify({ logger: false })`, then
  `await fastify.listen(...)`. Socket.io attaches to `fastify.server` (the raw
  `http.Server`) and must be attached **after** `fastify.listen()` has created
  it. Teardown hooks into the existing `shutdown()` alongside `stopPolling()`.
- **`notifier`** is a plain `EventEmitter` singleton. Phase 6 adds a listener
  for `matchUpdated`; Phase 7 will add more listeners on the same instance, so
  don't call `removeAllListeners()`.
- Socket.io **4.x** is already a dependency (`socket.io@^4.8.3`). No client
  package — the test page loads the client from the server's own
  `/socket.io/socket.io.js`.

---

## Part A — Phase 5: Caching Layer

### A1. `src/cache/redisClient.js` — JSON helpers

Keep the existing client + event logging. Add and export:

- `cacheGet(key)` → `Promise<any | null>`: `GET`, `JSON.parse`, return `null` on
  missing key **and** on parse failure (log a `warn` on parse failure — a
  corrupt value should not 500 a request).
- `cacheSet(key, value, ttlSeconds)` → `Promise<void>`: `JSON.stringify` then
  `SET key val EX ttlSeconds`. `ttlSeconds` is **required** — throw if it's
  missing or not a positive number. There is no "cache forever" in this app.
- `cacheDel(key)` → `Promise<void>` (used by tests / manual cache-busting).

Add a `CACHE_KEYS` helper or small module so key strings aren't duplicated:

```
match:live:list          // the GET /matches/live payload
match:detail:{id}         // one match's GET /matches/:id payload
```

### A2. The job becomes the cache writer

In `src/jobs/pollScores.js`, in `runPollOnce()`, **after** the `poll:snapshot`
write and the `matchUpdated` emit (order: snapshot → cache → emit, or
snapshot → emit → cache; pick one and document it — the cache write must not be
able to throw past the emit and skip listeners, so wrap it):

- `cacheSet(CACHE_KEYS.liveList, matches, CACHE_TTL_SECONDS)` — the whole live
  list, same array the route returns.
- For each match in `matches`: `cacheSet(CACHE_KEYS.detail(m.id), m,
  CACHE_TTL_SECONDS)`.
- On the **first run** (currently "seed snapshot, emit nothing"): still write the
  cache. A fresh deploy should have a warm cache after one poll cycle, not after
  the first *change*.
- Log at `debug`: `cache write: 1 list + N detail keys (ttl Ns)`.
- A `cacheSet` failure is logged (`warn`) and swallowed — a Redis write blip
  must not fail the poll job or block the emit.

`CACHE_TTL_SECONDS` from env `CACHE_TTL_SECONDS`, default `120`, clamp to a sane
floor (e.g. `>= 30`). It must be comfortably longer than `POLL_INTERVAL_MS` so a
single slow poll doesn't expire the cache — assert/log a warning at startup if
`CACHE_TTL_SECONDS * 1000 <= POLL_INTERVAL_MS`.

### A3. `GET /matches/live` — read from Redis only

```
const cached = await cacheGet(CACHE_KEYS.liveList);
if (cached) return cached;                 // warm path — the normal case
// cold cache: the job hasn't run yet (or Redis was wiped). Fall back once.
logger.warn('cache miss on /matches/live — falling back to direct API call');
const matches = await getLiveMatches();
await cacheSet(CACHE_KEYS.liveList, matches, CACHE_TTL_SECONDS);  // warm it
return matches;
```

- The docs say `/matches/live` "reads from Redis, not the API directly". The
  fallback above exists only so a brand-new process before its first poll isn't
  broken; it should be **rare** and it logs when it happens.
- If both the cache is empty **and** `getLiveMatches()` throws, let the typed
  error bubble to `errorHandler.js` (existing 502/503 behaviour).

### A4. `GET /matches/:id` — read from Redis, fall back on miss

Per the docs, explicitly a cache-with-fallback:

```
const cached = await cacheGet(CACHE_KEYS.detail(id));
if (cached) return cached;
logger.warn(`cache miss on /matches/${id} — direct API fallback (should be rare)`);
const match = await getMatchDetail(id);      // still throws NotFoundError -> 404
await cacheSet(CACHE_KEYS.detail(id), match, CACHE_TTL_SECONDS);
return match;
```

- `getMatchDetail` still owns the `NotFoundError` → 404 path; don't cache a
  not-found.
- Don't add per-request API calls back into the hot path any other way — the
  miss branch is the only place a route may call `cricketApiClient` now.

### A5. Config / `.env.example`

```
# --- Caching layer (Phase 5) ---
# TTL (seconds) on every cached key. Safety net for a stalled poll job —
# must be > POLL_INTERVAL_MS so a single slow poll can't expire the cache.
CACHE_TTL_SECONDS=120
```

### A6. Phase 5 checkpoint (manual)

- `docker compose up -d`, `npm run dev`.
- `redis-cli FLUSHALL`, then immediately `curl /matches/live` → one
  `cache miss ... direct API fallback` line, response noticeably slower.
- `curl /matches/live` again → no log line, near-instant.
- Wait one poll cycle, `redis-cli KEYS 'match:*'` → `match:live:list` +
  `match:detail:*`, each with `TTL` between 0 and 120.
- **Turn the job off** (`POLL_ENABLED=false`, restart) → `/matches/live` still
  serves (from the warm cache) until the TTL expires, then falls back to a
  direct call and re-warms. It never errors just because the job is down.

---

## Part B — Phase 6: Real-Time Push (WebSockets)

### B1. `src/realtime/socket.js` — Socket.io server

Replace the stub. Export:

- `initSocket(httpServer)` — creates `new Server(httpServer, { cors: { origin:
  '*' } })` (CORS open is fine for the local test client; note it as a
  follow-up), wires connection handling, subscribes the `notifier` listener,
  stores the `io` instance in module state, returns it.
- `getIO()` — returns the instance or throws if `initSocket` hasn't run (useful
  for future callers / tests).
- `closeSocket()` — `io.close()` (disconnects sockets, stops the server),
  removes the `notifier` listener it added, clears module state, idempotent.

Connection handling:

- On `connection`, log at `debug` with `socket.id`.
- `socket.on('join-match', (matchId) => { ... })`:
  - Validate `matchId` (coerce to string, reject empty / absurdly long).
  - `socket.join(\`match:${matchId}\`)`.
  - `ack`/emit a `joined` confirmation back to that socket so the test client
    can show it worked.
- `socket.on('leave-match', (matchId) => socket.leave(\`match:${matchId}\`))`.
- `socket.on('disconnect', ...)` — just log at `debug`. **Socket.io removes a
  disconnected socket from all its rooms automatically**, so there is no manual
  room cleanup to do; the "no memory leaks from dangling room memberships"
  requirement is satisfied by not hand-rolling a room registry. Add a one-line
  comment saying exactly that so a reviewer doesn't expect cleanup code.

### B2. `notifier` → room broadcast

Inside `initSocket`, register **one** listener (keep a reference for
`closeSocket` to remove):

```
notifier.on('matchUpdated', ({ polledAt, changes }) => {
  for (const change of changes) {
    io.to(`match:${change.id}`).emit('scoreUpdate', {
      id: change.id,
      type: change.type,          // 'added' | 'removed' | 'changed'
      match: change.after,        // full normalized match (null on 'removed')
      fields: change.fields,      // which fields changed
      polledAt,
    });
  }
});
```

- Broadcast **per changed match**, only to that match's room — a client viewing
  match 3 gets nothing when only match 7 changed.
- Use `changes`, not `matches`: pushing the whole list to every room defeats the
  point of rooms.
- If `io.sockets.adapter.rooms` has no such room, `io.to(...).emit` is a
  harmless no-op — no need to guard.
- Wrap the loop body so a malformed `change` logs and continues instead of
  killing the listener.

### B3. Wire into `server.js`

- Import `initSocket`, `closeSocket`.
- **After** `await fastify.listen(...)` succeeds (so `fastify.server` exists):
  `initSocket(fastify.server)` inside its own try/catch; on failure log and
  `process.exit(1)` (consistent with the Postgres / polling blocks — real-time
  is a headline feature of this app).
- Order in `start()`: `prisma.$connect` → `fastify.listen` → `initSocket` →
  `startPolling`. (Socket up before the poller, so the first `matchUpdated` has
  somewhere to go.)
- In `shutdown()`: `await fastify.close()` → `closeSocket()` → `stopPolling()` →
  `prisma.$disconnect()`. Closing Socket.io before the poller means a late
  `matchUpdated` emit finds no listener attached rather than emitting into a
  half-closed `io`.
- Confirm Ctrl-C is clean — no "server is not running" / EADDRINUSE / open
  handle keeping the process alive.

### B4. Minimal test client — `public/match-client.html`

A single static file, served by Fastify. Add `@fastify/static` **or** a tiny
inline route that returns the file (`@fastify/static` isn't currently a dep —
prefer a one-off `fastify.get('/client', ...)` route that reads and returns the
HTML with `text/html`, to avoid adding a plugin for one file; document the
choice).

The page:

- Loads `/socket.io/socket.io.js` (served by the Socket.io server itself).
- An input for match id + a "Join" button → `socket.emit('join-match', id)`.
- Logs to a `<pre>` on the page: connection open/close, `joined` confirmations,
  and every incoming `scoreUpdate` (pretty-printed JSON + a timestamp).
- No build step, no framework, no bundler. Plain `<script>`.

### B5. Config / `.env.example`

```
# --- Real-time push (Phase 6) ---
# CORS origin for the Socket.io server. "*" is fine for local dev / the test
# client; lock this down before any real deployment.
SOCKET_CORS_ORIGIN=*
```

(Read it in `initSocket`; default `*`.)

### B6. Phase 6 checkpoint (manual)

- `npm run dev`, open `http://localhost:3000/client` in **two** browser tabs.
- Both tabs "Join" the **same** match id (use one from `/matches/live`).
- Wait for the poller to report `Y changed` for that match (the mock provider
  evolves scores on its own; drop `POLL_INTERVAL_MS` to `30000` if it's slow) —
  **or** trigger a change deterministically (see Notes).
- Both tabs log a `scoreUpdate` for that match within a few seconds, no refresh.
- A third tab joined to a **different** match logs nothing for that change.
- Close one tab → server logs a `disconnect` at debug; the other tab keeps
  receiving updates; `redis-cli`/logs show no growth in room bookkeeping.

---

## Tests — `vitest`

### `src/cache/__tests__/redisClient.test.js`

- `cacheSet` + `cacheGet` round-trips an object; TTL is applied (`pttl` > 0).
- `cacheGet` returns `null` for a missing key.
- `cacheGet` returns `null` and logs `warn` when the stored value isn't JSON.
- `cacheSet` throws when `ttlSeconds` is missing / `0` / negative.

Use `ioredis-mock` or a dedicated test key prefix + `FLUSHDB` in
`beforeEach`/`afterAll`.

### `src/routes/__tests__/matches.test.js`

Spin up the Fastify app with a stubbed `cricketApiClient` and a fake/prefixed
Redis. Cover:

- `/matches/live` **cache hit**: pre-seed `match:live:list` → route returns it,
  `getLiveMatches` **not** called, no warn log.
- `/matches/live` **cache miss**: empty cache → route returns `getLiveMatches()`
  result, warns once, and the key is now populated (re-warmed).
- `/matches/live` cache miss **and** `getLiveMatches` throws
  `ApiUnavailableError` → 503 (existing error path intact).
- `/matches/:id` cache hit: pre-seed `match:detail:{id}` → returned, no API
  call.
- `/matches/:id` cache miss → falls back to `getMatchDetail`, warns, caches the
  result.
- `/matches/:id` cache miss + `getMatchDetail` throws `NotFoundError` → 404, and
  **nothing** is cached for that id.

### `src/jobs/__tests__/pollScores.test.js` (extend)

- After a poll **with changes**: `match:live:list` and one
  `match:detail:{id}` per match are written with the configured TTL.
- After the **first run** (no prior snapshot): cache is written even though no
  `matchUpdated` is emitted.
- A `cacheSet` that rejects does **not** reject `runPollOnce` and does **not**
  suppress the `matchUpdated` emit.

### `src/realtime/__tests__/socket.test.js`

Start `initSocket` on an ephemeral `http.Server`, connect a real
`socket.io-client` (add as a dev dep) or use Socket.io's own test harness:

- client `join-match` → client is in `match:{id}` room (assert via
  `io.sockets.adapter.rooms`), gets a `joined` ack.
- `notifier.emit('matchUpdated', { changes: [{ id: '3', type: 'changed', after,
  fields: ['score'] }], polledAt })` → a client joined to `match:3` receives one
  `scoreUpdate` with that payload; a client joined to `match:9` receives
  nothing.
- client disconnect → socket removed from all rooms (adapter shows the room
  gone / empty); no listener leak on `notifier` (`notifier.listenerCount(
  'matchUpdated')` is back to the pre-test count after `closeSocket`).
- `closeSocket` is idempotent and removes the `matchUpdated` listener it added.

Keep it fast: ephemeral ports, no real network, close every server in
`afterEach`.

---

## Acceptance Criteria

### Phase 5

- [ ] `src/cache/redisClient.js` exports `cacheGet` / `cacheSet` / `cacheDel`
      with JSON (de)serialize; `cacheSet` requires a positive `ttlSeconds`;
      `cacheGet` returns `null` on miss and on corrupt JSON (logs `warn`)
- [ ] Cache keys are `match:live:list` and `match:detail:{id}`, defined in one
      place, **disjoint** from the job's `poll:*` keys
- [ ] The Phase 4 job is the **only** writer of `match:*` keys — it writes the
      list + per-match detail on every poll (including the first), TTL applied,
      write failures logged and swallowed (emit still fires)
- [ ] `GET /matches/live` serves from Redis; a cold miss logs a `warn`, falls
      back to `getLiveMatches()` **once**, re-warms the key
- [ ] `GET /matches/:id` serves from Redis; a cold miss logs a `warn`, falls
      back to `getMatchDetail(id)`, caches the result; `NotFoundError` → 404 and
      nothing cached
- [ ] No route calls `cricketApiClient` except on a cache miss
- [ ] `CACHE_TTL_SECONDS` env (default 120), startup warns if it isn't safely
      larger than `POLL_INTERVAL_MS`
- [ ] `.env.example` + README updated (keys, shapes, the "job is the only
      writer" rule, TTL rationale)
- [ ] **Checkpoint:** warm `/matches/live` is near-instant; `FLUSHALL` then a
      request is visibly slower + logs one fallback line; with `POLL_ENABLED=
      false` the API keeps serving cached data until TTL, then falls back — never
      errors because the job is down

### Phase 6

- [ ] `src/realtime/socket.js` exports `initSocket(httpServer)` / `getIO()` /
      `closeSocket()`; stub gone
- [ ] Socket.io attached to `fastify.server` **after** `fastify.listen()`;
      `server.js` `start()` order is listen → `initSocket` → `startPolling`
- [ ] `join-match` validates the id and joins `match:{id}`; `leave-match`
      leaves; disconnect relies on Socket.io's automatic room cleanup (comment
      says so — no hand-rolled room registry)
- [ ] Exactly one `notifier.on('matchUpdated')` listener; it emits `scoreUpdate`
      **per changed match**, only to `match:{id}`, using `changes[]` (never the
      whole list); a malformed change is logged and skipped, listener survives
- [ ] `closeSocket()` closes `io` and removes its `notifier` listener,
      idempotent; `shutdown()` calls it (before `stopPolling`); Ctrl-C is clean,
      no dangling handles
- [ ] `public/match-client.html` served by Fastify (document the static-serving
      choice): connects, join by match id, logs connection events + `joined` +
      every `scoreUpdate` to the page; plain `<script>`, no build
- [ ] `SOCKET_CORS_ORIGIN` env (default `*`), read in `initSocket`;
      `.env.example` + README updated
- [ ] **Checkpoint:** two tabs on the same match both receive a `scoreUpdate`
      within seconds of a poll change, no refresh; a tab on a different match
      gets nothing; closing a tab logs a clean `disconnect`, others keep working

### Both

- [ ] `npm test` green: redisClient helpers, matches routes (hit/miss/error for
      both endpoints), pollScores cache-write + first-run + write-failure
      isolation, socket rooms + targeted broadcast + disconnect cleanup +
      idempotent close

---

## Out of scope (later issues)

- Real `notifier` listeners for `wicketFallen` / `milestoneReached` /
  `matchStarted` and notification fan-out → Phase 7
- Auth on the WebSocket handshake (only authenticated users may join rooms),
  rate-limiting `join-match`, tightening CORS → note as TODO comments
- Redis pub/sub or the Socket.io Redis adapter for multi-process broadcast
  (single process only here) → TODO comment
- Cache stampede protection / single-flight on the cold-miss fallback → a
  comment noting the miss is rare by design is enough
- Invalidating / warming the cache on any path other than the poll job
- A real front-end for viewing matches — `match-client.html` is a diagnostic
  tool, not a product surface

## Notes

- **Keep `runPollOnce()` free of Socket.io.** The job emits `matchUpdated` on
  `notifier` and writes `match:*` to Redis; `socket.js` is the only place that
  knows about `io`. This keeps the job unit-testable and lets Phase 7 hang more
  listeners off the same event without touching the job.
- **Deterministic score change for the Phase 6 checkpoint:** set
  `CRICKET_MOCK_FAIL=` off and rely on the evolving mock, or add a throwaway
  `notifier.emit('matchUpdated', { polledAt: Date.now(), changes: [{ id: '<id>',
  type: 'changed', after: {...}, fields: ['score'] }] })` from a REPL / a
  temporary `/debug/emit` route (delete before merge).
- The mock provider changes scores between polls, so with `POLL_INTERVAL_MS=
  30000` you'll see real `scoreUpdate` traffic within a minute of opening the
  test client — good enough for the "wow, it works" moment without faking
  anything.
- Namespace check: after this issue Redis holds `poll:snapshot`, `poll:lock`
  (Phase 4) and `match:live:list`, `match:detail:*` (Phase 5). List all four in
  the README so Phase 7+ don't collide.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
