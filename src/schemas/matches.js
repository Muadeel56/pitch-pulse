import { z } from 'zod';

export const matchIdParamSchema = z.object({
  id: z.string().min(1),
});
