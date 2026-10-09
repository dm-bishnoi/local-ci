/**
 * Fixtures for the diagnostic commands (doctor / preflight).
 *
 * Every scenario the diagnostics must distinguish — healthy, broken config,
 * missing requirement, unsupported step — is built here from disk up, so the
 * checks run against real files rather than mocks of the file system.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserSearchResult } from '../../src/env/browser.js';

/** A browser search result that found nothing, for deterministic no-browser tests. */
export const NO_BROWSERS: BrowserSearchResult = { browsers: [], searched: 0 };

/** A browser search result that found a Chrome install. */
export const CHROME_FOUND: BrowserSearchResult = {
  browsers: [{ name: 'chrome', path: '/fake/chrome', version: '120.0.0.0' }],
  searched: 1,
};

export interface ProjectFixture {
  packageJson?: Record<string, unknown> | null;
  config?: string | null;
  angularJson?: Record<string, unknown> | boolean | null;
  lockfile?: string | null;
  envExample?: string | null;
  /** Creates node_modules with one entry so dependencies read as installed. */
  installed?: boolean;
}

/**
 * Writes a project tree to `cwd` and returns it.
 *
 * `null` values mean "do not create this file", which is how the missing-file
 * scenarios are built: absence is a scenario, not an error.
 */
export async function writeProject(cwd: string, fixture: ProjectFixture = {}): Promise<string> {
  const {
    packageJson = { name: 'fixture', scripts: {}, dependencies: {}, devDependencies: {} },
    config = 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n',
    angularJson = true,
    lockfile = null,
    envExample = null,
    installed = true,
  } = fixture;

  if (packageJson !== null) {
    await writeFile(join(cwd, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
  }
  if (config !== null) {
    await writeFile(join(cwd, '.local-ci.yml'), config, 'utf8');
  }
  if (angularJson !== null) {
    await writeFile(
      join(cwd, 'angular.json'),
      JSON.stringify(angularJson === true ? { version: 1, projects: {} } : angularJson),
      'utf8',
    );
  }
  if (lockfile !== null) {
    await writeFile(join(cwd, lockfile), lockfile === 'package-lock.json' ? '{}' : '', 'utf8');
  }
  if (envExample !== null) {
    await writeFile(join(cwd, '.env.example'), envExample, 'utf8');
  }
  if (installed) {
    await mkdir(join(cwd, 'node_modules', 'fixture-pkg'), { recursive: true });
    await writeFile(join(cwd, 'node_modules', 'fixture-pkg', 'package.json'), '{}', 'utf8');
  }

  return cwd;
}

/** An Angular project that passes every default check. */
export const HEALTHY_ANGULAR: ProjectFixture = {
  packageJson: {
    name: 'healthy-app',
    engines: { node: '>=20' },
    scripts: { build: 'ng build', test: 'ng test' },
    dependencies: { '@angular/core': '^19.0.0' },
    devDependencies: { '@angular/cli': '^19.0.0', 'karma-chrome-launcher': '^3.2.0' },
  },
  config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - test\n  - build\n',
  lockfile: 'package-lock.json',
  installed: true,
};
