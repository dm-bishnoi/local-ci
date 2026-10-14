/**
 * The multi-project engine path, validated end to end with the Node adapter:
 * qualified step ids, per-project blocking, aggregation, attribution in every
 * report, `--project` selection and re-rendering of stored reports.
 *
 * Scripts only use `node -e`, so the fixtures behave identically under cmd.exe
 * and sh. Tool probes are skipped; missing-tool behaviour is covered with an
 * injected probe in tests/ecosystems/diagnostics.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../../src/cli/commands/report.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { writeTree } from '../helpers/tree.js';
import { newestRunIds, withTempProject } from '../helpers/reports.js';

const options = { skipToolProbes: true, browsers: NO_BROWSERS };
const node = (code: string): string => `node -e "${code}"`;

interface ReportedStep {
  id: string;
  name: string;
  status: string;
  outcome: string;
  project?: string;
  logPath?: string;
  error?: string;
  stdout: string;
}
interface ReportedProject {
  name: string;
  type: string;
  path: string;
  outcome: string;
  counts: Record<string, number>;
}
interface Report {
  runId: string;
  status: string;
  outcome: string;
  exitCode: number;
  counts: Record<string, number>;
  projects?: ReportedProject[];
  steps: ReportedStep[];
}

async function lastRun(cwd: string): Promise<{ report: Report; dir: string }> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = await newestRunIds(base);
  const dir = join(base, runId ?? '');
  return { report: JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Report, dir };
}

const step = (report: Report, id: string): ReportedStep => {
  const found = report.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}; have ${report.steps.map((s) => s.id).join(', ')}`);
  return found;
};
const project = (report: Report, name: string): ReportedProject => {
  const found = report.projects?.find((entry) => entry.name === name);
  if (!found) throw new Error(`no project ${name}`);
  return found;
};

/** `good` runs cleanly; `broken` declares a dependency that is not installed. */
async function monorepo(cwd: string, config: string): Promise<void> {
  await writeTree(cwd, {
    '.local-ci.yml': config,
    'apps/good/package.json': {
      name: 'good',
      private: true,
      scripts: { build: node("console.log('good build')"), test: node("console.log('good test')") },
    },
    'apps/good/package-lock.json': '{}',
    'apps/broken/package.json': {
      name: 'broken',
      private: true,
      scripts: { build: node("console.log('never runs')") },
      dependencies: { left_pad: '1.0.0' },
    },
    'apps/broken/package-lock.json': '{}',
    'apps/failing/package.json': {
      name: 'failing',
      private: true,
      scripts: { test: node('process.exit(3)'), slow: node('setTimeout(()=>{},60000)') },
    },
    'apps/failing/package-lock.json': '{}',
  });
}

const TWO_PROJECTS = `version: 1
projects:
  - name: good
    type: node
    path: apps/good
    pipeline: [build, test]
  - name: broken
    type: node
    path: apps/broken
    pipeline: [build]
`;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('one project blocked, another runnable', () => {
  it('runs the healthy project, blocks only the broken one and exits non-zero', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);

      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);

      expect(report.steps.map((s) => s.id)).toEqual(['good.build', 'good.test', 'broken.build']);
      expect(step(report, 'good.build').status).toBe('PASS');
      expect(step(report, 'good.build').stdout).toContain('good build');
      expect(step(report, 'good.build').logPath).toBeDefined();
      expect(step(report, 'good.test').status).toBe('PASS');

      const broken = step(report, 'broken.build');
      expect(broken.status).toBe('BLOCKED');
      expect(broken.error).toMatch(/node_modules is missing/);
      expect(broken.logPath).toBeUndefined();

      expect(report.status).toBe('FAIL');
      expect(report.outcome).toBe('BLOCKED');
      expect(report.exitCode).toBe(1);
      expect(project(report, 'good').outcome).toBe('PASS');
      expect(project(report, 'broken').outcome).toBe('BLOCKED');
      expect(project(report, 'good').counts).toMatchObject({ total: 2, passed: 2, blocked: 0 });
      expect(project(report, 'broken').counts).toMatchObject({ total: 1, blocked: 1 });
    });
  }, 90_000);

  it('attributes every step to its project and names rows "<project>: <step>"', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);
      await runCommand(cwd, options);
      const { report } = await lastRun(cwd);

      expect(step(report, 'good.test').project).toBe('good');
      expect(step(report, 'broken.build').project).toBe('broken');
      expect(step(report, 'good.test').name).toBe('good: Unit Tests');
      expect(step(report, 'broken.build').name).toBe('broken: Production Build');
    });
  }, 90_000);

  it('shows the per-project roll-up in console and HTML', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);
      const log = vi.mocked(console.log);
      await runCommand(cwd, options);
      const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('PROJECTS');
      expect(printed).toMatch(/good\s+node\s+PASS/);
      expect(printed).toMatch(/broken\s+node\s+BLOCKED/);

      const { dir } = await lastRun(cwd);
      const html = await readFile(join(dir, 'report.html'), 'utf8');
      expect(html).toContain('<h2>Projects</h2>');
      expect(html).toContain('apps/broken');
    });
  }, 90_000);

  it('re-renders the stored projects with `report <run-id>`', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);
      await runCommand(cwd, options);
      const { report } = await lastRun(cwd);

      const log = vi.mocked(console.log);
      log.mockClear();
      expect(await reportCommand(cwd, report.runId)).toBe(0);
      const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toMatch(/good\s+node\s+PASS/);
      expect(printed).toMatch(/broken\s+node\s+BLOCKED/);
      expect(printed).toContain('good: Unit Tests');
    });
  }, 90_000);
});

describe('failFast across projects', () => {
  it('skips later projects after a blocked one, naming why', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(
        cwd,
        `version: 1
projects:
  - name: broken
    type: node
    path: apps/broken
    pipeline: [build]
  - name: good
    type: node
    path: apps/good
    pipeline: [build]
settings:
  failFast: true
`,
      );
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);
      expect(step(report, 'broken.build').status).toBe('BLOCKED');
      expect(step(report, 'good.build').status).toBe('SKIPPED');
      expect(step(report, 'good.build').error).toMatch(/failFast/);
      expect(project(report, 'good').outcome).toBe('SKIPPED');
    });
  }, 90_000);
});

describe('failures inside a project', () => {
  it('reports a failing exit code, a timeout and an unsupported step per project', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(
        cwd,
        `version: 1
projects:
  - name: failing
    type: node
    path: apps/failing
    pipeline: [test, slow, lint]
    steps:
      slow:
        script: slow
        timeoutMs: 4000
  - name: good
    type: node
    path: apps/good
    pipeline: [build]
`,
      );
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);

      expect(step(report, 'failing.test').status).toBe('FAIL');
      expect(step(report, 'failing.slow').outcome).toBe('TIMEOUT');
      expect(step(report, 'failing.lint').status).toBe('UNSUPPORTED');
      expect(step(report, 'good.build').status).toBe('PASS');

      expect(project(report, 'failing').outcome).toBe('FAIL');
      expect(project(report, 'failing').counts).toMatchObject({ failed: 1, timeout: 1, unsupported: 1 });
      expect(project(report, 'good').outcome).toBe('PASS');
    });
  }, 120_000);

  it('a project whose only step is unsupported fails the run and is never PASS', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(
        cwd,
        'version: 1\nprojects:\n  - name: good\n    type: node\n    path: apps/good\n    pipeline: [lint]\n',
      );
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);
      expect(step(report, 'good.lint').status).toBe('UNSUPPORTED');
      expect(project(report, 'good').outcome).toBe('UNSUPPORTED');
      expect(report.exitCode).toBe(1);
    });
  }, 60_000);
});

describe('--project selection', () => {
  it('runs only the selected project and leaves the others out of the report', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);
      expect(await runCommand(cwd, { ...options, projects: ['good'] })).toBe(0);
      const { report } = await lastRun(cwd);
      expect(report.steps.map((s) => s.id)).toEqual(['good.build', 'good.test']);
      expect(report.projects?.map((p) => p.name)).toEqual(['good']);
      expect(report.exitCode).toBe(0);
    });
  }, 90_000);

  it('rejects an unknown project name instead of running nothing', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, TWO_PROJECTS);
      expect(await runCommand(cwd, { ...options, projects: ['nope'] })).toBe(1);
      expect(vi.mocked(console.error).mock.calls.join('\n')).toMatch(/unknown project "nope".*good, broken/);
    });
  }, 60_000);

  it('rejects --project for a single-project configuration', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: angular\npipeline: [build]\n',
        'package.json': { name: 'x' },
      });
      expect(await runCommand(cwd, { ...options, projects: ['a'] })).toBe(1);
    });
  }, 60_000);
});

describe('configuration problems', () => {
  it('blocks a project whose path does not exist without touching the others', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(
        cwd,
        `version: 1
projects:
  - name: ghost
    type: node
    path: apps/ghost
    pipeline: [build]
  - name: good
    type: node
    path: apps/good
    pipeline: [build]
`,
      );
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);
      expect(step(report, 'ghost.build').status).toBe('BLOCKED');
      expect(step(report, 'ghost.build').error).toMatch(/does not exist/);
      expect(step(report, 'good.build').status).toBe('PASS');
    });
  }, 90_000);

  it('blocks a project whose type does not match what is on disk', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(
        cwd,
        'version: 1\nprojects:\n  - name: empty\n    type: node\n    path: apps\n    pipeline: [build]\n',
      );
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastRun(cwd);
      expect(step(report, 'empty.build').status).toBe('BLOCKED');
      expect(step(report, 'empty.build').error).toMatch(/was not detected/);
    });
  }, 60_000);
});

describe('single project through the adapters', () => {
  it('keeps bare step ids and no projects section for `project: { type: node }`', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [build]\n',
        'package.json': { name: 'solo', private: true, scripts: { build: node("console.log('solo')") } },
        'package-lock.json': '{}',
      });
      expect(await runCommand(cwd, options)).toBe(0);
      const { report } = await lastRun(cwd);
      expect(report.steps.map((s) => [s.id, s.name, s.status])).toEqual([['build', 'Production Build', 'PASS']]);
      expect(report.projects).toBeUndefined();
      expect(report.steps[0]?.project).toBeUndefined();
    });
  }, 60_000);

  it('honours project.path for a single project', async () => {
    await withTempProject(async (cwd) => {
      await monorepo(cwd, 'version: 1\nproject:\n  type: node\n  path: apps/good\npipeline: [test]\n');
      expect(await runCommand(cwd, options)).toBe(0);
      expect(step((await lastRun(cwd)).report, 'test').stdout).toContain('good test');
    });
  }, 60_000);
});
