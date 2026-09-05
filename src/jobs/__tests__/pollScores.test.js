// Drives runPollOnce() directly against a real Redis (docker compose) under a
// `poll:test:` key prefix — no Worker, no 45s waits. `npm test` needs Redis up.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import { runPollOnce, pollProcessor, diffMatches, __resetPollState } from '../pollScores.js';
import { redisClient } from '../../cache/redisClient.js';
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

let matchUpdated;

beforeEach(async () => {
  await redisClient.del(SNAP, LOCK, 'poll:snapshot', 'poll:lock');
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
