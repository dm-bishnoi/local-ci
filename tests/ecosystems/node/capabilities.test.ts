import { afterEach, describe, expect, it } from 'vitest';
import { nodeAdapter, type NodeDetection } from '../../../src/ecosystems/node/index.js';
import { adapterFor, knownProjectTypes } from '../../../src/ecosystems/registry.js';
import type { Capability } from '../../../src/ecosystems/types.js';
import { cleanupTrees, makeTree } from '../../helpers/tree.js';

afterEach(cleanupTrees);

async function detect(files: Record<string, string | object>): Promise<NodeDetection> {
  return (await nodeAdapter.detect(await makeTree(files))) as NodeDetection;
}

function cmd(c: Capability | undefined): string {
  if (!c || c.state !== 'available') throw new Error(`expected available, got ${JSON.stringify(c)}`);
  return [c.command, ...c.args].join(' ');
}

function sourceOf(c: Capability | undefined): string | undefined {
  return c?.state === 'available' ? c.source : undefined;
}

describe('framework detection does not suppress applicable checks', () => {
  it('React + TypeScript: typecheck, lint, test and build are all independently available', async () => {
    const d = await detect({
      'package.json': {
        dependencies: { react: '^19', 'react-dom': '^19' },
        devDependencies: { typescript: '^5', eslint: '^9', vitest: '^3' },
      },
      'package-lock.json': '{}',
      'tsconfig.json': '{ "compilerOptions": {} }',
      'eslint.config.js': 'export default [];',
      'vitest.config.ts': 'export default {};',
      '_': '',
    });
    expect(d.frameworks).toEqual(['react']);
    expect(d.typescript).toBe(true);
    expect(cmd(d.capabilities['typecheck'])).toBe('npx --no-install tsc --noEmit -p tsconfig.json');
    expect(cmd(d.capabilities['lint'])).toBe('npx --no-install eslint .');
    expect(cmd(d.capabilities['test'])).toBe('npx --no-install vitest run');
    expect(sourceOf(d.capabilities['typecheck'])).toBe('inferred');
    expect(d.capabilities['build']).toEqual({ state: 'unavailable', reason: 'No "build" script in package.json.' });
    expect(cmd(d.capabilities['security'])).toBe('npm audit --json');
  });

  it('Vue + TypeScript with vue-tsc uses vue-tsc; without it falls back to tsc', async () => {
    const withVueTsc = await detect({
      'package.json': { dependencies: { vue: '^3' }, devDependencies: { typescript: '^5', 'vue-tsc': '^2' } },
      'pnpm-lock.yaml': 'x',
      'tsconfig.json': '{}',
    });
    expect(withVueTsc.frameworks).toEqual(['vue']);
    expect(cmd(withVueTsc.capabilities['typecheck'])).toBe('pnpm exec vue-tsc --noEmit');

    const without = await detect({
      'package.json': { dependencies: { vue: '^3' }, devDependencies: { typescript: '^5' } },
      'pnpm-lock.yaml': 'x',
      'tsconfig.json': '{}',
    });
    expect(cmd(without.capabilities['typecheck'])).toBe('pnpm exec tsc --noEmit -p tsconfig.json');
  });

  it('Angular + TypeScript keeps Angular behaviour: no inferred fallbacks, existing reasons', async () => {
    const d = await detect({
      'package.json': {
        dependencies: { '@angular/core': '^19' },
        devDependencies: { typescript: '^5', eslint: '^9', jest: '^29', '@angular/cli': '^19' },
      },
      'angular.json': '{}',
      'tsconfig.json': '{}',
      'eslint.config.js': 'export default [];',
      'jest.config.js': 'module.exports = {};',
    });
    expect(d.frameworks).toEqual(['angular']);
    expect(d.capabilities['typecheck']?.state).toBe('unavailable');
    expect(d.capabilities['lint']?.state).toBe('unavailable');
    expect(d.capabilities['test']?.state).toBe('unavailable');
    expect(cmd(d.capabilities['build'])).toBe('npx --no-install ng build');
    expect(sourceOf(d.capabilities['build'])).toBe('framework');
  });

  it('Angular with an explicit typecheck script uses it', async () => {
    const d = await detect({
      'package.json': { dependencies: { '@angular/core': '^19' }, scripts: { typecheck: 'tsc -p tsconfig.app.json' } },
    });
    expect(cmd(d.capabilities['typecheck'])).toBe('npm run typecheck');
    expect(sourceOf(d.capabilities['typecheck'])).toBe('script');
  });

  it('plain JavaScript: only scripts and audit are available; nothing is invented', async () => {
    const d = await detect({ 'package.json': { scripts: { test: 'node --test' } }, 'package-lock.json': '{}' });
    expect(d.frameworks).toEqual([]);
    expect(d.typescript).toBe(false);
    expect(cmd(d.capabilities['test'])).toBe('npm run test');
    for (const id of ['typecheck', 'lint', 'format', 'build', 'coverage']) {
      expect(d.capabilities[id]?.state, id).toBe('unavailable');
    }
  });
});

describe('explicit scripts take precedence over inference', () => {
  it('a lint script beats eslint+config', async () => {
    const d = await detect({
      'package.json': { scripts: { lint: 'eslint src' }, devDependencies: { eslint: '^9' } },
      'eslint.config.js': '',
    });
    expect(cmd(d.capabilities['lint'])).toBe('npm run lint');
    expect(sourceOf(d.capabilities['lint'])).toBe('script');
  });
});

describe('inference requires dependency AND configuration evidence', () => {
  it('eslint declared but no config -> unavailable', async () => {
    const d = await detect({ 'package.json': { devDependencies: { eslint: '^9' } } });
    expect(d.capabilities['lint']?.state).toBe('unavailable');
  });

  it('config file but eslint not declared -> unavailable', async () => {
    const d = await detect({ 'package.json': {}, 'eslint.config.js': '' });
    expect(d.capabilities['lint']?.state).toBe('unavailable');
  });

  it('typescript declared but no tsconfig -> unavailable', async () => {
    const d = await detect({ 'package.json': { devDependencies: { typescript: '^5' } } });
    expect(d.capabilities['typecheck']?.state).toBe('unavailable');
  });

  it('solution-style tsconfig is not checked with a plain tsc', async () => {
    const d = await detect({
      'package.json': { devDependencies: { typescript: '^5' } },
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./a" }] }',
    });
    expect(d.capabilities['typecheck']).toMatchObject({ state: 'unavailable' });
    expect((d.capabilities['typecheck'] as { reason: string }).reason).toMatch(/solution-style/);
  });

  it('vitest and jest both declared -> ambiguous, unavailable', async () => {
    const d = await detect({
      'package.json': { devDependencies: { vitest: '^3', jest: '^29' } },
      'vitest.config.ts': '',
      'jest.config.js': '',
    });
    expect((d.capabilities['test'] as { reason: string }).reason).toMatch(/ambiguous/);
  });

  it('jest with package.json "jest" key is accepted', async () => {
    const d = await detect({ 'package.json': { devDependencies: { jest: '^29' }, jest: { verbose: true } } });
    expect(cmd(d.capabilities['test'])).toBe('npx --no-install jest --ci');
  });

  it('a "format" script is never run as a check because it may rewrite files', async () => {
    const d = await detect({ 'package.json': { scripts: { format: 'prettier --write .' }, devDependencies: { prettier: '^3' } }, '.prettierrc': '{}' });
    expect(d.capabilities['format']?.state).toBe('unavailable');
  });

  it('prettier + config is inferred as --check', async () => {
    const d = await detect({ 'package.json': { devDependencies: { prettier: '^3' } }, '.prettierrc.json': '{}' });
    expect(cmd(d.capabilities['format'])).toBe('npx --no-install prettier --check .');
  });
});

describe('package manager detection', () => {
  const pkg = { scripts: { build: 'x' } };
  const cases: Array<[string, Record<string, string | object>, string, string]> = [
    ['npm lockfile', { 'package.json': pkg, 'package-lock.json': '{}' }, 'npm', 'npm ci'],
    ['npm shrinkwrap', { 'package.json': pkg, 'npm-shrinkwrap.json': '{}' }, 'npm', 'npm ci'],
    ['pnpm lockfile', { 'package.json': pkg, 'pnpm-lock.yaml': 'x' }, 'pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn classic', { 'package.json': pkg, 'yarn.lock': 'x' }, 'yarn', 'yarn install --frozen-lockfile'],
    ['yarn berry via .yarnrc.yml', { 'package.json': pkg, 'yarn.lock': 'x', '.yarnrc.yml': 'nodeLinker: node-modules' }, 'yarn', 'yarn install --immutable'],
    [
      'yarn berry via packageManager',
      { 'package.json': { ...pkg, packageManager: 'yarn@4.1.0' }, 'yarn.lock': 'x' },
      'yarn',
      'yarn install --immutable',
    ],
    ['bun text lock', { 'package.json': pkg, 'bun.lock': 'x' }, 'bun', 'bun install --frozen-lockfile'],
    ['bun binary lock', { 'package.json': pkg, 'bun.lockb': 'x' }, 'bun', 'bun install --frozen-lockfile'],
    ['no lockfile defaults to npm install', { 'package.json': pkg }, 'npm', 'npm install'],
  ];

  for (const [name, files, manager, install] of cases) {
    it(name, async () => {
      const d = await detect(files);
      expect(d.packageManager).toBe(manager);
      expect(cmd(d.capabilities['install'])).toBe(install);
    });
  }

  it('several lockfiles resolve deterministically (npm first) and are all reported', async () => {
    const d = await detect({ 'package.json': pkg, 'yarn.lock': 'x', 'package-lock.json': '{}', 'pnpm-lock.yaml': 'x' });
    expect(d.packageManager).toBe('npm');
    expect(d.lockfilesFound).toEqual(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
  });

  it('bun scripts and local bins use bun', async () => {
    const d = await detect({ 'package.json': { scripts: { build: 'x' }, devDependencies: { prettier: '1' } }, 'bun.lock': 'x', '.prettierrc': '{}' });
    expect(cmd(d.capabilities['build'])).toBe('bun run build');
    expect(cmd(d.capabilities['format'])).toBe('bun x --no-install prettier --check .');
    expect(d.capabilities['security']).toMatchObject({ state: 'unavailable' });
  });

  it('records the package manager a package.json declares', async () => {
    const d = await detect({ 'package.json': { packageManager: 'pnpm@9.0.0' }, 'package-lock.json': '{}' });
    expect(d.declaredPackageManager).toBe('pnpm');
    expect(d.packageManager).toBe('npm');
  });
});

describe('detection negatives', () => {
  it('no package.json -> not detected, with a reason, and no capabilities', async () => {
    const d = await detect({ 'README.md': 'x' });
    expect(d.detected).toBe(false);
    expect(d.reason).toMatch(/No package\.json/);
    expect(d.capabilities).toEqual({});
  });

  it('invalid package.json -> not detected and says why', async () => {
    const d = await detect({ 'package.json': '{ nope' });
    expect(d.detected).toBe(false);
    expect(d.reason).toMatch(/not valid JSON/);
  });

  it('a UTF-8 BOM in package.json is tolerated', async () => {
    const d = await detect({ 'package.json': '﻿{"scripts":{"build":"x"}}' });
    expect(d.detected).toBe(true);
    expect(cmd(d.capabilities['build'])).toBe('npm run build');
  });
});

describe('registry', () => {
  it('maps every JS-family type to the one Node adapter, case-insensitively', () => {
    for (const type of ['node', 'javascript', 'typescript', 'angular', 'ANGULAR', 'React', 'vue']) {
      expect(adapterFor(type)?.id, type).toBe('node');
    }
  });

  it('does not recognise arbitrary types', () => {
    expect(adapterFor('custom-thing')).toBeUndefined();
    expect(knownProjectTypes()).toContain('react');
  });
});
