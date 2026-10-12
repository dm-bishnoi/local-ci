/**
 * F-4 regression: unknown configuration keys are rejected with their path,
 * and `run` never executes a step without a time limit.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { validateCommand } from '../../src/cli/commands/validate.js';
import { ConfigError, loadConfig } from '../../src/config/loader.js';
import {
  DEFAULT_TIMEOUT_MS,
  effectiveTimeoutMs,
  localCiConfigSchema,
  withEffectiveDefaults,
} from '../../src/config/schema.js';
import { PipelineRunner } from '../../src/core/pipeline-runner.js';
import { NO_BROWSERS, writeProject } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';

const BASE = { version: 1, project: { type: 'angular' }, pipeline: ['build'] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unknown configuration keys (F-4)', () => {
  it.each([
    ['root', { ...BASE, pipline: ['test'] }],
    ['settings', { ...BASE, settings: { failfast: true } }],
    ['settings', { ...BASE, settings: { timeout: 1000 } }],
    ['project', { ...BASE, project: { type: 'angular', name: 'x' } }],
    ['environment', { ...BASE, environment: { required: ['A'] } }],
    ['environment.variables', { ...BASE, environment: { variables: { requried: ['A'] } } }],
  ])('rejects an unknown key under %s', (_where, config) => {
    const result = localCiConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('still accepts every documented key', () => {
    const result = localCiConfigSchema.safeParse({
      ...BASE,
      settings: { failFast: true, timeoutMs: 60_000 },
      environment: { variables: { required: ['API_URL'] } },
    });
    expect(result.success).toBe(true);
  });

  it('names the misspelled key and where it is in the loader error', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(
        join(cwd, '.local-ci.yml'),
        'version: 1\nproject:\n  type: angular\npipeline:\n  - build\nsettings:\n  timeoutms: 1000\n',
        'utf8',
      );
      const error = await loadConfig(cwd).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('settings');
      expect((error as Error).message).toContain('timeoutms');
    });
  });
});

describe('default step timeout (F-4)', () => {
  it('is 30 minutes and only applies when nothing is configured', () => {
    const parsed = localCiConfigSchema.parse(BASE);
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(effectiveTimeoutMs(parsed)).toBe(DEFAULT_TIMEOUT_MS);
    expect(effectiveTimeoutMs(localCiConfigSchema.parse({ ...BASE, settings: { timeoutMs: 5_000 } }))).toBe(5_000);
  });

  it('makes the default explicit without mutating the parsed configuration', () => {
    const parsed = localCiConfigSchema.parse(BASE);
    const effective = withEffectiveDefaults(parsed);
    expect(effective.settings.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(parsed.settings.timeoutMs).toBeUndefined();
  });

  it('is applied by run when the configuration has no timeout', async () => {
    const seen: Array<number | undefined> = [];
    const original = PipelineRunner.prototype.run;
    vi.spyOn(PipelineRunner.prototype, 'run').mockImplementation(function (this: PipelineRunner, context) {
      seen.push(context.config.settings.timeoutMs);
      return original.call(this, context);
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          name: 'default-timeout',
          scripts: { build: 'node -e "0"' },
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n',
        installed: true,
      });
      await runCommand(cwd, { skipToolProbes: true, browsers: NO_BROWSERS });
    });

    expect(seen).toEqual([DEFAULT_TIMEOUT_MS]);
  }, 30_000);

  it('is reported by validate, with its source', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)));

    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, '.local-ci.yml'), 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n', 'utf8');
      await validateCommand(cwd);
    });

    expect(lines.join('\n')).toContain('Step timeout: 1800s (default)');
  });
});
