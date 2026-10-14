/**
 * A mixed-language repository through the real CLI path: Node, Go, .NET and
 * Python in one `.local-ci.yml`, with the toolchain partly missing.
 *
 * Node runs for real (`node -e` scripts through npm). Go, .NET and Python are
 * fake tools on PATH (see tests/helpers/shims.ts), so this test proves the
 * orchestration, attribution, blocking and reporting, not those toolchains.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../../src/cli/commands/report.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { newestRunIds, withTempProject } from '../helpers/reports.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, writeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

const windows = process.platform === 'win32';
const pythonName = windows ? 'python' : 'python3';

const GO = "if (process.argv[2] === 'version') { console.log('go version go1.22.3 linux/amd64'); process.exit(0); } console.log('go ' + process.argv.slice(2).join(' ') + ' ok');";
const GOFMT = 'process.exit(0);';
const PYTHON = `
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('Python 3.12.4'); process.exit(0); }
if (a[0] === '-m' && a[2] === '--version') { console.log(a[1] + ' 1.0.0'); process.exit(0); }
console.log('python ' + a.join(' ') + ' ok');
`;
const BROKEN_DOTNET = "console.error('The command could not be loaded, possibly because:'); process.exit(145);";

const CONFIG = `version: 1
projects:
  - name: web
    type: node
    path: apps/web
    pipeline: [build, test]
  - name: svc
    type: go
    path: services/svc
    pipeline: [format, test]
  - name: api
    type: dotnet
    path: services/api
    pipeline: [restore, build]
  - name: ml
    type: python
    path: ml
    pipeline: [test]
`;

const node = (code: string): string => `node -e "${code}"`;
const REPO = {
  '.local-ci.yml': CONFIG,
  'apps/web/package.json': { name: 'web', private: true, scripts: { build: node("console.log('web build')"), test: node("console.log('web test')") } },
  'apps/web/package-lock.json': '{}',
  'services/svc/go.mod': 'module svc\n\ngo 1.21\n',
  'services/api/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
  'ml/pyproject.toml': '[project]\nname = "ml"\n',
  'ml/pytest.ini': '',
};

interface Report {
  runId: string;
  status: string;
  outcome: string;
  exitCode: number;
  counts: Record<string, number>;
  projects?: Array<{ name: string; type: string; path: string; outcome: string; counts: Record<string, number> }>;
  steps: Array<{ id: string; name: string; status: string; project?: string; error?: string; command?: string; stdout: string }>;
}

async function lastRun(cwd: string): Promise<{ report: Report; dir: string }> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = await newestRunIds(base);
  const dir = join(base, runId ?? '');
  return { report: JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Report, dir };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('mixed-language repository with a partly missing toolchain', () => {
  it('runs what can run, blocks only the project whose tool is broken, and exits non-zero', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, REPO);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const { report } = await lastRun(cwd);

        expect(report.steps.map((s) => [s.id, s.status])).toEqual([
          ['web.build', 'PASS'],
          ['web.test', 'PASS'],
          ['svc.format', 'PASS'],
          ['svc.test', 'PASS'],
          ['api.restore', 'BLOCKED'],
          ['api.build', 'BLOCKED'],
          ['ml.test', 'PASS'],
        ]);
        // gofmt prints nothing when everything is formatted; every other passing step printed something.
        expect(report.steps.filter((s) => s.status === 'PASS' && s.id !== 'svc.format').every((s) => s.stdout.length > 0)).toBe(true);
        expect(report.steps.find((s) => s.id === 'api.restore')!.error).toMatch(/needs dotnet/);
        expect(report.steps.find((s) => s.id === 'api.restore')!.stdout).toBe('');

        expect(report.projects?.map((p) => [p.name, p.type, p.outcome])).toEqual([
          ['web', 'node', 'PASS'],
          ['svc', 'go', 'PASS'],
          ['api', 'dotnet', 'BLOCKED'],
          ['ml', 'python', 'PASS'],
        ]);
        expect(report).toMatchObject({ status: 'FAIL', outcome: 'BLOCKED', exitCode: 1 });
        expect(report.counts).toMatchObject({ total: 7, passed: 5, blocked: 2 });
      });
    });
  }, 180_000);

  it('every step is attributed to its project and named "<project>: <step>"', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, REPO);
      await withPath([shims], async () => {
        await runCommand(cwd, { browsers: NO_BROWSERS });
        const { report } = await lastRun(cwd);
        expect(report.steps.map((s) => [s.project, s.name])).toEqual([
          ['web', 'web: Production Build'],
          ['web', 'web: Unit Tests'],
          ['svc', 'svc: Format'],
          ['svc', 'svc: Unit Tests'],
          ['api', 'api: Restore'],
          ['api', 'api: Production Build'],
          ['ml', 'ml: Unit Tests'],
        ]);
      });
    });
  }, 180_000);

  it('--project selects projects: the broken one can be left out, and the run then passes', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, REPO);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS, projects: ['web', 'svc', 'ml'] })).toBe(0);
        const { report } = await lastRun(cwd);
        expect(report.steps.map((s) => s.id)).toEqual(['web.build', 'web.test', 'svc.format', 'svc.test', 'ml.test']);
        expect(report.projects?.map((p) => p.name)).toEqual(['web', 'svc', 'ml']);
        expect(report).toMatchObject({ outcome: 'PASS', exitCode: 0 });

        expect(await runCommand(cwd, { browsers: NO_BROWSERS, projects: ['api'] })).toBe(1);
        expect((await lastRun(cwd)).report.steps.map((s) => s.status)).toEqual(['BLOCKED', 'BLOCKED']);
      });
    });
  }, 180_000);

  it('a missing optional Python tool blocks only the step that needs it', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        ...REPO,
        '.local-ci.yml': CONFIG.replace('pipeline: [test]\n', 'pipeline: [test, lint]\n'),
        'ml/ruff.toml': '',
      });
      // This shim answers "-m ruff --version" with a failure, as an interpreter without Ruff does.
      const noRuff = await installShims({
        [pythonName]: PYTHON.replace("if (a[0] === '-m' && a[2] === '--version')", "if (a[0] === '-m' && a[1] === 'ruff' && a[2] === '--version') { console.error('No module named ruff'); process.exit(1); }\nif (a[0] === '-m' && a[2] === '--version')"),
      });
      await withPath([noRuff, shims], async () => {
        await runCommand(cwd, { browsers: NO_BROWSERS, projects: ['ml'] });
        const { report } = await lastRun(cwd);
        expect(report.steps.map((s) => [s.id, s.status])).toEqual([['ml.test', 'PASS'], ['ml.lint', 'BLOCKED']]);
        expect(report.steps[1]!.error).toMatch(/needs ruff/);
      });
    });
  }, 180_000);

  it('the console, JSON, HTML and a re-rendered stored report all agree', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, REPO);
      await withPath([shims], async () => {
        const log = vi.mocked(console.log);
        await runCommand(cwd, { browsers: NO_BROWSERS });
        const consoleText = log.mock.calls.map((c) => String(c[0])).join('\n');
        const { report, dir } = await lastRun(cwd);
        const html = await readFile(join(dir, 'report.html'), 'utf8');

        for (const text of [consoleText, html]) {
          expect(text).toContain('web: Unit Tests');
          expect(text).toContain('api: Restore');
        }
        expect(consoleText).toMatch(/api\s+dotnet\s+BLOCKED/);
        expect(consoleText).toMatch(/web\s+node\s+PASS/);
        expect(html).toContain('services/api');

        log.mockClear();
        expect(await reportCommand(cwd, report.runId)).toBe(0);
        const rerendered = log.mock.calls.map((c) => String(c[0])).join('\n');
        expect(rerendered).toMatch(/api\s+dotnet\s+BLOCKED/);
        expect(rerendered).toContain('ml: Unit Tests');
      });
    });
  }, 180_000);

  it('failFast stops later projects after the first blocked one, naming why', async () => {
    const shims = await installShims({ go: GO, gofmt: GOFMT, [pythonName]: PYTHON, dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { ...REPO, '.local-ci.yml': `${CONFIG}settings:\n  failFast: true\n` });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const { report } = await lastRun(cwd);
        expect(report.steps.map((s) => [s.id, s.status])).toEqual([
          ['web.build', 'PASS'],
          ['web.test', 'PASS'],
          ['svc.format', 'PASS'],
          ['svc.test', 'PASS'],
          ['api.restore', 'BLOCKED'],
          // Already blocked by preflight, so it stays BLOCKED; only steps that could have run are skipped.
          ['api.build', 'BLOCKED'],
          ['ml.test', 'SKIPPED'],
        ]);
        expect(report.steps.find((s) => s.id === 'ml.test')!.error).toMatch(/failFast/);
        expect(report.projects?.find((p) => p.name === 'ml')?.outcome).toBe('SKIPPED');
      });
    });
  }, 180_000);
});
