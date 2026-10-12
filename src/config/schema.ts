import { z } from 'zod';

export const pipelineStepIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/);

/** Guard rail so a typo cannot disable the engine's termination guarantees. */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Per-step limit applied by `run` when `settings.timeoutMs` is not configured.
 *
 * Long enough for a cold `npm ci` plus a full Angular build or test run on a
 * slow machine, short enough that a hung step cannot hold a terminal forever.
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/*
 * Every object is strict: an unknown key is an error, never silently dropped.
 * A misspelled `timeoutms` or `failfast` would otherwise validate cleanly and
 * quietly run with a different behaviour than the one the user wrote down.
 */
export const settingsSchema = z
  .object({
    failFast: z.boolean().default(false),
    /**
     * Per-step time limit in milliseconds. The schema keeps what the user
     * wrote; when it is absent, `run` applies {@link DEFAULT_TIMEOUT_MS} via
     * {@link effectiveTimeoutMs}.
     */
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  })
  .strict();

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

export const environmentSchema = z
  .object({
    variables: z
      .object({
        /**
         * Names that must be present for the pipeline to be runnable.
         *
         * Presence is checked, never the value. `.env` files are not loaded.
         */
        required: z.array(environmentVariableNameSchema).default([]),
      })
      .strict()
      .default({ required: [] }),
  })
  .strict();

/**
 * Name of a package.json script to run.
 *
 * It becomes a single argv entry (`<manager> run <script>`), never part of a
 * shell string. The pattern still excludes everything that could matter if a
 * package manager or a script wrapper interpreted it: a leading `-` (option
 * injection), whitespace, quotes, `;`, `&`, `|`, `$`, backticks, backslashes
 * and `..` segments.
 */
export const scriptNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/,
    'must be a package.json script name: letters, digits and : . _ / - only, starting with a letter or digit',
  )
  .refine((name) => !name.split('/').includes('..'), "must not contain a '..' segment");

/** A pipeline step implemented by running a package.json script. */
export const scriptStepSchema = z
  .object({
    script: scriptNameSchema,
    /** Overrides settings.timeoutMs (and the default) for this step only. */
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  })
  .strict();

export const localCiConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        type: z.string().min(1),
      })
      .strict(),
    pipeline: z.array(pipelineStepIdSchema).min(1),
    settings: settingsSchema.default({ failFast: false }),
    /**
     * Script-backed steps, keyed by pipeline step id. An entry replaces any
     * built-in implementation of the same id.
     */
    steps: z.record(pipelineStepIdSchema, scriptStepSchema).optional(),
    environment: environmentSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    // A definition for a step that is not in the pipeline would never run, which
    // is almost always a typo. Say so instead of silently ignoring it.
    for (const id of Object.keys(config.steps ?? {})) {
      if (!config.pipeline.includes(id)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', id],
          message: `defines step "${id}", which is not listed in pipeline`,
        });
      }
    }
  });

export type LocalCiConfig = z.infer<typeof localCiConfigSchema>;

/** The per-step limit `run` enforces: the configured one, or the default. */
export function effectiveTimeoutMs(config: LocalCiConfig): number {
  return config.settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** A copy of the configuration with every runtime default made explicit. */
export function withEffectiveDefaults(config: LocalCiConfig): LocalCiConfig {
  return { ...config, settings: { ...config.settings, timeoutMs: effectiveTimeoutMs(config) } };
}

/** Names of environment variables the configuration declares as required. */
export function requiredEnvironmentVariables(config: LocalCiConfig): string[] {
  return config.environment?.variables.required ?? [];
}