/**
 * `doctor` for adapter-driven configurations: what each project could run, and
 * which projects in the repository the configuration does not cover.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { runDoctorChecks } from '../../src/diagnostics/doctor.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

// These tests scan real directories with every adapter and take well under a second
// alone, but a loaded machine running the whole suite in parallel has been measured
// at 5 s+ for them, which is the default limit. The limit is for headroom, not for
// slow code: nothing here waits on a process.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanupTrees);

const PKG = { name: 'x', private: true, scripts: { build: 'echo', test: 'echo' } };
const options = { skipToolProbes: true, browsers: NO_BROWSERS };
const byId = (diagnostics: Awaited<ReturnType<typeof runDoctorChecks>>, id: string) => diagnostics.find((d) => d.id === id);

describe('capability summary', () => {
  it('lists, per project, what can run and from what evidence, and what cannot and why', async () => {
    const dir = await makeTree({
      '.local-ci.yml': 'version: 1\nprojects:\n  - name: web\n    type: react\n    path: web\n    pipeline: [build]\n  - name: svc\n    type: go\n    path: svc\n    pipeline: [test]\n',
      'web/package.json': { ...PKG, dependencies: { react: '19' }, devDependencies: { eslint: '9' } },
      'web/package-lock.json': '{}',
      'web/eslint.config.js': '',
      'web/node_modules/react/index.js': '',
      'svc/go.mod': 'module svc\n\ngo 1.21\n',
    });
    const diagnostics = await runDoctorChecks(dir, options);

    const web = byId(diagnostics, 'project:web:capabilities');
    expect(web?.severity).toBe('PASS');
    expect(web?.detail).toMatch(/Available: .*build \(script: package\.json script "build"\)/);
    expect(web?.detail).toMatch(/lint \(inferred: eslint declared \+ eslint\.config\.js\)/);
    expect(web?.detail).toMatch(/Not available: .*format \(No "format:check" script/);

    const svc = byId(diagnostics, 'project:svc:capabilities');
    expect(svc?.detail).toMatch(/Available: format \(builtin: go\.mod\); vet \(builtin: go\.mod\); test \(builtin: go\.mod\); build \(builtin: go\.mod\)\./);
  });

  it('is part of doctor only, not of preflight', async () => {
    const { runPreflightChecks } = await import('../../src/diagnostics/preflight.js');
    const dir = await makeTree({
      '.local-ci.yml': 'version: 1\nprojects:\n  - name: web\n    type: node\n    path: web\n    pipeline: [build]\n',
      'web/package.json': PKG,
    });
    expect(byId(await runPreflightChecks(dir, options), 'project:web:capabilities')).toBeUndefined();
    expect(byId(await runDoctorChecks(dir, options), 'project:web:capabilities')).toBeDefined();
  });
});

describe('projects the configuration does not cover are mentioned, not silently absent', () => {
  const config = 'version: 1\nprojects:\n  - name: web\n    type: node\n    path: apps/web\n    pipeline: [build]\n';

  it('warns about unconfigured projects, naming path and type, and how to add them', async () => {
    const dir = await makeTree({
      '.local-ci.yml': config,
      'apps/web/package.json': PKG,
      'apps/api/package.json': PKG,
      'services/ml/pyproject.toml': '[project]\nname = "ml"\n',
    });
    const diagnostics = await runDoctorChecks(dir, options);
    const finding = byId(diagnostics, 'discovery:unconfigured');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.detail).toContain('apps/api (node)');
    expect(finding?.detail).toContain('services/ml (python)');
    expect(finding?.detail).not.toContain('apps/web');
    expect(finding?.recommendation).toMatch(/init --all --dry-run/);
  });

  it('says nothing when every project is covered', async () => {
    const dir = await makeTree({ '.local-ci.yml': config, 'apps/web/package.json': PKG });
    const diagnostics = await runDoctorChecks(dir, options);
    expect(diagnostics.some((d) => d.id.startsWith('discovery:'))).toBe(false);
  });

  it('a different ecosystem at the same path is a separate project', async () => {
    const dir = await makeTree({
      '.local-ci.yml': config,
      'apps/web/package.json': PKG,
      'apps/web/pyproject.toml': '[project]\nname = "w"\n',
    });
    expect(byId(await runDoctorChecks(dir, options), 'discovery:unconfigured')?.detail).toContain('apps/web (python)');
  });

  it('reports what the depth limit hid', async () => {
    const dir = await makeTree({ '.local-ci.yml': config, 'apps/web/package.json': PKG, 'a/b/c/d/package.json': PKG });
    const finding = byId(await runDoctorChecks(dir, options), 'discovery:depth');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.detail).toContain('"a/b/c"');
  });

  it('surfaces unsupported workspace patterns', async () => {
    const dir = await makeTree({
      '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [build]\n',
      'package.json': { ...PKG, workspaces: ['packages/{a,b}'] },
    });
    expect(byId(await runDoctorChecks(dir, options), 'discovery:note:1')?.detail).toMatch(/cannot expand/);
  });

  it('the original single-project path also learns about extra projects', async () => {
    const dir = await makeTree({
      '.local-ci.yml': 'version: 1\nproject:\n  type: angular\npipeline: [build]\n',
      'angular.json': '{}',
      'package.json': { ...PKG, dependencies: { '@angular/core': '19' } },
      'tools/gen/package.json': PKG,
    });
    const finding = byId(await runDoctorChecks(dir, options), 'discovery:unconfigured');
    expect(finding?.detail).toContain('tools/gen (node)');
    expect(finding?.detail).not.toContain('. (');
  });

  it('an unrecognised project type covers its path whatever is found there', async () => {
    const dir = await makeTree({
      '.local-ci.yml': 'version: 1\nproject:\n  type: custom-thing\npipeline: [build]\n',
      'package.json': PKG,
    });
    expect(byId(await runDoctorChecks(dir, options), 'discovery:unconfigured')).toBeUndefined();
  });

  it('is only a warning: doctor still exits 0 when the rest is healthy', async () => {
    const dir = await makeTree({
      '.local-ci.yml': config,
      'apps/web/package.json': PKG,
      'apps/web/package-lock.json': '{}',
      'apps/api/package.json': PKG,
    });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(' '));
    try {
      expect(await doctorCommand(dir, options)).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs.join('\n')).toMatch(/Projects not in the configuration/);
  });
});
