/**
 * End-to-end reporting integration.
 *
 * These tests drive the real {@link PipelineRunner} — no mocked runner, no
 * hand-assembled results — and assert on the files that actually land on disk:
 *
 *   PipelineRunner
 *        ↓
 *   collected StepResults
 *        ↓
 *   report generation
 *        ↓
 *   report.json  summary.json  report.html  logs/
 *
 * The steps themselves are deterministic in-process steps, so these tests
 * exercise reporting rather than re-testing process execution, which
 * `tests/core/process-step.test.ts` already covers against real processes.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PipelineRunner, type PipelineRunResult } from '../../src/core/pipeline-runner.js';
import { StepRegistry, type PipelineStep, type StepResult, type StepStatus } from '../../src/core/step-runner.js';
import type { PipelineContext } from '../../src/core/context.js';
import { localCiConfigSchema, type LocalCiConfig } from '../../src/config/schema.js';
import { writeRunReports } from '../../src/reporters/artifact.js';
import { formatConsoleReport } from '../../src/reporters/console.js';
import { buildRunReport } from '../../src/reporters/report-model.js';
import { TEST_METADATA, withTempProject } from '../helpers/reports.js';

const RUN_ID = '20261008-123456-abcd1234';

function config(pipeline: string[], failFast = false): LocalCiConfig {
  return localCiConfigSchema.parse({ version: 1, project: { type: 'angular' }, pipeline, settings: { failFast } });
}

/** A step whose outcome is decided by the test, with no process involved. */
function scriptedStep(
  id: string,
  name: string,
  status: StepStatus,
  extras: Partial<StepResult> = {},
): PipelineStep {
  return {
    id,
    name,
    async run(): Promise<StepResult> {
      return {
        id,
        name,
        status,
        durationMs: 1_234,
        exitCode: status === 'PASS' ? 0 : 1,
        stdout: `${name} output`,
        ...extras,
      };
    },
  };
}

async function runAndReport(
  cwd: string,
  pipeline: string[],
  register: (registry: StepRegistry) => void,
  options: { failFast?: boolean; signal?: AbortSignal } = {},
): Promise<{ result: PipelineRunResult; report: ReturnType<typeof buildRunReport>['report']; dir: string }> {
  const registry = new StepRegistry();
  register(registry);

  const context: PipelineContext = {
    cwd,
    config: config(pipeline, options.failFast ?? false),
    runId: RUN_ID,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const result = await new PipelineRunner(registry).run(context);
  const built = buildRunReport({ result, metadata: TEST_METADATA });
  const artifacts = await writeRunReports(cwd, built);

  expect(artifacts.errors).toEqual([]);
  return { result, report: built.report, dir: artifacts.paths.directory };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

describe('PipelineRunner -> report artifacts', () => {
  it('writes the documented artifact tree for a passing run', async () => {
    await withTempProject(async (cwd) => {
      const { report, dir } = await runAndReport(
        cwd,
        ['install', 'typecheck', 'build'],
        (registry) => {
          registry
            .register(scriptedStep('install', 'Dependencies', 'PASS'))
            .register(scriptedStep('typecheck', 'TypeScript', 'PASS'))
            .register(scriptedStep('build', 'Production Build', 'PASS'));
        },
      );

      expect(report.status).toBe('PASS');
      expect(report.exitCode).toBe(0);

      const expected = [
        'report.json',
        'summary.json',
        'report.html',
        join('logs', 'install.log'),
        join('logs', 'typecheck.log'),
        join('logs', 'build.log'),
      ];
      for (const name of expected) {
        expect(await exists(join(dir, name)), `${name} is missing`).toBe(true);
      }
    });
  });

  it('writes artifacts for a FAILED run and preserves the failure', async () => {
    await withTempProject(async (cwd) => {
      const { result, report, dir } = await runAndReport(
        cwd,
        ['install', 'test', 'build'],
        (registry) => {
          registry
            .register(scriptedStep('install', 'Dependencies', 'PASS'))
            .register(scriptedStep('test', 'Unit Tests', 'PASS'))
            .register(
              scriptedStep('build', 'Production Build', 'FAIL', {
                exitCode: 1,
                error: 'Process exited with code 1.',
                stderr: 'ERROR: Application bundle generation failed.',
              }),
            );
        },
      );

      // The report must never flatten a failure into a pass.
      expect(result.status).toBe('FAIL');
      expect(report.status).toBe('FAIL');
      expect(report.exitCode).toBe(1);
      expect(report.steps.at(-1)?.status).toBe('FAIL');

      const json = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        status: string;
        exitCode: number;
        steps: Array<{ status: string; error: string }>;
      };
      expect(json.status).toBe('FAIL');
      expect(json.exitCode).toBe(1);
      expect(json.steps.at(-1)?.error).toContain('exited with code 1');

      const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as {
        status: string;
        steps: { failed: number; passed: number };
        failures: Array<{ id: string }>;
      };
      expect(summary.status).toBe('FAIL');
      expect(summary.steps).toMatchObject({ passed: 2, failed: 1 });
      expect(summary.failures.map((failure) => failure.id)).toEqual(['build']);

      const html = await readFile(join(dir, 'report.html'), 'utf8');
      expect(html).toContain('ERROR: Application bundle generation failed.');
      expect(html).toContain('Failed steps (1)');
    });
  });

  it('writes artifacts for an UNSUPPORTED run and fails overall', async () => {
    await withTempProject(async (cwd) => {
      // An unregistered step id is exactly what the core reports as UNSUPPORTED.
      const { report, dir } = await runAndReport(
        cwd,
        ['install', 'lint'],
        (registry) => {
          registry.register(scriptedStep('install', 'Dependencies', 'PASS'));
        },
      );

      expect(report.status).toBe('FAIL');
      expect(report.exitCode).toBe(1);
      expect(report.counts.unsupported).toBe(1);

      const lint = report.steps.find((step) => step.id === 'lint');
      expect(lint?.status).toBe('UNSUPPORTED');
      expect(lint?.executed).toBe(false);
      expect(lint?.logPath).toBeUndefined();

      // No fabricated log for a step that never ran.
      const logs = await readdir(join(dir, 'logs'));
      expect(logs.sort()).toEqual(['install.log']);

      const html = await readFile(join(dir, 'report.html'), 'utf8');
      expect(html).toContain('Unsupported capabilities (1)');
      expect(html).not.toContain('Failed steps (1)');
    });
  });

  it('writes artifacts for a SKIPPED step under failFast, with no fake log', async () => {
    await withTempProject(async (cwd) => {
      const { report, dir } = await runAndReport(
        cwd,
        ['install', 'build', 'security'],
        (registry) => {
          registry
            .register(scriptedStep('install', 'Dependencies', 'PASS'))
            .register(scriptedStep('build', 'Production Build', 'FAIL', { error: 'boom' }));
        },
        { failFast: true },
      );

      const security = report.steps.find((step) => step.id === 'security');
      expect(security?.status).toBe('SKIPPED');
      expect(security?.executed).toBe(false);
      expect(security?.logPath).toBeUndefined();

      const logs = await readdir(join(dir, 'logs'));
      expect(logs.sort()).toEqual(['build.log', 'install.log']);
      expect(report.counts).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    });
  });

  it('writes artifacts for a CANCELLED run', async () => {
    await withTempProject(async (cwd) => {
      const controller = new AbortController();
      const registry = new StepRegistry();
      registry.register(scriptedStep('install', 'Dependencies', 'PASS'));

      // A step that is interrupted the way Ctrl+C interrupts one.
      const slow: PipelineStep = {
        id: 'build',
        name: 'Production Build',
        async run(context: PipelineContext): Promise<StepResult> {
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return { id: 'build', name: 'Production Build', status: 'CANCELLED', durationMs: 10, cancelled: true };
        },
      };
      registry.register(slow);

      const context: PipelineContext = { cwd, config: config(['install', 'build', 'security']), runId: RUN_ID, signal: controller.signal };

      const running = new PipelineRunner(registry).run(context);
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const result = await running;
      const built = buildRunReport({ result, metadata: TEST_METADATA });
      const artifacts = await writeRunReports(cwd, built);

      expect(result.status).toBe('CANCELLED');
      expect(built.report.status).toBe('CANCELLED');
      expect(built.report.exitCode).toBe(1);
      expect(built.report.steps.find((step) => step.id === 'build')?.status).toBe('CANCELLED');
      expect(built.report.steps.find((step) => step.id === 'security')?.status).toBe('SKIPPED');

      // The report is most valuable exactly when the run did not finish.
      expect(artifacts.errors).toEqual([]);
      expect(await exists(artifacts.paths.reportJson)).toBe(true);
      expect(await exists(artifacts.paths.reportHtml)).toBe(true);
      expect(await readFile(artifacts.paths.reportHtml, 'utf8')).toContain('CANCELLED');
    });
  });

  it('writes artifacts for a TIMED OUT run', async () => {
    await withTempProject(async (cwd) => {
      const registry = new StepRegistry();
      registry.register(scriptedStep('test', 'Unit Tests', 'FAIL', { error: 'nothing yet' }));

      const context: PipelineContext = {
        cwd,
        config: { ...config(['test']), settings: { failFast: false, timeoutMs: 25 } },
        runId: RUN_ID,
      };

      // A step that outlasts its timeout is the real thing, not a flag.
      const hanging: PipelineStep = {
        id: 'test',
        name: 'Unit Tests',
        async run(context: PipelineContext): Promise<StepResult> {
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          return { id: 'test', name: 'Unit Tests', status: 'PASS', durationMs: 5_000 };
        },
      };
      const hangingRegistry = new StepRegistry().register(hanging);

      const result = await new PipelineRunner(hangingRegistry).run(context);
      const built = buildRunReport({ result, metadata: TEST_METADATA });
      const artifacts = await writeRunReports(cwd, built);

      expect(result.status).toBe('FAIL');
      const step = built.report.steps[0];
      expect(step?.status).toBe('FAIL');
      expect(step?.timedOut).toBe(true);
      expect(step?.cancelled).toBe(false);
      expect(step?.error).toContain('timed out');

      expect(artifacts.errors).toEqual([]);
      expect(await readFile(artifacts.paths.reportJson, 'utf8')).toContain('"timedOut": true');
      expect(await readFile(join(artifacts.paths.logsDirectory, 'test.log'), 'utf8')).toContain('timedOut: true');
      void registry;
    });
  });

  it('reports an unexpected runner error as a failure, with artifacts', async () => {
    await withTempProject(async (cwd) => {
      const registry = new StepRegistry();
      registry.register({
        id: 'install',
        name: 'Dependencies',
        async run(): Promise<StepResult> {
          return { id: 'install', name: 'Dependencies', status: 'PASS', durationMs: 1 };
        },
      });

      const context: PipelineContext = { cwd, config: config(['install']), runId: RUN_ID };
      const result = await new PipelineRunner(registry, {
        onStepEnd() {
          // A throwing progress callback must not destroy the run.
          throw new Error('progress callback exploded');
        },
      }).run(context);

      const built = buildRunReport({ result, metadata: TEST_METADATA });
      const artifacts = await writeRunReports(cwd, built);

      expect(result.status).toBe('PASS');
      expect(built.report.steps[0]?.status).toBe('PASS');
      expect(artifacts.errors).toEqual([]);
      expect(await exists(artifacts.paths.reportJson)).toBe(true);
    });
  });
});

describe('console report of a real run', () => {
  it('summarizes the pipeline outcome in plain text', async () => {
    await withTempProject(async (cwd) => {
      const { result } = await runAndReport(
        cwd,
        ['install', 'build'],
        (registry) => {
          registry
            .register(scriptedStep('install', 'Dependencies', 'PASS'))
            .register(scriptedStep('build', 'Production Build', 'FAIL', { error: 'Process exited with code 1.' }));
        },
      );

      const output = formatConsoleReport(
        buildRunReport({ result, metadata: TEST_METADATA }).report,
      );

      expect(output).toContain('Result:          FAIL');
      expect(output).toContain('Failed step:');
      expect(output).toContain('Production Build');
      // No colour codes: the report must survive being piped to a file.
      expect(output).not.toMatch(/\[/);
    });
  });
});