# Issue #1: Project Setup & Auth Foundation (Phase 0 + Phase 1)

**Labels:** `setup`, `backend`, `auth`
**Milestone:** PitchPulse — Foundation
**Estimated effort:** 1–2 days

## Summary

Bootstrap the PitchPulse project end-to-end: pick a cricket data source, scaffold
the repo, stand up Postgres + Redis via Docker Compose, then build the Prisma
schema and JWT-based auth (signup/login/`GET /me`) so every later phase has a
working project skeleton and a way to identify a request's user.

This issue covers **Phase 0 (Setup & Planning)** and **Phase 1 (Database Schema
& Auth)** from the project docs. It's the foundation every other phase builds on
— nothing here should require touching cricket-match logic yet.

---

## Background / Context

PitchPulse is a live cricket score tracker built to learn real-world Node
backend patterns: REST APIs, background jobs, caching, WebSockets, and
event-driven architecture. See `pitchpulse-project-docs.md` for the full
10-phase plan. This issue is just the first two phases, combined because
neither is useful in isolation — Phase 1's auth routes need Phase 0's scaffold
and running Postgres to exist first.

---

## Scope

### Part A — Data source & project scaffold (Phase 0)

1. **Evaluate a cricket data source** before writing any code:
   - [CricAPI](https://cricapi.com/)
   - [Cricket Data API](https://cricketdata.org/)
   - any other free-tier live-score API
   - Check current free-tier request limits — they change often, don't trust docs from memory.
   - **Fallback:** if every free tier is too restrictive, build a mock data
     generator (random score increments every few seconds) instead. This still
     teaches 100% of the Node concepts — don't let API access block progress.
   - Get an API key and issue **one manual request** via `curl`/Postman before
     writing any client code. Confirm the actual response shape — free cricket
     APIs are notorious for docs that don't match reality.

2. **Initialize the project**
   - `npm init -y`
   - Set `"type": "module"` in `package.json`
   - Install core deps: `fastify @prisma/client prisma zod jsonwebtoken bcrypt ioredis bullmq socket.io dotenv`
   - Add `-D` dev deps as needed (e.g. `nodemon` or `--watch`, later `vitest`)

3. **Scaffold the folder structure:**
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
   - `matches.js`, `pollScores.js`, `socket.js`, `notifier.js`, `cricketApiClient.js`
     can be empty stub files for now (later phases fill them in) — the point here
     is the shape of the project existing, not full implementations.

4. **Environment config**
   - `.env` with `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CRICKET_API_KEY`
   - `.env.example` committed (no real secrets) so the repo is cloneable
   - `.gitignore` covering `.env`, `node_modules`

5. **`docker-compose.yml`** with `postgres` and `redis` services only for now
   (the Node app itself gets containerized later, in Phase 9). Node runs
   locally against these two containers.

**Checkpoint A:** `docker compose up -d` starts Postgres + Redis; you can
connect to both manually (`psql`, `redis-cli`) and confirm they're reachable.

---

### Part B — Database schema & JWT auth (Phase 1)

1. **Design the Prisma schema** — `User`, `Team`, `Player`, `FollowedTeam`
   (join table), `FollowedPlayer` (join table).
   - Keep `Match` data mostly in **Redis**, not Postgres — it's transient/live.
     Don't model a `Match` table yet unless you're deliberately adding a
     "match history" stretch feature; if so, keep it minimal.
   - `FollowedTeam` / `FollowedPlayer` are join tables with a composite unique
     constraint (`userId` + `teamId` / `userId` + `playerId`) so a user can't
     follow the same team/player twice.

2. **Run the migration**: `npx prisma migrate dev --name init`

3. **Auth routes**
   - `POST /auth/signup` — Zod-validated body (email, password, min length
     etc.), hash password with `bcrypt`, create `User`, return 201.
   - `POST /auth/login` — verify email exists, compare password with
     `bcrypt.compare`, issue a JWT (`jsonwebtoken`) signed with `JWT_SECRET`,
     reasonable expiry (e.g. `7d`).
   - Passwords are **never** returned in any response body — sanitize the
     user object before sending it back.

4. **Auth hook** — a Fastify `onRequest` hook (or `fastify.decorate`d
   function used per-route) that:
   - Reads `Authorization: Bearer <token>`
   - Verifies it with `jsonwebtoken.verify`
   - On success, attaches `request.user = { id, email, ... }`
   - On failure (missing/invalid/expired), replies `401` with a consistent
     error shape — don't let a raw JWT error leak as a 500.

5. **`GET /me`** — protected route, returns `request.user` (sanity check that
   the whole auth chain works end-to-end).

**Checkpoint B:** You can sign up, log in, get a token, and hit `GET /me` with
it (Postman/Thunder Client) — a request without a token, or with a garbage
token, gets a clean 401, not a stack trace.

---

## Acceptance Criteria

- [ ] Cricket API key obtained and one manual request confirmed (or fallback
      mock-data-generator decision documented in the README) **[Part A]**
- [ ] Project scaffolded with the folder structure above **[Part A]**
- [ ] `.env` (gitignored) + `.env.example` (committed) with `DATABASE_URL`,
      `REDIS_URL`, `JWT_SECRET`, `CRICKET_API_KEY` **[Part A]**
- [ ] `docker-compose.yml` brings up Postgres + Redis; both reachable manually **[Part A]**
- [ ] `prisma/schema.prisma` defines `User`, `Team`, `Player`,
      `FollowedTeam`, `FollowedPlayer` with correct relations and unique
      constraints on the join tables **[Part B]**
- [ ] `prisma migrate dev` runs clean against the Dockerized Postgres **[Part B]**
- [ ] `POST /auth/signup` — Zod validation, bcrypt-hashed password, no
      plaintext password ever stored or returned **[Part B]**
- [ ] `POST /auth/login` — correct credentials return a valid JWT; wrong
      credentials return 401, not a stack trace **[Part B]**
- [ ] Auth hook rejects missing/invalid/expired tokens with a consistent
      `401` error shape **[Part B]**
- [ ] `GET /me` returns the authenticated user's data given a valid token **[Part B]**
- [ ] Both checkpoints above pass manually via Postman/Thunder Client/curl

## Out of scope (later issues)

- Follow/unfollow endpoints and live-match listing → Phase 2
- Actual cricket API client with retry/backoff → Phase 3
- Background polling, caching, WebSockets, notifications → Phases 4–7
- Dockerizing the Node app itself → Phase 9

## Notes

- Don't over-build the `Match` model in Postgres — resist the urge to fully
  normalize live match data now; that's explicitly Redis's job later.
- Keep `matches.js`, `follows.js`, `pollScores.js` etc. as thin stub files if
  you scaffold them now — implementing them belongs to later issues.
