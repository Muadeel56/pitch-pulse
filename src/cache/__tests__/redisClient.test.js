// Drives the JSON cache helpers against a real Redis (docker compose) under a
// `cache:test:` key prefix — no mock. `npm test` needs Redis up.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import { redisClient, cacheGet, cacheSet, cacheDel, cacheTtlSeconds } from '../redisClient.js';
import { logger } from '../../utils/logger.js';

const K = 'cache:test:key';

beforeEach(async () => {
  await redisClient.del(K);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await redisClient.del(K);
});

afterAll(async () => {
  await redisClient.quit();
});

describe('cacheSet / cacheGet', () => {
  it('round-trips an object and applies the TTL', async () => {
    const value = { id: '3', teams: ['A', 'B'], score: { A: '10/0' }, nested: { n: 1 } };

    await cacheSet(K, value, 60);

    expect(await cacheGet(K)).toEqual(value);
    const pttl = await redisClient.pttl(K);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);
  });

  it('cacheGet returns null for a missing key', async () => {
    expect(await cacheGet(K)).toBeNull();
  });

  it('cacheGet returns null and warns when the stored value is not JSON', async () => {
    await redisClient.set(K, 'not json at all');

    expect(await cacheGet(K)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/corrupt JSON/));
  });

  it('cacheSet throws when ttlSeconds is missing / zero / negative', async () => {
    await expect(cacheSet(K, {}, undefined)).rejects.toThrow(TypeError);
    await expect(cacheSet(K, {}, 0)).rejects.toThrow(TypeError);
    await expect(cacheSet(K, {}, -5)).rejects.toThrow(TypeError);
    await expect(cacheSet(K, {}, NaN)).rejects.toThrow(TypeError);
  });
});

describe('cacheDel', () => {
  it('removes a key', async () => {
    await cacheSet(K, { a: 1 }, 60);
    await cacheDel(K);
    expect(await cacheGet(K)).toBeNull();
  });
});

describe('resilience — Redis connection errors degrade to a miss, never throw', () => {
  const boom = () => Promise.reject(new Error('Connection is closed'));

  it('cacheGet returns null and warns when the GET rejects', async () => {
    vi.spyOn(redisClient, 'get').mockImplementation(boom);

    expect(await cacheGet(K)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Redis GET .* failed/));
  });

  it('cacheSet swallows a rejected SET (logged, not thrown)', async () => {
    vi.spyOn(redisClient, 'set').mockImplementation(boom);

    await expect(cacheSet(K, { a: 1 }, 60)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Redis SET .* failed/));
  });

  it('cacheSet still throws a TypeError for a bad ttl BEFORE touching Redis', async () => {
    const set = vi.spyOn(redisClient, 'set').mockImplementation(boom);

    await expect(cacheSet(K, { a: 1 }, 0)).rejects.toThrow(TypeError);
    expect(set).not.toHaveBeenCalled();
  });

  it('cacheDel swallows a rejected DEL', async () => {
    vi.spyOn(redisClient, 'del').mockImplementation(boom);

    await expect(cacheDel(K)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Redis DEL .* failed/));
  });
});

describe('cacheTtlSeconds', () => {
  it('defaults to 120 and clamps to a 30s floor', () => {
    vi.stubEnv('CACHE_TTL_SECONDS', '');
    expect(cacheTtlSeconds()).toBe(120);
    vi.stubEnv('CACHE_TTL_SECONDS', '10');
    expect(cacheTtlSeconds()).toBe(30);
    vi.stubEnv('CACHE_TTL_SECONDS', '300');
    expect(cacheTtlSeconds()).toBe(300);
    vi.unstubAllEnvs();
  });
});
