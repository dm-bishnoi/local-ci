import { z } from 'zod';

export const pipelineStepIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/);

export const localCiConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    type: z.string().min(1),
  }),
  pipeline: z.array(pipelineStepIdSchema).min(1),
  settings: z.object({
    failFast: z.boolean().default(false),
  }).default({ failFast: false }),
});

export type LocalCiConfig = z.infer<typeof localCiConfigSchema>;
