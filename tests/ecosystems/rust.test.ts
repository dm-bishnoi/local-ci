import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { loadConfig } from '../../src/config/loader.js';
import { discoverProjects } from '../../src/ecosystems/discovery.js';
import { rustAdapter, type RustDetection } from '../../src/ecosystems/rust/index.js';
import type { AvailableCapability, Capability } from '../../src/ecosystems/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { newestRunIds, withTempProject } from '../helpers/reports.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, makeTree, writeTree } from '../helpers/tree.js';

// Detection tests scan real directories and look tools up on PATH. They take well under
// a second alone, but a loaded machine running the whole suite has been measured at 5 s+
// for them (the default limit). This is headroom, not a sign of slow code.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanupTrees);

const PACKAGE = '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n';
const detect = async (files: Record<string, string | object>, offline = false): Promise<RustDetection> =>
  (await rustAdapter.detect(await makeTree(files), { offline })) as RustDetection;
const argv = (c: Capability | undefined): string[] => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return [c.command, ...c.args];
};

describe('Rust detection', () => {
  it('detects a package and a workspace, and records the lock file and toolchain file', async () => {
    const pkg = await detect({ 'Cargo.toml': PACKAGE, 'Cargo.lock': '', 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n' });
    expect(pkg).toMatchObject({ detected: true, package: true, workspace: false, lockfile: true, toolchainFile: 'rust-toolchain.toml' });
    expect(pkg.evidence).toEqual(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']);

    const ws = await detect({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*", "tools/cli"]\n' });
    expect(ws).toMatchObject({ detected: true, package: false, workspace: true, members: ['crates/*', 'tools/cli'] });
  });

  it('parses multi-line member lists with comments and single quotes', async () => {
    const ws = await detect({ 'Cargo.toml': "[workspace]\nmembers = [\n  \"a\", # first\n  'b',\n]\nexclude = [\"c\"]\n" });
    expect(ws.members).toEqual(['a', 'b']);
  });

  it('is not detected without Cargo.toml', async () => {
    const d = await detect({ 'src/main.rs': 'fn main() {}' });
    expect(d).toMatchObject({ detected: false, reason: expect.stringMatching(/No Cargo\.toml/) });
    expect(d.capabilities).toEqual({});
  });

  it('a Cargo.toml with neither [package] nor [workspace] is not a project, and says why', async () => {
    const d = await detect({ 'Cargo.toml': '[dependencies]\nserde = "1"\n' });
    expect(d).toMatchObject({ detected: false, reason: expect.stringMatching(/neither \[package\] nor \[workspace\]/) });
  });

  it('does not mistake other ecosystems for Rust', async () => {
    expect((await detect({ 'package.json': '{}', 'go.mod': 'module m' })).detected).toBe(false);
  });
});

describe('Rust commands', () => {
  it('uses --locked when Cargo.lock exists and never writes formatting', async () => {
    const d = await detect({ 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
    expect(argv(d.capabilities['check'])).toEqual(['cargo', 'check', '--all-targets', '--locked']);
    expect(argv(d.capabilities['test'])).toEqual(['cargo', 'test', '--locked']);
    expect(argv(d.capabilities['build'])).toEqual(['cargo', 'build', '--release', '--locked']);
    expect(argv(d.capabilities['format'])).toEqual(['cargo', 'fmt', '--all', '--', '--check']);
    expect(argv(d.capabilities['lint'])).toEqual(['cargo', 'clippy', '--all-targets', '--locked', '--', '-D', 'warnings']);
    expect(d.warnings).toBeUndefined();
  });

  it('without Cargo.lock it cannot pass --locked, and says cargo will create the file', async () => {
    const d = await detect({ 'Cargo.toml': PACKAGE });
    expect(argv(d.capabilities['test'])).toEqual(['cargo', 'test']);
    expect(d.warnings?.[0]).toMatch(/No Cargo\.lock.*create one/);
  });

  it('a workspace is checked as a whole', async () => {
    const d = await detect({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n', 'Cargo.lock': '' });
    expect(argv(d.capabilities['test'])).toEqual(['cargo', 'test', '--workspace', '--locked']);
    expect(argv(d.capabilities['lint'])).toContain('--workspace');
    expect(argv(d.capabilities['format'])).toContain('--all');
  });

  it('settings.offline adds --offline to the steps that resolve crates, and nothing else', async () => {
    const d = await detect({ 'Cargo.toml': PACKAGE, 'Cargo.lock': '' }, true);
    for (const id of ['check', 'test', 'build', 'lint']) expect(argv(d.capabilities[id]), id).toContain('--offline');
    expect(argv(d.capabilities['format'])).not.toContain('--offline');
  });

  it('stops rustup from installing a toolchain', async () => {
    const d = await detect({ 'Cargo.toml': PACKAGE });
    for (const id of ['check', 'test', 'build', 'format', 'lint']) {
      expect((d.capabilities[id] as AvailableCapability).env).toEqual({ RUSTUP_AUTO_INSTALL: '0' });
    }
  });

  it('rustfmt and clippy are separate requirements, with readable names', async () => {
    const d = await detect({ 'Cargo.toml': PACKAGE });
    expect((d.capabilities['format'] as AvailableCapability).requires).toEqual([
      { kind: 'tool', name: 'cargo', env: { RUSTUP_AUTO_INSTALL: '0' }, probeArgs: ['fmt', '--version'], display: 'rustfmt (cargo fmt)' },
    ]);
    expect((d.capabilities['lint'] as AvailableCapability).requires[0]).toMatchObject({ probeArgs: ['clippy', '--version'], display: 'clippy (cargo clippy)' });
    expect((d.capabilities['test'] as AvailableCapability).requires).toEqual([{ kind: 'tool', name: 'cargo', env: { RUSTUP_AUTO_INSTALL: '0' } }]);
  });

  it('workspace members are covered by the root during discovery', async () => {
    const dir = await makeTree({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/a/Cargo.toml': PACKAGE,
      'crates/b/Cargo.toml': PACKAGE,
    });
    const result = await discoverProjects(dir);
    expect(result.projects.map((p) => [p.path, p.type])).toEqual([['.', 'rust']]);
    expect(result.covered.map((c) => c.path)).toEqual(['crates/a', 'crates/b']);
  });
});

describe('Rust through the pipeline with fake tools (mocked toolchain)', () => {
  const CARGO = `
const a = process.argv.slice(2);
const fs = require('fs');
const log = (s) => console.log(s);
if (a[0] === '--version') { log('cargo 1.78.0 (fake)'); process.exit(0); }
if (a[0] === 'fmt' && a[1] === '--version') { log('rustfmt 1.7.0-stable (fake)'); process.exit(0); }
if (a[0] === 'clippy' && a[1] === '--version') {
  if (fs.existsSync(require('path').join(__dirname, 'no-clippy'))) { console.error('error: no such command: clippy'); process.exit(101); }
  log('clippy 0.1.78 (fake)'); process.exit(0);
}
if (process.env.RUSTUP_AUTO_INSTALL !== '0') { console.error('RUSTUP_AUTO_INSTALL not pinned'); process.exit(9); }
if (a[0] === 'fmt' && a.includes('--check') && fs.existsSync('.misformatted')) { console.log('Diff in src/main.rs'); process.exit(1); }
log('cargo ' + a.join(' ') + ' ok');
`;
  const config = 'version: 1\nproject:\n  type: rust\npipeline: [format, lint, check, test, build]\n';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const lastReport = async (cwd: string) => {
    const base = join(cwd, '.local-ci', 'reports');
    const [runId] = await newestRunIds(base);
    return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; exitCode?: number; stdout: string; error?: string; command?: string }>;
    };
  };
  const statuses = (r: Awaited<ReturnType<typeof lastReport>>): Array<[string, string]> => r.steps.map((s) => [s.id, s.status]);

  it('passes every check and runs cargo with the safe flags and environment', async () => {
    const shims = await installShims({ cargo: CARGO });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
        const report = await lastReport(cwd);
        expect(statuses(report).every(([, s]) => s === 'PASS')).toBe(true);
        expect(report.steps.find((s) => s.id === 'test')!.stdout).toContain('cargo test --locked ok');
        expect(report.steps.find((s) => s.id === 'format')!.command).toBe('cargo fmt --all -- --check');
      });
    });
  }, 120_000);

  it('a formatting difference fails the format step only', async () => {
    const shims = await installShims({ cargo: CARGO });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'Cargo.toml': PACKAGE, 'Cargo.lock': '', '.misformatted': '' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['format', 'FAIL'], ['lint', 'PASS'], ['check', 'PASS'], ['test', 'PASS'], ['build', 'PASS']]);
        expect(report.steps[0]).toMatchObject({ exitCode: 1 });
      });
    });
  }, 120_000);

  it('a missing clippy component blocks only the lint step', async () => {
    const shims = await installShims({ cargo: CARGO });
    await writeTree(shims, { 'no-clippy': '' });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['format', 'PASS'], ['lint', 'BLOCKED'], ['check', 'PASS'], ['test', 'PASS'], ['build', 'PASS']]);
        expect(report.steps[1]!.error).toMatch(/needs clippy \(cargo clippy\)/);
      });
    });
  }, 120_000);

  it('without cargo every Rust step is BLOCKED and nothing runs', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
      await withPath([], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(report.steps.every((s) => s.status === 'BLOCKED')).toBe(true);
        expect(report.steps.every((s) => s.stdout === '')).toBe(true);
      }, { replace: true });
    });
  }, 120_000);

  it('init writes only the steps whose tools exist, and says why it left the rest out', async () => {
    const shims = await installShims({ cargo: CARGO });
    await writeTree(shims, { 'no-clippy': '' });
    const dir = await makeTree({ 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
    await withPath([shims], () => initCommand(dir));
    const config2 = await loadConfig(dir);
    expect(config2.project).toEqual({ type: 'rust' });
    expect(config2.pipeline).toEqual(['format', 'check', 'test', 'build']);
    const text = await readFile(join(dir, '.local-ci.yml'), 'utf8');
    expect(text).toMatch(/# - lint {2}# clippy \(cargo clippy\) was not found on this machine/);
  }, 60_000);

  it('init refuses to write an empty pipeline when cargo itself is absent', async () => {
    const dir = await makeTree({ 'Cargo.toml': PACKAGE, 'Cargo.lock': '' });
    await withPath([], () => expect(initCommand(dir)).rejects.toThrow(/No runnable checks.*cargo/s), { replace: true });
  }, 60_000);
});
