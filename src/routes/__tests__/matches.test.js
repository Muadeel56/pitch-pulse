// Spins up a minimal Fastify instance (error handler + matches routes, auth
// decorator stubbed) with a mocked cricketApiClient and the real Redis cache
// under the production key names — cleaned before/after each case. `npm test`
// needs Redis up. There is no app factory in server.js, so the instance is
// assembled here from the same plugin + route modules.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Fastify from 'fastify';

import errorHandlerPlugin from '../../plugins/errorHandler.js';
import matchesRoutes from '../matches.js';
import { redisClient, cacheSet, CACHE_KEYS } from '../../cache/redisClient.js';
import { getLiveMatches, getMatchDetail } from '../../lib/cricketApiClient.js';
import { ApiUnavailableError, ApiParseError, NotFoundError } from '../../errors.js';
import { logger } from '../../utils/logger.js';

vi.mock('../../lib/cricketApiClient.js', () => ({
  getLiveMatches: vi.fn(),
  getMatchDetail: vi.fn(),
}));

const DETAIL_ID = 'test-42';
const KEYS = [CACHE_KEYS.liveList, CACHE_KEYS.detail(DETAIL_ID)];

const match = (id) => ({ id, teams: ['A', 'B'], status: 'live', score: { A: '10/0' }, overs: 2 });

let app;

async function buildApp() {
  const fastify = Fastify();
  await errorHandlerPlugin(fastify);
  fastify.decorate('authenticate', async () => {}); // bypass JWT + Prisma
  await fastify.register(matchesRoutes, { prefix: '/matches' });
  await fastify.ready();
  return fastify;
}

beforeEach(async () => {
  await redisClient.del(...KEYS);
  getLiveMatches.mockReset();
  getMatchDetail.mockReset();
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  await redisClient.del(...KEYS);
});

afterAll(async () => {
  await redisClient.quit();
});

describe('GET /matches/live', () => {
  it('cache hit: returns the cached payload, never calls the API, does not warn', async () => {
    const cached = [match('1'), match('2')];
    await cacheSet(CACHE_KEYS.liveList, cached, 120);

    const res = await app.inject({ method: 'GET', url: '/matches/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(cached);
    expect(getLiveMatches).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('cache miss: falls back to the API, warns once, and re-warms the key', async () => {
    const live = [match('9')];
    getLiveMatches.mockResolvedValue(live);

    const res = await app.inject({ method: 'GET', url: '/matches/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(live);
    expect(getLiveMatches).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/cache miss on \/matches\/live/));
    expect(JSON.parse(await redisClient.get(CACHE_KEYS.liveList))).toEqual(live);
  });

  it('cache miss + API throws ApiUnavailableError → 503, existing error path intact', async () => {
    getLiveMatches.mockRejectedValue(new ApiUnavailableError('upstream down'));

    const res = await app.inject({ method: 'GET', url: '/matches/live' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('cache miss + malformed upstream body (ApiParseError) → 502 BAD_GATEWAY', async () => {
    getLiveMatches.mockRejectedValue(new ApiParseError('bad shape'));

    const res = await app.inject({ method: 'GET', url: '/matches/live' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('BAD_GATEWAY');
  });
});

describe('GET /matches/:id', () => {
  it('cache hit: returns the cached match, no API call', async () => {
    const cached = match(DETAIL_ID);
    await cacheSet(CACHE_KEYS.detail(DETAIL_ID), cached, 120);

    const res = await app.inject({ method: 'GET', url: `/matches/${DETAIL_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(cached);
    expect(getMatchDetail).not.toHaveBeenCalled();
  });

  it('cache miss: falls back, warns, and caches the result', async () => {
    const detail = match(DETAIL_ID);
    getMatchDetail.mockResolvedValue(detail);

    const res = await app.inject({ method: 'GET', url: `/matches/${DETAIL_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(detail);
    expect(getMatchDetail).toHaveBeenCalledWith(DETAIL_ID);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await redisClient.get(CACHE_KEYS.detail(DETAIL_ID)))).toEqual(detail);
  });

  it('cache miss + NotFoundError → 404, and nothing is cached for that id', async () => {
    getMatchDetail.mockRejectedValue(new NotFoundError('no such match'));

    const res = await app.inject({ method: 'GET', url: `/matches/${DETAIL_ID}` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await redisClient.get(CACHE_KEYS.detail(DETAIL_ID))).toBeNull();
  });

  it('cache miss + malformed upstream body (ApiParseError) → 502, nothing cached', async () => {
    getMatchDetail.mockRejectedValue(new ApiParseError('bad shape'));

    const res = await app.inject({ method: 'GET', url: `/matches/${DETAIL_ID}` });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('BAD_GATEWAY');
    expect(await redisClient.get(CACHE_KEYS.detail(DETAIL_ID))).toBeNull();
  });
});
