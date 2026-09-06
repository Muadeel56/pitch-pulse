import { prisma } from '../lib/prisma.js';

// Read-only lookups for the seeded reference data. The client needs a Team /
// Player id (UUID) to hit the follow endpoints, and GET /follows only returns
// what the user already follows — so these expose the full seed set to pick
// from. No pagination: the seed is a handful of rows.
export default async function referenceRoutes(fastify) {
  fastify.get('/teams', { onRequest: [fastify.authenticate] }, async () => {
    const teams = await prisma.team.findMany({ orderBy: { name: 'asc' } });
    return teams.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName }));
  });

  fastify.get('/players', { onRequest: [fastify.authenticate] }, async () => {
    const players = await prisma.player.findMany({ orderBy: { name: 'asc' } });
    return players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId }));
  });
}
