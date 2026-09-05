// Generic retry-with-backoff wrapper, kept deliberately provider-agnostic so
// Phase 4's job-level retry can share the same mental model. `withRetry` takes
// any `async () => value`: it resolves on the first success, and on a failure it
// consults `isRetryable(err)` to decide whether to back off and try again or
// rethrow straight away.
//
// The defaults below are HTTP-shaped (retry on `err.retryable === true`, honour a
// `err.retryAfterMs` hint, wrap the terminal failure into the typed errors from
// errors.js). Every one of them is overridable via options, so a non-HTTP caller
// can swap in its own classification without touching this file.
import { ApiRateLimitError, ApiUnavailableError } from '../errors.js';
import { logger } from '../utils/logger.js';

// `setTimeout`-based so vitest's fake timers can drive it. Exported because the
// client's min-interval gate needs the same primitive.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff: random point in [0, base * 2**attempt],
// clamped to maxDelayMs. `attempt` is 0-based (0 = the wait after the first try).
function fullJitterDelay(attempt, baseDelayMs, maxDelayMs) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

// Turn the last transient error into a typed error for the caller to log. A 429
// becomes ApiRateLimitError; everything else becomes ApiUnavailableError. Context
// fields are copied off the raw error where present.
function defaultWrapFinalError(err, attempts) {
  if (err?.status === 429) {
    const rateErr = new ApiRateLimitError(`Cricket API rate limit hit after ${attempts} attempts`, {
      retryAfterMs: err.retryAfterMs ?? null,
      endpoint: err.endpoint ?? null,
    });
    rateErr.attempts = attempts; // not part of the documented shape, but keeps the failure log line honest
    return rateErr;
  }
  return new ApiUnavailableError(`Cricket API unavailable after ${attempts} attempts: ${err?.message ?? err}`, {
    cause: err,
    status: err?.status ?? null,
    endpoint: err?.endpoint ?? null,
    attempts,
  });
}

/**
 * @param {() => Promise<any>} fn         operation to attempt
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] TOTAL number of attempts (not "extra"
 *   tries): 3 means the operation is called at most 3 times. Maps to the
 *   CRICKET_API_MAX_RETRIES env var. A run that fails every time throws with
 *   `attempts === maxRetries`.
 * @param {number} [options.baseDelayMs=300]
 * @param {number} [options.maxDelayMs=5000]
 * @param {string} [options.label='operation'] name used in the retry log line
 * @param {(err:any)=>boolean} [options.isRetryable] default: `err.retryable === true`
 * @param {(err:any, attempt:number)=>(number|null)} [options.retryDelayMs]
 *   return a number to override the computed backoff (used to honour Retry-After),
 *   or null/undefined to fall back to full-jitter. `attempt` is 0-based.
 * @param {(err:any, attempts:number)=>Error} [options.wrapFinalError]
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 300,
    maxDelayMs = 5000,
    label = 'operation',
    isRetryable = (err) => err?.retryable === true,
    retryDelayMs = () => null,
    wrapFinalError = defaultWrapFinalError,
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // A non-transient failure (4xx other than 429, a programming bug) won't
      // heal by waiting — surface it as-is, immediately.
      if (!isRetryable(err)) throw err;

      // Out of attempts: hand the caller a typed, logged-once error.
      if (attempt >= maxRetries) break;

      const hinted = retryDelayMs(err, attempt - 1);
      const delay = typeof hinted === 'number' ? hinted : fullJitterDelay(attempt - 1, baseDelayMs, maxDelayMs);
      logger.warn(
        `retrying ${label} attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${err?.message ?? err}`,
      );
      await sleep(delay);
    }
  }

  throw wrapFinalError(lastErr, maxRetries);
}
