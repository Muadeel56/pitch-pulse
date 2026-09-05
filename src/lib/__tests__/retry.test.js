import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../retry.js';
import { ApiRateLimitError, ApiUnavailableError } from '../../errors.js';
import { logger } from '../../utils/logger.js';

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const transient = (over = {}) => Object.assign(new Error('boom'), { retryable: true, ...over });

describe('withRetry', () => {
  it('resolves on the first success without logging a retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries a transient failure then resolves', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue('ok');
    const p = withRetry(fn, { baseDelayMs: 10, maxDelayMs: 20 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after `maxRetries` total attempts and wraps the error', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(transient());
    const p = withRetry(fn, { maxRetries: 3 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-retryable error and rethrows it raw', async () => {
    const original = Object.assign(new Error('bad key'), { retryable: false, status: 401 });
    const fn = vi.fn().mockRejectedValue(original);
    await expect(withRetry(fn)).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('wraps a 429-tagged terminal failure as ApiRateLimitError', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(transient({ status: 429, retryAfterMs: 1500 }));
    const p = withRetry(fn, { maxRetries: 2 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(ApiRateLimitError);
    expect(err.retryAfterMs).toBe(1500);
  });

  it('keeps every backoff delay within [0, min(maxDelayMs, base * 2**attempt)]', async () => {
    vi.useFakeTimers();
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const fn = vi.fn().mockRejectedValue(transient());
    const p = withRetry(fn, { maxRetries: 6, baseDelayMs: 100, maxDelayMs: 800 }).catch(() => {});
    await vi.runAllTimersAsync();
    await p;

    const delays = logger.warn.mock.calls.map((c) => Number(c[0].match(/after (\d+)ms/)[1]));
    // attempt 0..4 ceilings: 100, 200, 400, 800(capped), 800(capped)
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeLessThanOrEqual(200);
    expect(delays[2]).toBeLessThanOrEqual(400);
    expect(delays[3]).toBeLessThanOrEqual(800);
    expect(delays[4]).toBeLessThanOrEqual(800);
    delays.forEach((d) => expect(d).toBeGreaterThanOrEqual(0));
    randSpy.mockRestore();
  });

  it('honours a caller-supplied retryDelayMs over the computed backoff', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(transient());
    const p = withRetry(fn, { maxRetries: 2, retryDelayMs: () => 4321 }).catch(() => {});
    await vi.runAllTimersAsync();
    await p;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('after 4321ms'));
  });
});
