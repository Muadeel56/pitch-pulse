// Drives runPollOnce() directly against a real Redis (docker compose) under a
// `poll:test:` key prefix — no Worker, no 45s waits. `npm test` needs Redis up.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import {
  runPollOnce,
  pollProcessor,
  diffMatches,
  deriveMatchEvents,
  __resetPollState,
} from '../pollScores.js';
import { redisClient, cacheTtlSeconds, CACHE_KEYS } from '../../cache/redisClient.js';
import { notifier } from '../../events/notifier.js';
import { getLiveMatches } from '../../lib/cricketApiClient.js';
import { ApiParseError, ApiUnavailableError } from '../../errors.js';
import { UnrecoverableError } from 'bullmq';
import { logger } from '../../utils/logger.js';

vi.mock('../../lib/cricketApiClient.js', () => ({ getLiveMatches: vi.fn() }));

const P = 'poll:test:';
const SNAP = `${P}snapshot`;
const LOCK = `${P}lock`;
const opts = { keyPrefix: P, lockTtlMs: 30_000 };

// A normalized match; `score` is the `{ [team]: "runs/wkts" }` map.
const m = (id, over = {}) => ({
  id,
  teams: ['A', 'B'],
  status: 'live',
  score: { A: '10/0', B: '0/0' },
  overs: 2,
  ...over,
});

const readSnapshot = async () => JSON.parse((await redisClient.get(SNAP)) ?? 'null');
const readCache = async (key) => JSON.parse((await redisClient.get(key)) ?? 'null');
const clearCacheKeys = () =>
  redisClient.del(CACHE_KEYS.liveList, CACHE_KEYS.detail('x1'), CACHE_KEYS.detail('x2'));

let matchUpdated;

beforeEach(async () => {
  await redisClient.del(SNAP, LOCK, 'poll:snapshot', 'poll:lock');
  await clearCacheKeys();
  __resetPollState();
  getLiveMatches.mockReset();
  matchUpdated = vi.fn();
  notifier.on('matchUpdated', matchUpdated);
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  notifier.removeListener('matchUpdated', matchUpdated);
  vi.restoreAllMocks();
  await redisClient.del(SNAP, LOCK, 'poll:snapshot', 'poll:lock');
  await clearCacheKeys();
});

afterAll(async () => {
  await redisClient.quit();
});

describe('runPollOnce', () => {
  it('first run seeds the snapshot and emits nothing', async () => {
    getLiveMatches.mockResolvedValue([m('x1')]);

    const res = await runPollOnce(opts);

    expect(res).toMatchObject({ firstRun: true, changes: [] });
    expect(matchUpdated).not.toHaveBeenCalled();
    expect((await readSnapshot()).matches).toEqual([m('x1')]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/first run/));
  });

  it('no change: second identical poll emits nothing and does not rewrite the snapshot', async () => {
    getLiveMatches.mockResolvedValue([m('x1')]);
    await runPollOnce(opts); // first run — seeds
    const seededAt = (await readSnapshot()).polledAt;

    const res = await runPollOnce(opts);

    expect(res.changes).toEqual([]);
    expect(matchUpdated).not.toHaveBeenCalled();
    expect((await readSnapshot()).polledAt).toBe(seededAt); // untouched
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/0 changed/));
  });

  it('score change: one changed entry with fields ["score"], emitted once', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts);

    getLiveMatches.mockResolvedValueOnce([m('x1', { score: { A: '40/0', B: '0/0' } })]);
    const res = await runPollOnce(opts);

    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({ id: 'x1', type: 'changed', fields: ['score'] });
    expect(matchUpdated).toHaveBeenCalledTimes(1);
    expect(matchUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ polledAt: expect.any(String), matches: expect.any(Array), changes: res.changes }),
    );
  });

  it('wicket falling reports both "score" and "wickets" fields', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts);

    getLiveMatches.mockResolvedValueOnce([m('x1', { score: { A: '10/1', B: '0/0' } })]);
    const res = await runPollOnce(opts);

    expect(res.changes[0].fields).toEqual(expect.arrayContaining(['score', 'wickets']));
  });

  it('detects added and removed matches', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts);

    getLiveMatches.mockResolvedValueOnce([m('x2')]);
    const res = await runPollOnce(opts);

    const byType = Object.fromEntries(res.changes.map((c) => [c.type, c.id]));
    expect(byType).toEqual({ added: 'x2', removed: 'x1' });
    expect(matchUpdated).toHaveBeenCalledTimes(1);
  });

  it('idempotent retry: replaying already-applied poll data yields 0 changed', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts); // seed

    const changed = [m('x1', { score: { A: '40/0', B: '0/0' } })];
    getLiveMatches.mockResolvedValueOnce(changed);
    await runPollOnce(opts); // applies the change + emits

    getLiveMatches.mockResolvedValueOnce(changed);
    const res = await runPollOnce(opts); // same data again

    expect(res.changes).toEqual([]);
    expect(matchUpdated).toHaveBeenCalledTimes(1);
  });

  it('lock held: returns skipped, no fetch, no emit, foreign lock untouched', async () => {
    await redisClient.set(LOCK, 'someone-else', 'PX', 30_000);

    const res = await runPollOnce(opts);

    expect(res).toMatchObject({ skipped: true });
    expect(getLiveMatches).not.toHaveBeenCalled();
    expect(matchUpdated).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/skipped \(locked\)/));
    expect(await redisClient.get(LOCK)).toBe('someone-else');
  });

  it('transient client error rejects (so BullMQ retries); no snapshot, no emit, lock released', async () => {
    getLiveMatches.mockRejectedValue(new ApiUnavailableError('upstream down'));

    await expect(runPollOnce(opts)).rejects.toBeInstanceOf(ApiUnavailableError);
    expect(await redisClient.get(SNAP)).toBeNull();
    expect(await redisClient.get(LOCK)).toBeNull();
    expect(matchUpdated).not.toHaveBeenCalled();
  });

  it('order-insensitive: a shuffled but equal match array is 0 changed', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1'), m('x2')]);
    await runPollOnce(opts);

    getLiveMatches.mockResolvedValueOnce([m('x2'), m('x1')]);
    const res = await runPollOnce(opts);

    expect(res.changes).toEqual([]);
    expect(matchUpdated).not.toHaveBeenCalled();
  });
});

describe('runPollOnce — Phase 5 cache writes', () => {
  it('writes match:live:list + one match:detail:{id} per match with the configured TTL after a change', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts); // first run

    getLiveMatches.mockResolvedValueOnce([m('x1', { score: { A: '40/0', B: '0/0' } }), m('x2')]);
    await runPollOnce(opts); // change → snapshot + cache + emit

    const list = await readCache(CACHE_KEYS.liveList);
    expect(list.map((x) => x.id)).toEqual(['x1', 'x2']);
    expect(await readCache(CACHE_KEYS.detail('x1'))).toMatchObject({ id: 'x1' });
    expect(await readCache(CACHE_KEYS.detail('x2'))).toMatchObject({ id: 'x2' });

    const pttl = await redisClient.pttl(CACHE_KEYS.liveList);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(cacheTtlSeconds() * 1000);
  });

  it('writes the cache on the first run even though no matchUpdated is emitted', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);

    const res = await runPollOnce(opts);

    expect(res).toMatchObject({ firstRun: true });
    expect(matchUpdated).not.toHaveBeenCalled();
    expect(await readCache(CACHE_KEYS.liveList)).toEqual([m('x1')]);
    expect(await readCache(CACHE_KEYS.detail('x1'))).toEqual(m('x1'));
  });

  it('a cacheSet failure does not reject runPollOnce and does not suppress the emit', async () => {
    getLiveMatches.mockResolvedValueOnce([m('x1')]);
    await runPollOnce(opts); // seed

    const origSet = redisClient.set.bind(redisClient);
    vi.spyOn(redisClient, 'set').mockImplementation((key, ...args) =>
      String(key).startsWith('match:')
        ? Promise.reject(new Error('redis write blip'))
        : origSet(key, ...args),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    getLiveMatches.mockResolvedValueOnce([m('x1', { score: { A: '99/0', B: '0/0' } })]);
    const res = await runPollOnce(opts);

    expect(res.changes).toHaveLength(1);
    expect(matchUpdated).toHaveBeenCalledTimes(1);
    // cacheSet now swallows a connection error itself (Phase 8) — warmCache's
    // own catch is belt-and-braces and no longer the one that fires.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Redis SET match:.* failed/));
  });
});

describe('pollProcessor', () => {
  it('maps ApiParseError to a non-retryable UnrecoverableError (fails fast)', async () => {
    getLiveMatches.mockRejectedValue(new ApiParseError('bad body'));

    await expect(pollProcessor()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(getLiveMatches).toHaveBeenCalledTimes(1);
  });

  it('lets a transient error through for BullMQ to retry', async () => {
    getLiveMatches.mockRejectedValue(new ApiUnavailableError('down'));

    await expect(pollProcessor()).rejects.toBeInstanceOf(ApiUnavailableError);
  });
});

describe('deriveMatchEvents', () => {
  const polledAt = '2026-09-06T00:00:00.000Z';
  const changed = (id, before, after, fields) => ({ id, type: 'changed', before, after, fields });
  const names = (evts) => evts.map((e) => e.name);

  it('upcoming → live yields a single matchStarted', () => {
    const c = changed(
      '3',
      { id: '3', teams: ['A', 'B'], status: 'upcoming', score: null },
      { id: '3', teams: ['A', 'B'], status: 'live', score: { A: '0/0', B: '0/0' } },
      ['status', 'score'],
    );
    const evts = deriveMatchEvents({ polledAt, changes: [c] });
    expect(names(evts)).toEqual(['matchStarted']);
    expect(evts[0].payload).toEqual({ matchId: '3', teams: ['A', 'B'], polledAt });
  });

  it('a brand-new match already live yields matchStarted', () => {
    const c = {
      id: '9',
      type: 'added',
      before: null,
      after: { id: '9', teams: ['A', 'B'], status: 'live', score: { A: '0/0' } },
      fields: [],
    };
    expect(names(deriveMatchEvents({ polledAt, changes: [c] }))).toEqual(['matchStarted']);
  });

  it('wicket count up yields wicketFallen with the right delta', () => {
    const c = changed(
      '3',
      { score: { A: '80/2', B: '0/0' } },
      { score: { A: '80/4', B: '0/0' } },
      ['score', 'wickets'],
    );
    const evts = deriveMatchEvents({ polledAt, changes: [c] });
    expect(names(evts)).toEqual(['wicketFallen']);
    expect(evts[0].payload).toMatchObject({ matchId: '3', teamName: 'A', wickets: 4, delta: 2 });
  });

  it('runs 48 → 52 yields milestoneReached milestone 50', () => {
    const c = changed('3', { score: { A: '48/0' } }, { score: { A: '52/0' } }, ['score']);
    const evts = deriveMatchEvents({ polledAt, changes: [c] });
    expect(names(evts)).toEqual(['milestoneReached']);
    expect(evts[0].payload).toMatchObject({ teamName: 'A', runs: 52, milestone: 50 });
  });

  it('runs 52 → 60 (no new 50-boundary crossed) yields nothing', () => {
    const c = changed('3', { score: { A: '52/0' } }, { score: { A: '60/0' } }, ['score']);
    expect(deriveMatchEvents({ polledAt, changes: [c] })).toEqual([]);
  });

  it('no changes yields an empty array', () => {
    expect(deriveMatchEvents({ polledAt, changes: [] })).toEqual([]);
    expect(deriveMatchEvents({ polledAt, changes: undefined })).toEqual([]);
  });
});

describe('diffMatches', () => {
  it('flags status and overs changes by name', () => {
    const before = [m('x1')];
    const after = [m('x1', { status: 'completed', overs: 20 })];
    expect(diffMatches(before, after)[0].fields).toEqual(expect.arrayContaining(['status', 'overs']));
  });

  it('ignores match array order', () => {
    expect(diffMatches([m('a'), m('b')], [m('b'), m('a')])).toEqual([]);
  });
});
