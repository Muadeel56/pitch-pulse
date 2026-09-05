// Thrown by route handlers when a looked-up resource (team/player/match/etc.)
// doesn't exist, and caught by the centralized error handler (see
// plugins/errorHandler.js) and mapped to a 404. Zod's ZodError and Prisma's
// PrismaClientKnownRequestError are detected there by their own type instead
// of being wrapped — this is the only custom error class the app needs.
export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

// Thrown by the external cricket API client (lib/cricketApiClient.js) — one per
// failure mode of an outbound call. Their primary audience is Phase 4's polling
// job, which logs them and keeps going (they're not fatal). They also surface
// through errorHandler.js when a route calls the client directly: ApiParseError
// -> 502, ApiRateLimitError / ApiUnavailableError -> 503. Every field is context
// for a single log line, so callers never have to dig into a stack trace.

// The API told us to slow down: an HTTP 429, or a quota counter we know has hit
// zero (in which case the client throws this *without* making the doomed call).
// `retryAfterMs` is derived from a Retry-After header or a quota-reset timestamp.
export class ApiRateLimitError extends Error {
  constructor(message = 'Cricket API rate limit hit', { retryAfterMs = null, endpoint = null } = {}) {
    super(message);
    this.name = 'ApiRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.endpoint = endpoint;
  }
}

// The call didn't produce a usable response: a network failure, an aborted
// (timed-out) request, an HTTP 5xx after retries are exhausted, or an auth
// rejection (401/403 — a bad key won't fix itself, so it's thrown immediately
// with no retries). `attempts` is how many tries were made before giving up.
export class ApiUnavailableError extends Error {
  constructor(
    message = 'Cricket API unavailable',
    { cause = null, status = null, endpoint = null, attempts = null } = {},
  ) {
    super(message);
    this.name = 'ApiUnavailableError';
    this.cause = cause;
    this.status = status;
    this.endpoint = endpoint;
    this.attempts = attempts;
  }
}

// A response arrived (HTTP 200) but its shape isn't what we expect — a null/HTML
// body, an array where an object belonged, a missing `matches` key, etc. Carries
// the Zod `flatten()` output in `issues` so the mismatch is greppable instead of
// blowing up as a `TypeError` deep inside a consumer.
export class ApiParseError extends Error {
  constructor(message = 'Cricket API response failed validation', { endpoint = null, issues = null } = {}) {
    super(message);
    this.name = 'ApiParseError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}
