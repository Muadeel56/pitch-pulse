import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import {
  NotFoundError,
  ApiParseError,
  ApiRateLimitError,
  ApiUnavailableError,
} from '../errors.js';
import { logger } from '../utils/logger.js';

// Centralized fallback for every uncaught error — Zod validation failures,
// Prisma errors, NotFoundError, and anything else that bubbles up out of a
// route handler. Route handlers that already build their own response
// (auth.js's 401s/409s, authenticate.js's 401s) never throw, so they're
// unaffected: this only fires when a handler *throws*.
//
// The cricket API client's typed errors (ApiParseError / ApiRateLimitError /
// ApiUnavailableError) reach here only when a route calls the client directly
// (GET /matches/*). Phase 4's polling job catches them itself and keeps going,
// so it never reaches this handler.
//
// Called directly (not via fastify.register), same pattern as
// authenticatePlugin, so it's unambiguously registered on the root instance
// as THE error handler rather than scoped to one encapsulation context.
export default async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request payload',
          code: 'VALIDATION_ERROR',
          details: err.flatten(),
        },
      });
    }

    if (err instanceof NotFoundError) {
      return reply.code(404).send({
        error: { message: err.message, code: 'NOT_FOUND' },
      });
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return reply.code(409).send({
        error: { message: 'Already following this resource', code: 'ALREADY_FOLLOWING' },
      });
    }

    // Postgres unreachable mid-request (container stopped, network blip, pool
    // exhausted). Prisma reconnects on its own on the next query, so the fix is
    // a clean, retryable 503 — never a raw 500 or a crashed process. Checked
    // AFTER the P2002 branch above so a unique-constraint hit still maps to 409
    // (P2002 is a known-request error but not a connection code).
    const isDbDown =
      err instanceof Prisma.PrismaClientInitializationError ||
      err instanceof Prisma.PrismaClientRustPanicError ||
      (err instanceof Prisma.PrismaClientKnownRequestError &&
        ['P1000', 'P1001', 'P1002', 'P1008', 'P1017'].includes(err.code));

    if (isDbDown) {
      logger.error(
        `Database unavailable on ${request.method} ${request.url}: ${err.code ?? err.name}`,
      );
      return reply.code(503).send({
        error: {
          message: 'Database is temporarily unavailable, please retry',
          code: 'DB_UNAVAILABLE',
        },
      });
    }

    // Upstream data-provider failures — degrade cleanly instead of a raw 500.
    if (err instanceof ApiParseError) {
      logger.error(`Upstream parse error on ${request.method} ${request.url}: ${err.message}`);
      return reply.code(502).send({
        error: { message: 'Upstream data provider returned an unexpected response', code: 'BAD_GATEWAY' },
      });
    }

    if (err instanceof ApiRateLimitError || err instanceof ApiUnavailableError) {
      logger.error(`Upstream unavailable on ${request.method} ${request.url}: ${err.name}: ${err.message}`);
      if (err instanceof ApiRateLimitError && err.retryAfterMs) {
        reply.header('Retry-After', Math.ceil(err.retryAfterMs / 1000));
      }
      return reply.code(503).send({
        error: { message: 'Upstream data provider is temporarily unavailable', code: 'SERVICE_UNAVAILABLE' },
      });
    }

    // Fastify's own errors (malformed JSON body, etc.) carry a statusCode
    // under 500 — pass those through with a sanitized body instead of
    // always forcing a 500. Anything else (bugs, unexpected exceptions) is
    // logged server-side and returned as a generic, stack-trace-free 500.
    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;

    if (statusCode >= 500) {
      logger.error(`Unhandled error on ${request.method} ${request.url}: ${err.stack || err.message}`);
    }

    return reply.code(statusCode).send({
      error: {
        message: statusCode >= 500 ? 'Internal server error' : err.message,
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
      },
    });
  });

  // Distinct from the NotFoundError-driven 404s above (those are semantic
  // 404s from inside a matched route) — this is "no route matched at all".
  // Same response shape either way so clients never see Fastify's default.
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { message: 'Route not found', code: 'NOT_FOUND' },
    });
  });
}
