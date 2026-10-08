import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveBuild,
  resolveCoverage,
  resolveInstall,
  resolveLint,
  resolveSecurity,
  resolveStep,
  resolveTest,
  resolveTypecheck,
  supportedStepIds,
} from '../../../src/adapters/angular/commands.js';
import { detectAngularProject } from '../../../src/adapters/angular/detect.js';

/**
 * Detection is exercised against real files on disk in a temp directory; only
 * process execution is avoided, because command mapping never spawns anything.
 */
async function detection(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-commands-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return detectAngularProject(dir);
}

function packageJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'app',
    dependencies: { '@angular/core': '^19.0.0' },
    devDependencies: { '@angular/cli': '^19.0.0' },
    ...extra,
  });
}

async function resolved(files: Record<string, string>, id: string) {
  const command = resolveStep(id, await detection(files));
  if (!command || command.status !== 'resolved') {
    throw new Error(`expected ${id} to resolve, got ${command?.status ?? 'undefined'}`);
  }
  return command;
}

async function unsupportedReason(files: Record<string, string>, id: string): Promise<string> {
  const command = resolveStep(id, await detection(files));
  if (!command || command.status !== 'unsupported') {
    throw new Error(`expected ${id} to be unsupported, got ${command?.status ?? 'undefined'}`);
  }
  return command.reason;
}

describe('supportedStepIds', () => {
  it('covers exactly the documented Angular steps', () => {
    expect(supportedStepIds().sort()).toEqual(
      ['build', 'coverage', 'install', 'lint', 'security', 'test', 'typecheck'],
    );
  });
});

describe('install command mapping', () => {
  it('uses npm ci when a lockfile exists', async () => {
    const command = await resolved({ 'package.json': packageJson(), 'package-lock.json': '{}' }, 'install');

    expect(command.command).toBe('npm');
    expect(command.args).toEqual(['ci']);
  });

  it('falls back to npm install without a lockfile', async () => {
    const command = await resolved({ 'package.json': packageJson() }, 'install');

    expect(command.args).toEqual(['install']);
  });

  it('uses a frozen pnpm install with a pnpm lockfile', async () => {
    const command = await resolved({ 'package.json': packageJson(), 'pnpm-lock.yaml': '' }, 'install');

    expect(command.command).toBe('pnpm');
    expect(command.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('uses a frozen yarn install with a yarn lockfile', async () => {
    const command = await resolved({ 'package.json': packageJson(), 'yarn.lock': '' }, 'install');

    expect(command.command).toBe('yarn');
    expect(command.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('does not freeze when the matching lockfile is missing', async () => {
    const command = await resolved({ 'package.json': packageJson(), 'pnpm-lock.yaml': '' }, 'install');
    const noLock = await resolved({ 'package.json': packageJson() }, 'install');

    expect(command.args).toContain('--frozen-lockfile');
    expect(noLock.args).toEqual(['install']);
  });
});

describe('script-based command mapping', () => {
  const scripts = {
    'package.json': packageJson({
      scripts: { typecheck: 'ng build --configuration development', test: 'ng test', lint: 'ng lint', build: 'ng build' },
    }),
    'angular.json': JSON.stringify({ version: 1 }),
  };

  it('runs the typecheck script', async () => {
    const command = await resolved(scripts, 'typecheck');
    expect(command.command).toBe('npm');
    expect(command.args).toEqual(['run', 'typecheck']);
  });

  it('runs the test script', async () => {
    expect((await resolved(scripts, 'test')).args).toEqual(['run', 'test']);
  });

  it('runs the lint script', async () => {
    expect((await resolved(scripts, 'lint')).args).toEqual(['run', 'lint']);
  });

  it('runs the build script', async () => {
    expect((await resolved(scripts, 'build')).args).toEqual(['run', 'build']);
  });

  it('uses the detected package manager for every script', async () => {
    const pnpmScripts = {
      'package.json': packageJson({ scripts: { test: 'ng test' } }),
      'pnpm-lock.yaml': '',
    };

    const command = await resolved(pnpmScripts, 'test');
    expect(command.command).toBe('pnpm');
    expect(command.args).toEqual(['run', 'test']);
  });
});

describe('missing scripts', () => {
  const bare = { 'package.json': packageJson(), 'angular.json': JSON.stringify({ version: 1 }) };

  it('reports lint as UNSUPPORTED when there is no lint script', async () => {
    const reason = await unsupportedReason(bare, 'lint');

    expect(reason).toContain('No "lint" script');
    expect(reason).toContain('ng lint');
  });

  it('reports typecheck as UNSUPPORTED when there is no typecheck script', async () => {
    expect(await unsupportedReason(bare, 'typecheck')).toContain('No "typecheck" script');
  });

  it('reports test as UNSUPPORTED when there is no test script', async () => {
    expect(await unsupportedReason(bare, 'test')).toContain('No "test" script');
  });

  it('never reports a missing script as a resolved command', async () => {
    const command = resolveStep('lint', await detection(bare));

    expect(command?.status).toBe('unsupported');
  });
});

describe('coverage command mapping', () => {
  it('prefers a dedicated coverage script', async () => {
    const files = {
      'package.json': packageJson({ scripts: { coverage: 'ng test --code-coverage' } }),
      'angular.json': '{}',
    };

    expect((await resolved(files, 'coverage')).args).toEqual(['run', 'coverage']);
  });

  it('forwards --coverage to the test script for npm when a provider exists', async () => {
    const files = {
      'package.json': packageJson({ scripts: { test: 'ng test' }, devDependencies: { 'karma-coverage': '^2.0.0' } }),
      'angular.json': '{}',
      'package-lock.json': '{}',
    };

    const command = await resolved(files, 'coverage');

    expect(command.args).toEqual(['run', 'test', '--', '--coverage']);
  });

  it('forwards --coverage directly for pnpm', async () => {
    const files = {
      'package.json': packageJson({ scripts: { test: 'ng test' }, devDependencies: { nyc: '^15.0.0' } }),
      'pnpm-lock.yaml': '',
    };

    expect((await resolved(files, 'coverage')).args).toEqual(['run', 'test', '--coverage']);
  });

  it('forwards --coverage directly for yarn', async () => {
    const files = {
      'package.json': packageJson({ scripts: { test: 'ng test' }, devDependencies: { jest: '^29.0.0' } }),
      'yarn.lock': '',
    };

    expect((await resolved(files, 'coverage')).args).toEqual(['run', 'test', '--coverage']);
  });

  it('refuses to guess coverage when no provider is declared', async () => {
    const files = {
      'package.json': packageJson({ scripts: { test: 'ng test' } }),
      'angular.json': '{}',
    };

    const reason = await unsupportedReason(files, 'coverage');

    expect(reason).toContain('cannot be determined safely');
    expect(reason).toContain('karma-coverage');
  });

  it('refuses to guess coverage when there is no test script either', async () => {
    expect(await unsupportedReason({ 'package.json': packageJson() }, 'coverage')).toContain(
      'cannot be determined safely',
    );
  });
});

describe('build command mapping', () => {
  it('prefers the build script', async () => {
    const files = { 'package.json': packageJson({ scripts: { build: 'ng build --configuration production' } }) };
    expect((await resolved(files, 'build')).args).toEqual(['run', 'build']);
  });

  it('falls back to the local Angular CLI with npm, without fetching packages', async () => {
    const files = { 'angular.json': '{}', 'package.json': packageJson() };
    const command = await resolved(files, 'build');

    expect(command.command).toBe('npx');
    expect(command.args).toEqual(['--no-install', 'ng', 'build']);
  });

  it('falls back to pnpm exec for pnpm projects', async () => {
    const files = { 'angular.json': '{}', 'package.json': packageJson(), 'pnpm-lock.yaml': '' };
    const command = await resolved(files, 'build');

    expect(command.command).toBe('pnpm');
    expect(command.args).toEqual(['exec', 'ng', 'build']);
  });

  it('falls back to yarn exec for yarn projects', async () => {
    const files = { 'angular.json': '{}', 'package.json': packageJson(), 'yarn.lock': '' };
    const command = await resolved(files, 'build');

    expect(command.command).toBe('yarn');
    expect(command.args).toEqual(['exec', 'ng', 'build']);
  });

  it('refuses the CLI fallback when angular.json is absent', async () => {
    // Angular detected only through package.json, so there is no workspace.
    expect(await unsupportedReason({ 'package.json': packageJson() }, 'build')).toContain(
      'could not be resolved locally',
    );
  });

  it('refuses the CLI fallback when @angular/cli is not declared', async () => {
    const files = {
      'angular.json': '{}',
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^19.0.0' } }),
    };

    expect(await unsupportedReason(files, 'build')).toContain('could not be resolved locally');
  });
});

describe('security command mapping', () => {
  it('uses npm audit for npm projects', async () => {
    const command = resolveSecurity(await detection({ 'package.json': packageJson(), 'package-lock.json': '{}' }));

    expect(command).toEqual(
      expect.objectContaining({ status: 'resolved', command: 'npm', args: ['audit', '--json'] }),
    );
  });

  it('uses pnpm audit for pnpm projects', async () => {
    const command = resolveSecurity(await detection({ 'package.json': packageJson(), 'pnpm-lock.yaml': '' }));

    expect(command).toEqual(
      expect.objectContaining({ status: 'resolved', command: 'pnpm', args: ['audit', '--json'] }),
    );
  });

  it('declines yarn rather than guessing an audit command', async () => {
    const command = resolveSecurity(await detection({ 'package.json': packageJson(), 'yarn.lock': '' }));

    expect(command?.status).toBe('unsupported');
    if (command?.status === 'unsupported') expect(command.reason).toContain('yarn');
  });
});

describe('resolveStep', () => {
  it('returns undefined for an id the adapter does not own', async () => {
    expect(resolveStep('deploy', await detection({ 'package.json': packageJson() }))).toBeUndefined();
  });

  it('never throws for any supported id', async () => {
    const project = await detection({ 'package.json': packageJson(), 'angular.json': '{}' });

    for (const id of supportedStepIds()) {
      expect(() => resolveStep(id, project)).not.toThrow();
    }
  });
});

// Direct resolver coverage for the exported helpers.
describe('exported resolvers', () => {
  it('resolveInstall, resolveTypecheck and friends accept a detection object', async () => {
    const project = await detection({ 'package.json': packageJson(), 'angular.json': '{}' });

    expect(resolveInstall(project).status).toBe('resolved');
    expect(resolveTypecheck(project).status).toBe('unsupported');
    expect(resolveTest(project).status).toBe('unsupported');
    expect(resolveCoverage(project).status).toBe('unsupported');
    expect(resolveLint(project).status).toBe('unsupported');
    expect(resolveBuild(project).status).toBe('resolved');
    expect(resolveSecurity(project).status).toBe('resolved');
  });
});