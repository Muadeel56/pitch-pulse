import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLiveMatches, getMatchDetail, __resetClientState } from '../cricketApiClient.js';
import * as mock from '../mockCricketApi.js';
import { getAllMatches } from '../mockMatches.js';
import { NotFoundError, ApiParseError, ApiRateLimitError, ApiUnavailableError } from '../../errors.js';
import { logger } from '../../utils/logger.js';

beforeEach(() => {
  // Force the mock provider, no spacing gate, no env-configured failure.
  vi.stubEnv('CRICKET_API_KEY', '');
  vi.stubEnv('CRICKET_API_MIN_INTERVAL_MS', '0');
  vi.stubEnv('CRICKET_MOCK_FAIL', '');
  __resetClientState();
  mock.__resetMock();
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mock.__resetMock();
});

describe('happy path', () => {
  it('getLiveMatches() returns the normalized internal shape, byte-compatible with the fixtures', async () => {
    const matches = await getLiveMatches();
    expect(matches).toEqual(getAllMatches());
    matches.forEach((m) => {
      expect(Object.keys(m).sort()).toEqual(['id', 'overs', 'score', 'status', 'teams']);
      expect(['live', 'completed', 'upcoming', 'unknown']).toContain(m.status);
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/getLiveMatches ok: 6 matches in \d+ms/));
  });

  it('getMatchDetail(id) returns a single normalized match', async () => {
    const match = await getMatchDetail('1');
    expect(match).toEqual(getAllMatches()[0]);
  });

  it('getMatchDetail() throws NotFoundError for an unknown id', async () => {
    await expect(getMatchDetail('999')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('retry behaviour', () => {
  it('recovers from a single 500 and logs exactly one retry', async () => {
    mock.__setMockFailure({ kind: '500', mode: 'once' });
    const matches = await getLiveMatches();
    expect(matches).toHaveLength(6);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/retrying getLiveMatches attempt 2\/3/));
  });

  it('throws ApiUnavailableError with attempts === 3 after three consecutive 500s', async () => {
    vi.useFakeTimers();
    mock.__setMockFailure({ kind: '500', mode: 'always' });
    const p = getLiveMatches().catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err.attempts).toBe(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/getLiveMatches failed after 3 attempts: ApiUnavailableError/),
    );
  });
});

describe('rate limiting', () => {
  it('429 with Retry-After -> ApiRateLimitError, honouring the header delay, capped at maxRetries', async () => {
    vi.useFakeTimers();
    mock.__setMockFailure({ kind: '429', mode: 'always' });
    const p = getLiveMatches().catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiRateLimitError);
    expect(err.retryAfterMs).toBe(2000);
    // 3 total attempts => 2 retry log lines, each using the Retry-After value.
    expect(logger.warn).toHaveBeenCalledTimes(2);
    logger.warn.mock.calls.forEach((c) => expect(c[0]).toContain('after 2000ms'));
  });

  it('a known-exhausted quota throws ApiRateLimitError without issuing a request', async () => {
    vi.stubEnv('CRICKET_API_KEY', 'real-key');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [], info: { hitsToday: 100, hitsLimit: 100 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getLiveMatches(); // first call succeeds, records remaining = 0
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(getLiveMatches()).rejects.toBeInstanceOf(ApiRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call short-circuited
  });
});

describe('non-transient failures', () => {
  it('a bad key (401) fails immediately with ApiUnavailableError and zero retries', async () => {
    vi.stubEnv('CRICKET_API_KEY', 'wrong-key');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401,
      headers: new Headers(),
      json: async () => ({ status: 'Failure', reason: 'Invalid API Key' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await getLiveMatches().catch((e) => e);
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an in-body failure marker (HTTP 200 + {status:"failure"}) is treated as a bad key, zero retries', async () => {
    vi.stubEnv('CRICKET_API_KEY', 'wrong-key');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: 'failure', reason: 'Invalid API Key' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await getLiveMatches().catch((e) => e);
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a malformed 200 body -> ApiParseError with populated issues', async () => {
    mock.__setMockFailure({ kind: 'malformed', mode: 'once' });
    const err = await getLiveMatches().catch((e) => e);
    expect(err).toBeInstanceOf(ApiParseError);
    expect(err.issues).toBeTruthy();
    expect(err.issues.fieldErrors).toHaveProperty('data');
  });

  it('a timeout/abort -> ApiUnavailableError whose cause is the abort', async () => {
    vi.useFakeTimers();
    mock.__setMockFailure({ kind: 'timeout', mode: 'always' });
    const p = getLiveMatches().catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err.attempts).toBe(3);
    expect(err.cause?.name).toBe('AbortError');
  });
});

describe('logging', () => {
  it('logs start (debug) and success (info) on the happy path', async () => {
    await getLiveMatches();
    expect(logger.debug).toHaveBeenCalledWith('GET /currentMatches (provider=mock)');
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/getLiveMatches ok:/));
  });
});
