import { z } from 'zod';

import { MAX_PARALLEL_LIMIT } from './constants.js';

export const teamRunSchema = z.object({
  teamId: z.string().min(1).describe('Team ID from .pulse-coder/teams/*.team.json'),
  goal: z.string().min(1).describe('Top-level user goal for this team run'),
  input: z.record(z.string(), z.unknown()).optional().describe('Structured input payload for node templates'),
  maxParallel: z.number().int().positive().max(MAX_PARALLEL_LIMIT).optional().describe('Override max parallelism for this run')
});

export type TeamRunInput = z.infer<typeof teamRunSchema>;
