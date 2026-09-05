import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

// Thin working client — docker-compose brings up Redis so this connects for
// real. JSON get/set helper wrappers and caching strategy are Phase 5's job.
export const redisClient = new Redis(process.env.REDIS_URL);

redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('error', (err) => logger.error(`Redis error: ${err.message}`));
