import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../errors.js';
import { notificationQuerySchema, notificationIdParamSchema } from '../schemas/notifications.js';

// Phase 7 — read side of event-driven notifications. Every route is protected
// and scoped strictly to request.user.id — a caller never sees another user's
// notifications. Rows are written by src/events/notificationHandlers.js.
export default async function notificationsRoutes(fastify) {
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const { unread, limit, before } = notificationQuerySchema.parse(request.query);

    const rows = await prisma.notification.findMany({
      where: {
        userId: request.user.id,
        ...(unread !== undefined ? { read: !unread } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        message: r.message,
        matchId: r.matchId,
        teamId: r.teamId,
        read: r.read,
        createdAt: r.createdAt,
      })),
      // Full page => there may be more; cursor is the oldest row's createdAt.
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
    };
  });

  fastify.patch('/:id/read', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { id } = notificationIdParamSchema.parse(request.params);

    // updateMany (not update) so the userId scope is part of the filter — a
    // mismatch is a 404, not someone else's row flipped.
    const { count } = await prisma.notification.updateMany({
      where: { id, userId: request.user.id },
      data: { read: true },
    });
    if (count === 0) throw new NotFoundError('Notification not found');

    return reply.code(204).send();
  });

  fastify.post('/read-all', { onRequest: [fastify.authenticate] }, async (request) => {
    const { count } = await prisma.notification.updateMany({
      where: { userId: request.user.id, read: false },
      data: { read: true },
    });
    return { updated: count };
  });
}
