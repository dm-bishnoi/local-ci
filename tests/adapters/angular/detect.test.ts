import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAngularProject, detectPackageManager, hasAngularCli, stripBom } from '../../../src/adapters/angular/detect.js';

const created: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-detect-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('detectAngularProject', () => {
  it('detects Angular from angular.json', async () => {
    const cwd = await makeProject({
      'angular.json': JSON.stringify({ version: 1, projects: {} }),
      'package.json': JSON.stringify({ name: 'app' }),
    });

    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(true);
    expect(detection.framework).toBe('angular');
    expect(detection.angularConfig).toBe(join(cwd, 'angular.json'));
    expect(detection.packageJson).toBe(join(cwd, 'package.json'));
    expect(detection.reason).toBeUndefined();
  });

  it('detects Angular from package.json dependencies alone', async () => {
    const cwd = await makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^19.0.0' } }),
    });

    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(true);
    expect(detection.angularConfig).toBeNull();
    expect(detection.dependencies['@angular/core']).toBe('^19.0.0');
  });

  it('detects Angular from @angular/cli in devDependencies', async () => {
    const cwd = await makeProject({
      'package.json': JSON.stringify({ devDependencies: { '@angular/cli': '^19.0.0' } }),
    });

    expect((await detectAngularProject(cwd)).detected).toBe(true);
  });

  it('does not treat a plain TypeScript project as Angular', async () => {
    const cwd = await makeProject({
      'package.json': JSON.stringify({
        name: 'not-angular',
        devDependencies: { typescript: '^5.9.0' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    });

    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(false);
    expect(detection.framework).toBeNull();
    expect(detection.reason).toContain('Angular was not detected');
    expect(detection.reason).toContain('angular.json');
  });

  it('reports missing files rather than throwing', async () => {
    const cwd = await makeProject({});
    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(false);
    expect(detection.packageJson).toBeNull();
    expect(detection.angularConfig).toBeNull();
    expect(detection.reason).toContain('No angular.json and no package.json');
  });

  it('reports malformed package.json without throwing', async () => {
    const cwd = await makeProject({
      'package.json': '{ this is not json',
      'angular.json': JSON.stringify({ version: 1 }),
    });

    const detection = await detectAngularProject(cwd);

    // angular.json still proves Angular, so detection succeeds...
    expect(detection.detected).toBe(true);
    // ...but the broken file is not silently swallowed as valid.
    expect(detection.packageJson).toBeNull();
  });

  it('surfaces a malformed package.json as the reason when nothing else proves Angular', async () => {
    const cwd = await makeProject({ 'package.json': '{ broken' });

    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('not valid JSON');
  });

  it('rejects a package.json that is not an object', async () => {
    const cwd = await makeProject({ 'package.json': '"just a string"' });

    expect((await detectAngularProject(cwd)).detected).toBe(false);
  });

  it('ignores non-string script and dependency values', async () => {
    const cwd = await makeProject({
      'angular.json': JSON.stringify({ version: 1 }),
      'package.json': JSON.stringify({ scripts: { build: 42, test: 'ng test' } }),
    });

    const detection = await detectAngularProject(cwd);

    expect(detection.scripts['test']).toBe('ng test');
    expect(detection.scripts['build']).toBeUndefined();
  });

  it('ignores a blank script as absent', async () => {
    const cwd = await makeProject({
      'angular.json': JSON.stringify({ version: 1 }),
      'package.json': JSON.stringify({ scripts: { lint: '   ' } }),
    });

    expect((await detectAngularProject(cwd)).scripts['lint']).toBe('   ');
  });

  it('tolerates a UTF-8 BOM in package.json', async () => {
    // Windows editors commonly write one; npm and Node accept it, so the
    // detector must too or a valid project looks scriptless.
    const bom = '﻿';
    const cwd = await makeProject({
      'angular.json': JSON.stringify({ version: 1 }),
      'package.json': `${bom}${JSON.stringify({
        name: 'app',
        scripts: { build: 'ng build' },
        devDependencies: { '@angular/cli': '^19.0.0' },
      })}`,
    });

    const detection = await detectAngularProject(cwd);

    expect(detection.detected).toBe(true);
    expect(detection.scripts['build']).toBe('ng build');
    expect(hasAngularCli(detection)).toBe(true);
  });

  it('stripBom leaves untagged text untouched', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
    expect(stripBom(`﻿{"a":1}`)).toBe('{"a":1}');
  });

  it('still reports genuinely malformed JSON as an error', async () => {
    const cwd = await makeProject({ 'package.json': `${'﻿'}{ broken` });
    expect((await detectAngularProject(cwd)).reason).toContain('not valid JSON');
  });

  it('reports hasAngularCli only when the CLI is declared', async () => {
    const withCli = await makeProject({
      'angular.json': '{}',
      'package.json': JSON.stringify({ devDependencies: { '@angular/cli': '^19.0.0' } }),
    });
    const withoutCli = await makeProject({
      'angular.json': '{}',
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^19.0.0' } }),
    });

    expect(hasAngularCli(await detectAngularProject(withCli))).toBe(true);
    expect(hasAngularCli(await detectAngularProject(withoutCli))).toBe(false);
  });
});

describe('detectPackageManager', () => {
  it('detects npm from package-lock.json', async () => {
    const cwd = await makeProject({ 'package-lock.json': '{}' });
    const result = await detectPackageManager(cwd);

    expect(result.manager).toBe('npm');
    expect(result.lockfile).toBe('package-lock.json');
    expect(result.isDefault).toBe(false);
  });

  it('detects pnpm from pnpm-lock.yaml', async () => {
    const cwd = await makeProject({ 'pnpm-lock.yaml': 'lockfileVersion: 9' });
    const result = await detectPackageManager(cwd);

    expect(result.manager).toBe('pnpm');
    expect(result.lockfile).toBe('pnpm-lock.yaml');
    expect(result.isDefault).toBe(false);
  });

  it('detects yarn from yarn.lock', async () => {
    const cwd = await makeProject({ 'yarn.lock': '# yarn lockfile v1' });
    const result = await detectPackageManager(cwd);

    expect(result.manager).toBe('yarn');
    expect(result.lockfile).toBe('yarn.lock');
    expect(result.isDefault).toBe(false);
  });

  it('applies a deterministic priority when several lockfiles exist', async () => {
    const cwd = await makeProject({
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
    });

    // npm wins, and it wins every time.
    expect((await detectPackageManager(cwd)).manager).toBe('npm');
    expect((await detectPackageManager(cwd)).manager).toBe('npm');
  });

  it('prefers pnpm over yarn when both are present', async () => {
    const cwd = await makeProject({ 'pnpm-lock.yaml': '', 'yarn.lock': '' });

    expect((await detectPackageManager(cwd)).manager).toBe('pnpm');
  });

  it('defaults to npm and flags the default when no lockfile exists', async () => {
    const result = await detectPackageManager(await makeProject({ 'package.json': '{}' }));

    expect(result.manager).toBe('npm');
    expect(result.lockfile).toBeNull();
    expect(result.isDefault).toBe(true);
  });
});