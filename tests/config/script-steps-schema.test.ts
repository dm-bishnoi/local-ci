/**
 * F-3: the `steps` section. A script step is a package.json script name and an
 * optional timeout, nothing else; anything malformed is rejected with the
 * location of the problem rather than ignored or half-accepted.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/loader.js';
import { MAX_TIMEOUT_MS, localCiConfigSchema, withEffectiveDefaults } from '../../src/config/schema.js';
import { withTempProject } from '../helpers/reports.js';

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, project: { type: 'node' }, pipeline: ['lint', 'e2e'], ...overrides };
}

function issuesFor(input: unknown): Array<{ path: string; message: string }> {
  const result = localCiConfigSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('steps: valid configurations', () => {
  it('accepts script steps with and without a timeout', () => {
    const result = localCiConfigSchema.safeParse(
      config({ steps: { lint: { script: 'lint' }, e2e: { script: 'test:e2e', timeoutMs: 600_000 } } }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps?.['lint']).toEqual({ script: 'lint' });
      expect(result.data.steps?.['e2e']).toEqual({ script: 'test:e2e', timeoutMs: 600_000 });
    }
  });

  it('keeps `steps` optional, and empty is fine', () => {
    expect(localCiConfigSchema.safeParse(config()).success).toBe(true);
    expect(localCiConfigSchema.safeParse(config({ steps: {} })).success).toBe(true);
  });

  it.each(['lint', 'test:e2e', 'build.prod', 'ci_lint', 'lint-fix', 'a/b', 'A1', 'x'.repeat(128)])(
    'accepts the script name %j',
    (script) => {
      expect(localCiConfigSchema.safeParse(config({ steps: { lint: { script } } })).success).toBe(true);
    },
  );

  it('does not change a configuration without steps when defaults are applied', () => {
    const parsed = localCiConfigSchema.parse(config());
    expect(withEffectiveDefaults(parsed).steps).toBeUndefined();
  });

  it('carries steps through when defaults are applied', () => {
    const parsed = localCiConfigSchema.parse(config({ steps: { lint: { script: 'lint' } } }));
    expect(withEffectiveDefaults(parsed).steps).toEqual({ lint: { script: 'lint' } });
  });
});

describe('steps: rejected configurations', () => {
  it.each([
    ['an empty name', ''],
    ['a leading dash (option injection)', '--help'],
    ['a single leading dash', '-r'],
    ['a space', 'lint fix'],
    ['a leading space', ' lint'],
    ['a trailing newline', 'lint\n'],
    ['a semicolon', 'lint;rm -rf /'],
    ['an ampersand', 'lint&&echo'],
    ['a pipe', 'lint|cat'],
    ['command substitution', '$(whoami)'],
    ['a variable', '$HOME'],
    ['backticks', '`id`'],
    ['a redirect', 'lint>out'],
    ['quotes', '"lint"'],
    ['a backslash', 'a\\b'],
    ['a parent segment', 'a/../b'],
    ['a leading dot', '.hidden'],
    ['a leading colon', ':lint'],
    ['a name longer than 128 characters', 'x'.repeat(129)],
    ['a null byte', 'lint\0'],
    ['a prototype key', '__proto__'],
  ])('rejects a script name with %s', (_why, script) => {
    const issues = issuesFor(config({ steps: { lint: { script } } }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe('steps.lint.script');
  });

  it('rejects a step without a script', () => {
    const issues = issuesFor(config({ steps: { lint: {} } }));
    expect(issues.map((issue) => issue.path)).toContain('steps.lint.script');
  });

  it.each([
    ['command', { script: 'lint', command: 'rm' }],
    ['args', { script: 'lint', args: ['--fix'] }],
    ['env', { script: 'lint', env: { A: 'b' } }],
    ['cwd', { script: 'lint', cwd: '..' }],
    ['a misspelled timeout', { script: 'lint', timeoutms: 5 }],
  ])('rejects an unsupported key (%s) and names it', (_why, step) => {
    const result = localCiConfigSchema.safeParse(config({ steps: { lint: step } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.find((issue) => issue.code === 'unrecognized_keys');
      expect(unrecognized?.path.join('.')).toBe('steps.lint');
    }
  });

  it.each([0, -1, 1.5, MAX_TIMEOUT_MS + 1, '30', null])('rejects the step timeout %j', (timeoutMs) => {
    expect(issuesFor(config({ steps: { lint: { script: 'lint', timeoutMs } } })).length).toBeGreaterThan(0);
  });

  it.each([
    ['a string', 'lint'],
    ['a list', [{ script: 'lint' }]],
    ['a number', 3],
    ['null', null],
  ])('rejects `steps` as %s', (_what, steps) => {
    expect(issuesFor(config({ steps })).length).toBeGreaterThan(0);
  });

  it('rejects a step entry that is not an object', () => {
    expect(issuesFor(config({ steps: { lint: 'lint' } })).length).toBeGreaterThan(0);
    expect(issuesFor(config({ steps: { lint: null } })).length).toBeGreaterThan(0);
  });

  it('rejects a step id that is not a valid pipeline id', () => {
    expect(issuesFor(config({ pipeline: ['lint'], steps: { 'bad id': { script: 'lint' } } })).length).toBeGreaterThan(0);
    expect(issuesFor(config({ pipeline: ['lint'], steps: { '': { script: 'lint' } } })).length).toBeGreaterThan(0);
  });

  it('rejects a step that is defined but not in the pipeline, naming it', () => {
    const issues = issuesFor(config({ steps: { lntt: { script: 'lint' } } }));
    expect(issues).toEqual([
      { path: 'steps.lntt', message: 'defines step "lntt", which is not listed in pipeline' },
    ]);
  });

  it('reports every problem at once', () => {
    const issues = issuesFor(
      config({ steps: { lint: { script: '--help' }, nope: { script: 'x' }, e2e: { script: 'e2e', timeoutMs: -1 } } }),
    );
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['steps.lint.script', 'steps.e2e.timeoutMs']));
  });

  it('surfaces a readable message through the loader', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(
        join(cwd, '.local-ci.yml'),
        'version: 1\nproject:\n  type: node\npipeline:\n  - lint\nsteps:\n  lint:\n    script: "--help"\n    args: [x]\n',
        'utf8',
      );
      const error = await loadConfig(cwd).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain('steps.lint.script');
      expect(message).toContain('steps.lint');
      expect(message).toContain('args');
    });
  });
});
