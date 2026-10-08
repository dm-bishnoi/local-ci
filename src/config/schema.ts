import { z } from 'zod';

export const pipelineStepIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/);

/** Guard rail so a typo cannot disable the engine's termination guarantees. */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const settingsSchema = z.object({
  failFast: z.boolean().default(false),
  /**
   * Per-step time limit in milliseconds. Absent means "no limit", which keeps
   * backwards compatibility with Phase 1 configurations.
   */
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

export const localCiConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    type: z.string().min(1),
  }),
  pipeline: z.array(pipelineStepIdSchema).min(1),
  settings: settingsSchema.default({ failFast: false }),
});

export type LocalCiConfig = z.infer<typeof localCiConfigSchema>;