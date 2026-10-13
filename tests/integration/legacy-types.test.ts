/**
 * Backward compatibility of `project.type`: configurations written for 0.2.x
 * keep loading and keep behaving the same way, whatever they put in `type`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { validateCommand } from '../../src/cli/commands/validate.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';
import { writeTree } from '../helpers/tree.js';

const options = { skipToolProbes: true, browsers: NO_BROWSERS };
const node = (code: string): string => `node -e "${code}"`;

interface Report {
  steps: Array<{ id: string; name: string; status: string; command?: string; stdout: string }>;
}

async function lastReport(cwd: string): Promise<Report> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = (await readdir(base)).sort().reverse();
  return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as Report;
}

async function fixture(cwd: string, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeTree(cwd, {
    '.local-ci.yml': `version: 1\nproject:\n  type: ${type}\npipeline:\n  - build\n`,
    'package.json': {
      name: 'legacy',
      private: true,
      scripts: { build: node("console.log('built')") },
      dependencies: { '@angular/core': '^19.0.0' },
      ...extra,
    },
    'package-lock.json': '{}',
    'node_modules/placeholder/package.json': '{}',
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('project.type is case-insensitive for angular, as in 0.2.x', () => {
  const results: Record<string, unknown> = {};

  for (const type of ['angular', 'Angular', 'ANGULAR']) {
    it(`type: ${type} runs the Angular adapter`, async () => {
      await withTempProject(async (cwd) => {
        await fixture(cwd, type);
        expect(await runCommand(cwd, options)).toBe(0);
        const step = (await lastReport(cwd)).steps[0]!;
        results[type] = { id: step.id, name: step.name, status: step.status, command: step.command };
        expect(step).toMatchObject({ id: 'build', name: 'Production Build', status: 'PASS', command: 'npm run build' });
      });
    }, 60_000);
  }

  it('all three spellings produce identical results', () => {
    expect(results['Angular']).toEqual(results['angular']);
    expect(results['ANGULAR']).toEqual(results['angular']);
  });
});

describe('recognised and unrecognised types', () => {
  it('a recognised non-Angular type (react) runs scripted steps through the adapter', async () => {
    await withTempProject(async (cwd) => {
      await fixture(cwd, 'react', { dependencies: { react: '^19.0.0' } });
      expect(await runCommand(cwd, options)).toBe(0);
      expect((await lastReport(cwd)).steps[0]).toMatchObject({ id: 'build', status: 'PASS', command: 'npm run build' });
    });
  }, 60_000);

  it('an unrecognised type still loads, validates with a warning, and only runs steps: entries', async () => {
    await withTempProject(async (cwd) => {
      await fixture(cwd, 'custom-thing');
      await validateCommand(cwd);
      expect(vi.mocked(console.warn).mock.calls.join('\n')).toMatch(/"custom-thing" is not a recognised ecosystem/);

      expect(await runCommand(cwd, options)).toBe(1);
      expect((await lastReport(cwd)).steps[0]).toMatchObject({ id: 'build', status: 'UNSUPPORTED' });
    });
  }, 60_000);

  it('a recognised type validates without a warning', async () => {
    await withTempProject(async (cwd) => {
      await fixture(cwd, 'react');
      await validateCommand(cwd);
      expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    });
  });

  it('the shipped template and the engine-floor fixture config still validate', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': await readFile(join(process.cwd(), 'templates', 'local-ci.yml'), 'utf8'),
        'package.json': { name: 'x' },
      });
      await validateCommand(cwd);
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n  - test\n',
      });
      await validateCommand(cwd);
      expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    });
  });
});
