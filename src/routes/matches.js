import { getLiveMatches, getMatchDetail } from '../lib/cricketApiClient.js';
import { matchIdParamSchema } from '../schemas/matches.js';

// Protected (not public), for consistency with the rest of the API surface
// — see the README's "Follows & Matches" section for the rationale.
//
// As of Phase 3 these read through cricketApiClient (mock provider by default,
// real HTTP when CRICKET_API_KEY is set) instead of the mockMatches.js fixture.
// The response shape is unchanged: { id, teams, status, score, overs }. Typed
// client errors (ApiUnavailableError / ApiRateLimitError / ApiParseError) bubble
// to errorHandler.js, which degrades them to a clean 503/502.
export default async function matchesRoutes(fastify) {
  fastify.get('/live', { onRequest: [fastify.authenticate] }, async () => {
    return getLiveMatches();
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = matchIdParamSchema.parse(request.params);

    // getMatchDetail throws NotFoundError itself when the provider has no such
    // match — errorHandler.js maps that to 404.
    return getMatchDetail(id);
  });
}
