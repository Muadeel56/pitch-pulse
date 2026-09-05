# PitchPulse — Project Build Docs

**Goal:** Master real-world Node.js backend patterns — REST APIs, background jobs, caching, real-time communication, and event-driven architecture — by building a live cricket score tracker that polls external data, caches it, pushes updates in real time, and notifies users about things they follow. **A React frontend is built alongside the backend, phase by phase, learning React from first principles — no framework magic, tools added only when the problem they solve is actually felt.**

**Estimated time:** 7–10 focused days for the backend, plus ~5–7 more if you build the full frontend track (they interleave — see "Frontend Track" below)
**Backend stack:** Fastify, Prisma, PostgreSQL, Redis, BullMQ, Socket.io (or `ws`), Zod, JWT, Docker Compose
**Frontend stack:** React + Vite (plain JavaScript first), `fetch` → TanStack Query, react-router, socket.io-client, plain CSS / CSS Modules. Deliberately **no** Next.js, Redux, TypeScript, Tailwind, or UI kit at the start — each is introduced later, only when you've hit the wall it exists for.

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
├── src/                         # backend (Fastify)
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
├── client/                      # frontend (React + Vite) — added in the Frontend Track
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── api/          client.js — the ONLY place that calls fetch
│   │   ├── auth/         AuthProvider.jsx, useAuth.js
│   │   ├── components/   MatchCard.jsx, ...
│   │   ├── pages/        MatchesPage.jsx, MatchDetailPage.jsx, LoginPage.jsx, ...
│   │   └── hooks/        useMatchSocket.js, ...
│   ├── index.html
│   └── package.json
├── prisma/
│   └── schema.prisma
├── docker-compose.yml
├── .env
├── package.json
└── README.md
```

The backend runs on `:3000`, the Vite dev server on `:5173`. Configure Vite's dev proxy so `/auth`, `/matches`, `/follows` requests forward to `:3000` during development, and add `@fastify/cors` to the backend (Frontend Phase A) for when they run on separate origins.

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

> **Frontend hook-in:** the endpoints from this phase are exactly what **Frontend Phase A** consumes. Once this checkpoint passes, you can start the React app against a real, stable API — no need to wait for the later backend phases.

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
- [ ] Swap the minimal HTML test client for the full React app (see the **Frontend Track** below) showing live scores updating in real time — this makes the project demo-able and genuinely satisfying to show off

---

## Frontend Track (React) — learn React from first principles

Built **alongside** the backend, not after it. Each frontend phase pairs with a backend phase and consumes what that phase produced. Same format as above: Steps, Todos, Checkpoint.

**The one rule: feel the pain before you reach for the library.** Every tool below (router, TanStack Query, Context, TypeScript) is introduced at the exact point you've already hit the problem it solves by hand. If you adopt it earlier, it's just magic you can't reason about.

**Start with — and ONLY with:** Vite + React, plain JavaScript (no TS), `fetch` (no axios/no data lib), `useState` + `useEffect` (no state manager), plain CSS or CSS Modules (no Tailwind, no component kit).

**Add later, when it hurts:** react-router → TanStack Query → Context → a WebSocket custom hook → (optionally) TypeScript → (optionally) Tailwind.

---

### Frontend Phase A — React fundamentals

*Pairs with backend Phase 2 (already done — auth, follows, matches endpoints are live).*

#### Steps
1. `npm create vite@latest client -- --template react` (JavaScript, not TS). Delete the boilerplate CSS/logo noise.
2. Configure `vite.config.js` dev proxy: `/auth`, `/matches`, `/follows` → `http://localhost:3000`.
3. Add `@fastify/cors` to the backend, allowing the Vite origin — needed once frontend and backend are served separately.
4. Build a **static** matches list first (hardcoded array → `.map()` → `<MatchCard>`), THEN make it real with `fetch` in `useEffect`.
5. Write the loading / error / empty / data branches by hand. This boilerplate is exactly what TanStack Query deletes for you later — you need to have written it once.
6. Build login + signup forms as **controlled inputs**; store the returned JWT in `useState`, then persist to `localStorage`.

#### Todos
- [ ] `client/` scaffolded with Vite, dev proxy working, `@fastify/cors` on the backend
- [ ] `<MatchCard>` component — props only, no state
- [ ] `MatchesPage` — `fetch('/matches/live')` in `useEffect`, handles loading/error/empty/data
- [ ] Correct `key` on the mapped list (understand why index-as-key is a trap)
- [ ] `LoginPage` / `SignupPage` — controlled forms, submit to `POST /auth/login` & `/auth/signup`
- [ ] JWT stored in state + `localStorage`; render differs when logged in vs out (conditional rendering)
- [ ] Backend errors (`{ error: { message, code } }`) surfaced in the form UI
- [ ] Effect cleanup / ignore-flag so a fast unmount doesn't set state on a dead component (you'll see React's StrictMode double-invoke in dev — that's the lesson, not a bug)

**Core concepts locked in:** components, props vs state, JSX, event handlers, `useEffect` + dependency array + cleanup, conditional & list rendering, lifting state up.

**Checkpoint:** You can open the React app, see real matches from the backend, sign up, log in, and the UI changes based on auth state. Every fetch state (loading, error, empty) is visibly handled — no blank screens, no uncaught promise rejections in the console.

---

### Frontend Phase B — Routing & auth context

*Pairs with backend Phase 3 (external API client). Mirror on the frontend: wrap all backend calls in one `client/src/api/client.js` — never call `fetch` from a component, just like the backend never calls `fetch` from a route.*

#### Steps
1. Add **react-router**. Routes: `/login`, `/signup`, `/matches`, `/matches/:id`, `/follows`.
2. Build a `<ProtectedRoute>` that redirects to `/login` when there's no token.
3. You've now prop-drilled `token` through several layers and it hurts — **that's why** you now lift it into a `<AuthProvider>` using `useContext`. Expose a `useAuth()` custom hook (`{ user, token, login, logout }`).
4. `api/client.js` reads the token and attaches `Authorization: Bearer <token>`; on `401` it triggers `logout()`. It throws typed errors mirroring the backend's error codes.

#### Todos
- [ ] react-router installed; nested layout route with a shared `<NavBar>`
- [ ] `useParams` drives `MatchDetailPage` (`/matches/:id` → `GET /matches/:id`, handle 404 → "Match not found" UI)
- [ ] `useNavigate` for post-login redirect
- [ ] `<ProtectedRoute>` wrapping `/matches`, `/matches/:id`, `/follows`
- [ ] `AuthProvider` + `useAuth()` custom hook; token drilling removed
- [ ] `api/client.js` — single module, attaches auth header, centralizes base URL + error parsing
- [ ] Follow / unfollow buttons on team/player views calling `POST`/`DELETE /follows/...`
- [ ] `/follows` page listing the current user's followed teams & players (`GET /follows`)

**Core concepts locked in:** client-side routing, route params, protected routes, layouts; `useContext`; custom hooks; why prop drilling is a smell and Context is the fix.

**Checkpoint:** Deep-linking to `/matches/2` works on a page refresh. Hitting a protected route while logged out bounces you to `/login` and back after login. No component receives `token` as a prop anymore.

---

### Frontend Phase C — Server state done right (TanStack Query)

*Pairs with backend Phases 4–5 (background polling + Redis cache). The backend now serves cached data fast and refreshes it on a timer — the frontend should reflect that freshness without you wiring refetch logic by hand.*

#### Steps
1. You've hand-written `useEffect` + `useState` fetching 4+ times now. Install **`@tanstack/react-query`** — you'll immediately recognize everything it gives you as boilerplate you already wrote.
2. Convert reads to `useQuery` (query keys: `['matches','live']`, `['matches', id]`, `['follows']`).
3. Convert follow/unfollow to `useMutation` with **optimistic updates** and `invalidateQueries` on settle.
4. Set a `refetchInterval` on the live matches query roughly matching the backend poll cadence, and/or `refetchOnWindowFocus`.

#### Todos
- [ ] `QueryClientProvider` at the app root
- [ ] All GETs migrated to `useQuery`; manual loading/error state deleted
- [ ] `useMutation` for follow/unfollow, optimistic update + rollback on error + invalidate on settle
- [ ] `refetchInterval` on `['matches','live']`
- [ ] React Query Devtools wired in dev
- [ ] A visible "updated Xs ago" indicator driven by `dataUpdatedAt`

**Core concepts locked in:** the distinction between **server state and client (UI) state**; query keys & cache invalidation; mutations; optimistic UI; staleness vs cache time.

**Checkpoint:** Follow a team — the button flips instantly (optimistic), and reverts cleanly if the request fails. The live matches list visibly refreshes on its own. You deleted more code than you added.

---

### Frontend Phase D — Real-time (WebSockets)

*Pairs with backend Phase 6 (Socket.io). The polling job emits `matchUpdated`; the server broadcasts `scoreUpdate` to a room per match.*

#### Steps
1. `npm i socket.io-client`.
2. Build a `useMatchSocket(matchId)` custom hook: connect on mount, `socket.emit('join-match', matchId)`, subscribe to `scoreUpdate`, and **clean up fully** on unmount / when `matchId` changes.
3. On a `scoreUpdate`, update the React Query cache directly (`queryClient.setQueryData(['matches', id], ...)`) instead of refetching — the socket IS the fresh data.
4. Store the socket instance in a `useRef` (it's not render state).

#### Todos
- [ ] `useMatchSocket(matchId)` hook — connect / join / listen / cleanup, no dangling listeners
- [ ] Socket instance held in `useRef`, not `useState`
- [ ] `scoreUpdate` payload written into the Query cache via `setQueryData`
- [ ] Connection status indicator (connecting / live / reconnecting)
- [ ] Leaves the match room on unmount; reconnect handling doesn't double-subscribe
- [ ] Watch out for **stale closures** in the socket handler — the classic React real-time bug

**Core concepts locked in:** `useRef` for mutable non-render values; effect cleanup for real; custom hooks that encapsulate a side-effecting resource; stale-closure pitfalls.

**Checkpoint:** Open two browser tabs on the same match. Trigger a score change on the backend (or wait for the mock generator). Both tabs update within seconds, no refresh, and the Network tab shows **no polling** — the update arrived over the socket.

---

### Frontend Phase E — Notifications & polish

*Pairs with backend Phases 7 & 10 (event-driven notifications + polish).*

#### Steps
1. Notifications bell in the navbar: `GET /notifications` via `useQuery` (or push over the socket if the backend supports it), unread badge count.
2. Mark-as-read `useMutation`.
3. Polish pass: loading **skeletons** (not spinners), an `<ErrorBoundary>` around each route, real empty states, pagination on long lists.
4. Add `React.memo` / `useMemo` / `useCallback` **only where React Devtools Profiler shows a real wasted render** — learn them, don't cargo-cult them.
5. Optional: convert `client/` to **TypeScript** now that the data shapes are stable — type the API client responses first.

#### Todos
- [ ] Notifications page + navbar bell with unread count
- [ ] Mark-as-read mutation with cache update
- [ ] `<ErrorBoundary>` per route; a global fallback UI
- [ ] Loading skeletons for `MatchesPage` and `NotificationsPage`
- [ ] Pagination or infinite scroll on `/notifications` and `/matches/live` (matches backend Phase 10 pagination)
- [ ] Profiler-verified memoization only where it measurably helps
- [ ] (Optional) TypeScript migration, starting from `api/client.js`
- [ ] (Optional) extract a tiny design-token CSS file; Tailwind only if you actively want it

**Core concepts locked in:** error boundaries; perceived-performance patterns; when NOT to memoize; (optionally) typing an API boundary.

**Checkpoint:** Follow a team, trigger a match event involving them on the backend, and a notification appears in the bell without a manual refresh. Every route survives a thrown error with a friendly fallback instead of a white screen.

---

### React mastery checklist (tick as you go)

- [ ] Components, props, composition via `children`
- [ ] `useState` — immutable updates, updater functions
- [ ] `useEffect` — dependency array, cleanup, StrictMode double-invoke
- [ ] Lists, keys, why index-as-key bites
- [ ] Controlled forms
- [ ] Lifting state up vs prop drilling
- [ ] `useContext` + custom hooks
- [ ] `useReducer` for complex local state
- [ ] `useRef` — DOM refs AND mutable non-render values
- [ ] Routing: params, navigation, protected routes, nested layouts
- [ ] Server state vs client state
- [ ] Data fetching: loading/error/success, race conditions, cleanup
- [ ] Mutations + optimistic updates + cache invalidation
- [ ] Memoization — and when not to
- [ ] Error boundaries
- [ ] WebSocket integration via a custom hook
- [ ] Stale-closure debugging

---

## Definition of Done

A fully running stack (via `docker compose up`) where:
1. A user can sign up, log in, and follow teams/players
2. Live match data is fetched, cached, and served fast on repeat requests
3. A background job continuously polls for updates without manual triggering
4. Score changes push instantly to connected clients via WebSocket, no polling from the frontend
5. Followed-team/player events generate retrievable notifications
6. The entire system survives external API failures, Redis drops, and bad input without crashing
7. **A React frontend (in `client/`) covers the full flow: sign up / log in, browse & follow, and watch a match page update live over a WebSocket with no polling — every route handles loading, empty, and error states without a blank screen**

---

## What You Should Walk Away Understanding

- How to run a **long-lived, stateful** Node process (vs Repo Radar's one-shot CLI)
- Background job/queue patterns in Node (BullMQ) — and how directly this maps to what you already know from Celery
- Caching strategy: what to cache, for how long, and what happens on a miss
- Real-time bidirectional communication — a genuine strength of Node over typical Django setups
- Event-driven design with `EventEmitter` — decoupling "something happened" from "here's what to do about it"
- How all of Repo Radar's lessons (retry, backoff, error handling) apply just as much in a persistent server as they did in a CLI tool

### On the frontend side

- React's core model: components, props vs state, one-way data flow, and why re-renders happen
- The `useEffect` lifecycle for real — dependencies, cleanup, and the classes of bug that come from getting it wrong
- The difference between **server state** and **client/UI state**, and why a data library (TanStack Query) exists
- Client-side routing, protected routes, and sharing cross-cutting state with Context instead of prop drilling
- Consuming a real-time WebSocket feed from React without leaks or stale closures
- Why the "feel the pain first" approach makes each added tool (router, query lib, Context, TS) something you can actually reason about
