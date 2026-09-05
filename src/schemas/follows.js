import { z } from 'zod';

export const teamIdParamSchema = z.object({
  teamId: z.string().uuid(),
});

export const playerIdParamSchema = z.object({
  playerId: z.string().uuid(),
});
