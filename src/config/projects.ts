import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MULTI_PROJECT_TYPE, type LocalCiConfig } from './schema.js';

/** One project of a configuration, in the shape everything downstream iterates. */
export interface ConfiguredProject {
  /** `null` for the single-`project` form, which keeps bare step ids. */
  name: string | null;
  type: string;
  /** Path as written, relative to the configuration directory (`.` when absent). */
  path: string;
  /** Step ids without the project prefix. */
  pipeline: string[];
  steps: NonNullable<LocalCiConfig['steps']>;
}

/** The id a step carries in the flattened pipeline and in reports. */
export function qualifyStepId(projectName: string | null, id: string): string {
  return projectName === null ? id : `${projectName}.${id}`;
}

export function normalizeProjects(config: LocalCiConfig): ConfiguredProject[] {
  if (config.projects !== undefined) {
    return config.projects.map((entry) => ({
      name: entry.name,
      type: entry.type,
      path: entry.path ?? '.',
      pipeline: [...entry.pipeline],
      steps: entry.steps ?? {},
    }));
  }
  return [
    {
      name: null,
      type: config.project.type,
      path: config.project.path ?? '.',
      pipeline: [...config.pipeline],
      steps: config.steps ?? {},
    },
  ];
}

export function isMultiProject(config: LocalCiConfig): boolean {
  return config.project.type === MULTI_PROJECT_TYPE;
}

export type ProjectDirResult = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * Resolves a configured project path to an absolute directory and proves, using
 * real paths, that it is an existing directory inside `root`. A symlink or
 * junction that leads outside the repository is rejected.
 */
export async function resolveProjectDir(root: string, projectPath: string): Promise<ProjectDirResult> {
  const lexical = resolve(root, projectPath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(lexical);
  } catch {
    return { ok: false, reason: `Project path "${projectPath}" does not exist.` };
  }

  const rel = relative(realRoot, realTarget);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: `Project path "${projectPath}" resolves outside the repository, which is not allowed.` };
  }
  try {
    if (!(await stat(realTarget)).isDirectory()) return { ok: false, reason: `Project path "${projectPath}" is not a directory.` };
  } catch {
    return { ok: false, reason: `Project path "${projectPath}" could not be read.` };
  }
  return { ok: true, dir: realTarget };
}
