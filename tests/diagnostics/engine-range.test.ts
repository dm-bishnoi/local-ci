/**
 * F-13 regression at the diagnostics level: whether preflight blocks must
 * depend on the declared Node range, never on how it is spaced.
 *
 * Before the fix, `engines.node: ">= 18"` was read as ">=" plus an exact match
 * for "18", so a compatible runtime was reported BLOCKED and `run` refused to
 * start.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { CHROME_FOUND, HEALTHY_ANGULAR, writeProject } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';

const options = { skipToolProbes: true as const, browsers: CHROME_FOUND };
const running = process.versions.node;
const major = Number(running.split('.')[0]);

async function nodeSeverity(enginesNode: string | undefined, nvmrc?: string): Promise<string | undefined> {
  return withTempProject(async (cwd) => {
    const { engines: _engines, ...withoutEngines } = HEALTHY_ANGULAR.packageJson as Record<string, unknown>;
    await writeProject(cwd, {
      ...HEALTHY_ANGULAR,
      packageJson: enginesNode === undefined ? withoutEngines : { ...withoutEngines, engines: { node: enginesNode } },
    });
    if (nvmrc !== undefined) await writeFile(join(cwd, '.nvmrc'), `${nvmrc}\n`, 'utf8');
    const diagnostics = await runPreflightChecks(cwd, options);
    return diagnostics.find((diagnostic) => diagnostic.id === 'node-version')?.severity;
  });
}

describe('preflight: engines.node spacing (F-13)', () => {
  it.each([
    '>= 18',
    '>=18',
    '>= 18.0.0',
    '>=20.5.0',
    '>= 20.5.0',
    `>= ${major}`,
    `>= ${running}`,
    `^${major}.0.0`,
    `>= ${major - 1} < ${major + 1}`,
    `>=${major - 1} <${major + 1}`,
    `>= ${major - 1}, < ${major + 1}`,
    `^${major - 2}.0.0 || >= ${major}`,
    `${major}.x`,
  ])('does not block a compatible runtime for %j', async (range) => {
    expect(await nodeSeverity(range)).toBe('PASS');
  });

  it.each([
    `>= ${major + 1}`,
    `>=${major + 1}`,
    `>= ${major + 1} < ${major + 5}`,
    `^${major + 1}.0.0`,
    `< ${major}`,
    '<1.0.0',
  ])('still blocks an incompatible runtime for %j', async (range) => {
    expect(await nodeSeverity(range)).toBe('BLOCKED');
  });

  it('blocks a compound range the runtime is above, not satisfied by its first token', async () => {
    // Node 22+ against ">=18 <21" used to pass because ">=18" alone was enough.
    expect(await nodeSeverity(`>=${major - 5} <${major - 1}`)).toBe('BLOCKED');
  });

  it.each(['ancient-magic', '>=', '18 - 20', 'lts/*'])('reports UNKNOWN, not PASS or BLOCKED, for %j', async (range) => {
    expect(await nodeSeverity(range)).toBe('UNKNOWN');
  });

  it('applies the same rules to .nvmrc when engines is absent', async () => {
    expect(await nodeSeverity(undefined, `>= ${major}`)).toBe('PASS');
    expect(await nodeSeverity(undefined, `>= ${major + 1}`)).toBe('BLOCKED');
    expect(await nodeSeverity(undefined, `v${running}`)).toBe('PASS');
  });

  it('lets engines.node win over .nvmrc', async () => {
    expect(await nodeSeverity(`>= ${major}`, `${major + 5}`)).toBe('PASS');
  });
});
