// A minimal Fastify instance (error handler + notifications routes) with a
// stubbed `authenticate` decorator and a fully mocked Prisma — no DB. Mirrors
// the assembly in matches.test.js; there is no app factory in server.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/prisma.js', () => ({
  prisma: { notification: { findMany: vi.fn(), updateMany: vi.fn() } },
}));

import { prisma } from '../../lib/prisma.js';
import errorHandlerPlugin from '../../plugins/errorHandler.js';
import notificationsRoutes from '../notifications.js';

const USER = 'user-1';
const AUTH = { authorization: 'Bearer test-token' };

const row = (over = {}) => ({
  id: 'n1',
  type: 'wicketFallen',
  message: 'Wicket! India are 3 down',
  matchId: '3',
  teamId: 't1',
  read: false,
  createdAt: new Date('2026-09-06T12:00:00.000Z'),
  ...over,
});

let app;

async function buildApp() {
  const fastify = Fastify();
  await errorHandlerPlugin(fastify);
  // Enforce the Bearer prefix (so the 401 path is real) but skip JWT + Prisma.
  fastify.decorate('authenticate', async (request, reply) => {
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
    }
    request.user = { id: USER };
  });
  await fastify.register(notificationsRoutes, { prefix: '/notifications' });
  await fastify.ready();
  return fastify;
}

beforeEach(async () => {
  prisma.notification.findMany.mockReset().mockResolvedValue([]);
  prisma.notification.updateMany.mockReset().mockResolvedValue({ count: 0 });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('GET /notifications', () => {
  it('401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/notifications' });
    expect(res.statusCode).toBe(401);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the caller and maps the rows', async () => {
    prisma.notification.findMany.mockResolvedValue([row()]);

    const res = await app.inject({ method: 'GET', url: '/notifications', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER }) }),
    );
    expect(res.json()).toEqual({
      notifications: [
        {
          id: 'n1',
          type: 'wicketFallen',
          message: 'Wicket! India are 3 down',
          matchId: '3',
          teamId: 't1',
          read: false,
          createdAt: '2026-09-06T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('?unread=true filters to read: false', async () => {
    await app.inject({ method: 'GET', url: '/notifications?unread=true', headers: AUTH });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER, read: false }) }),
    );
  });

  it('?unread=false filters to read: true', async () => {
    await app.inject({ method: 'GET', url: '/notifications?unread=false', headers: AUTH });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ read: true }) }),
    );
  });

  it('caps ?limit at 100', async () => {
    await app.inject({ method: 'GET', url: '/notifications?limit=500', headers: AUTH });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('defaults limit to 50 and orders newest-first', async () => {
    await app.inject({ method: 'GET', url: '/notifications', headers: AUTH });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('returns a nextCursor when the page is full', async () => {
    prisma.notification.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => row({ id: `n${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) })),
    );
    const res = await app.inject({ method: 'GET', url: '/notifications', headers: AUTH });
    expect(res.json().nextCursor).toBe(new Date(2026, 0, 1, 0, 0, 49).toISOString());
  });
});

describe('PATCH /notifications/:id/read', () => {
  it('204 when a row was flipped, scoped to the caller', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/notifications/11111111-1111-4111-8111-111111111111/read',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111', userId: USER },
      data: { read: true },
    });
  });

  it('404 when nothing matched', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/notifications/11111111-1111-4111-8111-111111111111/read',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /notifications/read-all', () => {
  it('flips every unread row for the caller and returns the count', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 4 });
    const res = await app.inject({ method: 'POST', url: '/notifications/read-all', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 4 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, read: false },
      data: { read: true },
    });
  });
});
