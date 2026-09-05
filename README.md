# PitchPulse

A live cricket score tracker built to learn real-world Node.js backend
patterns — REST APIs, background jobs, caching, WebSockets, and event-driven
architecture. See [`pitchpulse-project-docs.md`](./pitchpulse-project-docs.md)
for the full 10-phase build plan, and [`issues/`](./issues) for the phase-by-phase
issue breakdown.

This README currently covers **Phase 0 (Setup)**, **Phase 1 (Database
Schema & Auth)**, and **Phase 2 (Core REST Endpoints — Follows + Match
Listing)**.

## Cricket data source decision

We evaluated [CricAPI](https://cricapi.com/) and
[Cricket Data API](https://cricketdata.org/). Both require signup and issue
rate-limited API keys, and at this stage of the project we haven't registered
for and validated a live key against real network access.

Per the project docs' explicit fallback clause, we deferred live API
integration and built Phase 3's client with a **pluggable data source**:

- **Mock provider (default):** used whenever `CRICKET_API_KEY` is empty.
  Emits the same external response shape a real API would (so both providers
  flow through one parse/normalize path), evolves live matches' scores/overs
  on a wall-clock basis, and can inject timeout / 429 / 500 / malformed-body
  failures on demand (`CRICKET_MOCK_FAIL`, or `__setMockFailure()` in tests).
- **HTTP provider:** real `fetch` against `CRICKET_API_BASE_URL`
  (CricAPI-style `/currentMatches` + `/match_info`), used when
  `CRICKET_API_KEY` is set.

The resilience layer — retry with backoff, rate-limit handling, defensive
parsing, logging, typed errors — is **identical for both**. Obtaining a real
key later is a config change; no consumer moves. See "External API client"
below.

## Project structure

```
pitch-pulse/
├── src/
│   ├── server.js            # Fastify app entrypoint
│   ├── routes/
│   │   ├── auth.js          # signup / login / me
│   │   ├── matches.js       # GET /matches/live, GET /matches/:id (via cricketApiClient)
│   │   └── follows.js       # follow/unfollow team/player, GET /follows
│   ├── plugins/
│   │   ├── authenticate.js  # JWT auth hook (fastify.authenticate)
│   │   └── errorHandler.js  # centralized setErrorHandler / setNotFoundHandler
│   ├── errors.js            # NotFoundError + ApiRateLimit/Unavailable/ParseError
│   ├── jobs/
│   │   └── pollScores.js    # stub — Phase 4
│   ├── realtime/
│   │   └── socket.js        # stub — Phase 6
│   ├── events/
│   │   └── notifier.js      # stub — Phase 7
│   ├── cache/
│   │   └── redisClient.js   # ioredis client
│   ├── lib/
│   │   ├── prisma.js        # PrismaClient singleton
│   │   ├── cricketApiClient.js # resilient client — getLiveMatches / getMatchDetail (Phase 3)
│   │   ├── retry.js         # generic withRetry(fn, opts) — jittered backoff
│   │   ├── cricketSchemas.js # loose Zod schemas + normalize to internal shape
│   │   ├── mockCricketApi.js # default data provider (evolving scores, failure injection)
│   │   └── mockMatches.js   # fixture seed for mockCricketApi (Phase 2 shape)
│   ├── schemas/
│   │   ├── auth.js          # zod schemas
│   │   ├── follows.js       # zod schemas (teamId/playerId params)
│   │   └── matches.js       # zod schema (match id param)
│   └── utils/
│       └── logger.js        # leveled console logger
├── prisma/
│   ├── schema.prisma
│   └── seed.js               # sample Team/Player rows (npx prisma db seed)
├── docker-compose.yml
├── .env.example
└── package.json
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the env template and adjust if needed:
   ```bash
   cp .env.example .env
   ```
   (`JWT_SECRET` should be a long random string in real use — see below.)
3. Start Postgres and Redis:
   ```bash
   docker compose up -d
   ```
   > **Note:** Postgres is mapped to host port **5434** (not the default 5432)
   > to avoid clashing with any other local Postgres instance. `DATABASE_URL`
   > in `.env.example` already reflects this.
4. Run the initial migration:
   ```bash
   npx prisma migrate dev --name init
   ```
5. Seed a handful of `Team`/`Player` rows (needed to exercise the follow
   endpoints — see "Follows & Matches" below):
   ```bash
   npx prisma db seed
   ```
6. Start the dev server (auto-restarts on file changes via `node --watch`):
   ```bash
   npm run dev
   ```

## Docker Compose usage

- `docker compose up -d` — start Postgres + Redis in the background
- `docker compose ps` — check container/health status
- `docker compose logs -f postgres` / `redis` — tail logs
- `docker compose down` — stop and remove containers (data persists in named volumes)
- `docker compose down -v` — stop and also wipe the volumes (fresh DB/cache)

Only `postgres` and `redis` are containerized for now — the Node app runs
locally against them. Dockerizing the app itself is Phase 9.

## Prisma workflow

- `npm run prisma:migrate` — create/apply a migration in dev
- `npm run prisma:generate` — regenerate the Prisma client after schema changes
- `npm run prisma:studio` — open Prisma Studio to browse data

Match data is **not** modeled in Postgres — it's transient/live and lives in
Redis instead (see Phase 5). Postgres only holds `User`, `Team`, `Player`,
and the `FollowedTeam` / `FollowedPlayer` join tables.

- `npx prisma db seed` — run `prisma/seed.js`, which check-then-creates 4
  `Team` rows and 8 `Player` rows (idempotent — safe to re-run; it logs each
  row's id so you can copy-paste them into the curl commands below).

## Centralized error handling

`src/plugins/errorHandler.js` registers a single `fastify.setErrorHandler`
(plus `setNotFoundHandler` for unmatched routes) on the root instance,
covering every route added from Phase 2 onward. Anything a handler *throws*
— a Zod `ZodError`, a Prisma unique-constraint violation, a thrown
`NotFoundError` (`src/errors.js`), or any other bug — resolves to the same
`{ "error": { "message": "...", "code": "..." } }` shape, never a raw stack
trace or Fastify's default `{ statusCode, error, message }` body:

| Error                                          | Status | `code`             |
| ----------------------------------------------- | ------ | ------------------ |
| `ZodError` (invalid params/body)                 | 400    | `VALIDATION_ERROR`  |
| `NotFoundError` (unknown team/player/match)       | 404    | `NOT_FOUND`         |
| Unmatched route                                  | 404    | `NOT_FOUND`         |
| Prisma `P2002` (duplicate follow)                | 409    | `ALREADY_FOLLOWING` |
| `ApiParseError` (bad upstream shape)             | 502    | `BAD_GATEWAY`       |
| `ApiRateLimitError` / `ApiUnavailableError`      | 503    | `SERVICE_UNAVAILABLE` |
| Anything else                                    | 500    | `INTERNAL_ERROR`    |

Routes that already build their own response directly (auth.js's 401s/409s,
authenticate.js's 401s) never throw, so they're unaffected by this handler —
it's purely the fallback for everything that does.

The 502/503 rows fire when a `/matches/*` route calls the cricket API client
and the upstream provider misbehaves — a `Retry-After` header is echoed on the
503 when the client knows one. Phase 4's polling job catches these itself
(logs, keeps going) and never reaches this handler.

## External API client

`src/lib/cricketApiClient.js` is the **only** way the app gets match data —
`getLiveMatches()` and `getMatchDetail(id)`, both returning the internal shape
`{ id, teams, status, score, overs }`. No `fetch` or `console.*` lives outside
this module (and `retry.js`). It picks the mock or HTTP provider from config
(see "Cricket data source decision"), then runs every call through one
pipeline: rate-limit gate → `withRetry` → Zod parse → normalize → log.

**Typed errors** (`src/errors.js`), thrown by the client:

| Error                 | Thrown when                                             | Carries                                   | HTTP (direct route call) |
| --------------------- | ------------------------------------------------------ | ----------------------------------------- | ------------------------ |
| `ApiRateLimitError`   | HTTP 429, or a known-exhausted quota (no request made) | `retryAfterMs`, `endpoint`                | 503 + `Retry-After`      |
| `ApiUnavailableError` | network / timeout / HTTP 5xx / auth rejected (401/403) | `cause`, `status`, `endpoint`, `attempts` | 503                      |
| `ApiParseError`       | HTTP 200 but the body shape isn't what we expect       | `endpoint`, `issues` (Zod `flatten()`)    | 502                      |

**Retry / rate-limit behavior:**

| Concern             | Behavior                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Backoff             | full jitter — `delay = random(0, baseDelayMs * 2 ** attempt)`, capped at `maxDelayMs` (5000) |
| Attempts            | `CRICKET_API_MAX_RETRIES` *total* tries (default 3); terminal error carries `attempts`     |
| What retries        | network errors, timeouts, HTTP 5xx, HTTP 429 — nothing else                                |
| What never retries  | HTTP 4xx ≠ 429 (401/403/404/400) — a bad key won't fix itself by waiting                   |
| `Retry-After`       | honoured (delta-seconds or HTTP-date) on a 429, used instead of the computed backoff       |
| Quota headers       | `X-RateLimit-*` / CricAPI `info.hitsToday`/`hitsLimit` read; at 0, next call fails fast    |
| Min spacing         | `CRICKET_API_MIN_INTERVAL_MS` (default 1000) between outbound calls; set `0` to disable    |
| Per-attempt timeout | `AbortController` at `CRICKET_API_TIMEOUT_MS` (default 8000) → clean abort, not a hang     |
| Logging             | start `debug`, success `info`, each retry `warn`, terminal failure `error` — via `logger`  |

A circuit breaker / provider-health endpoint is a **TODO**, deliberately not
built in this phase.

Config lives in `.env` (see `.env.example`): `CRICKET_API_KEY`,
`CRICKET_API_BASE_URL`, `CRICKET_API_TIMEOUT_MS`, `CRICKET_API_MAX_RETRIES`,
`CRICKET_API_MIN_INTERVAL_MS`. `CRICKET_MOCK_FAIL` (`<kind>[:<mode>[:<n>]]`,
kind = `timeout|429|500|malformed`, mode = `once|always|everyNth`) forces the
mock provider to fail — how the resilience paths are demoed without a real key.

## Follows & Matches — manual verification

**Design decisions:**
- `GET /matches/live` and `GET /matches/:id` are **protected**
  (`Authorization: Bearer <token>` required), for consistency with the rest
  of the API surface, even though nothing on them is user-specific yet.
- `DELETE /follows/team/:teamId` and `DELETE /follows/player/:playerId`
  return **404 `NOT_FOUND`** if the user isn't currently following that
  resource, rather than silently succeeding — this is a deliberate,
  non-idempotent choice so callers get explicit feedback on a no-op delete.
- `/matches/*` is backed by a small fixed set of **mock** matches
  (`src/lib/mockMatches.js`) — real cricket API integration is Phase 3.

With the server running (`npm run dev`), Postgres/Redis up, and
`npx prisma db seed` already run:

```bash
# Signup + login (reuse the Auth section above) to get a token, then:
TOKEN="<token from login>"

# Grab a team id + player id from the seed script's console output, e.g.:
TEAM_ID="<India's id from the seed output>"
PLAYER_ID="<Virat Kohli's id from the seed output>"

# Follow a team — expect 201 with { id, teamId, createdAt }
curl -i -X POST http://localhost:3000/follows/team/$TEAM_ID \
  -H "Authorization: Bearer $TOKEN"

# Follow the same team again — expect 409 ALREADY_FOLLOWING
curl -i -X POST http://localhost:3000/follows/team/$TEAM_ID \
  -H "Authorization: Bearer $TOKEN"

# Follow an unknown team — expect 404 NOT_FOUND
curl -i -X POST http://localhost:3000/follows/team/00000000-0000-0000-0000-000000000000 \
  -H "Authorization: Bearer $TOKEN"

# Malformed teamId — expect 400 VALIDATION_ERROR
curl -i -X POST http://localhost:3000/follows/team/not-a-uuid \
  -H "Authorization: Bearer $TOKEN"

# Follow a player — expect 201
curl -i -X POST http://localhost:3000/follows/player/$PLAYER_ID \
  -H "Authorization: Bearer $TOKEN"

# See your follows — expect { teams: [...], players: [...] }
curl -i http://localhost:3000/follows -H "Authorization: Bearer $TOKEN"

# Unfollow the team — expect 204 No Content
curl -i -X DELETE http://localhost:3000/follows/team/$TEAM_ID \
  -H "Authorization: Bearer $TOKEN"

# Unfollow it again — expect 404 NOT_FOUND (not currently following)
curl -i -X DELETE http://localhost:3000/follows/team/$TEAM_ID \
  -H "Authorization: Bearer $TOKEN"

# Live matches — expect 200 with an array of mock matches
curl -i http://localhost:3000/matches/live -H "Authorization: Bearer $TOKEN"

# One match by id — expect 200 (use an id from the /matches/live response)
curl -i http://localhost:3000/matches/1 -H "Authorization: Bearer $TOKEN"

# Unknown match id — expect 404 NOT_FOUND
curl -i http://localhost:3000/matches/999 -H "Authorization: Bearer $TOKEN"

# No token on a protected route — expect a clean 401, not a stack trace
curl -i http://localhost:3000/matches/live

# Undefined route — expect 404 NOT_FOUND (not Fastify's default 404 shape)
curl -i http://localhost:3000/nonsense
```

## Auth — manual verification

With the server running (`npm run dev`) and Postgres/Redis up:

```bash
# Signup — expect 201, body has id/email/createdAt, no password field
curl -i -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"password123"}'

# Duplicate signup — expect 409 EMAIL_TAKEN
curl -i -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"password123"}'

# Login — expect 200 with { "token": "..." }
curl -i -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"password123"}'

# Wrong password — expect 401 INVALID_CREDENTIALS
curl -i -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"wrongpass"}'

# GET /me with a valid token — expect 200 with { id, email }
curl -i http://localhost:3000/me -H "Authorization: Bearer <token from login>"

# GET /me with no token — expect a clean 401, not a stack trace
curl -i http://localhost:3000/me

# GET /me with a garbage token — expect a clean 401, not a 500
curl -i http://localhost:3000/me -H "Authorization: Bearer garbage.token.value"
```

All error responses use a consistent shape: `{ "error": { "message": "...", "code": "..." } }`.
From Phase 2 onward this is enforced centrally for every route — see
"Centralized error handling" above for the full list of codes.
