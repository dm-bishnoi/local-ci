/**
 * `init` for the adapter-driven ecosystems: minimal runnable configuration,
 * explicit selection, nothing overwritten, nothing guessed when ambiguous.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { CONFIG_FILE, loadConfig } from '../../src/config/loader.js';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { blockingDiagnostics } from '../../src/diagnostics/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTrees();
});

const reactTs = {
  name: 'app',
  private: true,
  scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint .' },
  dependencies: { react: '^19.0.0' },
  devDependencies: { typescript: '^5.0.0', vite: '^6.0.0' },
};

async function pipelineOf(dir: string): Promise<string[]> {
  return (await loadConfig(dir)).pipeline;
}

describe('single project', () => {
  it('writes only the checks the project can run, as a loadable, runnable configuration', async () => {
    const dir = await makeTree({
      'package.json': reactTs,
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
      'node_modules/react/package.json': '{}',
    });
    await initCommand(dir);

    const config = await loadConfig(dir);
    expect(config.project).toEqual({ type: 'react' });
    // typecheck is inferred from typescript+tsconfig; install is skipped because node_modules exists.
    expect(config.pipeline).toEqual(['typecheck', 'test', 'lint', 'build']);

    const text = await readFile(join(dir, CONFIG_FILE), 'utf8');
    expect(text).toMatch(/# - install {2}# Dependencies are already installed/);
    expect(text).toMatch(/# - security {2}# An audit contacts the package registry/);
    expect(text).toMatch(/# - coverage/);

    const diagnostics = await runPreflightChecks(dir, { skipToolProbes: true, browsers: NO_BROWSERS });
    expect(blockingDiagnostics(diagnostics)).toEqual([]);
  });

  it('adds install first when a lockfile exists and dependencies are not installed', async () => {
    const dir = await makeTree({ 'package.json': reactTs, 'pnpm-lock.yaml': 'x', 'tsconfig.json': '{}' });
    await initCommand(dir);
    expect((await pipelineOf(dir)).slice(0, 2)).toEqual(['install', 'typecheck']);
  });

  it('never generates an install that would create a lockfile, nor steps that then cannot run', async () => {
    const dir = await makeTree({ 'package.json': reactTs, 'tsconfig.json': '{}' });
    await expect(initCommand(dir)).rejects.toThrow(/No runnable checks/);
    expect(await exists(join(dir, CONFIG_FILE))).toBe(false);
  });

  it('a dependency-free project needs neither install nor node_modules', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x', scripts: { test: 'node --test', build: 'node build.js' } } });
    await initCommand(dir);
    expect(await pipelineOf(dir)).toEqual(['test', 'build']);
  });

  it('records a project that lives below the root as project.path', async () => {
    const dir = await makeTree({
      'apps/web/package.json': { name: 'web', scripts: { build: 'x' } },
    });
    await initCommand(dir);
    const config = await loadConfig(dir);
    expect(config.project).toEqual({ type: 'node', path: 'apps/web' });
    expect(config.pipeline).toEqual(['build']);
  });

  it('keeps the original Angular output byte-for-byte, with or without --type angular', async () => {
    const files = {
      'angular.json': '{}',
      'package-lock.json': '{}',
      'package.json': { name: 'ng', scripts: { build: 'ng build', test: 'ng test' }, dependencies: { '@angular/core': '^19' } },
    };
    const first = await makeTree(files);
    const second = await makeTree(files);
    await initCommand(first);
    await initCommand(second, { type: 'angular' });
    const a = await readFile(join(first, CONFIG_FILE), 'utf8');
    expect(await readFile(join(second, CONFIG_FILE), 'utf8')).toBe(a);

    const lines = a.split('\n');
    expect(lines.slice(0, 11)).toEqual([
      'version: 1',
      '',
      'project:',
      '  type: angular',
      '',
      'pipeline:',
      '  - install',
      '  - test',
      '  - build',
      '  - security',
      '  # Not added: this project cannot run these yet. Fix the cause, then uncomment.',
    ]);
    expect(lines[11]).toMatch(/^ {2}# - typecheck {2}# /);
    expect(lines[12]).toMatch(/^ {2}# - coverage {2}# /);
    expect(lines[13]).toMatch(/^ {2}# - lint {2}# /);
    expect(lines.slice(14)).toEqual(['', 'settings:', '  failFast: false', '  timeoutMs: 300000', '']);
  });

  it('writes the default configuration, with a note, when nothing is detected', async () => {
    const dir = await makeTree({ 'README.md': 'x' });
    await initCommand(dir);
    expect((await loadConfig(dir)).project.type).toBe('angular');
    expect(logs.join('\n')).toMatch(/No supported project was detected/);
  });
});

describe('ambiguity is never guessed', () => {
  const two = {
    'apps/web/package.json': { name: 'web', scripts: { build: 'x' } },
    'apps/api/package.json': { name: 'api', scripts: { test: 'x' } },
  };

  it('several projects: error that lists each with the exact command to choose it; nothing written', async () => {
    const dir = await makeTree(two);
    const error = await initCommand(dir).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(error).toMatch(/More than one project was found/);
    expect(error).toContain('local-ci-runner init --path "apps/api" --type node');
    expect(error).toContain('local-ci-runner init --path "apps/web" --type node');
    expect(error).toMatch(/init --all/);
    expect(await exists(join(dir, CONFIG_FILE))).toBe(false);
  });

  it('--all writes every project as a projects: list', async () => {
    const dir = await makeTree(two);
    await initCommand(dir, { all: true });
    const config = await loadConfig(dir);
    expect(config.projects?.map((p) => [p.name, p.type, p.path, p.pipeline])).toEqual([
      ['api', 'node', 'apps/api', ['test']],
      ['web', 'node', 'apps/web', ['build']],
    ]);
    expect(config.pipeline).toEqual(['api.test', 'web.build']);
  });

  it('--path chooses one project', async () => {
    const dir = await makeTree(two);
    await initCommand(dir, { path: 'apps/web' });
    expect((await loadConfig(dir)).project).toEqual({ type: 'node', path: 'apps/web' });
  });

  it('a root project plus an undeclared nested one needs a choice; --path . picks the root only', async () => {
    const dir = await makeTree({
      'package.json': { name: 'root', scripts: { build: 'x' } },
      'tools/gen/package.json': { name: 'gen', scripts: { build: 'x' } },
    });
    await expect(initCommand(dir)).rejects.toThrow(/inside "\."/);
    await initCommand(dir, { path: '.' });
    expect((await loadConfig(dir)).project).toEqual({ type: 'node' });
  });

  it('workspace members are covered by the root, so a workspace root is not ambiguous', async () => {
    const dir = await makeTree({
      'package.json': { name: 'root', scripts: { build: 'x' }, workspaces: ['packages/*'] },
      'packages/a/package.json': { name: 'a' },
    });
    await initCommand(dir);
    expect((await loadConfig(dir)).project).toEqual({ type: 'node' });
    expect(logs.join('\n')).toMatch(/Covered by "\." \(package\.json workspaces\), not listed separately: packages\/a/);
  });

  it('reports what the depth limit hid', async () => {
    const dir = await makeTree({
      'package.json': { name: 'root', scripts: { build: 'x' } },
      'a/b/c/d/package.json': { name: 'deep' },
    });
    await initCommand(dir, { dryRun: true });
    expect(logs.join('\n')).toMatch(/Not scanned below "a\/b\/c"/);
  });
});

describe('explicit selection errors', () => {
  it('rejects an unknown --type with the known ones', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x' } });
    await expect(initCommand(dir, { type: 'cobol' })).rejects.toThrow(/Unknown project type "cobol".*node/);
  });

  it('rejects --type that is not what is on disk', async () => {
    const dir = await makeTree({ 'README.md': 'x' });
    await expect(initCommand(dir, { type: 'react' })).rejects.toThrow(/No react project was detected/);
    expect(await exists(join(dir, CONFIG_FILE))).toBe(false);
  });

  it('rejects an escaping or missing --path', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x' } });
    await expect(initCommand(dir, { path: '../elsewhere' })).rejects.toThrow(/--path/);
    await expect(initCommand(dir, { path: 'nope' })).rejects.toThrow(/does not exist/);
  });

  it('rejects --all together with --type or --path, and a bad --scan-depth', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x' } });
    await expect(initCommand(dir, { all: true, type: 'node' })).rejects.toThrow(/cannot be combined/);
    await expect(initCommand(dir, { scanDepth: 99 })).rejects.toThrow(/--scan-depth/);
    await expect(initCommand(dir, { scanDepth: 1.5 })).rejects.toThrow(/--scan-depth/);
  });
});

describe('existing configuration is never overwritten silently', () => {
  it('refuses without --force and points at --dry-run', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x', scripts: { build: 'x' } } });
    await writeFile(join(dir, CONFIG_FILE), 'version: 1\n# mine\n', 'utf8');
    await expect(initCommand(dir)).rejects.toThrow(/--force.*--dry-run/);
    expect(await readFile(join(dir, CONFIG_FILE), 'utf8')).toBe('version: 1\n# mine\n');
  });

  it('--dry-run prints the configuration and writes nothing, even over an existing file', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x', scripts: { build: 'x' } } });
    await initCommand(dir, { dryRun: true });
    expect(logs.join('\n')).toMatch(/version: 1[\s\S]*pipeline:[\s\S]*- build/);
    expect(await exists(join(dir, CONFIG_FILE))).toBe(false);
    expect(await exists(join(dir, '.local-ci'))).toBe(false);

    await writeFile(join(dir, CONFIG_FILE), 'keep me\n', 'utf8');
    logs.length = 0;
    await initCommand(dir, { dryRun: true });
    expect(logs.join('\n')).toMatch(/already exists and was not modified/);
    expect(await readFile(join(dir, CONFIG_FILE), 'utf8')).toBe('keep me\n');
  });

  it('--force replaces it', async () => {
    const dir = await makeTree({ 'package.json': { name: 'x', scripts: { build: 'x' } } });
    await writeFile(join(dir, CONFIG_FILE), 'old\n', 'utf8');
    await initCommand(dir, { force: true });
    expect((await loadConfig(dir)).pipeline).toEqual(['build']);
  });
});
