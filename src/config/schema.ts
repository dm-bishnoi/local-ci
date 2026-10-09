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

/**
 * Environment requirements declared by the project.
 *
 * Only *names* are ever held here. Values are never read into configuration,
 * never passed through, and never printed: a diagnostic tool that reports
 * "present" or "absent" is useful, and one that can echo a database URL is a
 * liability.
 */
const environmentVariableNameSchema = z
  .string()
  .min(1)
  .max(256)
  // Environment variable names are conventionally shell identifiers. Rejecting
  // anything else keeps a hostile config from smuggling odd strings into output
  // that a human will read.
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name (letters, digits and underscore)');

export const environmentSchema = z.object({
  variables: z
    .object({
      /**
       * Names that must be present for the pipeline to be runnable.
       *
       * Presence is checked, never the value. `.env` files are not loaded.
       */
      required: z.array(environmentVariableNameSchema).default([]),
    })
    .default({ required: [] }),
});

export const localCiConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    type: z.string().min(1),
  }),
  pipeline: z.array(pipelineStepIdSchema).min(1),
  settings: settingsSchema.default({ failFast: false }),
  environment: environmentSchema.optional(),
});

export type LocalCiConfig = z.infer<typeof localCiConfigSchema>;

/** Names of environment variables the configuration declares as required. */
export function requiredEnvironmentVariables(config: LocalCiConfig): string[] {
  return config.environment?.variables.required ?? [];
}