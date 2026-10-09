/**
 * The environment fingerprint: a small, stable, comparable snapshot of what this
 * machine looks like.
 *
 * Its purpose is DETECT → COMPARE. Today it is recorded into every report so a
 * report is self-describing; comparing a local fingerprint against a CI one
 * later needs exactly this shape, which is why it is a plain serializable value
 * rather than something assembled ad hoc inside a reporter.
 *
 * Security rule, and it is absolute: **this structure has no field that can
 * carry a secret.** It records tool *names* and *versions*, never environment
 * variable values, never file contents, never a path outside the project. The
 * only environment-related field is a boolean CI/local indicator, which is a
 * presence fact rather than a value.
 */

import { platform, release, arch } from 'node:os';
import type { AngularDetection, PackageManager } from '../adapters/angular/detect.js';

export interface ToolVersion {
  /** `npm`, `git`, `chrome`, ... */
  name: string;
  /** Parsed major version, when one could be read. */
  version: string | null;
  /**
   * How the version was obtained.
   *
   * `probed` means the tool actually ran. `declared` means the version was read
   * from a manifest and the tool itself was never executed. `unknown` means no
   * reliable source exists. These are kept distinct because a declared version
   * is a claim by the project, not an observation of the machine.
   */
  source: 'probed' | 'declared' | 'unknown';
}

export interface EnvironmentFingerprint {
  /** Schema version, so a future comparison can reject an incompatible shape. */
  schemaVersion: number;
  /** ISO-8601 capture time. */
  capturedAt: string;
  os: { platform: string; release: string; arch: string };
  runtime: ToolVersion;
  packageManager: { name: PackageManager | null; version: string | null };
  git: ToolVersion;
  /** Framework under test, e.g. `angular`. */
  project: { name: string; type: string; framework: string | null };
  /** Declared vs installed Angular version, when determinable. */
  angular: { declared: string | null; installed: string | null } | null;
  browsers: Array<{ name: string; version: string | null }>;
  /**
   * True when the process appears to be running in CI.
   *
   * A boolean derived from well-known CI environment *markers*. No marker value
   * is read, stored or exposed.
   */
  runningInCi: boolean;
}

export const FINGERPRINT_SCHEMA_VERSION = 1;

/** True when a well-known CI marker is present. Presence only — never the value. */
export function detectCiIndicator(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['CI'] ?? env['CONTINUOUS_INTEGRATION'] ?? env['BUILD_NUMBER'] ?? env['GITHUB_ACTIONS']);
}

/** Runtime version of the current Node process. */
export function currentRuntime(): ToolVersion {
  return { name: 'node', version: process.versions.node, source: 'probed' };
}

/**
 * Reads the installed version of a package, without executing anything.
 *
 * A filesystem read of `<pkg>/package.json`. Absence is `null`, never a guess.
 */
export async function readInstalledPackageVersion(
  cwd: string,
  packageName: string,
): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  try {
    const raw = await readFile(join(cwd, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { version?: unknown };
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Declared Angular version range from the project's dependencies. */
export function declaredAngularVersion(detection: AngularDetection | null): string | null {
  if (!detection) return null;
  const declared = detection.dependencies['@angular/core'] ?? detection.devDependencies['@angular/core'];
  return typeof declared === 'string' ? declared : null;
}

export interface FingerprintInput {
  /** Project directory; used only to read `node_modules` metadata. */
  cwd: string;
  projectName: string;
  projectType: string;
  detection: AngularDetection | null;
  /** Version reported by running the package manager, when it could be probed. */
  packageManagerVersion: string | null;
  gitVersion: string | null;
  browsers: Array<{ name: string; version: string | null }>;
  /** Resolved ahead of time by the caller to keep this function single-purpose. */
  installedAngularVersion?: string | null;
  capturedAt?: Date;
}

/** Builds a fingerprint from already-collected facts. Pure apart from `readInstalledPackageVersion`. */
export async function buildFingerprint(input: FingerprintInput): Promise<EnvironmentFingerprint> {
  const angularDeclared = declaredAngularVersion(input.detection);
  const framework = input.detection?.framework ?? null;
  const packageManager = input.detection?.packageManager ?? null;

  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: currentRuntime(),
    packageManager: { name: packageManager, version: input.packageManagerVersion },
    git: input.gitVersion
      ? { name: 'git', version: input.gitVersion, source: 'probed' }
      : { name: 'git', version: null, source: 'unknown' },
    project: { name: input.projectName, type: input.projectType, framework },
    angular:
      framework === 'angular'
        ? {
            declared: angularDeclared,
            installed:
              input.installedAngularVersion === undefined
                ? await readInstalledPackageVersion(input.cwd, '@angular/core')
                : input.installedAngularVersion,
          }
        : null,
    browsers: input.browsers.map((browser) => ({ name: browser.name, version: browser.version })),
    runningInCi: detectCiIndicator(),
  };
}

/**
 * The exact key set a fingerprint may contain.
 *
 * Used by the tests to assert that no field capable of holding a secret has
 * been added. Kept here, next to the type, so adding a field is a deliberate act.
 */
export const FINGERPRINT_KEYS: readonly string[] = [
  'schemaVersion',
  'capturedAt',
  'os',
  'runtime',
  'packageManager',
  'git',
  'project',
  'angular',
  'browsers',
  'runningInCi',
];