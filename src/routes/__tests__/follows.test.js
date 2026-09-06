// Real Fastify instance (follows routes + the real authenticate plugin + the
// real error handler) against the real test database (.env.test → pitchpulse_test,
// migrated by `npm run test:db`). Tables truncated before each test; a caller
// user + a second user are seeded so the GET /follows scoping can be asserted.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

import { prisma } from '../../lib/prisma.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import errorHandlerPlugin from '../../plugins/errorHandler.js';
import followsRoutes from '../follows.js';
import { truncateAll } from '../../../test/db.js';

const SECRET = process.env.JWT_SECRET;
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

let app;
let me;
let other;
let team;
let team2;
let player;

const bearer = (user) => ({ authorization: `Bearer ${jwt.sign({ id: user.id, email: user.email }, SECRET)}` });

async function buildApp() {
  const fastify = Fastify();
  await authenticatePlugin(fastify);
  await errorHandlerPlugin(fastify);
  await fastify.register(followsRoutes, { prefix: '/follows' });
  await fastify.ready();
  return fastify;
}

beforeEach(async () => {
  await truncateAll(prisma);
  me = await prisma.user.create({ data: { email: 'me@example.com', passwordHash: 'x' } });
  other = await prisma.user.create({ data: { email: 'other@example.com', passwordHash: 'x' } });
  team = await prisma.team.create({ data: { name: 'India', shortName: 'IND' } });
  team2 = await prisma.team.create({ data: { name: 'Australia', shortName: 'AUS' } });
  player = await prisma.player.create({ data: { name: 'V Kohli', teamId: team.id } });
  app = await buildApp();
  return async () => {
    await app.close();
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /follows/team/:teamId', () => {
  it('follows a team → 201 { id, teamId, createdAt }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/follows/team/${team.id}`,
      headers: bearer(me),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      teamId: team.id,
      createdAt: expect.any(String),
    });
  });

  it('following the same team twice → 409 ALREADY_FOLLOWING', async () => {
    await app.inject({ method: 'POST', url: `/follows/team/${team.id}`, headers: bearer(me) });
    const res = await app.inject({
      method: 'POST',
      url: `/follows/team/${team.id}`,
      headers: bearer(me),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_FOLLOWING');
  });

  it('unknown (well-formed) team id → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/follows/team/${MISSING_UUID}`,
      headers: bearer(me),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('malformed team id → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/follows/team/not-a-uuid',
      headers: bearer(me),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /follows/player/:playerId', () => {
  it('follows a player → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/follows/player/${player.id}`,
      headers: bearer(me),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ playerId: player.id });
  });
});

describe('GET /follows', () => {
  it('returns the caller\'s follows only, never another user\'s', async () => {
    await app.inject({ method: 'POST', url: `/follows/team/${team.id}`, headers: bearer(me) });
    await app.inject({ method: 'POST', url: `/follows/player/${player.id}`, headers: bearer(me) });
    // `other` follows a different team — must not bleed into `me`'s list.
    await app.inject({ method: 'POST', url: `/follows/team/${team2.id}`, headers: bearer(other) });

    const res = await app.inject({ method: 'GET', url: '/follows', headers: bearer(me) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.teams.map((t) => t.id)).toEqual([team.id]);
    expect(body.players.map((p) => p.id)).toEqual([player.id]);
  });
});

describe('DELETE /follows/team/:teamId', () => {
  it('unfollow → 204, then unfollow again → 404 NOT_FOUND', async () => {
    await app.inject({ method: 'POST', url: `/follows/team/${team.id}`, headers: bearer(me) });

    const first = await app.inject({
      method: 'DELETE',
      url: `/follows/team/${team.id}`,
      headers: bearer(me),
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: 'DELETE',
      url: `/follows/team/${team.id}`,
      headers: bearer(me),
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('NOT_FOUND');
  });
});

describe('auth', () => {
  it('every route without a token → 401', async () => {
    const calls = [
      ['POST', `/follows/team/${team.id}`],
      ['DELETE', `/follows/team/${team.id}`],
      ['POST', `/follows/player/${player.id}`],
      ['DELETE', `/follows/player/${player.id}`],
      ['GET', '/follows'],
    ];

    for (const [method, url] of calls) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });
});
