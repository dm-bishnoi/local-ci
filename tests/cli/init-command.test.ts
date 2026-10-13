/**
 * `init` creates the configuration and protects the reports directory, without
 * editing any file the project already owns.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { CONFIG_FILE, loadConfig } from '../../src/config/loader.js';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { REPORT_ROOT_GITIGNORE } from '../../src/reporters/artifact.js';
import { NO_BROWSERS, writeProject } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('init', () => {
  it('writes a valid configuration and a self-ignoring reports directory', async () => {
    await withTempProject(async (cwd) => {
      await initCommand(cwd);

      const config = await loadConfig(cwd);
      expect(config.pipeline.length).toBeGreaterThan(0);
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toMatch(/^\*$/m);
    });
  });

  it('leaves the project .gitignore untouched', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, '.gitignore'), 'dist/\r\n', 'utf8');
      await initCommand(cwd);
      expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('dist/\r\n');
    });
  });

  it('keeps an existing .local-ci/.gitignore', async () => {
    await withTempProject(async (cwd) => {
      await initCommand(cwd);
      await writeFile(join(cwd, REPORT_ROOT_GITIGNORE), 'custom\n', 'utf8');
      await initCommand(cwd, true);
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toBe('custom\n');
    });
  });

  it('refuses to replace a configuration without --force and writes nothing', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, CONFIG_FILE), 'version: 1\n', 'utf8');

      await expect(initCommand(cwd)).rejects.toThrow(/already exists/);
      expect(await readFile(join(cwd, CONFIG_FILE), 'utf8')).toBe('version: 1\n');
      expect(await exists(join(cwd, REPORT_ROOT_GITIGNORE))).toBe(false);
    });
  });
});

/**
 * Release 0.2.0: `init` must not hand a fresh Angular project a pipeline that
 * fails on its first run. Steps the project cannot support are left out of
 * the pipeline and explained, never reported as passing.
 */
describe('init on an Angular project', () => {
  /** The shape `ng new` produces: build and test scripts, no typecheck or lint script, no coverage provider. */
  const FRESH_ANGULAR = {
    name: 'fresh-app',
    scripts: { ng: 'ng', start: 'ng serve', build: 'ng build', watch: 'ng build --watch', test: 'ng test' },
    dependencies: { '@angular/core': '^22.2.0' },
    devDependencies: { '@angular/cli': '^22.2.2', '@angular/build': '^22.2.2', vitest: '^5.0.0' },
  };
  const preflightOptions = { skipToolProbes: true, browsers: NO_BROWSERS };

  async function blockingOrUnsupported(cwd: string): Promise<string[]> {
    const diagnostics = await runPreflightChecks(cwd, preflightOptions);
    return diagnostics
      .filter((diagnostic) => diagnostic.severity === 'UNSUPPORTED' || diagnostic.severity === 'BLOCKED' || diagnostic.severity === 'ERROR')
      .map((diagnostic) => `${diagnostic.severity} ${diagnostic.id}`);
  }

  it('writes only the steps a fresh project supports, and preflight raises nothing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: FRESH_ANGULAR, config: null, lockfile: 'package-lock.json' });

      await initCommand(cwd);

      const config = await loadConfig(cwd);
      expect(config.pipeline).toEqual(['install', 'test', 'build', 'security']);
      expect(await blockingOrUnsupported(cwd)).toEqual([]);
    });
  });

  it('records every omitted step and its reason in the file and the console', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: FRESH_ANGULAR, config: null, lockfile: 'package-lock.json' });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await initCommand(cwd);

      const text = await readFile(join(cwd, CONFIG_FILE), 'utf8');
      expect(text).toMatch(/^ {2}# - typecheck +# .*"typecheck" script/m);
      expect(text).toMatch(/^ {2}# - coverage +# .*coverage/m);
      expect(text).toMatch(/^ {2}# - lint +# .*"lint" script/m);
      const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toMatch(/typecheck, coverage, lint/);
    });
  });

  it('keeps every default step, in order, when the project supports them all', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          ...FRESH_ANGULAR,
          scripts: { ...FRESH_ANGULAR.scripts, typecheck: 'tsc --noEmit', lint: 'ng lint', coverage: 'ng test --coverage' },
        },
        config: null,
        lockfile: 'package-lock.json',
      });

      await initCommand(cwd);

      expect((await loadConfig(cwd)).pipeline).toEqual(['install', 'typecheck', 'test', 'coverage', 'lint', 'build', 'security']);
      expect(await readFile(join(cwd, CONFIG_FILE), 'utf8')).not.toMatch(/^ {2}# -/m);
    });
  });

  it('leaves out install when there is no lockfile, because preflight would block it', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: FRESH_ANGULAR, config: null, lockfile: null });

      await initCommand(cwd);

      expect((await loadConfig(cwd)).pipeline).not.toContain('install');
      expect(await readFile(join(cwd, CONFIG_FILE), 'utf8')).toMatch(/^ {2}# - install +# .*lockfile/m);
      expect(await blockingOrUnsupported(cwd)).toEqual([]);
    });
  });

  it('still writes the full default pipeline where no Angular project is detected', async () => {
    await withTempProject(async (cwd) => {
      await initCommand(cwd);

      expect(await readFile(join(cwd, CONFIG_FILE), 'utf8')).toBe(
        'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - typecheck\n  - test\n  - coverage\n  - lint\n  - build\n  - security\n\nsettings:\n  failFast: false\n  timeoutMs: 300000\n',
      );
    });
  });
});
