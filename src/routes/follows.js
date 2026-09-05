import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../errors.js';
import { teamIdParamSchema, playerIdParamSchema } from '../schemas/follows.js';

export default async function followsRoutes(fastify) {
  fastify.post('/team/:teamId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { teamId } = teamIdParamSchema.parse(request.params);

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundError('Team not found');

    // A duplicate follow throws Prisma's P2002 (unique constraint on
    // [userId, teamId]) — the centralized error handler maps that to 409
    // ALREADY_FOLLOWING, so no need to pre-check here.
    const follow = await prisma.followedTeam.create({
      data: { userId: request.user.id, teamId },
    });

    return reply.code(201).send({ id: follow.id, teamId: follow.teamId, createdAt: follow.createdAt });
  });

  fastify.delete('/team/:teamId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { teamId } = teamIdParamSchema.parse(request.params);

    // Deliberately not idempotent — returns 404 rather than silently
    // succeeding when the user isn't currently following this team. See the
    // README's "Follows & Matches" section for the rationale.
    const existing = await prisma.followedTeam.findUnique({
      where: { userId_teamId: { userId: request.user.id, teamId } },
    });
    if (!existing) throw new NotFoundError('Not following this team');

    await prisma.followedTeam.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });

  fastify.post('/player/:playerId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { playerId } = playerIdParamSchema.parse(request.params);

    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) throw new NotFoundError('Player not found');

    const follow = await prisma.followedPlayer.create({
      data: { userId: request.user.id, playerId },
    });

    return reply.code(201).send({ id: follow.id, playerId: follow.playerId, createdAt: follow.createdAt });
  });

  fastify.delete('/player/:playerId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { playerId } = playerIdParamSchema.parse(request.params);

    const existing = await prisma.followedPlayer.findUnique({
      where: { userId_playerId: { userId: request.user.id, playerId } },
    });
    if (!existing) throw new NotFoundError('Not following this player');

    await prisma.followedPlayer.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    // Scoped strictly to request.user.id — never another user's follows.
    const [followedTeams, followedPlayers] = await Promise.all([
      prisma.followedTeam.findMany({
        where: { userId: request.user.id },
        include: { team: true },
      }),
      prisma.followedPlayer.findMany({
        where: { userId: request.user.id },
        include: { player: true },
      }),
    ]);

    return {
      teams: followedTeams.map((f) => ({ id: f.team.id, name: f.team.name, shortName: f.team.shortName })),
      players: followedPlayers.map((f) => ({ id: f.player.id, name: f.player.name, teamId: f.player.teamId })),
    };
  });
}
