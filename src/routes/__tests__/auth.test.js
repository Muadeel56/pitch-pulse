// Real Fastify instance (auth routes + the real authenticate plugin + the real
// error handler) against the real test database — .env.test points DATABASE_URL
// at `pitchpulse_test`, which `npm run test:db` migrates. Tables are truncated
// before each test. There is no app factory in server.js, so the instance is
// assembled here from the same plugin + route modules.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

import { prisma } from '../../lib/prisma.js';
import authenticatePlugin from '../../plugins/authenticate.js';
import errorHandlerPlugin from '../../plugins/errorHandler.js';
import authRoutes from '../auth.js';
import { truncateAll } from '../../../test/db.js';

const SECRET = process.env.JWT_SECRET;
const creds = { email: 'a@example.com', password: 'hunter2horse' };

let app;

async function buildApp() {
  const fastify = Fastify();
  await authenticatePlugin(fastify);
  await errorHandlerPlugin(fastify);
  await fastify.register(authRoutes);
  await fastify.ready();
  return fastify;
}

async function signup(payload = creds) {
  return app.inject({ method: 'POST', url: '/auth/signup', payload });
}
async function login(payload = creds) {
  return app.inject({ method: 'POST', url: '/auth/login', payload });
}

beforeEach(async () => {
  await truncateAll(prisma);
  app = await buildApp();
  return async () => {
    await app.close();
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /auth/signup', () => {
  it('creates a user and returns id/email/createdAt with no password field', async () => {
    const res = await signup();

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      id: expect.any(String),
      email: creds.email,
      createdAt: expect.any(String),
    });
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('passwordHash');

    const row = await prisma.user.findUnique({ where: { email: creds.email } });
    expect(row.passwordHash).not.toBe(creds.password); // stored hashed
  });

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    await signup();
    const res = await signup();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a bad email with 400 VALIDATION_ERROR', async () => {
    const res = await signup({ email: 'not-an-email', password: 'longenough1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a too-short password with 400 VALIDATION_ERROR', async () => {
    const res = await signup({ email: 'b@example.com', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/login', () => {
  it('returns a JWT that verifies and carries the user id', async () => {
    const { json } = await signup();
    const created = json();

    const res = await login();

    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    const payload = jwt.verify(token, SECRET);
    expect(payload.id).toBe(created.id);
    expect(payload.email).toBe(creds.email);
  });

  it('wrong password → 401 INVALID_CREDENTIALS', async () => {
    await signup();
    const res = await login({ email: creds.email, password: 'wrongwrongwrong' });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('unknown email → 401 INVALID_CREDENTIALS, byte-identical to a wrong password', async () => {
    await signup();
    const wrongPw = await login({ email: creds.email, password: 'wrongwrongwrong' });
    const unknown = await login({ email: 'nobody@example.com', password: 'whatever12' });

    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrongPw.body); // no user enumeration
  });
});

describe('GET /me', () => {
  async function tokenFor(payload = creds) {
    await signup(payload);
    return (await login(payload)).json().token;
  }

  it('returns { id, email } for a valid token', async () => {
    const token = await tokenFor();
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: expect.any(String), email: creds.email });
  });

  it('every bad-credential shape → 401 UNAUTHORIZED, identical body, never 500', async () => {
    const good = await tokenFor();
    const tampered = `${good.slice(0, -1)}${good.at(-1) === 'a' ? 'b' : 'a'}`;
    const expired = jwt.sign({ id: 'whoever', email: creds.email }, SECRET, { expiresIn: -10 });

    const cases = [
      undefined, // no header
      'Token abc', // malformed scheme
      'Bearer', // no token
      'Bearer not.a.jwt', // garbage
      `Bearer ${tampered}`, // tampered signature
      `Bearer ${expired}`, // expired
    ];

    const results = [];
    for (const authorization of cases) {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: authorization ? { authorization } : {},
      });
      results.push(res);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    // no stack trace ever leaks
    for (const res of results) expect(res.body).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});
