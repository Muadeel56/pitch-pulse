// Structured logging (Phase 10). Backed by `pino`: JSON lines in production
// (NODE_ENV=production), human-readable via `pino-pretty` everywhere else.
// `pino-pretty` is a dev dependency and is only referenced on the non-prod
// path, so a production install without it is fine.
//
// The exported surface is deliberately unchanged from the old hand-rolled
// console logger — `logger.info/warn/error/debug(msg[, fields])` — so the ~15
// modules that `import { logger }` don't need touching. Level is env-driven
// (LOG_LEVEL, default `info`); `debug` messages only render when LOG_LEVEL=debug.
import pino from 'pino';

const usePretty =
  process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: usePretty
    ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
    : undefined,
});

// pino's signature is (mergeObject, message); ours is (message, mergeObject).
export const logger = {
  info: (msg, fields) => base.info(fields ?? {}, msg),
  warn: (msg, fields) => base.warn(fields ?? {}, msg),
  error: (msg, fields) => base.error(fields ?? {}, msg),
  debug: (msg, fields) => base.debug(fields ?? {}, msg),
};

// The raw pino instance, for anything that wants child loggers or to hand
// Fastify a logger later (a noted follow-up — server.js still uses this wrapper).
export { base as pinoLogger };
