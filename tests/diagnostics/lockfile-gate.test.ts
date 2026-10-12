/**
 * F-5 regression: without a lockfile the install step is BLOCKED, so `run`
 * never creates a lockfile or installs anything in the project it checks.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { NO_BROWSERS, writeProject } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';

const PACKAGE = {
  name: 'lockfile-gate',
  scripts: { build: 'node -e "0"' },
  dependencies: { '@angular/core': '^19.0.0' },
};
const WITH_INSTALL = 'version: 1\nproject:\n  type: angular\npipeline:\n  - install\n  - build\n';
const options = { skipToolProbes: true, browsers: NO_BROWSERS };

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('preflight lockfile gate', () => {
  it('blocks only the install step when there is no lockfile', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: PACKAGE, config: WITH_INSTALL, lockfile: null });
      const diagnostics = await runPreflightChecks(cwd, options);
      const gate = diagnostics.find((diagnostic) => diagnostic.id === 'lockfile');

      expect(gate?.severity).toBe('BLOCKED');
      expect(gate?.steps).toEqual(['install']);
      expect(gate?.recommendation).toContain('lockfile');
    });
  });

  it('does not block when a lockfile exists', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: PACKAGE, config: WITH_INSTALL, lockfile: 'package-lock.json' });
      const diagnostics = await runPreflightChecks(cwd, options);
      expect(diagnostics.find((diagnostic) => diagnostic.id === 'lockfile')).toBeUndefined();
    });
  });

  it('does not apply to a pipeline without an install step', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: PACKAGE,
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n',
        lockfile: null,
      });
      const diagnostics = await runPreflightChecks(cwd, options);
      expect(diagnostics.find((diagnostic) => diagnostic.id === 'lockfile')).toBeUndefined();
    });
  });
});

describe('run does not modify the project without a lockfile', () => {
  it('reports install BLOCKED, still runs build, and creates no lockfile', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withTempProject(async (cwd) => {
      await writeProject(cwd, { packageJson: PACKAGE, config: WITH_INSTALL, lockfile: null, installed: true });
      const before = (await readdir(cwd)).sort();
      const nodeModulesBefore = (await readdir(join(cwd, 'node_modules'))).sort();

      const code = await runCommand(cwd, options);

      expect(code).toBe(1);
      for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
        expect(await exists(join(cwd, lockfile)), `${lockfile} was created`).toBe(false);
      }
      // Only the reports directory is new; node_modules is untouched.
      expect((await readdir(cwd)).sort()).toEqual([...before, '.local-ci'].sort());
      expect((await readdir(join(cwd, 'node_modules'))).sort()).toEqual(nodeModulesBefore);

      const [runId] = await readdir(join(cwd, '.local-ci', 'reports'));
      const report = JSON.parse(
        await readFile(join(cwd, '.local-ci', 'reports', runId ?? '', 'report.json'), 'utf8'),
      ) as { steps: Array<{ id: string; status: string; error?: string }> };
      const install = report.steps.find((step) => step.id === 'install');
      expect(install?.status).toBe('BLOCKED');
      expect(install?.error).toContain('lockfile');
      expect(report.steps.find((step) => step.id === 'build')?.status).toBe('PASS');
    });
  }, 60_000);
});
