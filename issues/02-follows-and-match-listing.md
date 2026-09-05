# Issue #2: Core REST Endpoints — Follows + Match Listing (Phase 2)

**Labels:** `backend`, `api`
**Milestone:** PitchPulse — Foundation
**Estimated effort:** 1–2 days
**Depends on:** Issue #1 (Project Setup & Auth Foundation)

## Summary

Build the follow/unfollow endpoints for teams and players, a live-match
listing endpoint, and a single-match-detail endpoint, all validated with Zod
and returning a consistent error shape via a centralized Fastify error
handler. This is **Phase 2** from the project docs — it turns the auth-only
skeleton from Issue #1 into an app with real, user-facing functionality.

---

## Background / Context

`src/routes/follows.js` and `src/routes/matches.js` are currently empty stub
files registered in [`server.js`](../src/server.js) with `/follows` and
`/matches` prefixes. `fastify.authenticate` (from
[`plugins/authenticate.js`](../src/plugins/authenticate.js)) is already
decorated on the root instance and ready to use as an `onRequest` guard.
`FollowedTeam` / `FollowedPlayer` join tables already exist in
[`schema.prisma`](../prisma/schema.prisma) with composite unique constraints.

**Cricket data source note:** per the [README](../README.md)'s Phase 0
decision, `src/lib/cricketApiClient.js` is still a stub — the real
retry/backoff-hardened client (real key or mock generator) is Phase 3, and
moving results through Redis is Phase 4. So for **this** issue, `GET
/matches/live` and `GET /matches/:id` should return **static/randomized mock
match data generated inline** in `matches.js` (or a tiny local helper) —
just enough shape (teams, score, overs, status) to prove the route contract
and unblock frontend work. Don't build real HTTP-fetch logic against a
cricket API yet; that's explicitly Phase 3's job and would be thrown away.

**No `Team`/`Player` seed data exists yet.** Following an endpoint needs a
real `teamId`/`playerId` to test against — add a minimal Prisma seed script
(or a documented manual `INSERT`/Prisma Studio step) so this is testable
without waiting on a separate seeding issue.

---

## Scope

### 1. Centralized error handler

- Add a Fastify `setErrorHandler` in `server.js` (or a small
  `plugins/errorHandler.js` registered before the routes) so **every**
  uncaught error — Zod validation failures, Prisma errors (e.g. unique
  constraint `P2002`), 404s, anything else — resolves to the same
  `{ error: { message, code } }` shape already used by `auth.js` and
  `authenticate.js`. Route handlers that already build their own error
  response (like the existing 401s) keep working; this is the fallback for
  everything else, including bugs, so it must never leak a raw stack trace
  or Fastify's default `{ statusCode, error, message }` shape.
- Zod errors → `400` with a `code` like `VALIDATION_ERROR`.
- Not-found lookups (unknown `teamId`/`playerId`/match id) → `404` with
  `NOT_FOUND`.
- Duplicate follow (Prisma `P2002` unique-constraint violation) → `409` with
  something like `ALREADY_FOLLOWING`.

### 2. Follow/unfollow routes — `src/routes/follows.js`

All routes below are protected (`onRequest: [fastify.authenticate]`) and use
`request.user.id` as the acting user.

- `POST /follows/team/:teamId`
  - Validate `:teamId` is a well-formed id (Zod param schema).
  - 404 if the team doesn't exist.
  - Create a `FollowedTeam` row; 409 if already following (unique
    constraint).
  - 201 on success.
- `DELETE /follows/team/:teamId`
  - 404 if no such follow relationship exists for this user (idempotent
    delete — don't silently 200 on "nothing happened" without deciding this
    deliberately; document whichever choice is made).
  - 200/204 on success.
- `POST /follows/player/:playerId` / `DELETE /follows/player/:playerId` —
  same shape as team follow/unfollow.
- `GET /follows` — returns the current user's followed teams and players,
  e.g. `{ teams: [...], players: [...] }`, each with enough denormalized
  data (name, shortName) to render a list without a second round trip.

### 3. Match listing routes — `src/routes/matches.js`

- `GET /matches/live` — public or protected (decide and document; protected
  is more consistent with the rest of the API but the project docs don't
  require it). Returns an array of mock live matches with a stable shape,
  e.g.:
  ```json
  [{ "id": "...", "teams": ["...", "..."], "status": "live", "score": "..." , "overs": "..." }]
  ```
- `GET /matches/:id` — single match detail, 404 if the mock id doesn't
  exist. Reuses the same mock data source as `/matches/live` so the two
  routes are consistent with each other.

### 4. Zod validation

- Add `src/schemas/follows.js` and `src/schemas/matches.js` for param/body
  validation, following the existing pattern in `schemas/auth.js`.
- Route handlers should validate via `schema.parse(...)` and let a thrown
  `ZodError` fall through to the centralized error handler rather than each
  route hand-rolling its own try/catch.

### 5. Seed data

- Add `prisma/seed.js` (or `prisma/seed.mjs`) with a handful of `Team`/
  `Player` rows, wired into `package.json` (`prisma.seed` config +
  `npx prisma db seed`) so follow endpoints are testable end-to-end without
  manual DB surgery.

---

## Acceptance Criteria

- [ ] Centralized `setErrorHandler` in place; Zod errors, Prisma errors, and
      generic thrown errors all resolve to `{ error: { message, code } }`
      with an appropriate status code — none leak a raw stack trace or
      Fastify's default error shape
- [ ] `POST /follows/team/:teamId` — 201 on success, 404 unknown team, 409
      duplicate follow, 401 with no/invalid token
- [ ] `DELETE /follows/team/:teamId` — removes the row, documented behavior
      for "not currently following"
- [ ] `POST /follows/player/:playerId` and `DELETE /follows/player/:playerId`
      — same guarantees as the team routes
- [ ] `GET /follows` — returns the authenticated user's followed teams and
      players only (never another user's)
- [ ] `GET /matches/live` — returns an array of mock matches with a
      consistent shape
- [ ] `GET /matches/:id` — returns one mock match by id, 404 for unknown ids
- [ ] All request bodies/params validated with Zod; invalid input returns
      `400 VALIDATION_ERROR`, not a 500
- [ ] `prisma/seed.js` seeds enough `Team`/`Player` rows to exercise the
      follow endpoints, runnable via `npx prisma db seed`
- [ ] Full flow verified manually (curl/Postman): seed → signup/login →
      follow a team → `GET /follows` shows it → unfollow → `GET /follows`
      no longer shows it → `GET /matches/live` and `GET /matches/:id` return
      data
- [ ] README updated with the new endpoints and manual verification steps,
      following the existing "Auth — manual verification" section's format

## Out of scope (later issues)

- Real cricket API integration (retry/backoff, actual live data) → Phase 3
- Moving match data into Redis, background polling → Phases 4–5
- WebSocket push / notifications on match events → Phases 6–7

## Notes

- Keep the mock match data source isolated (one small module/function) so
  Phase 3 can swap it for the real `cricketApiClient` without touching the
  route handlers' shape.
- Don't scope-creep into pagination/filtering for `/matches/live` — a flat
  array is enough for this phase.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
