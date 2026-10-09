/**
 * Facts about the project on disk, gathered once and reused by `doctor`,
 * `preflight` and `run`.
 *
 * These are *observations*, not verdicts. Deciding whether an observation is
 * acceptable belongs to doctor/preflight; deciding what to do about it belongs
 * to `run`. Keeping those apart is what stops the same rule from being written
 * three times and disagreeing with itself.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectAngularProject, type AngularDetection, type PackageManager } from '../adapters/angular/detect.js';
import { CONFIG_FILE, loadConfig, ConfigError } from '../config/loader.js';
import type { LocalCiConfig } from '../config/schema.js';
import { parseNvmrc, satisfies, parseVersion, type RangeResult } from '../env/semver.js';

export const NVMRC_FILE = '.nvmrc';
export const ENV_EXAMPLE_FILE = '.env.example';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

export interface ConfigObservation {
  exists: boolean;
  /** Parsed configuration, when it loaded successfully. */
  config: LocalCiConfig | null;
  /** Message describing why the configuration could not be used. */
  problem: string | null;
}

export interface NodeRequirementObservation {
  /** Range from `engines.node`, when declared. */
  enginesRange: string | null;
  /** Raw `.nvmrc` contents, when present. */
  nvmrc: string | null;
  /** Range from the `packageManager` field's implicit engine hint, when any. */
  /** The evaluated result of the narrowest declared requirement. */
  result: RangeResult | null;
  /** The source the evaluated range came from. */
  source: 'engines' | 'nvmrc' | null;
}

export interface DependenciesObservation {
  /** True when `node_modules` exists and holds something. */
  installed: boolean;
  /** Count of entries in `node_modules`, when it could be read. */
  packageCount: number | null;
  /** True when `node_modules` exists but holds nothing useful. */
  empty: boolean;
}

export interface ProjectFacts {
  cwd: string;
  packageJsonExists: boolean;
  packageJsonValid: boolean;
  packageJsonProblem: string | null;
  packageName: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  packageManagerField: string | null;
  declaredPackageManager: PackageManager | null;
  lockfile: string | null;
  angular: AngularDetection | null;
  config: ConfigObservation;
  node: NodeRequirementObservation;
  dependenciesOnDisk: DependenciesObservation;
  /** Names from `.env.example`, used only to offer guidance about expected variables. */
  envExampleNames: string[];
  /** True when a `.env` file exists. Its contents are never read. */
  envFileExists: boolean;
}

interface RawPackageJson {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  packageManager?: unknown;
  engines?: unknown;
}

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** Extracts the manager name from a `packageManager` field such as `pnpm@9.1.0`. */
export function parsePackageManagerField(field: string | null): PackageManager | null {
  if (!field) return null;
  const name = field.split('@')[0]?.trim().toLowerCase();
  return name === 'npm' || name === 'pnpm' || name === 'yarn' ? name : null;
}

async function readJson(path: string): Promise<{ value: RawPackageJson | null; problem: string | null; exists: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { value: null, problem: null, exists: false };
  }

  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, problem: 'package.json does not contain a JSON object.', exists: true };
    }
    return { value: parsed as RawPackageJson, problem: null, exists: true };
  } catch (error) {
    return { value: null, problem: error instanceof Error ? error.message : String(error), exists: true };
  }
}

async function readNodeRequirement(cwd: string, enginesNode: string | null): Promise<NodeRequirementObservation> {
  let nvmrc: string | null = null;
  try {
    nvmrc = parseNvmrc(await readFile(join(cwd, NVMRC_FILE), 'utf8'));
  } catch {
    nvmrc = null;
  }

  // `engines.node` wins when both are present: it is the version the project
  // actually declares it needs, while `.nvmrc` is a developer convenience.
  const range = enginesNode ?? nvmrc;
  if (!range) return { enginesRange: enginesNode, nvmrc, result: null, source: null };

  const result = satisfies(process.versions.node, range);
  return {
    enginesRange: enginesNode,
    nvmrc,
    result,
    source: enginesNode ? 'engines' : 'nvmrc',
  };
}

async function readDependencyState(cwd: string): Promise<DependenciesObservation> {
  const moduleDir = join(cwd, 'node_modules');
  if (!(await exists(moduleDir))) return { installed: false, packageCount: null, empty: true };

  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(moduleDir);
    // `node_modules/.bin` and scope directories are counted, which is enough to
    // distinguish "installed" from "exists but empty" without deep traversal.
    return { installed: entries.length > 0, packageCount: entries.length, empty: entries.length === 0 };
  } catch {
    return { installed: true, packageCount: null, empty: false };
  }
}

/**
 * Extracts variable *names* from `.env.example`.
 *
 * Names only, and only from the example file. Values in `.env.example` are
 * placeholders by convention and are still discarded rather than retained, so
 * this function can never become a path from example values into a report.
 */
export function extractEnvExampleNames(contents: string): string[] {
  const names = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/** Gathers every observation the diagnostic commands need. Read-only. */
export async function collectProjectFacts(cwd: string): Promise<ProjectFacts> {
  const pkg = await readJson(join(cwd, 'package.json'));

  let envExampleNames: string[] = [];
  try {
    envExampleNames = extractEnvExampleNames(await readFile(join(cwd, ENV_EXAMPLE_FILE), 'utf8'));
  } catch {
    envExampleNames = [];
  }

  const angular = await detectAngularProject(cwd);
  const dependenciesOnDisk = await readDependencyState(cwd);

  const packageManagerField = typeof pkg.value?.packageManager === 'string' ? pkg.value.packageManager : null;
  const enginesNode =
    typeof pkg.value?.engines === 'object' && pkg.value.engines !== null && typeof (pkg.value.engines as { node?: unknown }).node === 'string'
      ? ((pkg.value.engines as { node: string }).node)
      : null;

  return {
    cwd,
    packageJsonExists: pkg.exists,
    packageJsonValid: pkg.exists && pkg.value !== null,
    packageJsonProblem: pkg.problem,
    packageName: typeof pkg.value?.name === 'string' ? pkg.value.name : null,
    dependencies: asRecord(pkg.value?.dependencies),
    devDependencies: asRecord(pkg.value?.devDependencies),
    packageManagerField,
    declaredPackageManager: parsePackageManagerField(packageManagerField),
    lockfile: angular.lockfile,
    angular,
    config: await collectConfig(cwd),
    node: await readNodeRequirement(cwd, enginesNode),
    dependenciesOnDisk,
    envExampleNames,
    envFileExists: await exists(join(cwd, '.env')),
  };
}

async function collectConfig(cwd: string): Promise<ConfigObservation> {
  const path = join(cwd, CONFIG_FILE);
  if (!(await exists(path))) {
    return { exists: false, config: null, problem: `${CONFIG_FILE} was not found.` };
  }

  try {
    return { exists: true, config: await loadConfig(cwd), problem: null };
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    return { exists: true, config: null, problem: message };
  }
}

/** True when the running Node satisfies a declared requirement. */
export function nodeRequirementSatisfied(facts: ProjectFacts): boolean | null {
  if (!facts.node.result) return null;
  return facts.node.result.verdict === 'satisfied';
}

/** The major version of the running Node, or null when it cannot be parsed. */
export function nodeMajorVersion(): number | null {
  return parseVersion(process.versions.node)?.major ?? null;
}