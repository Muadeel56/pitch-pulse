// The one and only module the rest of the app uses to get cricket-match data.
// Everything ugly — HTTP, retry with backoff, rate-limit awareness, defensive
// parsing, typed errors, a log line per outbound call — lives behind two
// functions: getLiveMatches() and getMatchDetail(id).
//
// Data source is pluggable and chosen from config: the mock provider
// (mockCricketApi.js) whenever CRICKET_API_KEY is empty, a real `fetch` against
// a CricAPI-style endpoint when it's set. The resilience layer around them is
// identical, so obtaining a key later is a config change — no consumer moves.
//
// Rules this module keeps: no `console.*` anywhere (use logger), and `fetch`
// appears only here and in retry.js.
import { NotFoundError, ApiParseError, ApiRateLimitError, ApiUnavailableError } from '../errors.js';
import { logger } from '../utils/logger.js';
import { withRetry, sleep } from './retry.js';
import {
  externalMatchListSchema,
  externalMatchDetailSchema,
  extractMatchList,
  normalizeMatch,
  parseOrThrow,
} from './cricketSchemas.js';
import * as mockProvider from './mockCricketApi.js';

// Read at call time (not module load) so tests can vi.stubEnv between cases and
// so a unit test importing this file directly — which never loads dotenv — still
// gets working defaults.
function readConfig() {
  const key = (process.env.CRICKET_API_KEY || '').trim();
  return {
    apiKey: key,
    useMock: key === '',
    baseUrl: (process.env.CRICKET_API_BASE_URL || 'https://api.cricapi.com/v1').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.CRICKET_API_TIMEOUT_MS) || 8000,
    maxRetries: Number(process.env.CRICKET_API_MAX_RETRIES) || 3,
    minIntervalMs: Number(process.env.CRICKET_API_MIN_INTERVAL_MS ?? 1000),
    baseDelayMs: 300,
    maxDelayMs: 5000,
  };
}

// --- module state (spacing gate + last-seen quota) -------------------------

let lastCallAt = 0;
let quota = { remaining: null, resetAt: null };

export function __resetClientState() {
  lastCallAt = 0;
  quota = { remaining: null, resetAt: null };
}

// --- header / retry-after helpers ----------------------------------------

// Works for both a fetch `Headers` instance and the plain object the mock uses.
function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// Retry-After is either delta-seconds ("120") or an HTTP-date. Returns ms, or
// null if absent/unparseable.
function parseRetryAfter(value) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(String(value).trim())) return Number(value) * 1000;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

// --- rate-limit gate + quota tracking ---------------------------------------

// Enforce a minimum spacing between outbound calls so a misconfigured Phase 4
// interval can't hammer the provider. Disabled when minIntervalMs <= 0.
async function applyMinInterval(minIntervalMs) {
  if (minIntervalMs <= 0) return;
  const wait = minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// If we already know the quota is spent and hasn't reset, fail fast — don't
// spend the doomed request.
function guardQuota(endpoint) {
  if (quota.remaining === 0 && typeof quota.resetAt === 'number' && quota.resetAt > Date.now()) {
    throw new ApiRateLimitError('Cricket API daily quota exhausted', {
      retryAfterMs: quota.resetAt - Date.now(),
      endpoint,
    });
  }
}

// After a successful call, remember whatever the provider told us about quota —
// from response headers or CricAPI's `info.hitsToday` / `info.hitsLimit`.
function updateQuota(envelope) {
  const remainingHeader = getHeader(envelope.headers, 'x-ratelimit-remaining');
  const resetHeader = getHeader(envelope.headers, 'x-ratelimit-reset');
  if (remainingHeader != null) {
    quota.remaining = Number(remainingHeader);
    if (resetHeader != null) quota.resetAt = Number(resetHeader) * 1000;
    else if (quota.remaining === 0) quota.resetAt = Date.now() + 60_000;
    return;
  }

  const info = envelope.body?.info;
  if (info && typeof info.hitsToday === 'number' && typeof info.hitsLimit === 'number') {
    quota.remaining = Math.max(0, info.hitsLimit - info.hitsToday);
    if (quota.remaining === 0) quota.resetAt = Date.now() + 60_000;
  }
}

// --- HTTP provider (inline — fetch is allowed here) ------------------------

async function httpGet(url, endpoint, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    let body;
    try {
      body = await res.json();
    } catch {
      // A 200 with an HTML error page, a truncated body, etc. Hand the raw text
      // to the parser, which will reject it as a shape mismatch.
      body = await res.text().catch(() => null);
    }
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    // Network failure or abort (timeout). Mark transient so withRetry retries.
    const reason = err?.name === 'AbortError' ? `request aborted after ${timeoutMs}ms` : err?.message || String(err);
    const wrapped = new Error(reason);
    wrapped.retryable = true;
    wrapped.cause = err;
    wrapped.endpoint = endpoint;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

function httpProvider(cfg) {
  return {
    getCurrentMatches: () =>
      httpGet(
        `${cfg.baseUrl}/currentMatches?apikey=${encodeURIComponent(cfg.apiKey)}&offset=0`,
        '/currentMatches',
        cfg.timeoutMs,
      ),
    getMatchInfo: (id) =>
      httpGet(
        `${cfg.baseUrl}/match_info?apikey=${encodeURIComponent(cfg.apiKey)}&id=${encodeURIComponent(id)}`,
        '/match_info',
        cfg.timeoutMs,
      ),
  };
}

function pickProvider(cfg) {
  return cfg.useMock ? mockProvider : httpProvider(cfg);
}

// Some providers (CricAPI) signal errors in-body with HTTP 200 +
// `{ status: "failure", reason: "..." }`. Translate that into the same tagged
// errors an HTTP status would produce, so the retry/typing logic is uniform.
function assertBodyOk(body, endpoint) {
  if (!body || typeof body !== 'object') return;
  const marker = typeof body.status === 'string' ? body.status.toLowerCase() : '';
  if (marker !== 'failure' && marker !== 'error') return;

  const reason = String(body.reason || body.message || 'upstream reported a failure');
  const r = reason.toLowerCase();
  const err = new Error(`${endpoint}: ${reason}`);
  err.endpoint = endpoint;
  err.retryable = false;

  if (/api ?key|unauthor|forbidden|invalid key/.test(r)) {
    err.status = 401;
    err.message = `${endpoint}: ${reason} (check CRICKET_API_KEY)`;
  } else if (/limit|quota|hits today|too many/.test(r)) {
    err.rateLimited = true;
  } else if (/not found|no match|no data|invalid id|match id/.test(r) || endpoint === '/match_info') {
    err.notFound = true;
  }
  throw err;
}

// Classify a returned envelope. 2xx passes; 429 / 5xx are transient (tagged
// `retryable`); 401/403/404/other-4xx are permanent (a bad key won't heal by
// waiting).
function assertOk(envelope, endpoint) {
  const { status } = envelope;
  if (status >= 200 && status < 300) return;

  const err = new Error(`HTTP ${status} from ${endpoint}`);
  err.status = status;
  err.endpoint = endpoint;

  if (status === 429) {
    err.retryable = true;
    err.retryAfterMs = parseRetryAfter(getHeader(envelope.headers, 'retry-after'));
  } else if (status >= 500) {
    err.retryable = true;
  } else {
    err.retryable = false;
    if (status === 404) err.notFound = true;
    if (status === 401 || status === 403) err.message = `HTTP ${status} from ${endpoint} (auth rejected — check CRICKET_API_KEY)`;
  }
  throw err;
}

// --- shared per-call pipeline -------------------------------------------------

async function callProvider({ opName, endpoint, cfg, run, schema, finish, treat404AsNotFound }) {
  const startedAt = Date.now();
  logger.debug(`GET ${endpoint} (provider=${cfg.useMock ? 'mock' : 'http'})`);

  try {
    guardQuota(endpoint);
    await applyMinInterval(cfg.minIntervalMs);

    const envelope = await withRetry(
      async () => {
        const res = await run();
        assertOk(res, endpoint);
        assertBodyOk(res.body, endpoint);
        return res;
      },
      {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.baseDelayMs,
        maxDelayMs: cfg.maxDelayMs,
        label: opName,
        retryDelayMs: (err) => (typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null),
      },
    );

    updateQuota(envelope);

    const parsed = parseOrThrow(schema, envelope.body, endpoint);
    const result = finish(parsed);

    logger.info(`${opName} ok: ${result.summary} in ${Date.now() - startedAt}ms`);
    return result.value;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;

    if (treat404AsNotFound && (err?.status === 404 || err?.notFound || err?.cause?.notFound)) {
      logger.error(`${opName} failed: NotFoundError (404 from ${endpoint})`);
      throw new NotFoundError('Match not found');
    }

    // withRetry already wraps an exhausted transient failure into a typed error.
    // A permanent failure (401/403/4xx, or an in-body failure marker) comes back
    // raw — wrap it once here so callers only ever see the typed hierarchy.
    let typed = err;
    if (err instanceof ApiRateLimitError || err instanceof ApiUnavailableError || err instanceof ApiParseError) {
      // already typed
    } else if (err?.rateLimited) {
      typed = new ApiRateLimitError(err.message ?? 'Cricket API rate limit hit', {
        retryAfterMs: err.retryAfterMs ?? null,
        endpoint,
      });
    } else {
      typed = new ApiUnavailableError(err?.message ?? String(err), {
        cause: err,
        status: err?.status ?? null,
        endpoint,
        attempts: 1,
      });
    }
    if (typed.endpoint == null) typed.endpoint = endpoint;

    logger.error(
      `${opName} failed after ${typed.attempts ?? 1} attempts: ${typed.name}: ${typed.message}`,
    );
    throw typed;
  }
}

// --- public API ------------------------------------------------------------

/**
 * Fetch the current set of matches, normalized to the internal shape
 * `{ id, teams, status, score, overs }[]`.
 */
export async function getLiveMatches() {
  const cfg = readConfig();
  const provider = pickProvider(cfg);

  return callProvider({
    opName: 'getLiveMatches',
    endpoint: '/currentMatches',
    cfg,
    run: () => provider.getCurrentMatches(),
    schema: externalMatchListSchema,
    finish: (parsed) => {
      const matches = extractMatchList(parsed).map(normalizeMatch);
      return { value: matches, summary: `${matches.length} matches` };
    },
  });
}

/**
 * Fetch one match by id, normalized. Throws NotFoundError if the provider 404s
 * or returns no match for the id.
 */
export async function getMatchDetail(id) {
  const cfg = readConfig();
  const provider = pickProvider(cfg);

  return callProvider({
    opName: 'getMatchDetail',
    endpoint: '/match_info',
    cfg,
    run: () => provider.getMatchInfo(id),
    schema: externalMatchDetailSchema,
    treat404AsNotFound: true,
    finish: (parsed) => {
      const raw = parsed.data ?? null;
      if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
        throw new NotFoundError('Match not found');
      }
      const match = normalizeMatch(raw);
      return { value: match, summary: `match ${match.id}` };
    },
  });
}
