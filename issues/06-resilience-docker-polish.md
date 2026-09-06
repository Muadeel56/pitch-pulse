# Issue #6: Resilience Pass + Dockerize + Polish (Phases 8, 9 & 10)

**Labels:** `backend`, `resilience`, `docker`, `infra`, `testing`, `enhancement`
**Milestone:** PitchPulse — Production-Readiness
**Estimated effort:** 4–6 days

## Summary

The three closing phases of `pitchpulse-project-docs.md`, bundled because they
share one goal — turn a working local build into something that survives a bad
day and can be handed to someone else:

1. **Phase 8 — Error Handling & Resilience Pass.** Walk the whole system
   end-to-end and prove each dependency can fail without crashing the process:
   the cricket API, Redis, Postgres, JWT verification, WebSocket disconnects,
   and malformed upstream data. Most of the machinery already exists (typed
   `Api*Error`s, the poll job's retry/lock, `errorHandler.js`, `socket.js`'s
   auto room cleanup) — this phase is about **closing the gaps**, adding a
   health/readiness signal, and locking the behaviour down with tests.

2. **Phase 9 — Dockerize Everything.** A multi-stage `Dockerfile` for the Node
   app and a `docker-compose.yml` that stands up `app` + `postgres` + `redis`
   as one stack, with migrations run on startup and service names (not
   `localhost`) as hostnames between containers.

3. **Phase 10 — Polish & Stretch Goals.** Rate-limit our own API, structured
   logging with `pino`, pagination where lists can grow, and a first real test
   suite for the `auth` and `follows` routes. The React frontend is **carved
   out into its own follow-up issue** (see "Out of scope").

After this issue: `docker compose up` on a clean machine brings up the whole
stack, migrations included; killing Postgres or Redis mid-request produces a
clean `503`, not a stack trace or a dead process; and `npm test` covers the
auth and follows routes it currently doesn't touch.

This builds on every prior phase. Key existing pieces it modifies:
`src/plugins/errorHandler.js`, `src/cache/redisClient.js`, `src/lib/prisma.js`,
`src/plugins/authenticate.js`, `src/jobs/pollScores.js`, `src/server.js`,
`src/utils/logger.js`, `docker-compose.yml`, `README.md`.

---

## Background / Context

- **Error handler today** (`src/plugins/errorHandler.js`) maps `ZodError`→400,
  `NotFoundError`→404, Prisma `P2002`→409, `ApiParseError`→502,
  `ApiRateLimitError`/`ApiUnavailableError`→503, sub-500 `err.statusCode`
  passthrough, everything else→500 with a stack-trace-free body. It does **not**
  special-case Prisma connection failures (`PrismaClientInitializationError`,
  `PrismaClientRustPanicError`, `P1001` "can't reach database server") — those
  currently fall through to a generic 500.
- **`redisClient`** (`src/cache/redisClient.js`) is `new Redis(process.env.REDIS_URL)`
  with default `ioredis` behaviour: it auto-reconnects forever, but while it's
  down `cacheGet`/`cacheSet` **reject** (or hang until `connectTimeout`). The
  match routes (`src/routes/matches.js`) `await cacheGet(...)` with no try/catch,
  so a Redis outage currently turns `GET /matches/live` into a 500 even though a
  direct API fallback exists two lines below.
- **`prisma`** (`src/lib/prisma.js`) is a bare `new PrismaClient()`. No
  readiness probe. `server.js` does `await prisma.$connect()` once at boot and
  `process.exit(1)` on failure — but a mid-run Postgres drop is unhandled.
- **JWT** (`src/plugins/authenticate.js`) already returns a clean `401`
  (`code: 'UNAUTHORIZED'`) for missing/malformed headers, `jwt.verify` throws
  (bad signature, expired), and deleted users. This is in good shape — Phase 8
  just needs a test that an **expired** token and a **tampered** token both give
  the same 401 shape, and that a missing `JWT_SECRET` fails loudly at boot, not
  per-request.
- **WebSocket disconnect** (`src/realtime/socket.js`) already relies on
  Socket.io's automatic room removal and logs `disconnect` at `debug`; the
  `matchUpdated` bridge wraps each change in try/catch. Phase 8 confirms this
  with a test; no code change expected beyond what the test surfaces.
- **Malformed cricket data** — `src/lib/cricketApiClient.js` throws
  `ApiParseError` on a bad shape (Phase 3); `pollProcessor()` in
  `pollScores.js` catches it and re-throws `UnrecoverableError` so BullMQ
  doesn't burn retries; `worker.on('failed')` logs it. Confirm end-to-end.
- **Cricket API fully down** — `getLiveMatches()` throws `ApiUnavailableError`
  after retries; `pollProcessor()` lets BullMQ retry with exponential backoff
  (`attempts: 3`), then `worker.on('failed')` logs and the scheduler fires
  again next interval. The process never sees it. Confirm with a test that
  forces the mock provider to `500:always`.
- **Logger** (`src/utils/logger.js`) is a hand-rolled leveled console logger.
  Every module imports `{ logger }` from it. Phase 10 swaps the internals for
  `pino` while keeping that import surface stable so the change is mechanical.
- **`docker-compose.yml`** today has only `postgres` (host port **5434**→5432)
  and `redis` (6379), each with a healthcheck, plus named volumes `pgdata` /
  `redisdata`. No `app` service, no explicit network, no `.dockerignore`,
  no `Dockerfile`.
- **Migrations** exist: `prisma/migrations/20260905102754_init` and
  `20260906083621_add_notification`, with `migration_lock.toml`. The container
  path is `prisma migrate deploy` (not `migrate dev`).
- **`package.json`** scripts: `start` = `node src/server.js`, `prisma:migrate`
  = `prisma migrate dev`. `"type": "module"`. No `migrate deploy` script yet.
- **Tests**: `vitest`. Suites exist for `redisClient`, `cricketApiClient`,
  `retry`, `pollScores`, `notificationHandlers`, `notifications` route,
  `matches` route, `socket`. **None for `auth` or `follows` routes.** The
  `matches` route test (`src/routes/__tests__/matches.test.js`) shows the house
  pattern: build a minimal Fastify instance from the real plugin/route modules,
  stub `fastify.authenticate`, use `app.inject(...)`.

---

## Part A — Phase 8: Error Handling & Resilience Pass

### A1. Postgres connection loss → 503, not 500 or a crash

**`src/plugins/errorHandler.js`** — add a branch **above** the generic 500:

```js
import { Prisma } from '@prisma/client';
// ...
const isDbDown =
  err instanceof Prisma.PrismaClientInitializationError ||
  err instanceof Prisma.PrismaClientRustPanicError ||
  (err instanceof Prisma.PrismaClientKnownRequestError &&
    ['P1000', 'P1001', 'P1002', 'P1008', 'P1017'].includes(err.code));

if (isDbDown) {
  logger.error(`Database unavailable on ${request.method} ${request.url}: ${err.code ?? err.name}`);
  return reply.code(503).send({
    error: { message: 'Database is temporarily unavailable, please retry', code: 'DB_UNAVAILABLE' },
  });
}
```

- Keep the existing `P2002` → 409 branch; the new check must not shadow it
  (P2002 is a known-request error but not in the list above).
- The process must **stay up** — a `503` per request while Postgres is down,
  and normal service the moment it returns (Prisma reconnects on the next
  query on its own; no pool reset needed).

**`src/lib/prisma.js`** — optionally pass `log: ['warn', 'error']` and forward
to our logger, so a connection blip is visible without `DEBUG=prisma:*`.

### A2. Redis connection loss → routes fall back, never 500

The docs allow either "fall back to direct API calls temporarily" **or** "fail
gracefully with a clear error". We already have the fallback path — just make
the cache calls non-throwing.

**`src/cache/redisClient.js`:**

- Construct with explicit resilience options and keep auto-reconnect:
  ```js
  export const redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,     // don't queue requests forever while down
    enableOfflineQueue: false,   // reject fast instead of buffering
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  ```
- Add a module-level `redisReady` boolean, flipped by the existing
  `connect`/`ready` and `error`/`end`/`close` handlers. Log the transition
  once per edge (not once per retry): `Redis connection lost — routes will
  fall back to the API` / `Redis reconnected`.
- Wrap `cacheGet` so a connection error (not a parse error) resolves to `null`
  — a Redis outage is a cache miss, indistinguishable from a cold cache:
  ```js
  export async function cacheGet(key) {
    let raw;
    try {
      raw = await redisClient.get(key);
    } catch (err) {
      logger.warn(`cache: Redis GET ${key} failed (${err.message}) — treating as miss`);
      return null;
    }
    if (raw == null) return null;
    try { return JSON.parse(raw); }
    catch { logger.warn(`cache: corrupt JSON at ${key}, treating as miss`); return null; }
  }
  ```
- Wrap `cacheSet` / `cacheDel` so a connection error is logged at `warn` and
  swallowed (the `ttlSeconds` validation `TypeError` must still throw — that's
  a programming error, not an outage).
- **The poll job already swallows `cacheSet` failures** (`warmCache` in
  `pollScores.js`) — leave that as belt-and-braces.

Result: with Redis down, `GET /matches/live` logs a fallback line and serves
from `getLiveMatches()` directly; when Redis returns, the next poll re-warms it
and reads go fast again. No 500 at any point.

> **Note:** BullMQ's own connections (`makeBullConnection`, `maxRetriesPerRequest:
> null`) are separate and already tolerate Redis blips — a poll during a Redis
> outage fails, gets retried by BullMQ, and logs via `worker.on('failed')`.
> Don't change those.

### A3. `/health` and `/ready` endpoints

Add a tiny unauthenticated route module `src/routes/health.js` (registered in
`server.js` before the others):

- `GET /health` → `200 { status: 'ok' }` always (liveness — process is up).
- `GET /ready` → checks dependencies and returns `200` or `503`:
  ```json
  { "status": "degraded",
    "checks": { "postgres": "up", "redis": "down", "poller": "up" } }
  ```
  - `postgres`: `await prisma.$queryRaw\`SELECT 1\`` in a try/catch.
  - `redis`: the `redisReady` flag from A2 (or `redisClient.status === 'ready'`).
  - `poller`: `started` from `pollScores.js` — export a `isPollingStarted()`
    getter for it.
  - `200` only when Postgres is up (Redis down is "degraded" but still serving
    via fallback, so it's arguably still ready — pick one, document it: **`redis:
    down` → still `200 degraded`; `postgres: down` → `503`**).

This gives Phase 9's `depends_on` / compose healthcheck something real to hit,
and is a manual-verification handle for the whole resilience pass.

### A4. Confirm the already-handled cases (tests, not code)

- **Cricket API fully down**: set `CRICKET_MOCK_FAIL=500:always`, run the
  poller, assert `runPollOnce()` / `pollProcessor()` rejects, BullMQ retries,
  `worker.on('failed')` fires, process is alive, next interval tries again.
- **Malformed cricket data**: `CRICKET_MOCK_FAIL=malformed:always` →
  `ApiParseError` → `pollProcessor` throws `UnrecoverableError` (no retry
  storm) → logged. A route hitting `getMatchDetail` on a cold miss with a
  malformed body → `errorHandler.js` → `502 BAD_GATEWAY`.
- **Expired / tampered JWT**: both → `401 { code: 'UNAUTHORIZED' }`, identical
  body, no stack trace. Add to a new `authenticate` test.
- **WebSocket mid-session disconnect**: client joins `match:3`, disconnects
  abruptly (`socket.disconnect()` client-side / `socket.client.conn.close()`);
  assert no unhandled rejection, `io.sockets.adapter.rooms` no longer lists
  `match:3`, `notifier.listenerCount('matchUpdated')` unchanged, a subsequent
  `matchUpdated` emit doesn't throw.

### A5. Boot-time config validation

- `server.js`: if `!process.env.JWT_SECRET`, log `error` and `process.exit(1)`
  **before** `fastify.listen` — a missing secret must fail at boot, never as a
  confusing per-request 500/401. Same for `DATABASE_URL` and `REDIS_URL`.
- Consider a small `src/config.js` that reads + validates env once with `zod`
  and is imported everywhere instead of raw `process.env` reads — **optional**,
  note as a follow-up if it balloons.

---

## Part B — Phase 9: Dockerize Everything

### B1. `Dockerfile` (multi-stage)

At repo root. Multi-stage: deps → runtime.

```dockerfile
# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app
USER app
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
```

- Pin the Node version to what you develop on (`node:22-alpine` suggested;
  match `engines` if you add one).
- `npm ci` needs `package-lock.json` — it's committed, good.
- `prisma generate` in the deps stage so the client is in `node_modules` that
  gets copied forward.

**`docker-entrypoint.sh`** (runs migrations then hands off to `CMD`):

```sh
#!/bin/sh
set -e
echo "Running prisma migrate deploy..."
npx prisma migrate deploy
# Optional: seed only when explicitly asked, so restarts don't re-seed.
if [ "$RUN_DB_SEED" = "true" ]; then
  echo "Seeding database..."
  npx prisma db seed || echo "seed failed (non-fatal)"
fi
exec "$@"
```

Add a script to `package.json`: `"prisma:deploy": "prisma migrate deploy"`.

**`.dockerignore`** at repo root:

```
node_modules
.git
.env
npm-debug.log
issues
*.md
!README.md
coverage
```

### B2. `docker-compose.yml` — full stack

Extend the existing file (keep the `postgres` / `redis` services and their
healthchecks and volumes; keep the `5434:5432` host mapping for host-side
`psql`/Prisma Studio convenience):

```yaml
services:
  app:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://pitchpulse:pitchpulse@postgres:5432/pitchpulse?schema=public
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      PORT: 3000
      POLL_ENABLED: ${POLL_ENABLED:-true}
      CRICKET_API_KEY: ${CRICKET_API_KEY:-}
      # ...forward the rest of the Phase 3–7 vars with sensible defaults
      RUN_DB_SEED: ${RUN_DB_SEED:-false}
    ports:
      - "3000:3000"
    restart: unless-stopped

  postgres:
    # unchanged, plus:
    # (healthcheck already present)

  redis:
    # unchanged

volumes:
  pgdata:
  redisdata:
```

Key points:
- **Hostnames are service names**: `postgres:5432` and `redis:6379` from inside
  the `app` container — **not** `localhost`, and **not** the `5434` host port.
  Call this out explicitly (it's the #1 gotcha).
- Compose's default network is fine — all three services are on it; no custom
  `networks:` block needed. Say so in a comment.
- `depends_on: condition: service_healthy` makes `app` wait for both
  healthchecks. The entrypoint's `migrate deploy` then runs against a Postgres
  that's actually accepting connections.
- `env_file: .env` is an alternative to listing `environment:` — pick one.
  Recommended: `env_file: .env` for the app service so a single `.env` drives
  both `docker compose` and a local `npm run dev`, with the two URLs overridden
  in `environment:` (compose merges, `environment:` wins) to the service-name
  form. Document this dual-use clearly.

### B3. `.env.example` + `.env`

- Add a comment block explaining the **two** URL forms:
  ```
  # Local (npm run dev):      postgresql://...@localhost:5434/...   redis://localhost:6379
  # Inside docker compose:    postgresql://...@postgres:5432/...    redis://redis:6379
  # docker-compose.yml overrides DATABASE_URL/REDIS_URL to the service-name form,
  # so .env can keep the localhost form for host-side tooling.
  ```
- Add `RUN_DB_SEED=false`.

### B4. README rewrite — "Docker Compose usage" + "Setup"

- Replace "Only `postgres` and `redis` are containerized for now" with the full
  story.
- New top-level **"Run the whole stack (Docker)"** section:
  ```bash
  git clone https://github.com/Muadeel56/pitch-pulse.git
  cd pitch-pulse
  cp .env.example .env         # set JWT_SECRET to a long random string
  docker compose up --build    # app waits for db+redis, runs migrations, starts
  # first run only, to get Team/Player rows for the follow endpoints:
  RUN_DB_SEED=true docker compose up --build
  # or: docker compose exec app npx prisma db seed
  ```
- Document `docker compose up` / `down` / `down -v` / `logs -f app` /
  `exec app sh`.
- Keep the existing "run locally against containerized pg+redis" flow as an
  alternative for active development (`node --watch` doesn't belong in the
  image).

### B5. Checkpoint (manual, on a clean checkout / VM)

- Fresh `git clone`, `cp .env.example .env`, edit `JWT_SECRET`.
- `docker compose up --build` → three containers, `app` starts **after**
  pg+redis are healthy, entrypoint logs `migrate deploy` applying 2 migrations.
- `curl localhost:3000/health` → `200`; `curl localhost:3000/ready` → `200`
  with all checks `up`.
- `RUN_DB_SEED=true docker compose up` once (or `exec app npx prisma db seed`),
  then the full Phase 2 follows curl flow works.
- `docker compose down && docker compose up` → no re-migrate churn (deploy is a
  no-op), data persists.
- `docker compose down -v && docker compose up --build` → clean slate, migrations
  re-run, works with zero manual steps.

---

## Part C — Phase 10: Polish & Stretch Goals

### C1. Rate-limit our own API — `@fastify/rate-limit`

- `npm i @fastify/rate-limit`.
- Register globally in `server.js` **before** the routes:
  ```js
  await fastify.register(import('@fastify/rate-limit'), {
    max: Number(process.env.RATE_LIMIT_MAX) || 100,
    timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
    // key by user id when authenticated, else IP
    keyGenerator: (req) => req.user?.id ?? req.ip,
    allowList: (req) => req.url === '/health' || req.url === '/ready',
  });
  ```
- A limited request returns `429` — make sure it flows through `errorHandler.js`
  as the standard `{ error: { message, code } }` shape (rate-limit's default
  body differs; set `errorResponseBuilder` or let the error handler catch it).
- `.env.example`: `RATE_LIMIT_MAX=100`, `RATE_LIMIT_WINDOW="1 minute"`.
- **Auth routes**: consider a tighter per-route limit on `/auth/login` and
  `/auth/signup` (e.g. `max: 10 / 5 minutes`) to blunt credential stuffing.

### C2. Structured logging with `pino`

- `npm i pino` (+ `pino-pretty` as a dev dep for readable local output).
- Rewrite `src/utils/logger.js` internals to wrap a `pino` instance but **keep
  the exported shape** (`logger.info/warn/error/debug(msg)`), so no other file
  changes:
  ```js
  import pino from 'pino';
  const base = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' } : undefined,
  });
  export const logger = {
    info: (msg, o) => base.info(o ?? {}, msg),
    warn: (msg, o) => base.warn(o ?? {}, msg),
    error: (msg, o) => base.error(o ?? {}, msg),
    debug: (msg, o) => base.debug(o ?? {}, msg),
  };
  ```
- Optionally flip `server.js` to `Fastify({ logger: base })` and use
  `request.log` in routes — **but** that's a wider change; keeping the custom
  wrapper is acceptable and lower-risk. Document the choice.
- Drop the hand-rolled ANSI `colors` helper (or keep it exported as a no-op for
  back-comat if anything imports it — grep first: only `logger.js` uses it).
- Update the README "Real-time push" / logging mentions and the code comment in
  `logger.js` that currently says "pino ... is deferred to Phase 10".

### C3. Pagination

- **`/notifications`** already has cursor pagination (`limit` default + cap,
  `before`, `nextCursor`) — verify `limit` has a hard ceiling (e.g. 100) in
  `src/schemas/notifications.js` and document the cursor contract in the README.
  Likely **no code change**, just tests + docs. If missing a cap, add it.
- **`/matches/live`** returns a raw array from cache. The live-match list is
  inherently small (mock provider: a handful), so full pagination is overkill.
  Minimum: cap the array server-side and add an `?limit=` passthrough that
  slices the cached list, returning `{ matches, total }` instead of a bare
  array **only if** we're willing to change the response shape (the WS client
  and tests consume the array form — check `public/match-client.html` and
  `matches.test.js`). **Recommended: leave `/matches/live` as-is, add a
  code comment + README note explaining why**, and treat this bullet as done.

### C4. Tests for `auth` and `follows` routes

New suites, following `src/routes/__tests__/matches.test.js`'s pattern (build a
minimal Fastify app from the real modules, `app.inject`, real Prisma against
the test database — or a transaction rollback per test).

**`src/routes/__tests__/auth.test.js`:**
- signup: `201`, body has `id/email/createdAt`, **no** password field.
- signup duplicate email → `409 EMAIL_TAKEN`.
- signup invalid payload (bad email, short password) → `400 VALIDATION_ERROR`.
- login: `200 { token }`; token verifies with `JWT_SECRET` and carries `id`.
- login wrong password → `401 INVALID_CREDENTIALS`.
- login unknown email → `401 INVALID_CREDENTIALS` (**same** body as wrong
  password — no user enumeration).
- `GET /me` with a valid token → `200 { id, email }`.
- `GET /me` no token / malformed header / garbage token / **expired** token →
  `401 { code: 'UNAUTHORIZED' }`, identical shape, never 500.

**`src/routes/__tests__/follows.test.js`:**
- follow team → `201 { id, teamId, createdAt }`.
- follow same team twice → `409 ALREADY_FOLLOWING`.
- follow unknown team id → `404 NOT_FOUND`.
- malformed team id (bad uuid) → `400 VALIDATION_ERROR`.
- follow player → `201`.
- `GET /follows` → `{ teams: [...], players: [...] }`, scoped to the caller
  (seed a second user with their own follows, assert they're not visible).
- unfollow → `204`; unfollow again → `404 NOT_FOUND`.
- every route without a token → `401`.

**Test DB strategy:** add a `DATABASE_URL` pointing at a `pitchpulse_test`
schema/db in a `.env.test` (or `vitest` `setupFiles` that sets it), run
`prisma migrate deploy` against it in a `pretest` step, and truncate the
relevant tables in `beforeEach`. Document it in the README's testing section.

### C5. README — testing section

Add a **"Running the tests"** section: what `npm test` needs (Redis up, a test
Postgres), how to point it at the test DB, and what's covered.

---

## Out of scope (separate follow-up issues)

- **The React frontend** ("Frontend Track" in the docs — swap
  `public/match-client.html` for a real app showing live scores). This is a
  whole project of its own (build tooling, component structure, auth flow, WS
  client, deploy). **File it as Issue #7.** `match-client.html` stays as the
  diagnostic tool until then.
- WebSocket handshake auth / rate-limiting `join-match` / CORS tightening —
  still the TODO noted in `socket.js` (issue #5). Not this issue.
- Redis adapter for multi-process Socket.io broadcast; horizontal scaling of
  the BullMQ worker — still deferred (comments in `pollScores.js` / `socket.js`).
- Circuit breaker on the cricket provider (a Phase 3 TODO) — the retry +
  `UnrecoverableError` handling is enough for this issue.
- A full `src/config.js` zod-validated config module — mentioned in A5 as
  optional; if it grows past ~30 lines, split it out.
- Metrics / Prometheus / OpenTelemetry — not in the docs' scope.
- CI pipeline (GitHub Actions running `npm test` + `docker build`) — worth
  doing, but its own infra issue.

---

## Acceptance Criteria

### Phase 8 — Resilience

- [ ] `errorHandler.js` maps Prisma connection failures
      (`PrismaClientInitializationError`, `RustPanicError`, `P1001`/`P1002`/…)
      to `503 { code: 'DB_UNAVAILABLE' }`; `P2002` → 409 still works; process
      stays up across a Postgres drop and recovers on its own
- [ ] `redisClient` uses `enableOfflineQueue: false` + bounded retries;
      `cacheGet` returns `null` on a connection error (logged `warn`),
      `cacheSet`/`cacheDel` swallow connection errors (logged), `ttlSeconds`
      validation still throws; a `redisReady` flag logs lost/reconnected once
      per edge
- [ ] With Redis down, `GET /matches/live` and `GET /matches/:id` fall back to
      the API and return `200` (or a typed `502/503` if the API also fails) —
      **never a 500**; when Redis returns, reads are fast again after one poll
- [ ] `GET /health` → always `200`; `GET /ready` → `200` with per-dependency
      `checks` when Postgres is up (Redis down = `200 degraded`), `503` when
      Postgres is down; `isPollingStarted()` exported from `pollScores.js`
- [ ] Invalid / expired / tampered JWT → `401 { code: 'UNAUTHORIZED' }`,
      identical body, no stack trace (test proves it)
- [ ] WebSocket client disconnecting mid-session → no unhandled rejection,
      room gone from the adapter, `notifier` listener count unchanged, later
      `matchUpdated` emit is fine (test proves it)
- [ ] Cricket API `500:always` → poll job retries via BullMQ, logs via
      `worker.on('failed')`, process alive, retries next interval;
      `malformed:always` → `ApiParseError` → `UnrecoverableError` (no retry
      storm) → `502` on a direct route hit (tests prove both)
- [ ] Missing `JWT_SECRET` / `DATABASE_URL` / `REDIS_URL` → `process.exit(1)`
      at boot with a clear log line, not a per-request failure

### Phase 9 — Docker

- [ ] Multi-stage `Dockerfile` at repo root (deps → runtime, non-root user,
      `prisma generate` baked in), `.dockerignore`, `docker-entrypoint.sh`
      running `prisma migrate deploy` then `exec "$@"`
- [ ] `package.json` has `"prisma:deploy": "prisma migrate deploy"`
- [ ] `docker-compose.yml` runs `app` + `postgres` + `redis`; `app` has
      `depends_on: { condition: service_healthy }` on both; env uses
      `postgres:5432` / `redis:6379` service-name hosts, **not** `localhost`
- [ ] `docker compose up --build` on a clean checkout brings the whole stack
      up, migrations run automatically, `/ready` goes green with no manual
      troubleshooting
- [ ] Seeding is opt-in (`RUN_DB_SEED=true` or `docker compose exec app npx
      prisma db seed`), not on every restart
- [ ] `docker compose down -v && docker compose up --build` reproduces a
      working stack from scratch
- [ ] README documents the exact clone → `.env` → `docker compose up` steps
      and the local-dev alternative; the `localhost` vs service-name URL
      distinction is called out

### Phase 10 — Polish

- [ ] `@fastify/rate-limit` registered globally (env-configurable `max` /
      `timeWindow`, `/health` + `/ready` allow-listed, keyed by user id or IP);
      `429` responses use the app's standard error body; tighter limit on
      `/auth/*`
- [ ] `src/utils/logger.js` backed by `pino` with the export shape unchanged;
      `pino-pretty` in dev, JSON in production (`NODE_ENV=production`); the
      "deferred to Phase 10" comment removed; no remaining `console.log` in
      `src/` except inside `logger.js`
- [ ] `/notifications` `limit` has a hard ceiling; cursor pagination contract
      documented in the README; `/matches/live` decision (paginate or
      deliberately not) documented in code + README
- [ ] `src/routes/__tests__/auth.test.js` and
      `src/routes/__tests__/follows.test.js` exist and cover the cases listed
      in C4; test-DB setup documented
- [ ] `npm test` green end-to-end (all existing suites + the two new ones)
- [ ] README has a "Running the tests" section

### Cross-cutting

- [ ] `.env.example` updated with every new var (`RATE_LIMIT_*`, `RUN_DB_SEED`,
      any `LOG_*`) and the dual URL-form comment block
- [ ] `docker compose up --build` + `npm test` + the Phase 2/7 manual curl
      flows all pass from a clean clone

---

## Notes

- **Do the resilience pass (Part A) before Dockerizing (Part B).** The `/ready`
  endpoint from A3 is what Phase 9's healthcheck and your clean-VM checkpoint
  lean on, and it's much easier to test failure modes (`kill` a container,
  `docker network disconnect`) once the app degrades gracefully instead of
  crashing.
- **Keep `logger.js`'s public surface frozen** while swapping in `pino` — the
  whole point is that ~15 files that `import { logger }` don't get touched. If
  you decide to adopt Fastify's request-scoped `request.log` too, that's a
  bigger, separate change — note it as a follow-up rather than folding it in.
- **`prisma migrate deploy` is idempotent** — running it on every container
  start is fine and is the documented pattern. Don't gate it behind a "is this
  the first run" check.
- **The `5434` host port stays** for `postgres` so host-side `npx prisma
  studio` / `psql` keep working; it's unrelated to the in-network `5432` the
  `app` container uses.
- Force-fail dependencies for manual testing: Postgres — `docker compose stop
  postgres` mid-request; Redis — `docker compose stop redis` then `curl
  /matches/live` (watch for the fallback log line); cricket API —
  `CRICKET_MOCK_FAIL=500:always` in the `app` env then `docker compose up -d
  app`.
- After this issue, the only remaining item from the 10-phase doc is the React
  frontend (Issue #7).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
