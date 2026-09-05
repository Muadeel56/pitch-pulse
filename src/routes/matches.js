import { getLiveMatches, getMatchDetail } from '../lib/cricketApiClient.js';
import { matchIdParamSchema } from '../schemas/matches.js';
import { cacheGet, cacheSet, cacheTtlSeconds, CACHE_KEYS } from '../cache/redisClient.js';
import { logger } from '../utils/logger.js';

// Protected (not public), for consistency with the rest of the API surface
// — see the README's "Follows & Matches" section for the rationale.
//
// As of Phase 5 these read from the Redis cache that the background poll job
// keeps warm (src/jobs/pollScores.js is the only writer). They only touch
// cricketApiClient on a cold miss — a brand-new process before its first poll,
// or a wiped Redis. That branch is rare by design (no stampede protection here —
// see issue #5 "out of scope") and it logs when it happens. Typed client errors
// (ApiUnavailableError / ApiRateLimitError / ApiParseError) still bubble to
// errorHandler.js, which degrades them to a clean 503/502.
export default async function matchesRoutes(fastify) {
  fastify.get('/live', { onRequest: [fastify.authenticate] }, async () => {
    const cached = await cacheGet(CACHE_KEYS.liveList);
    if (cached) return cached; // warm path — the normal case

    logger.warn('cache miss on /matches/live — direct API fallback (should be rare)');
    const matches = await getLiveMatches();
    await cacheSet(CACHE_KEYS.liveList, matches, cacheTtlSeconds()); // re-warm
    return matches;
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = matchIdParamSchema.parse(request.params);

    const cached = await cacheGet(CACHE_KEYS.detail(id));
    if (cached) return cached;

    logger.warn(`cache miss on /matches/${id} — direct API fallback (should be rare)`);
    // getMatchDetail throws NotFoundError itself when the provider has no such
    // match — errorHandler.js maps that to 404, and we do not cache a not-found.
    const match = await getMatchDetail(id);
    await cacheSet(CACHE_KEYS.detail(id), match, cacheTtlSeconds());
    return match;
  });
}
