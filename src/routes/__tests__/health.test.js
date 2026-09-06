// Liveness/readiness routes. Real Fastify instance, real prisma against the
// test DB, real Redis (both up for `npm test`). The poller is not started in
// tests (POLL_ENABLED=false), so `poller: 'down'` is expected and still 200.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Fastify from 'fastify';

import { prisma } from '../../lib/prisma.js';
import healthRoutes from '../health.js';

let app;

beforeEach(async () => {
  app = Fastify();
  await app.register(healthRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('is always 200 { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('200 with per-dependency checks when Postgres is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checks.postgres).toBe('up');
    expect(body.checks.redis).toBe('up');
    expect(body.checks).toHaveProperty('poller');
    expect(['ok', 'degraded']).toContain(body.status);
  });

  it('503 "unavailable" when the Postgres probe fails', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('P1001: cannot reach database'));

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks.postgres).toBe('down');
  });
});
