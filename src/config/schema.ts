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

/**
 * A project directory relative to the configuration file.
 *
 * Containment is enforced twice: lexically here (no absolute path, drive
 * letter, UNC path or `..` segment) and against the real path at run time, so
 * a symlink cannot lead out of the repository either.
 */
export const projectPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes(String.fromCharCode(0)), 'must not contain NUL')
  .refine(
    (value) => !/^([A-Za-z]:|[\\/])/.test(value),
    'must be relative to the configuration file (no absolute path, drive letter or UNC path)',
  )
  .refine((value) => !value.split(/[\\/]/).includes('..'), "must not contain a '..' segment");

const projectTypeSchema = z.string().min(1);

/** Step ids inside a `projects:` entry may not contain '.', which separates project and step. */
const projectStepIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "must not contain '.' inside a project pipeline");

export const projectNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'must contain only letters, digits, underscore and hyphen');

const stepsSchema = z.record(pipelineStepIdSchema, scriptStepSchema);

const projectEntrySchema = z
  .object({
    name: projectNameSchema,
    type: projectTypeSchema,
    path: projectPathSchema.optional(),
    pipeline: z.array(projectStepIdSchema).min(1),
    steps: z.record(projectStepIdSchema, scriptStepSchema).optional(),
  })
  .strict();

export type ProjectEntry = z.infer<typeof projectEntrySchema>;

/** Name used as `project.type` when the configuration uses the `projects:` form. */
export const MULTI_PROJECT_TYPE = 'multi';

const rawConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        type: projectTypeSchema,
        path: projectPathSchema.optional(),
      })
      .strict()
      .optional(),
    projects: z.array(projectEntrySchema).min(1).optional(),
    pipeline: z.array(pipelineStepIdSchema).min(1).optional(),
    settings: settingsSchema.default({ failFast: false }),
    /**
     * Script-backed steps, keyed by pipeline step id. An entry replaces any
     * built-in implementation of the same id.
     */
    steps: stepsSchema.optional(),
    environment: environmentSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const issue = (path: Array<string | number>, message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };

    if (config.project !== undefined && config.projects !== undefined) {
      issue(['projects'], 'use either "project" (one project) or "projects" (several), not both');
      return;
    }
    if (config.project === undefined && config.projects === undefined) {
      issue(['project'], 'required: declare "project" (one project) or "projects" (several)');
      return;
    }

    if (config.projects === undefined) {
      if (config.pipeline === undefined) issue(['pipeline'], 'required');
      // A definition for a step that is not in the pipeline would never run, which
      // is almost always a typo. Say so instead of silently ignoring it.
      for (const id of Object.keys(config.steps ?? {})) {
        if (!config.pipeline?.includes(id)) {
          issue(['steps', id], `defines step "${id}", which is not listed in pipeline`);
        }
      }
      return;
    }

    if (config.pipeline !== undefined) {
      issue(['pipeline'], 'not allowed with "projects": give each project its own pipeline');
    }
    if (config.steps !== undefined) {
      issue(['steps'], 'not allowed with "projects": give each project its own steps');
    }
    const seen = new Set<string>();
    config.projects.forEach((entry, index) => {
      if (seen.has(entry.name)) issue(['projects', index, 'name'], `duplicate project name "${entry.name}"`);
      seen.add(entry.name);
      for (const id of Object.keys(entry.steps ?? {})) {
        if (!entry.pipeline.includes(id)) {
          issue(['projects', index, 'steps', id], `defines step "${id}", which is not listed in this project's pipeline`);
        }
      }
    });
  });

type RawConfig = z.infer<typeof rawConfigSchema>;

/**
 * Parsed configuration.
 *
 * `project`, `pipeline` and `steps` always describe what the runner executes.
 * With the `projects:` form they are flattened: pipeline ids become
 * `<project>.<step>` and `project.type` is {@link MULTI_PROJECT_TYPE}; the
 * original entries stay available in `projects`.
 */
export interface LocalCiConfig {
  version: 1;
  project: { type: string; path?: string };
  projects?: ProjectEntry[];
  pipeline: string[];
  settings: z.infer<typeof settingsSchema>;
  steps?: Record<string, z.infer<typeof scriptStepSchema>>;
  environment?: z.infer<typeof environmentSchema>;
}

function flatten(raw: RawConfig): LocalCiConfig {
  const { project, projects, pipeline, steps, ...rest } = raw;
  if (projects === undefined) {
    return { ...rest, project: project!, pipeline: pipeline!, ...(steps !== undefined ? { steps } : {}) };
  }

  const flatSteps: Record<string, z.infer<typeof scriptStepSchema>> = {};
  const flatPipeline: string[] = [];
  for (const entry of projects) {
    for (const id of entry.pipeline) flatPipeline.push(`${entry.name}.${id}`);
    for (const [id, definition] of Object.entries(entry.steps ?? {})) flatSteps[`${entry.name}.${id}`] = definition;
  }
  return {
    ...rest,
    project: { type: MULTI_PROJECT_TYPE },
    projects,
    pipeline: flatPipeline,
    ...(Object.keys(flatSteps).length > 0 ? { steps: flatSteps } : {}),
  };
}

export const localCiConfigSchema = rawConfigSchema.transform((raw): LocalCiConfig => flatten(raw));

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