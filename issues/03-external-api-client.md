# Issue #3: External Cricket API Client — Resilient Fetching (Phase 3)

**Labels:** `backend`, `resilience`, `integration`
**Milestone:** PitchPulse — Live Data
**Estimated effort:** 1–2 days
**Depends on:** Issue #2 (Core REST Endpoints — Follows + Match Listing)

## Summary

Turn `src/lib/cricketApiClient.js` from a stub into the **one and only** module
the rest of the app uses to get cricket-match data. It exposes two functions —
`getLiveMatches()` and `getMatchDetail(id)` — and hides everything ugly behind
them: HTTP, retry with exponential backoff, rate-limit awareness, defensive
response parsing, typed error classes, and a log line on every outbound call.

This is **Phase 3** from the project docs. Nothing here is user-facing — it is
plumbing that Phase 4's background polling job and the existing `/matches/*`
routes sit on top of.

---

## Background / Context

Per the [README](../README.md)'s Phase 0 "Cricket data source decision", we have
**not** registered and validated a live API key. Rather than let that block the
project, Phase 3 builds the resilient client **with a pluggable data source**:

- **Mock provider (default):** a generator that mimics a real cricket API's
  response shape and evolves scores over time (random increments every few
  seconds). Used whenever `CRICKET_API_KEY` is empty.
- **HTTP provider:** real `fetch` against a documented cricket API
  (CricAPI / cricketdata.org), used when `CRICKET_API_KEY` is set.

The resilience layer (retry, backoff, rate-limit handling, parsing, logging,
error classes) is **identical for both providers** — the mock provider can be
told to inject failures (timeouts, 429s, malformed bodies) so the retry/error
paths are exercisable without a real key or real network. When a key is
obtained later, flipping to the HTTP provider must not touch any consumer.

**Current state:**
- `src/lib/cricketApiClient.js` — `export const cricketApiClient = {};` stub.
- `src/lib/mockMatches.js` — a fixed, deterministic array with the internal
  match shape `{ id, teams, status, score, overs }`, consumed by
  `src/routes/matches.js` via `getAllMatches()` / `getMatchById(id)`.
- `src/errors.js` — only `NotFoundError` today.
- `src/utils/logger.js` — `logger.info/warn/error/debug` (debug gated on
  `LOG_LEVEL=debug`).
- `src/plugins/errorHandler.js` — central Fastify error handler; maps
  `ZodError`, `NotFoundError`, Prisma `P2002`, else 500.
- `src/jobs/pollScores.js` — stub (Phase 4), will be the primary caller.

---

## Scope

### 1. Custom error classes — `src/errors.js`

Add three classes alongside `NotFoundError`, each extending `Error`, each
setting `this.name`, and each carrying context useful in a log line:

| Class                | Meaning                                                        | Carries                              |
| -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `ApiRateLimitError`  | API said "slow down" (HTTP 429, or a quota header at 0)       | `retryAfterMs`, `endpoint`          |
| `ApiUnavailableError`| Network failure, timeout, 5xx, or auth rejected (401/403)     | `cause`, `status`, `endpoint`, `attempts` |
| `ApiParseError`      | Response arrived but its shape isn't what we expect           | `endpoint`, `issues` (Zod flatten)  |

Keep the existing comment convention in `errors.js`. These are thrown by the
client and are expected to surface mostly in Phase 4's job (logged, not fatal),
so they do **not** need to be caught in `errorHandler.js` yet — but add a short
note there (or map `ApiUnavailableError` → 503, `ApiRateLimitError` → 503/429)
if you want `/matches/*` to degrade cleanly when a route calls the client
directly. Document whichever choice is made.

### 2. Retry wrapper — `src/lib/retry.js`

A small, provider-agnostic `withRetry(fn, options)` adapted from the Repo Radar
pattern:

- Exponential backoff with **full jitter**: `delay = random(0, base * 2 ** attempt)`,
  capped at `maxDelayMs`.
- Config (defaults, all overridable via options / env):
  `maxRetries` = 3, `baseDelayMs` = 300, `maxDelayMs` = 5000.
- **Retry only transient failures:** network errors, timeouts, HTTP 5xx, and
  HTTP 429 (honour `Retry-After` — use it instead of the computed backoff when
  present).
- **Never retry:** HTTP 4xx other than 429 (401/403/404/400) — a bad key won't
  fix itself by waiting.
- On exhausting retries, throw the appropriate typed error (`ApiRateLimitError`
  / `ApiUnavailableError`) with `attempts` set.
- Log every retry at `warn` (`"retrying getLiveMatches attempt 2/3 after 480ms:
  <reason>"`) and let the caller log the terminal success/failure.

### 3. Rate-limit awareness

- Respect `Retry-After` (seconds or HTTP-date) on 429 responses.
- If the provider returns quota headers (e.g. `X-RateLimit-Remaining` /
  `X-RateLimit-Reset` — cricketdata.org exposes a per-day hit counter in its
  JSON body), read them and, when remaining is 0, throw `ApiRateLimitError`
  with `retryAfterMs` from the reset time **without** making the doomed call.
- A minimum spacing between outbound calls (simple timestamp gate, e.g.
  `minIntervalMs` ~ 1000) so a misconfigured Phase 4 interval can't hammer the
  API. Configurable; default on.

### 4. Defensive parsing — internal normalized shape

- Define a Zod schema for the **external** response of each endpoint (loose:
  only the fields we actually use, `.passthrough()` the rest).
- Parse every response through it; on failure throw `ApiParseError` with the
  Zod `flatten()` output — never let an unexpected shape propagate as a
  `TypeError: cannot read property ... of undefined` from deep in a consumer.
- Map the parsed external shape to the **existing internal shape** used by
  `mockMatches.js` / the routes: `{ id, teams: [a, b], status, score, overs }`.
  Missing optional fields become `null`, not `undefined`. Unknown `status`
  strings normalize to a known set (`live` | `completed` | `upcoming`) or
  `unknown`.
- Guard against: `null`/empty body, `200` with an HTML error page, an array
  where an object was expected (and vice-versa), `matches: []` vs `matches`
  absent entirely.

### 5. The client module — `src/lib/cricketApiClient.js`

```js
export async function getLiveMatches()      // -> Match[]  (normalized internal shape)
export async function getMatchDetail(id)    // -> Match    (throws NotFoundError if the API 404s / returns none)
```

- Internally: pick provider from config → build request → `withRetry(...)` →
  rate-limit gate → parse/normalize → return.
- **Logging on every external call** via `logger`:
  - start: `debug` — `"GET /currentMatches (provider=mock)"`
  - success: `info` — `"getLiveMatches ok: 4 matches in 312ms"`
  - retry: `warn` (from the retry wrapper)
  - failure: `error` — `"getLiveMatches failed after 3 attempts: ApiUnavailableError: fetch failed"`
- Timeout each HTTP attempt with `AbortController` (default `timeoutMs` 8000) so
  "internet dies mid-request" becomes a clean abort → `ApiUnavailableError`,
  not a hang.
- No `console.*`, no `fetch` anywhere outside this module (and `retry.js`).

### 6. Mock provider — `src/lib/mockCricketApi.js`

- Produces the **external** response shape (so it flows through the same
  parse/normalize path as real HTTP), seeded from the fixtures currently in
  `mockMatches.js`.
- Live matches' scores/overs advance on each call (or on a wall-clock basis) so
  Phase 4's diffing has something to detect.
- Failure injection for tests/dev: env or option flags to force a timeout, a
  429 (with `Retry-After`), a 500, or a malformed body on the next / every Nth
  call.
- Once this exists, `src/routes/matches.js` switches from `mockMatches.js` to
  `cricketApiClient` (`getLiveMatches` / `getMatchDetail`); `mockMatches.js`
  can be deleted or kept only as the mock provider's fixture source. The route
  handlers' response shape must not change.

### 7. Config — `.env.example` + README

Add and document:

```
CRICKET_API_KEY=                       # empty -> mock provider
CRICKET_API_BASE_URL=https://api.cricapi.com/v1
CRICKET_API_TIMEOUT_MS=8000
CRICKET_API_MAX_RETRIES=3
CRICKET_API_MIN_INTERVAL_MS=1000
```

Update the README's "Cricket data source decision" section to say the client is
now implemented with a mock/HTTP provider split, and add a short "External API
client" section describing the error classes and the retry/rate-limit behavior
(same table style as "Centralized error handling").

### 8. Tests — `vitest`

`npm test` already runs `vitest run`. Add `src/lib/__tests__/cricketApiClient.test.js`
(or similar) covering, with the mock provider's failure injection and/or a
stubbed `fetch`:

- happy path: `getLiveMatches()` returns normalized `Match[]`; `getMatchDetail`
  returns one; unknown id → `NotFoundError`.
- retry: one 500 then success → resolves, one retry logged; three 500s →
  `ApiUnavailableError` with `attempts === 3`.
- backoff: delays are bounded by `maxDelayMs` and use jitter (assert range, not
  exact value); use fake timers so the suite stays fast.
- 429 with `Retry-After` → `ApiRateLimitError` with `retryAfterMs` set; not
  retried more than allowed.
- bad key (401/403) → `ApiUnavailableError` immediately, **zero** retries.
- malformed body (`200` + garbage / missing `matches`) → `ApiParseError` with
  `issues` populated.
- abort/timeout → `ApiUnavailableError` (cause is the abort).

---

## Acceptance Criteria

- [ ] `getLiveMatches()` and `getMatchDetail(id)` are the only way the app gets
      match data; no `fetch` / `console.*` outside `cricketApiClient.js` +
      `retry.js`
- [ ] `ApiRateLimitError`, `ApiUnavailableError`, `ApiParseError` exist in
      `src/errors.js`, each with `name` set and useful context fields
- [ ] Transient failures (network / timeout / 5xx / 429) retry with jittered
      exponential backoff, capped, max 3 attempts; 4xx≠429 never retries
- [ ] `Retry-After` on a 429 is honoured; a known-exhausted quota throws
      `ApiRateLimitError` **without** issuing the request
- [ ] A minimum inter-call interval is enforced and configurable
- [ ] Every response is parsed through a Zod schema and normalized to
      `{ id, teams, status, score, overs }`; a bad shape throws `ApiParseError`,
      never a raw `TypeError` in a consumer
- [ ] Every external call logs start (debug) / success (info) / retry (warn) /
      failure (error) via `logger`
- [ ] Mock provider is the default (no key), evolves live scores between calls,
      and can inject timeout / 429 / 500 / malformed-body failures on demand
- [ ] `src/routes/matches.js` now uses `cricketApiClient`; `/matches/live` and
      `/matches/:id` responses are byte-compatible with Issue #2's shape
- [ ] `.env.example` + README updated (data-source note, error-class table,
      new env vars)
- [ ] `npm test` green, covering happy path, retry-then-succeed, retry-exhausted,
      429/Retry-After, bad-key-no-retry, malformed-body, timeout/abort
- [ ] **Checkpoint 1:** with `CRICKET_API_KEY` set to a real HTTP provider,
      kill the network mid-request → logs show a clean
      `getLiveMatches failed after 3 attempts: ApiUnavailableError` line and the
      process stays up (verify by hitting `/matches/live` with the network
      down: a clean 5xx JSON error, not a crash)
- [ ] **Checkpoint 2:** point at the HTTP provider with a deliberately wrong
      `CRICKET_API_KEY` → a single `ApiUnavailableError` (401, zero retries) or
      `ApiRateLimitError`, logged clearly — never a generic unhandled exception

## Out of scope (later issues)

- BullMQ queue/worker, the repeatable poll, snapshot diffing → Phase 4
- Redis caching of match data / TTLs → Phase 5
- WebSocket push and `matchUpdated` events → Phases 6–7
- A circuit breaker / provider health endpoint — mention as a TODO, don't build

## Notes

- Keep `retry.js` generic (takes any async fn) so Phase 4's job-level retry
  config and this share one mental model.
- Don't over-fit the Zod schema to CricAPI specifically — we may end up on
  cricketdata.org or the mock forever; parse loosely, normalize firmly.
- The mock provider's failure injection is a feature, not test-only scaffolding
  — it's how Checkpoint-style behavior is demoed without a real key.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
