import { z } from 'zod';

// Query params for GET /notifications. Everything arrives as a string, so
// booleans/numbers/dates are coerced. `limit` is clamped (not rejected) at 100
// so a caller asking for more just gets the ceiling.
export const notificationQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((n) => Math.min(n, 100)),
  before: z.coerce.date().optional(),
});

export const notificationIdParamSchema = z.object({
  id: z.string().uuid(),
});
