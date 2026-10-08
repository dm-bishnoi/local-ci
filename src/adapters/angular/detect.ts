import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Angular project and package-manager detection.
 *
 * Detection is read-only and never installs, mutates or repairs anything. It
 * answers three questions with evidence: is this an Angular project, which
 * package manager does it use, and what does its package.json actually offer.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  [key: string]: unknown;
}

export interface AngularDetection {
  /** True only when Angular was actually found. */
  detected: boolean;
  framework: 'angular' | null;
  /** Absolute path of angular.json, when present. */
  angularConfig: string | null;
  /** Absolute path of package.json, when present and valid. */
  packageJson: string | null;
  packageManager: PackageManager | null;
  /** Lockfile that decided the package manager, when one exists. */
  lockfile: string | null;
  /** True when no lockfile was found and the default was applied. */
  packageManagerIsDefault: boolean;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** Human-readable explanation, always present when not detected. */
  reason?: string;
}

export const ANGULAR_CONFIG_FILE = 'angular.json';
export const PACKAGE_JSON_FILE = 'package.json';

/**
 * Fixed lookup order. Deterministic by design: a project containing more than
 * one lockfile resolves to the first match in this list, always the same way.
 */
const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
];

const ANGULAR_PACKAGES = ['@angular/core', '@angular/cli', '@angular/build', '@angular-devkit/build-angular'];

/**
 * Removes a leading UTF-8 byte order mark.
 *
 * npm and Node tolerate a BOM in package.json, but JSON.parse does not, and a
 * BOM is common in files written by Windows editors. Without this, a perfectly
 * valid project would look like it declares no scripts at all.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readJson(file: string): Promise<{ value: unknown } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { error: 'missing' };
  }

  try {
    // npm and Node both tolerate a UTF-8 BOM (Windows editors add one), but
    // JSON.parse does not. Strip it so such a project is not misreported as
    // having no scripts or dependencies.
    return { value: JSON.parse(stripBom(raw)) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

export async function detectPackageManager(cwd: string): Promise<{
  manager: PackageManager;
  lockfile: string | null;
  isDefault: boolean;
}> {
  for (const { file, manager } of LOCKFILES) {
    if (await exists(join(cwd, file))) {
      return { manager, lockfile: file, isDefault: false };
    }
  }
  // npm ships with Node, so it is the only safe default when nothing is declared.
  return { manager: 'npm', lockfile: null, isDefault: true };
}

/**
 * Detects whether `cwd` is an Angular project.
 *
 * Two independent signals are accepted, and the evidence for each is reported:
 * an `angular.json` workspace file, or Angular packages declared in
 * package.json. A TypeScript project with neither is not Angular.
 */
export async function detectAngularProject(cwd: string): Promise<AngularDetection> {
  const angularConfigPath = join(cwd, ANGULAR_CONFIG_FILE);
  const packageJsonPath = join(cwd, PACKAGE_JSON_FILE);
  const hasAngularConfig = await exists(angularConfigPath);

  const parsed = await readJson(packageJsonPath);
  let packageJson: PackageJson | null = null;
  let packageJsonProblem: string | undefined;

  if ('error' in parsed) {
    packageJsonProblem =
      parsed.error === 'missing' ? undefined : `package.json is not valid JSON: ${parsed.error}`;
  } else {
    const value = parsed.value;
    packageJson =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as PackageJson) : null;
    if (!packageJson) packageJsonProblem = 'package.json does not contain a JSON object.';
  }

  const dependencies = asRecord(packageJson?.dependencies);
  const devDependencies = asRecord(packageJson?.devDependencies);
  const declaredAngularPackages = ANGULAR_PACKAGES.filter(
    (name) => name in dependencies || name in devDependencies,
  );

  const detectedByAngularConfig = hasAngularConfig;
  const detectedByPackages = declaredAngularPackages.length > 0;
  const detected = detectedByAngularConfig || detectedByPackages;

  const packageManagerResult = await detectPackageManager(cwd);

  const base: AngularDetection = {
    detected,
    framework: detected ? 'angular' : null,
    angularConfig: hasAngularConfig ? angularConfigPath : null,
    packageJson: packageJson ? packageJsonPath : null,
    packageManager: packageManagerResult.manager,
    lockfile: packageManagerResult.lockfile,
    packageManagerIsDefault: packageManagerResult.isDefault,
    scripts: asRecord(packageJson?.scripts),
    dependencies,
    devDependencies,
  };

  if (detected) return base;

  // Not Angular: explain precisely what was looked for and what was found.
  if (packageJsonProblem) {
    return { ...base, reason: packageJsonProblem };
  }
  if (!packageJson) {
    return { ...base, reason: `No ${ANGULAR_CONFIG_FILE} and no ${PACKAGE_JSON_FILE} found in ${cwd}.` };
  }
  return {
    ...base,
    reason:
      `Angular was not detected: ${ANGULAR_CONFIG_FILE} is absent and ${PACKAGE_JSON_FILE} ` +
      `declares none of ${ANGULAR_PACKAGES.join(', ')}.`,
  };
}

/** True when the project declares the Angular CLI it would run `ng` with. */
export function hasAngularCli(detection: AngularDetection): boolean {
  return '@angular/cli' in detection.dependencies || '@angular/cli' in detection.devDependencies;
}