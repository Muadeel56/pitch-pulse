// Thrown by route handlers when a looked-up resource (team/player/match/etc.)
// doesn't exist, and caught by the centralized error handler (see
// plugins/errorHandler.js) and mapped to a 404. Zod's ZodError and Prisma's
// PrismaClientKnownRequestError are detected there by their own type instead
// of being wrapped — this is the only custom error class the app needs.
export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
