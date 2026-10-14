/**
 * `steps.<id>.run` end to end through the real CLI path: multi-project and the
 * original single-project Angular path, success, failure, blocking and reports.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { blockingDiagnostics } from '../../src/diagnostics/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { newestRunIds, withTempProject } from '../helpers/reports.js';
import { writeTree } from '../helpers/tree.js';

const options = { skipToolProbes: true, browsers: NO_BROWSERS };

interface Report {
  steps: Array<{ id: string; status: string; command?: string; stdout: string; error?: string; project?: string }>;
  projects?: Array<{ name: string; outcome: string }>;
}

async function lastReport(cwd: string): Promise<Report> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = await newestRunIds(base);
  return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as Report;
}

const stepOf = (report: Report, id: string): Report['steps'][number] => {
  const found = report.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const PKG = { name: 'p', private: true, scripts: {} };

describe('run steps in a projects configuration', () => {
  it('runs a custom command, qualifies its id and attributes it to the project', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': `version: 1
projects:
  - name: tools
    type: node
    path: pkg
    pipeline: [check]
    steps:
      check:
        run: [node, -e, "console.log('custom ok ' + process.cwd().split(/[\\\\\\\\/]/).pop())"]
        cwd: sub
`,
        'pkg/package.json': PKG,
        'pkg/package-lock.json': '{}',
        'pkg/sub/.keep': '',
      });
      expect(await runCommand(cwd, options)).toBe(0);
      const report = await lastReport(cwd);
      const step = stepOf(report, 'tools.check');
      expect(step.status).toBe('PASS');
      expect(step.stdout).toContain('custom ok sub');
      expect(step.project).toBe('tools');
      expect(step.command?.startsWith('node -e')).toBe(true);
      expect(report.projects).toEqual([expect.objectContaining({ name: 'tools', outcome: 'PASS' })]);
    });
  }, 60_000);

  it('a missing executable blocks only that step in preflight and at run time', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': `version: 1
projects:
  - name: a
    type: node
    path: pkg
    pipeline: [check, other]
    steps:
      check:
        run: [definitely-not-installed-xyz, --flag]
      other:
        run: [node, -e, "console.log('still runs')"]
`,
        'pkg/package.json': PKG,
        'pkg/package-lock.json': '{}',
      });

      const diagnostics = await runPreflightChecks(cwd, options);
      expect(blockingDiagnostics(diagnostics, 'a.check')[0]?.detail).toMatch(/not found on PATH/);
      expect(blockingDiagnostics(diagnostics, 'a.other')).toEqual([]);

      expect(await runCommand(cwd, options)).toBe(1);
      const report = await lastReport(cwd);
      expect(stepOf(report, 'a.check').status).toBe('BLOCKED');
      expect(stepOf(report, 'a.other').status).toBe('PASS');
    });
  }, 60_000);

  it('a project-relative executable that escapes through a path is rejected by the schema', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nprojects:\n  - name: a\n    type: node\n    pipeline: [check]\n    steps:\n      check:\n        run: ["../evil"]\n',
        'package.json': PKG,
      });
      expect(await runCommand(cwd, options)).toBe(1);
      const report = await lastReport(cwd);
      expect(report.steps[0]).toMatchObject({ id: 'preflight', status: 'BLOCKED' });
    });
  }, 60_000);
});

describe('run steps on the original single-project path', () => {
  const angular = {
    name: 'ng',
    private: true,
    dependencies: { '@angular/core': '^19.0.0' },
    scripts: { build: 'node -e "console.log(1)"' },
  };

  it('adds a custom step next to the Angular adapter', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': `version: 1
project:
  type: angular
pipeline: [build, check]
steps:
  check:
    run: [node, -e, "console.log('custom on angular path')"]
`,
        'package.json': angular,
        'package-lock.json': '{}',
        'node_modules/placeholder/package.json': '{}',
      });
      expect(await runCommand(cwd, options)).toBe(0);
      const report = await lastReport(cwd);
      expect(stepOf(report, 'build').status).toBe('PASS');
      expect(stepOf(report, 'check')).toMatchObject({ status: 'PASS' });
      expect(stepOf(report, 'check').stdout).toContain('custom on angular path');
    });
  }, 60_000);

  it('flags an unresolvable executable in preflight and blocks only that step', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: angular\npipeline: [build, check]\nsteps:\n  check:\n    run: [definitely-not-installed-xyz]\n',
        'package.json': angular,
        'package-lock.json': '{}',
        'node_modules/placeholder/package.json': '{}',
      });
      const diagnostics = await runPreflightChecks(cwd, options);
      expect(blockingDiagnostics(diagnostics, 'check')).toHaveLength(1);
      expect(blockingDiagnostics(diagnostics, 'build')).toEqual([]);

      expect(await runCommand(cwd, options)).toBe(1);
      const report = await lastReport(cwd);
      expect(stepOf(report, 'build').status).toBe('PASS');
      expect(stepOf(report, 'check').status).toBe('BLOCKED');
    });
  }, 60_000);
});
