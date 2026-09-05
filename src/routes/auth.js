import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { signupSchema, loginSchema } from '../schemas/auth.js';

export default async function authRoutes(fastify) {
  fastify.post('/auth/signup', async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: 'Invalid signup payload',
          code: 'VALIDATION_ERROR',
          details: parsed.error.flatten(),
        },
      });
    }
    const { email, password } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({
        error: { message: 'Email already registered', code: 'EMAIL_TAKEN' },
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, passwordHash } });

    return reply.code(201).send({ id: user.id, email: user.email, createdAt: user.createdAt });
  });

  fastify.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { message: 'Invalid login payload', code: 'VALIDATION_ERROR' },
      });
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Same message/code as a wrong password below — don't let login leak
      // whether an email is registered.
      return reply.code(401).send({
        error: { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({
        error: { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
      });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    return reply.send({ token });
  });

  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    return request.user;
  });
}
