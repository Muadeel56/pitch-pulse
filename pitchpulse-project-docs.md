# PitchPulse — Project Build Docs

**Goal:** Master real-world Node.js backend patterns — REST APIs, background jobs, caching, real-time communication, and event-driven architecture — by building a live cricket score tracker that polls external data, caches it, pushes updates in real time, and notifies users about things they follow.

**Estimated time:** 7–10 focused days (bigger than Repo Radar — this is a "pro-level" project)
**Tech stack:** Fastify, Prisma, PostgreSQL, Redis, BullMQ, Socket.io (or `ws`), Zod, JWT, Docker Compose

---

## Phase 0 — Setup & Planning

### Steps
1. Pick a cricket data source. Options to evaluate (check current free-tier limits before committing — they change often):
   - CricAPI
   - Cricket Data API (cricketdata.org)
   - Any other free-tier live score API
   - **Fallback plan:** if all free tiers are too limited, build a mock data generator that simulates live match updates (random score increments every few seconds) — this still teaches 100% of the Node concepts, just without real data. Don't let API access block your learning.
2. Get an API key, test one manual request with `curl` or Postman before writing any code — confirm the response shape.
3. `npm init -y`, set `"type": "module"`.
4. Install core deps: `fastify`, `@prisma/client`, `prisma`, `zod`, `jsonwebtoken`, `bcrypt`, `ioredis`, `bullmq`, `socket.io`, `dotenv`.

### Folder structure
```
pitchpulse/
├── src/
│   ├── server.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── matches.js
│   │   └── follows.js
│   ├── jobs/
│   │   └── pollScores.js
│   ├── realtime/
│   │   └── socket.js
│   ├── events/
│   │   └── notifier.js
│   ├── cache/
│   │   └── redisClient.js
│   ├── lib/
│   │   └── cricketApiClient.js
│   ├── schemas/
│   │   └── (zod schemas per route)
│   └── utils/
│       └── logger.js
├── prisma/
│   └── schema.prisma
├── docker-compose.yml
├── .env
├── package.json
└── README.md
```

### Todos
- [ ] Cricket API key obtained and tested manually
- [ ] Project scaffolded with folders above
- [ ] `.env` file with `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CRICKET_API_KEY`
- [ ] `docker-compose.yml` with Postgres + Redis services (Node app can run locally against these for now)

**Checkpoint:** `docker compose up -d` starts Postgres + Redis, you can connect to both manually (e.g. `psql`, `redis-cli`).

---

## Phase 1 — Database Schema & Auth (Prisma + JWT)

### Steps
1. Design schema: `User`, `Team`, `Player`, `FollowedTeam` (join table), `FollowedPlayer` (join table).
2. Keep `Match` data itself mostly in Redis (it's transient/live), not fully normalized in Postgres — only store minimal match history if you want a "past matches" feature later.
3. Build signup/login: hash passwords with `bcrypt`, issue JWT on login.
4. Build a Fastify auth decorator/hook (`fastify.decorate` or `onRequest` hook) that verifies JWT and attaches `request.user`.

### Todos
- [ ] `prisma/schema.prisma`: `User`, `Team`, `Player`, `FollowedTeam`, `FollowedPlayer` models
- [ ] `prisma migrate dev` run successfully
- [ ] `POST /auth/signup` — Zod-validated body, hashed password stored
- [ ] `POST /auth/login` — verify password, return JWT
- [ ] Auth hook/middleware verifying JWT on protected routes
- [ ] `GET /me` — protected route returning current user (sanity check auth works)

**Checkpoint:** You can sign up, log in, get a token, and hit a protected route with it (Postman/Thunder Client works fine here).

---

## Phase 2 — Core REST Endpoints (Follows + Match Listing)

### Steps
1. Build endpoints for users to follow/unfollow teams and players.
2. Build a basic "list live matches" endpoint — for now, this can call the cricket API directly (you'll move this to cache in Phase 4).
3. Validate all request bodies with Zod, return consistent error shapes.

### Todos
- [ ] `POST /follows/team/:teamId` and `DELETE /follows/team/:teamId`
- [ ] `POST /follows/player/:playerId` and `DELETE /follows/player/:playerId`
- [ ] `GET /follows` — returns current user's followed teams/players
- [ ] `GET /matches/live` — fetches live matches (direct API call for now)
- [ ] `GET /matches/:id` — single match detail
- [ ] Centralized error handler (Fastify `setErrorHandler`) so all routes return consistent `{ error: { message, code } }` shape

**Checkpoint:** Full follow/unfollow flow works, live matches endpoint returns real (or mocked) data.

---

## Phase 3 — External API Client (Resilient Fetching)

This reuses everything you learned in Repo Radar — apply it here for real.

### Steps
1. Wrap all cricket API calls in a single client module — never call `fetch` directly from routes/jobs.
2. Add retry with exponential backoff (same pattern as Repo Radar).
3. Add rate-limit awareness — respect the API's documented limits, don't hammer it.
4. Handle malformed/unexpected response shapes defensively (external APIs are never as clean as docs promise).

### Todos
- [ ] `src/lib/cricketApiClient.js`: `getLiveMatches()`, `getMatchDetail(id)`
- [ ] Retry wrapper reused/adapted from Repo Radar
- [ ] Custom error classes: `ApiRateLimitError`, `ApiUnavailableError`, `ApiParseError`
- [ ] Logging on every external call (success/failure/retry) via your logger util

**Checkpoint:** Killing your internet mid-request produces a clean error log, not a crash. Simulate a bad API key and confirm you get a clear `ApiRateLimitError` or similar, not a generic exception.

---

## Phase 4 — Background Polling Job (BullMQ)

This is where the project stops being "just another REST API."

### Steps
1. Set up a BullMQ queue + worker backed by Redis.
2. Create a **repeatable job** (BullMQ supports cron-like repeat options) that runs every 30-60 seconds.
3. Job logic: fetch live matches → compare against last-cached snapshot → if changed, update cache AND emit an event (Phase 6 hooks into this).
4. Think carefully about **idempotency** — if the job runs twice or overlaps, it shouldn't cause duplicate notifications or corrupted cache state.

### Todos
- [ ] `src/jobs/pollScores.js`: BullMQ queue + worker setup
- [ ] Repeatable job scheduled on app startup (every 30-60s)
- [ ] Job compares new data vs previous cached snapshot (diffing logic — what actually changed?)
- [ ] On change: update Redis cache (Phase 5) and emit a `matchUpdated` event (Phase 7)
- [ ] Job failures logged but don't crash the app — BullMQ has built-in retry, configure it (e.g. 3 attempts, exponential backoff)
- [ ] Graceful shutdown: worker stops cleanly on `SIGTERM`/`SIGINT`, no half-written state

**Checkpoint:** Start the app, watch logs — every 30-60s you see "polled X matches, Y changed" (or similar), running continuously without you triggering anything manually.

---

## Phase 5 — Caching Layer (Redis)

### Steps
1. Instead of hitting the cricket API on every `GET /matches/live` request, serve from Redis.
2. The background job (Phase 4) is the **only** thing that writes fresh data into the cache.
3. Set a reasonable TTL as a safety net (e.g. 2 minutes) in case the background job stalls — don't serve infinitely stale data silently.
4. Structure cache keys sensibly: `match:live:list`, `match:detail:{id}`.

### Todos
- [ ] `src/cache/redisClient.js`: connection setup, `get`/`set` helpers with JSON serialize/deserialize
- [ ] `GET /matches/live` now reads from Redis, not the API directly
- [ ] `GET /matches/:id` reads from Redis, falls back to a direct API call only if cache miss (log this fallback — it should be rare)
- [ ] TTL set on all cached keys
- [ ] Verify: turn off the background job, confirm the API still serves (slightly stale) cached data instead of erroring

**Checkpoint:** Response times for `/matches/live` are near-instant (cache hit) vs noticeably slower on a cold cache miss — you should be able to feel/measure this difference.

---

## Phase 6 — Real-Time Push (WebSockets)

The "wow, this actually works" phase.

### Steps
1. Set up Socket.io (or raw `ws` if you want to go rawer/harder) alongside your Fastify server.
2. Clients connect and "join a room" per match they're viewing (e.g. `socket.join('match:123')`).
3. When the background job (Phase 4) detects a change and emits `matchUpdated`, broadcast that update to everyone in the relevant room.
4. Build a minimal test client (a plain HTML file with a script tag is enough — you don't need React for this) to actually *see* two tabs updating live.

### Todos
- [ ] `src/realtime/socket.js`: Socket.io server attached to Fastify's underlying HTTP server
- [ ] Client `join-match` event → server joins socket to `match:{id}` room
- [ ] Background job's `matchUpdated` event triggers `io.to('match:{id}').emit('scoreUpdate', data)`
- [ ] Minimal test HTML client: connects, joins a match, logs incoming `scoreUpdate` events to the page
- [ ] Handle disconnects cleanly (no memory leaks from dangling room memberships)

**Checkpoint:** Open two browser tabs, both viewing the same match. Manually trigger a fake score change (or wait for a real one) — both tabs update within seconds, no page refresh.

---

## Phase 7 — Event-Driven Notifications (`EventEmitter`)

### Steps
1. Create a central `EventEmitter` instance (a "notifier" module) that the polling job emits events into — decouple "detecting a change" from "deciding what to do about it."
2. Listen for specific event types: `wicketFallen`, `milestoneReached`, `matchStarted`.
3. For each event, check: does any user follow this team/player? If yes, create a notification record (simplest version: a `Notification` table in Postgres, or even just a structured log line — pick based on how far you want to take it).
4. This is the payoff for keeping things decoupled — your notification logic doesn't need to know anything about polling, Redis, or WebSockets; it just reacts to events.

### Todos
- [ ] `src/events/notifier.js`: `EventEmitter` instance, exported as a singleton
- [ ] Polling job emits `wicketFallen`, `milestoneReached`, `matchStarted` with relevant payload (match id, player id, team id)
- [ ] Listener(s) in `notifier.js` (or a separate `notificationHandlers.js`) query which users follow the relevant team/player
- [ ] Store notifications (Postgres table: `Notification { userId, message, matchId, read, createdAt }`) or log clearly if skipping DB storage
- [ ] `GET /notifications` — protected route, returns current user's notifications

**Checkpoint:** Follow a specific team, simulate (or wait for) a match event involving them, confirm a notification is created and retrievable via the API.

---

## Phase 8 — Error Handling & Resilience Pass

Go back through the entire system end-to-end.

### Todos
- [ ] Cricket API down entirely → background job logs failure, doesn't crash, retries next cycle
- [ ] Redis connection drops → app logs error, falls back to direct API calls temporarily (or fails gracefully with clear error), reconnects automatically when Redis returns
- [ ] Postgres connection drops → Fastify returns 503 with clear message, doesn't crash the whole process
- [ ] Invalid/expired JWT → consistent 401 response, not a stack trace
- [ ] WebSocket client disconnects mid-session → no server-side errors, room cleanup happens
- [ ] Malformed data from cricket API (missing fields, unexpected shape) → caught by your `ApiParseError` handling from Phase 3, doesn't propagate as a crash

---

## Phase 9 — Dockerize Everything

### Steps
1. Add a `Dockerfile` for the Node app itself (not just Postgres/Redis).
2. Extend `docker-compose.yml` to include the app, Postgres, and Redis as a full stack.
3. Confirm environment variables flow correctly between containers (service names as hostnames, not `localhost`).

### Todos
- [ ] `Dockerfile` for the Node app (multi-stage build recommended: install deps → run)
- [ ] `docker-compose.yml` updated: `app`, `postgres`, `redis` services, proper `depends_on` and networking
- [ ] `docker compose up` brings up the entire stack from scratch, migrations run automatically (or via a documented manual step)
- [ ] README documents exact steps to run the whole thing fresh on another machine

**Checkpoint:** Someone else (or you, on a clean machine/VM) can clone the repo, add a `.env`, run `docker compose up`, and have the whole thing working without manual troubleshooting.

---

## Phase 10 — Polish & Stretch Goals

### Todos
- [ ] Rate-limit your own API (protect against abuse) — e.g. `@fastify/rate-limit` plugin
- [ ] Add pagination to `/notifications` and `/matches/live` if lists get long
- [ ] Structured logging with `pino` instead of `console.log` everywhere
- [ ] Basic tests with Vitest + `supertest` (or Fastify's built-in `inject`) for at least the auth and follows routes
- [ ] Swap the minimal HTML test client for a tiny React page (quick win given your frontend background) showing live scores updating in real time — this makes the project demo-able and genuinely satisfying to show off

---

## Definition of Done

A fully running stack (via `docker compose up`) where:
1. A user can sign up, log in, and follow teams/players
2. Live match data is fetched, cached, and served fast on repeat requests
3. A background job continuously polls for updates without manual triggering
4. Score changes push instantly to connected clients via WebSocket, no polling from the frontend
5. Followed-team/player events generate retrievable notifications
6. The entire system survives external API failures, Redis drops, and bad input without crashing

---

## What You Should Walk Away Understanding

- How to run a **long-lived, stateful** Node process (vs Repo Radar's one-shot CLI)
- Background job/queue patterns in Node (BullMQ) — and how directly this maps to what you already know from Celery
- Caching strategy: what to cache, for how long, and what happens on a miss
- Real-time bidirectional communication — a genuine strength of Node over typical Django setups
- Event-driven design with `EventEmitter` — decoupling "something happened" from "here's what to do about it"
- How all of Repo Radar's lessons (retry, backoff, error handling) apply just as much in a persistent server as they did in a CLI tool
