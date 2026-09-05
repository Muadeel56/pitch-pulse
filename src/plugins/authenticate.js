import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';

// Decorates `fastify.authenticate` for opt-in use on protected routes via
// `{ onRequest: [fastify.authenticate] }` — NOT a blanket app-wide hook, so
// /auth/signup and /auth/login stay public.
export default async function authenticatePlugin(fastify) {
  fastify.decorate('authenticate', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: { message: 'Missing or malformed Authorization header', code: 'UNAUTHORIZED' },
      });
    }

    const token = authHeader.slice('Bearer '.length);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return reply.code(401).send({
        error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' },
      });
    }

    // Re-fetch from Postgres (rather than trusting the JWT payload verbatim)
    // so a deleted/deactivated user is locked out immediately even with a
    // still-valid 7-day token, and so request.user is DB-fresh for every
    // protected route, not just /me.
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) {
      return reply.code(401).send({
        error: { message: 'User no longer exists', code: 'UNAUTHORIZED' },
      });
    }

    request.user = { id: user.id, email: user.email };
  });
}
