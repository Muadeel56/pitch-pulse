// The authenticate decorator in isolation: a bare Fastify app with one
// protected route, the real plugin, and the real test database (.env.test →
// pitchpulse_test). Covers the token-shape matrix and the "token still valid
// but the user row is gone" case that the auth route suite doesn't.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

import { prisma } from '../../lib/prisma.js';
import authenticatePlugin from '../authenticate.js';
import { truncateAll } from '../../../test/db.js';

const SECRET = process.env.JWT_SECRET;

let app;
let user;

async function buildApp() {
  const fastify = Fastify();
  await authenticatePlugin(fastify);
  fastify.get('/protected', { onRequest: [fastify.authenticate] }, async (req) => req.user);
  await fastify.ready();
  return fastify;
}

const get = (authorization) =>
  app.inject({ method: 'GET', url: '/protected', headers: authorization ? { authorization } : {} });

beforeEach(async () => {
  await truncateAll(prisma);
  user = await prisma.user.create({ data: { email: 'u@example.com', passwordHash: 'x' } });
  app = await buildApp();
  return async () => {
    await app.close();
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

it('a valid token populates request.user with the DB-fresh id + email', async () => {
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET);
  const res = await get(`Bearer ${token}`);

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ id: user.id, email: user.email });
});

it('a still-valid token for a since-deleted user → 401 UNAUTHORIZED', async () => {
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: '7d' });
  await prisma.user.delete({ where: { id: user.id } });

  const res = await get(`Bearer ${token}`);

  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe('UNAUTHORIZED');
});

describe('every rejected shape is an identical 401, never a 500 or a stack trace', () => {
  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc123'],
    ['Bearer with no token', 'Bearer '],
    ['garbage token', 'Bearer not.a.jwt'],
    ['wrong signing secret', `Bearer ${jwt.sign({ id: 'x' }, 'not-the-secret')}`],
    ['expired token', `Bearer ${jwt.sign({ id: 'x' }, SECRET, { expiresIn: -10 })}`],
  ])('%s', async (_label, authorization) => {
    const res = await get(authorization);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { message: expect.any(String), code: 'UNAUTHORIZED' },
    });
    expect(res.body).not.toMatch(/\bat .*:\d+:\d+/); // no stack
  });
});
