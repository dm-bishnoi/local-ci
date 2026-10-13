import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import type { ProcessResult } from '../../src/core/process-runner.js';
import type { PipelineContext } from '../../src/core/context.js';
import { runStep } from '../../src/core/step-runner.js';
import { gofmtListEvaluator } from '../../src/ecosystems/evaluators.js';
import { goAdapter, parseGoMod, parseGoWorkUse, type GoDetection } from '../../src/ecosystems/go/index.js';
import { createCapabilityStep } from '../../src/ecosystems/steps.js';
import type { AvailableCapability, Capability } from '../../src/ecosystems/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';
import { withTempProject } from '../helpers/reports.js';
import { writeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

const detect = async (files: Record<string, string | object>): Promise<GoDetection> =>
  (await goAdapter.detect(await makeTree(files))) as GoDetection;

const command = (c: Capability | undefined): string => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return [c.command, ...c.args].join(' ');
};

describe('Go detection', () => {
  it('detects a module and reads the go directive', async () => {
    const d = await detect({ 'go.mod': 'module example.com/x\n\ngo 1.21\n\ntoolchain go1.22.3\n' });
    expect(d).toMatchObject({ detected: true, workspace: false, modules: ['.'], goVersion: '1.21', toolchain: '1.22.3' });
    expect(d.evidence).toEqual(['go.mod']);
  });

  it('detects a workspace from go.work and prefers it over go.mod', async () => {
    const d = await detect({
      'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./lib // shared\n)\nuse ./tools\n',
      'go.mod': 'module root\ngo 1.20\n',
    });
    expect(d).toMatchObject({ detected: true, workspace: true, modules: ['api', 'lib', 'tools'], goVersion: '1.22' });
  });

  it('is not detected without go.mod or go.work, and says why', async () => {
    const d = await detect({ 'main.go': 'package main\n' });
    expect(d.detected).toBe(false);
    expect(d.reason).toMatch(/No go\.work or go\.mod/);
    expect(d.capabilities).toEqual({});
  });

  it('does not treat other manifests as Go', async () => {
    expect((await detect({ 'package.json': '{}', 'Cargo.toml': '' })).detected).toBe(false);
  });

  it('parses go.work use directives in every spelling', () => {
    expect(parseGoWorkUse('use ./a\nuse "./b c"\nuse (\n  ./d\n\n  `./e`\n)\n// use ./ignored\n')).toEqual(['./a', './b c', './d', './e']);
    expect(parseGoMod('module m\ngo 1.22.1\n')).toEqual({ goVersion: '1.22.1', toolchain: null });
    expect(parseGoMod('module m\n')).toEqual({ goVersion: null, toolchain: null });
  });
});

describe('Go commands', () => {
  it('a module gets format, vet, test and build with no mutating flags', async () => {
    const d = await detect({ 'go.mod': 'module m\ngo 1.21\n' });
    expect(command(d.capabilities['format'])).toBe('gofmt -l .');
    expect(command(d.capabilities['vet'])).toBe('go vet ./...');
    expect(command(d.capabilities['test'])).toBe('go test ./...');
    expect(command(d.capabilities['build'])).toBe('go build ./...');
    for (const id of ['format', 'vet', 'test', 'build']) {
      const c = d.capabilities[id] as AvailableCapability;
      expect([c.command, ...c.args]).not.toContain('-w');
      expect([c.command, ...c.args]).not.toContain('fmt');
    }
  });

  it('never allows a toolchain download', async () => {
    const d = await detect({ 'go.mod': 'module m\ngo 1.21\n' });
    expect((d.capabilities['test'] as AvailableCapability).env).toEqual({ GOTOOLCHAIN: 'local' });
  });

  it('a workspace names each module explicitly', async () => {
    const d = await detect({ 'go.work': 'go 1.22\nuse ./api\nuse ./lib\n' });
    expect(command(d.capabilities['format'])).toBe('gofmt -l ./api ./lib');
    expect(command(d.capabilities['test'])).toBe('go test ./api/... ./lib/...');
  });

  it('records the minimum Go version and the tools each check needs', async () => {
    const d = await detect({ 'go.mod': 'module m\ngo 1.21\n' });
    expect((d.capabilities['vet'] as AvailableCapability).requires).toEqual([
      { kind: 'tool', name: 'go', probeArgs: ['version'] },
      { kind: 'version', tool: 'go', atLeast: '1.21', source: 'go.mod', probeArgs: ['version'] },
    ]);
    expect((d.capabilities['format'] as AvailableCapability).requires).toEqual([{ kind: 'tool', name: 'gofmt', locateOnly: true }]);
  });

  it.each([
    ['a parent directory', 'use ../shared\n'],
    ['an absolute path', 'use /opt/mod\n'],
    ['a drive path', 'use C:/mod\n'],
  ])('go.work with %s makes every step unavailable instead of running outside the project', async (_name, use) => {
    const d = await detect({ 'go.work': `go 1.22\nuse ./ok\n${use}` });
    for (const id of ['format', 'vet', 'test', 'build']) {
      expect(d.capabilities[id]).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/outside the project/) });
    }
  });

  it('go.work without use directives has nothing to check', async () => {
    const d = await detect({ 'go.work': 'go 1.22\n' });
    expect(d.capabilities['test']).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/no "use" directive|no modules/) });
  });

  it('init pipeline lists every runnable step in order', async () => {
    const d = await detect({ 'go.mod': 'module m\ngo 1.21\n' });
    expect(goAdapter.defaultPipeline(d)).toEqual({ pipeline: ['format', 'vet', 'test', 'build'], omitted: [] });
  });
});

function result(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    command: 'gofmt',
    args: ['-l', '.'],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    failed: false,
    ...overrides,
  };
}

describe('gofmt -l is judged by its output, not its exit code', () => {
  const evaluate = gofmtListEvaluator();

  it('exit 0 with files listed FAILS and names them', () => {
    const verdict = evaluate(result({ stdout: 'main.go\npkg/util.go\n' }));
    expect(verdict).toMatchObject({ status: 'FAIL' });
    expect(verdict.status === 'FAIL' && verdict.error).toMatch(/2 files need formatting.*main\.go, pkg\/util\.go/);
    expect(verdict.status === 'FAIL' && verdict.error).toMatch(/never rewrites files/);
  });

  it('exit 0 with nothing listed passes', () => {
    expect(evaluate(result({ stdout: '' }))).toEqual({ status: 'PASS' });
    expect(evaluate(result({ stdout: '\n  \r\n' }))).toEqual({ status: 'PASS' });
  });

  it('handles CRLF output from Windows', () => {
    const verdict = evaluate(result({ stdout: 'a.go\r\nb.go\r\n' }));
    expect(verdict.status === 'FAIL' && verdict.error).toMatch(/2 files.*a\.go, b\.go/);
  });

  it('ignores vendored and test-data paths', () => {
    expect(evaluate(result({ stdout: 'vendor/x/y.go\nsub/testdata/z.go\nvendor\\w.go\n' }))).toEqual({ status: 'PASS' });
    const mixed = evaluate(result({ stdout: 'vendor/x/y.go\nreal.go\n' }));
    expect(mixed.status === 'FAIL' && mixed.error).toMatch(/1 file needs formatting.*real\.go/);
  });

  it('does not confuse stderr with the file list: stderr on exit 0 changes nothing', () => {
    expect(evaluate(result({ stdout: '', stderr: 'warning: something' }))).toEqual({ status: 'PASS' });
    const failing = evaluate(result({ stdout: 'a.go\n', stderr: 'warning: something' }));
    expect(failing.status === 'FAIL' && failing.error).not.toMatch(/warning: something/);
  });

  it('truncates a long list but reports the real count', () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.go`).join('\n');
    const verdict = evaluate(result({ stdout: files }));
    expect(verdict.status === 'FAIL' && verdict.error).toMatch(/30 files.*and 10 more/);
  });
});

describe('gofmt step through the real step runner (mocked executor)', () => {
  const capability = async (): Promise<AvailableCapability> =>
    (await detect({ 'go.mod': 'module m\ngo 1.21\n' })).capabilities['format'] as AvailableCapability;

  const context = (cwd: string): PipelineContext => ({
    cwd,
    runId: '20260101-000000-feedf00d',
    config: { version: 1, project: { type: 'go' }, pipeline: ['format'], settings: { failFast: false } },
  });

  async function runWith(process: Partial<ProcessResult>) {
    const step = createCapabilityStep('format', await capability(), { exec: async () => result(process) });
    return runStep(step, context(process.stdout ?? ''));
  }

  it('exit 0 + files listed -> FAIL with exit code 0 preserved and stdout kept', async () => {
    const r = await runWith({ stdout: 'main.go\n' });
    expect(r.status).toBe('FAIL');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('main.go\n');
    expect(r.error).toMatch(/1 file needs formatting.*main\.go/);
  });

  it('exit 0 + empty stdout -> PASS', async () => {
    expect((await runWith({ stdout: '' })).status).toBe('PASS');
  });

  it('exit 2 + stderr -> FAIL whose message is stderr, never the stdout list', async () => {
    const r = await runWith({ exitCode: 2, failed: true, stdout: 'main.go\n', stderr: 'x.go:3:1: expected declaration', error: 'Process exited with code 2.' });
    expect(r.status).toBe('FAIL');
    expect(r.exitCode).toBe(2);
    expect(r.error).toBe('Process exited with code 2.');
    expect(r.error).not.toMatch(/need formatting/);
  });

  it('a timed-out or cancelled gofmt is not re-judged by its partial output', async () => {
    const timed = await runWith({ exitCode: null, failed: true, timedOut: true, stdout: '' });
    expect(timed.status).toBe('FAIL');
    expect(timed.timedOut).toBe(true);
    const cancelled = await runWith({ exitCode: null, failed: true, cancelled: true, stdout: '' });
    expect(cancelled.status).toBe('CANCELLED');
  });
});

describe('Go through the whole pipeline with fake tools (mocked toolchain)', () => {
  const GO_SHIM = `
const a = process.argv.slice(2);
if (a[0] === 'version') { console.log('go version go1.22.3 linux/amd64'); process.exit(0); }
if (process.env.GOTOOLCHAIN !== 'local') { console.error('GOTOOLCHAIN not pinned'); process.exit(9); }
console.log('go ' + a.join(' ') + ' ok');
`;
  const GOFMT_SHIM = `
const fs = require('fs');
if (fs.existsSync('.unformatted')) { process.stdout.write(fs.readFileSync('.unformatted', 'utf8')); }
process.exit(0);
`;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const config = 'version: 1\nproject:\n  type: go\npipeline: [format, vet, test, build]\n';
  const lastReport = async (cwd: string) => {
    const base = join(cwd, '.local-ci', 'reports');
    const [runId] = (await readdir(base)).sort().reverse();
    return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; exitCode?: number; stdout: string; error?: string }>;
    };
  };

  it('fails on unformatted files even though gofmt exits 0, then passes once they are formatted', async () => {
    const shims = await installShims({ go: GO_SHIM, gofmt: GOFMT_SHIM });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'go.mod': 'module m\n\ngo 1.21\n', '.unformatted': 'main.go\n' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const failing = await lastReport(cwd);
        const format = failing.steps.find((s) => s.id === 'format')!;
        expect(format).toMatchObject({ status: 'FAIL', exitCode: 0 });
        expect(format.error).toMatch(/main\.go/);
        expect(failing.steps.filter((s) => s.id !== 'format').map((s) => s.status)).toEqual(['PASS', 'PASS', 'PASS']);
        expect(failing.steps.find((s) => s.id === 'test')!.stdout).toContain('go test ./... ok');

        await writeTree(cwd, { '.unformatted': '' });
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
      });
    });
  }, 120_000);

  it('blocks the whole Go project when go is not installed, without running anything', async () => {
    const shims = await installShims({ gofmt: GOFMT_SHIM });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'go.mod': 'module m\n\ngo 1.21\n' });
      await withPath(
        [shims],
        async () => {
          expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
          const report = await lastReport(cwd);
          expect(report.steps.map((s) => [s.id, s.status])).toEqual([
            ['format', 'PASS'],
            ['vet', 'BLOCKED'],
            ['test', 'BLOCKED'],
            ['build', 'BLOCKED'],
          ]);
          expect(report.steps.find((s) => s.id === 'vet')!.error).toMatch(/needs go.*not found on PATH/);
        },
        { replace: true },
      );
    });
  }, 120_000);

  it('blocks when the installed Go is older than go.mod requires', async () => {
    const shims = await installShims({ go: GO_SHIM, gofmt: GOFMT_SHIM });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'go.mod': 'module m\n\ngo 1.23\n' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const vet = (await lastReport(cwd)).steps.find((s) => s.id === 'vet')!;
        expect(vet.status).toBe('BLOCKED');
        expect(vet.error).toMatch(/go\.mod requires go >= 1\.23, but 1\.22\.3 is installed/);
      });
    });
  }, 120_000);
});
