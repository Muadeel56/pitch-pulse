// Drives the reactive notification listeners against a fully mocked Prisma —
// no DB, no Redis. Events are pushed through the real `notifier` singleton;
// handlers do their work on a later microtask (see `guard` in the module), so
// assertions wait with `vi.waitFor` / a short tick.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    team: { findFirst: vi.fn() },
    followedTeam: { findMany: vi.fn() },
    notification: { createMany: vi.fn() },
  },
}));

import { prisma } from '../../lib/prisma.js';
import { notifier } from '../notifier.js';
import { logger } from '../../utils/logger.js';
import { initNotificationHandlers, closeNotificationHandlers } from '../notificationHandlers.js';

const polledAt = '2026-09-06T00:00:00.000Z';
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
  prisma.team.findFirst.mockReset().mockResolvedValue({ id: 't1' });
  prisma.followedTeam.findMany.mockReset().mockResolvedValue([]);
  prisma.notification.createMany.mockReset().mockResolvedValue({ count: 0 });
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  initNotificationHandlers();
});

afterEach(() => {
  closeNotificationHandlers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('wicketFallen', () => {
  it('creates one Notification per follower when two users follow the team', async () => {
    prisma.followedTeam.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    notifier.emit('wicketFallen', { matchId: '3', teamName: 'India', wickets: 3, delta: 1, polledAt });

    await vi.waitFor(() => expect(prisma.notification.createMany).toHaveBeenCalledTimes(1));
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data).toEqual([
      { userId: 'u1', type: 'wicketFallen', message: 'Wicket! India are 3 down', matchId: '3', teamId: 't1' },
      { userId: 'u2', type: 'wicketFallen', message: 'Wicket! India are 3 down', matchId: '3', teamId: 't1' },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('creates nothing when nobody follows the team', async () => {
    prisma.followedTeam.findMany.mockResolvedValue([]);

    notifier.emit('wicketFallen', { matchId: '3', teamName: 'India', wickets: 3, delta: 1, polledAt });
    await tick();

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('creates nothing and does not throw when the team name is unresolvable', async () => {
    prisma.team.findFirst.mockResolvedValue(null);

    expect(() =>
      notifier.emit('wicketFallen', { matchId: '3', teamName: 'New Zealand', wickets: 2, delta: 1, polledAt }),
    ).not.toThrow();
    await tick();

    expect(prisma.followedTeam.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/not seeded/));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('catches a Prisma rejection and logs a warning instead of rethrowing', async () => {
    prisma.followedTeam.findMany.mockResolvedValue([{ userId: 'u1' }]);
    prisma.notification.createMany.mockRejectedValue(new Error('db down'));

    expect(() =>
      notifier.emit('wicketFallen', { matchId: '3', teamName: 'India', wickets: 3, delta: 1, polledAt }),
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/'wicketFallen' failed: db down/)),
    );
  });
});

describe('matchStarted', () => {
  it('dedupes a user who follows both teams into a single row', async () => {
    prisma.team.findFirst
      .mockResolvedValueOnce({ id: 'tA' })
      .mockResolvedValueOnce({ id: 'tB' });
    prisma.followedTeam.findMany
      .mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]) // follow team A
      .mockResolvedValueOnce([{ userId: 'u1' }]); // u1 also follows team B
    prisma.notification.createMany.mockResolvedValue({ count: 2 });

    notifier.emit('matchStarted', { matchId: '7', teams: ['India', 'Australia'], polledAt });

    await vi.waitFor(() => expect(prisma.notification.createMany).toHaveBeenCalledTimes(1));
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data).toEqual([
      { userId: 'u1', type: 'matchStarted', message: 'Match started: India vs Australia', matchId: '7', teamId: 'tA' },
      { userId: 'u2', type: 'matchStarted', message: 'Match started: India vs Australia', matchId: '7', teamId: 'tA' },
    ]);
  });
});

describe('closeNotificationHandlers', () => {
  it('detaches every listener — a later emit is a no-op', async () => {
    closeNotificationHandlers();
    prisma.team.findFirst.mockClear();

    notifier.emit('wicketFallen', { matchId: '3', teamName: 'India', wickets: 3, delta: 1, polledAt });
    notifier.emit('milestoneReached', { matchId: '3', teamName: 'India', runs: 50, milestone: 50, polledAt });
    notifier.emit('matchStarted', { matchId: '3', teams: ['India', 'Australia'], polledAt });
    await tick();

    expect(prisma.team.findFirst).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
