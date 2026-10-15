import { mkdir, rmdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeProjects, qualifyStepId, resolveProjectDir } from '../../src/config/projects.js';
import { localCiConfigSchema, type LocalCiConfig } from '../../src/config/schema.js';
import { unrecognisedTypeWarning } from '../../src/ecosystems/registry.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

function parse(input: unknown): { ok: true; data: LocalCiConfig } | { ok: false; issues: string[] } {
  const result = localCiConfigSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

describe('single-project form is unchanged', () => {
  it('parses to exactly the same shape as 0.2.x', () => {
    const result = parse({ version: 1, project: { type: 'angular' }, pipeline: ['install', 'build'], settings: { failFast: true } });
    expect(result).toEqual({
      ok: true,
      data: { version: 1, project: { type: 'angular' }, pipeline: ['install', 'build'], settings: { failFast: true } },
    });
  });

  it('still requires a pipeline', () => {
    const result = parse({ version: 1, project: { type: 'angular' } });
    expect(result.ok).toBe(false);
  });

  it('still rejects a step definition that is not in the pipeline', () => {
    const result = parse({ version: 1, project: { type: 'angular' }, pipeline: ['build'], steps: { lint: { script: 'lint' } } });
    expect(result).toMatchObject({ ok: false });
  });

  it('keeps accepting any project.type string (legacy policy)', () => {
    for (const type of ['angular', 'ANGULAR', 'custom-thing', 'monolith']) {
      expect(parse({ version: 1, project: { type }, pipeline: ['build'] }).ok, type).toBe(true);
    }
  });

  it('rejects unknown keys at every level', () => {
    expect(parse({ version: 1, project: { type: 'a', extra: 1 }, pipeline: ['b'] }).ok).toBe(false);
    expect(parse({ version: 1, project: { type: 'a' }, pipeline: ['b'], extra: 1 }).ok).toBe(false);
  });
});

describe('projects form', () => {
  const multi = {
    version: 1,
    projects: [
      { name: 'web', type: 'react', path: 'apps/web', pipeline: ['install', 'build'], steps: { build: { script: 'compile' } } },
      { name: 'api', type: 'dotnet', path: 'services/api', pipeline: ['restore', 'test'] },
    ],
  };

  it('flattens to qualified ids so the runner needs no changes', () => {
    const result = parse(multi);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pipeline).toEqual(['web.install', 'web.build', 'api.restore', 'api.test']);
    expect(result.data.steps).toEqual({ 'web.build': { script: 'compile' } });
    expect(result.data.project.type).toBe('multi');
  });

  it('normalizeProjects returns bare ids and names', () => {
    const result = parse(multi);
    if (!result.ok) throw new Error('unexpected');
    const projects = normalizeProjects(result.data);
    expect(projects.map((p) => [p.name, p.type, p.path, p.pipeline])).toEqual([
      ['web', 'react', 'apps/web', ['install', 'build']],
      ['api', 'dotnet', 'services/api', ['restore', 'test']],
    ]);
    expect(qualifyStepId('web', 'build')).toBe('web.build');
    expect(qualifyStepId(null, 'build')).toBe('build');
  });

  it('normalizeProjects of the single form keeps bare ids and path "."', () => {
    const result = parse({ version: 1, project: { type: 'angular' }, pipeline: ['build'] });
    if (!result.ok) throw new Error('unexpected');
    expect(normalizeProjects(result.data)).toEqual([{ name: null, type: 'angular', path: '.', pipeline: ['build'], steps: {} }]);
  });

  it('rejects project and projects together, and neither', () => {
    expect(parse({ ...multi, project: { type: 'x' } })).toMatchObject({ ok: false });
    expect(parse({ version: 1, pipeline: ['a'] })).toMatchObject({ ok: false });
  });

  it('rejects a top-level pipeline or steps next to projects', () => {
    expect(parse({ ...multi, pipeline: ['a'] })).toMatchObject({ ok: false });
    expect(parse({ ...multi, steps: { a: { script: 'a' } } })).toMatchObject({ ok: false });
  });

  it('rejects duplicate names, bad names and dotted step ids', () => {
    const dup = parse({ version: 1, projects: [multi.projects[0], { ...multi.projects[1], name: 'web' }] });
    expect(dup).toMatchObject({ ok: false });
    expect(parse({ version: 1, projects: [{ name: 'a.b', type: 'node', pipeline: ['x'] }] }).ok).toBe(false);
    expect(parse({ version: 1, projects: [{ name: 'a b', type: 'node', pipeline: ['x'] }] }).ok).toBe(false);
    expect(parse({ version: 1, projects: [{ name: 'a', type: 'node', pipeline: ['x.y'] }] }).ok).toBe(false);
  });

  it('rejects a project step definition missing from that project pipeline', () => {
    const result = parse({
      version: 1,
      projects: [{ name: 'a', type: 'node', pipeline: ['build'], steps: { lint: { script: 'lint' } } }],
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe('project paths are lexically contained', () => {
  const bad = ['/etc', '\\\\server\\share', 'C:\\x', 'C:/x', '../x', 'a/../../x', 'a\\..\\x'];
  for (const path of bad) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(parse({ version: 1, project: { type: 'node', path }, pipeline: ['b'] }).ok).toBe(false);
      expect(parse({ version: 1, projects: [{ name: 'a', type: 'node', path, pipeline: ['b'] }] }).ok).toBe(false);
    });
  }

  it('accepts nested relative paths', () => {
    expect(parse({ version: 1, project: { type: 'node', path: 'apps/web' }, pipeline: ['b'] }).ok).toBe(true);
    expect(parse({ version: 1, project: { type: 'node', path: './apps/web' }, pipeline: ['b'] }).ok).toBe(true);
  });
});

describe('resolveProjectDir (real-path containment)', () => {
  it('accepts an existing directory inside the root', async () => {
    const root = await makeTree({ 'apps/web/package.json': '{}' });
    const result = await resolveProjectDir(root, 'apps/web');
    expect(result.ok).toBe(true);
  });

  it('rejects a missing directory and a file', async () => {
    const root = await makeTree({ 'file.txt': 'x' });
    expect(await resolveProjectDir(root, 'nope')).toMatchObject({ ok: false });
    expect(await resolveProjectDir(root, 'file.txt')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a directory/) });
  });

  it('rejects a symlink/junction that escapes the root', async () => {
    const outside = await makeTree({ 'secret.txt': 'x' });
    const root = await makeTree({});
    await mkdir(join(root, 'apps'), { recursive: true });
    try {
      // 'junction' works without elevation on Windows and is ignored elsewhere.
      await symlink(outside, join(root, 'apps', 'link'), 'junction');
    } catch {
      return; // cannot create links in this environment; nothing to assert
    }
    try {
      const result = await resolveProjectDir(root, 'apps/link');
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the repository/) });
    } finally {
      // Remove the junction itself so cleanup never follows it.
      await rmdir(join(root, 'apps', 'link')).catch(() => unlink(join(root, 'apps', 'link')).catch(() => undefined));
    }
  });
});

describe('legacy project.type policy', () => {
  it('recognised types and the multi sentinel produce no warning', () => {
    for (const type of ['angular', 'Angular', 'react', 'node', 'multi']) expect(unrecognisedTypeWarning(type), type).toBeNull();
  });

  it('an unrecognised type produces a warning naming the known types', () => {
    const warning = unrecognisedTypeWarning('custom-thing');
    expect(warning).toMatch(/custom-thing/);
    expect(warning).toMatch(/only "steps:" entries will run/);
    expect(warning).toMatch(/angular/);
  });
});
