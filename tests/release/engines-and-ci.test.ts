/**
 * F-7 regression: the Node floor package.json advertises is one every runtime
 * dependency actually supports, the lockfile agrees with it, and CI covers
 * Windows, macOS and Linux plus that exact floor version.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { satisfies } from '../../src/env/semver.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: { node: string };
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { engines?: { node?: string } }>;
};
const workflow = parse(readFileSync('.github/workflows/verify-linux-process-tree.yml', 'utf8')) as {
  jobs: Record<string, { strategy?: { matrix?: Record<string, unknown> }; steps: Array<{ with?: Record<string, unknown> }> }>;
};

const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(pkg.engines.node)?.[1];

describe('Node engine floor', () => {
  it('is an exact lower bound', () => {
    expect(floor, `engines.node must look like ">=x.y.z", got "${pkg.engines.node}"`).toBeDefined();
  });

  it('matches the lockfile root metadata', () => {
    expect(lock.packages['']?.engines?.node).toBe(pkg.engines.node);
  });

  it.each(Object.keys(pkg.dependencies))('is supported by runtime dependency %s', (name) => {
    // Read from disk: several packages do not export "./package.json".
    const manifest = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    const range = manifest.engines?.node;
    if (range === undefined) return;
    expect(satisfies(floor ?? '0.0.0', range).verdict, `${name} requires node ${range}`).toBe('satisfied');
  });
});

describe('CI coverage', () => {
  it('runs the full verification on Windows, macOS and Linux', () => {
    const os = workflow.jobs['verify']?.strategy?.matrix?.['os'];
    expect(os).toEqual(expect.arrayContaining(['ubuntu-latest', 'windows-latest', 'macos-latest']));
  });

  it('smoke-tests the packed CLI on exactly the advertised floor', () => {
    const versions = (workflow.jobs['engine-floor']?.steps ?? [])
      .map((step) => step.with?.['node-version'])
      .filter((version) => version !== undefined)
      .map(String);
    expect(versions).toContain(floor);
  });
});
