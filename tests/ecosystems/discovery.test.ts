import { mkdir, rmdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCAN_DEPTH, discoverProjects } from '../../src/ecosystems/discovery.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

// These tests scan real directories with every adapter and take well under a second
// alone, but a loaded machine running the whole suite in parallel has been measured
// at 5 s+ for them, which is the default limit. The limit is for headroom, not for
// slow code: nothing here waits on a process.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanupTrees);

const PKG = { name: 'x', private: true, scripts: { build: 'echo' } };
const paths = (result: Awaited<ReturnType<typeof discoverProjects>>): string[] => result.projects.map((p) => p.path);

describe('declared workspace metadata decides what is covered', () => {
  it('npm workspaces: members are covered by the root, not listed again', async () => {
    const dir = await makeTree({
      'package.json': { ...PKG, workspaces: ['packages/*'] },
      'packages/a/package.json': PKG,
      'packages/b/package.json': PKG,
      'packages/b/inner/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(paths(result)).toEqual(['.', 'packages/b/inner']);
    expect(result.covered.map((c) => [c.path, c.coveredBy, c.source])).toEqual([
      ['packages/a', '.', 'package.json workspaces'],
      ['packages/b', '.', 'package.json workspaces'],
    ]);
    // The undeclared nested package is real work that must not be hidden.
    expect(result.projects.find((p) => p.path === 'packages/b/inner')?.nestedIn).toBe('.');
  });

  it('npm workspaces object form with "packages"', async () => {
    const dir = await makeTree({
      'package.json': { ...PKG, workspaces: { packages: ['libs/*'] } },
      'libs/x/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(paths(result)).toEqual(['.']);
    expect(result.covered.map((c) => c.path)).toEqual(['libs/x']);
  });

  it('pnpm-workspace.yaml with a trailing **', async () => {
    const dir = await makeTree({
      'package.json': PKG,
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'libs/**'\n",
      'apps/web/package.json': PKG,
      'libs/deep/er/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(paths(result)).toEqual(['.']);
    expect(result.covered.map((c) => c.path).sort()).toEqual(['apps/web', 'libs/deep/er']);
  });

  it('a declared member that does not exist is simply absent, not an error', async () => {
    const dir = await makeTree({ 'package.json': { ...PKG, workspaces: ['packages/ghost'] } });
    const result = await discoverProjects(dir);
    expect(paths(result)).toEqual(['.']);
    expect(result.covered).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns about member patterns it cannot expand instead of ignoring them', async () => {
    const dir = await makeTree({
      'package.json': { ...PKG, workspaces: ['packages/{a,b}', '!packages/skip'] },
      'packages/a/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/"packages\/\{a,b\}".*cannot expand/);
    expect(result.warnings[1]).toMatch(/"!packages\/skip"/);
    // Not covered, so the member is still listed rather than lost.
    expect(paths(result)).toContain('packages/a');
  });
});

describe('scanning without workspace metadata', () => {
  it('lists independent projects and names them from their directories', async () => {
    const dir = await makeTree({ 'apps/web/package.json': PKG, 'apps/api/package.json': PKG });
    const result = await discoverProjects(dir);
    expect(result.projects.map((p) => [p.name, p.path])).toEqual([
      ['api', 'apps/api'],
      ['web', 'apps/web'],
    ]);
    expect(result.projects.every((p) => p.nestedIn === undefined)).toBe(true);
  });

  it('gives colliding directory names distinct, valid names', async () => {
    const dir = await makeTree({ 'apps/a/web/package.json': PKG, 'libs/b/web/package.json': PKG });
    const result = await discoverProjects(dir);
    expect(result.projects.map((p) => p.name)).toEqual(['web', 'libs-b-web']);
    for (const project of result.projects) expect(project.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('is deterministic', async () => {
    const dir = await makeTree({ 'b/package.json': PKG, 'a/package.json': PKG, 'c/d/package.json': PKG });
    const first = await discoverProjects(dir);
    const second = await discoverProjects(dir);
    expect(paths(first)).toEqual(['a', 'b', 'c/d']);
    expect(paths(second)).toEqual(paths(first));
  });

  it('suggests the framework profile as the type', async () => {
    const dir = await makeTree({
      'a/package.json': { ...PKG, dependencies: { react: '1' } },
      'b/package.json': { ...PKG, dependencies: { vue: '3' } },
      'c/package.json': { ...PKG, dependencies: { '@angular/core': '19' } },
      'd/package.json': { ...PKG, devDependencies: { typescript: '5' } },
      'e/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(result.projects.map((p) => p.type)).toEqual(['react', 'vue', 'angular', 'typescript', 'node']);
  });
});

describe('bounded scan: nothing is silently omitted', () => {
  it('ignores dependency and build directories and says how many it skipped', async () => {
    const dir = await makeTree({
      'package.json': PKG,
      'node_modules/dep/package.json': PKG,
      'node_modules/other/package.json': PKG,
      'dist/package.json': PKG,
    });
    const result = await discoverProjects(dir);
    expect(paths(result)).toEqual(['.']);
    expect(result.skipped.ignoredDirectories).toMatchObject({ node_modules: 1, dist: 1 });
  });

  it('honours extra ignored names', async () => {
    const dir = await makeTree({ 'legacy/package.json': PKG, 'app/package.json': PKG });
    const result = await discoverProjects(dir, { ignore: ['legacy'] });
    expect(paths(result)).toEqual(['app']);
    expect(result.skipped.ignoredDirectories['legacy']).toBe(1);
  });

  it('reports directories it did not scan because of the depth limit', async () => {
    const dir = await makeTree({ 'a/b/c/d/e/package.json': PKG });
    const shallow = await discoverProjects(dir);
    expect(DEFAULT_SCAN_DEPTH).toBe(3);
    expect(paths(shallow)).toEqual([]);
    expect(shallow.skipped.depthLimited).toEqual(['a/b/c']);

    const deep = await discoverProjects(dir, { scanDepth: 5 });
    expect(paths(deep)).toEqual(['a/b/c/d/e']);
    expect(deep.skipped.depthLimited).toEqual([]);
  });

  it('depth 0 looks only at the root', async () => {
    const dir = await makeTree({ 'package.json': PKG, 'sub/package.json': PKG });
    expect(paths(await discoverProjects(dir, { scanDepth: 0 }))).toEqual(['.']);
  });

  it('never follows a symlink or junction, and reports it', async () => {
    const outside = await makeTree({ 'package.json': PKG });
    const dir = await makeTree({ 'real/package.json': PKG });
    await mkdir(join(dir, 'links'), { recursive: true });
    const link = join(dir, 'links', 'out');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      return; // links cannot be created in this environment
    }
    try {
      const result = await discoverProjects(dir);
      expect(paths(result)).toEqual(['real']);
      expect(result.skipped.symlinks).toEqual(['links/out']);
    } finally {
      await rmdir(link).catch(() => unlink(link).catch(() => undefined));
    }
  });

  it('a symlinked workspace member is reported, not followed', async () => {
    const outside = await makeTree({ 'package.json': PKG });
    const dir = await makeTree({ 'package.json': { ...PKG, workspaces: ['packages/*'] } });
    await mkdir(join(dir, 'packages'), { recursive: true });
    const link = join(dir, 'packages', 'linked');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      return;
    }
    try {
      const result = await discoverProjects(dir);
      expect(result.skipped.symlinks).toContain('packages/linked');
      expect(result.covered).toEqual([]);
    } finally {
      await rmdir(link).catch(() => unlink(link).catch(() => undefined));
    }
  });

  it('finds nothing in an empty directory without failing', async () => {
    const dir = await makeTree({ 'README.md': 'x' });
    const result = await discoverProjects(dir);
    expect(result).toMatchObject({ projects: [], covered: [], candidates: [], warnings: [] });
  });
});
