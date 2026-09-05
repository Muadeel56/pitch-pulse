import { getAllMatches, getMatchById } from '../lib/mockMatches.js';
import { NotFoundError } from '../errors.js';
import { matchIdParamSchema } from '../schemas/matches.js';

// Protected (not public), for consistency with the rest of the API surface
// — see the README's "Follows & Matches" section for the rationale.
export default async function matchesRoutes(fastify) {
  fastify.get('/live', { onRequest: [fastify.authenticate] }, async () => {
    return getAllMatches();
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = matchIdParamSchema.parse(request.params);

    const match = getMatchById(id);
    if (!match) throw new NotFoundError('Match not found');

    return match;
  });
}
