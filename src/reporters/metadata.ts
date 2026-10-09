/**
 * Run metadata — the facts about the project that the engine does not carry.
 *
 * `PipelineRunResult` describes what happened; it cannot know the project's
 * name, its framework or its package manager. Rather than teach the core about
 * frameworks, this module collects that context at the edge and hands it to the
 * report model, which keeps `PipelineRunner` framework-agnostic.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RunMetadata } from './report-model.js';

/**
 * Reads the project name from `package.json`.
 *
 * Falls back to the directory name when there is no package.json, when it is not
 * valid JSON, or when it declares no name. A missing project name is never a
 * reason to fail a run or lose the report.
 */
export async function readProjectName(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { name?: unknown };
    if (typeof parsed?.name === 'string' && parsed.name.trim() !== '') return parsed.name.trim();
  } catch {
    // Fall through to the directory name below.
  }
  return basename(cwd) || cwd;
}

export function buildRunMetadata(input: {
  projectName: string;
  projectType: string;
  framework: string | null;
  packageManager: string | null;
}): RunMetadata {
  return {
    projectName: input.projectName,
    projectType: input.projectType,
    framework: input.framework,
    packageManager: input.packageManager,
  };
}