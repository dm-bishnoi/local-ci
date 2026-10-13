import { afterEach, describe, expect, it } from 'vitest';
import { localCiConfigSchema, type LocalCiConfig } from '../../src/config/schema.js';
import { blockingDiagnostics, buildDiagnosticReport, type Diagnostic } from '../../src/diagnostics/types.js';
import { ecosystemDiagnostics } from '../../src/ecosystems/diagnostics.js';
import { planProjects, qualifiedPipeline, usesEcosystemPath } from '../../src/ecosystems/plan.js';
import type { ProbeResult } from '../../src/env/tools.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

function config(input: unknown): LocalCiConfig {
  return localCiConfigSchema.parse(input);
}

const ok = (version = '1.0.0'): ProbeResult => ({ outcome: 'ok', version, detail: version });
const missing = (name: string): ProbeResult => ({ outcome: 'missing', detail: `${name} was not found on PATH.` });
const denied: ProbeResult = { outcome: 'blocked', detail: 'could not be checked: process execution was blocked (EPERM).' };

const PKG = { name: 'x', private: true, scripts: { build: 'echo build', test: 'echo test' } };

async function diagnose(
  files: Record<string, string | object>,
  cfg: unknown,
  probe: (name: string) => Promise<ProbeResult>,
): Promise<Diagnostic[]> {
  const dir = await makeTree(files);
  const parsed = config(cfg);
  const plans = await planProjects(dir, parsed);
  return ecosystemDiagnostics(plans, parsed, {}, { probe });
}

describe('severity -> step fate mapping', () => {
  const files = {
    'web/package.json': PKG,
    'web/package-lock.json': '{}',
    'api/package.json': PKG,
    'api/package-lock.json': '{}',
  };
  const cfg = {
    version: 1,
    projects: [
      { name: 'web', type: 'node', path: 'web', pipeline: ['build'] },
      { name: 'api', type: 'node', path: 'api', pipeline: ['build'] },
    ],
  };

  it('PASS probes block nothing', async () => {
    const diagnostics = await diagnose(files, cfg, async () => ok('10.0.0'));
    expect(blockingDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.find((d) => d.id === 'project:web:tool:npm')).toMatchObject({ severity: 'PASS', steps: ['web.build'] });
  });

  it('UNKNOWN (probe not permitted) does not block: the step is allowed to run', async () => {
    const diagnostics = await diagnose(files, cfg, async () => denied);
    const unknown = diagnostics.filter((d) => d.severity === 'UNKNOWN');
    expect(unknown.length).toBe(2);
    expect(blockingDiagnostics(diagnostics, 'web.build')).toEqual([]);
    expect(blockingDiagnostics(diagnostics, 'api.build')).toEqual([]);
    // ...but it is never reported as a clean pass.
    expect(buildDiagnosticReport('preflight', diagnostics).verdict).toBe('WARNING');
  });

  it('a missing tool BLOCKS only the project that needs it', async () => {
    const dir = await makeTree({
      'web/package.json': PKG,
      'web/pnpm-lock.yaml': 'x',
      'api/package.json': PKG,
      'api/package-lock.json': '{}',
    });
    const parsed = config(cfg);
    const plans = await planProjects(dir, parsed);
    const diagnostics = await ecosystemDiagnostics(plans, parsed, {}, { probe: async (name) => (name === 'pnpm' ? missing('pnpm') : ok()) });

    expect(blockingDiagnostics(diagnostics, 'web.build')).toHaveLength(1);
    expect(blockingDiagnostics(diagnostics, 'web.build')[0]?.detail).toMatch(/needs pnpm/);
    expect(blockingDiagnostics(diagnostics, 'api.build')).toEqual([]);
    expect(buildDiagnosticReport('preflight', diagnostics).verdict).toBe('BLOCKED');
  });

  it('UNSUPPORTED findings do not block, but are not a clean pass either', async () => {
    const diagnostics = await diagnose(files, { ...cfg, projects: [{ name: 'web', type: 'node', path: 'web', pipeline: ['lint'] }] }, async () => ok());
    const finding = diagnostics.find((d) => d.id === 'project:web:step:lint');
    expect(finding).toMatchObject({ severity: 'UNSUPPORTED', steps: ['web.lint'] });
    expect(blockingDiagnostics(diagnostics, 'web.lint')).toEqual([]);
    expect(buildDiagnosticReport('preflight', diagnostics).verdict).toBe('WARNING');
  });
});

describe('dependencies and install ordering', () => {
  const withDeps = { ...PKG, dependencies: { left_pad: '1.0.0' } };

  it('missing node_modules blocks a step with no earlier install', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': withDeps, 'p/package-lock.json': '{}' },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['build'] }] },
      async () => ok(),
    );
    expect(blockingDiagnostics(diagnostics, 'p.build')[0]?.detail).toMatch(/no earlier install step/);
  });

  it('an earlier install step turns it into a warning', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': withDeps, 'p/package-lock.json': '{}' },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['install', 'build'] }] },
      async () => ok(),
    );
    expect(blockingDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.find((d) => d.id === 'project:p:deps:build')?.severity).toBe('WARNING');
  });

  it('an install AFTER the step does not help', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': withDeps, 'p/package-lock.json': '{}' },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['build', 'install'] }] },
      async () => ok(),
    );
    expect(blockingDiagnostics(diagnostics, 'p.build')).toHaveLength(1);
  });

  it('a project that declares no dependencies needs no node_modules', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': PKG, 'p/package-lock.json': '{}' },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['build'] }] },
      async () => ok(),
    );
    expect(blockingDiagnostics(diagnostics)).toEqual([]);
  });

  it('install without a lockfile is blocked rather than creating one', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': PKG },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['install'] }] },
      async () => ok(),
    );
    const blockers = blockingDiagnostics(diagnostics, 'p.install');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.detail).toMatch(/No lockfile/);
  });

  it('a hoisted workspace node_modules satisfies a member project', async () => {
    const dir = await makeTree({
      'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
      'package-lock.json': '{}',
      'node_modules/left_pad/index.js': '',
      'packages/a/package.json': withDeps,
    });
    const parsed = config({ version: 1, projects: [{ name: 'a', type: 'node', path: 'packages/a', pipeline: ['build'] }] });
    const plans = await planProjects(dir, parsed);
    expect(plans[0]?.dependenciesOnDisk).toBe(true);
    const diagnostics = await ecosystemDiagnostics(plans, parsed, {}, { probe: async () => ok() });
    expect(blockingDiagnostics(diagnostics)).toEqual([]);
  });
});

describe('engines.node per project', () => {
  it('blocks only the project whose engines requirement is violated', async () => {
    const diagnostics = await diagnose(
      {
        'old/package.json': { ...PKG, engines: { node: '<=8' } },
        'old/package-lock.json': '{}',
        'new/package.json': { ...PKG, engines: { node: '>=18' } },
        'new/package-lock.json': '{}',
      },
      {
        version: 1,
        projects: [
          { name: 'old', type: 'node', path: 'old', pipeline: ['build'] },
          { name: 'new', type: 'node', path: 'new', pipeline: ['build'] },
        ],
      },
      async () => ok(),
    );
    expect(blockingDiagnostics(diagnostics, 'old.build')[0]?.detail).toMatch(/does not satisfy <=8/);
    expect(blockingDiagnostics(diagnostics, 'new.build')).toEqual([]);
  });
});

describe('unrecognised and mismatched projects', () => {
  it('an unrecognised type in a projects list warns and has no built-in steps', async () => {
    const diagnostics = await diagnose(
      { 'p/package.json': PKG, 'p/package-lock.json': '{}' },
      { version: 1, projects: [{ name: 'p', type: 'custom-thing', path: 'p', pipeline: ['build'] }] },
      async () => ok(),
    );
    expect(diagnostics.find((d) => d.id === 'project:p:type')?.severity).toBe('WARNING');
    expect(diagnostics.find((d) => d.id === 'project:p:step:build')?.severity).toBe('UNSUPPORTED');
  });

  it('a project that is not what its type claims blocks all of its own steps', async () => {
    const diagnostics = await diagnose(
      { 'p/README.md': 'x' },
      { version: 1, projects: [{ name: 'p', type: 'node', path: 'p', pipeline: ['build', 'test'] }] },
      async () => ok(),
    );
    const blockers = blockingDiagnostics(diagnostics);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.steps).toEqual(['p.build', 'p.test']);
  });
});

describe('path selection rules', () => {
  it('angular single-project configs keep the original path; others use the adapters', () => {
    const single = (type: string, path?: string): LocalCiConfig =>
      config({ version: 1, project: { type, ...(path ? { path } : {}) }, pipeline: ['build'] });
    expect(usesEcosystemPath(single('angular'))).toBe(false);
    expect(usesEcosystemPath(single('Angular'))).toBe(false);
    expect(usesEcosystemPath(single('custom-thing'))).toBe(false);
    expect(usesEcosystemPath(single('node'))).toBe(true);
    expect(usesEcosystemPath(single('react'))).toBe(true);
    expect(usesEcosystemPath(single('angular', 'apps/web'))).toBe(true);
    expect(usesEcosystemPath(config({ version: 1, projects: [{ name: 'a', type: 'node', pipeline: ['x'] }] }))).toBe(true);
  });

  it('qualifiedPipeline prefixes only named projects', async () => {
    const dir = await makeTree({ 'package.json': PKG });
    const named = await planProjects(dir, config({ version: 1, projects: [{ name: 'a', type: 'node', pipeline: ['build'] }] }));
    const bare = await planProjects(dir, config({ version: 1, project: { type: 'node' }, pipeline: ['build'] }));
    expect(qualifiedPipeline(named[0]!)).toEqual(['a.build']);
    expect(qualifiedPipeline(bare[0]!)).toEqual(['build']);
  });
});
