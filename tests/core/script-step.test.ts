/**
 * F-3: the script step is a thin wrapper — an argument vector handed to the
 * existing process step. These tests pin that contract with a fake executor so
 * nothing is spawned, then check cancellation against a real process.
 */

import { describe, expect, it } from 'vitest';
import type { PipelineContext } from '../../src/core/context.js';
import type { ProcessExecutor, ProcessResult, RunProcessOptions } from '../../src/core/process-runner.js';
import { createMissingScriptStep, createScriptStep, type ScriptRunner } from '../../src/core/script-step.js';
import { runStep } from '../../src/core/step-runner.js';

function context(overrides: Partial<PipelineContext> = {}, timeoutMs?: number): PipelineContext {
  return {
    cwd: process.cwd(),
    runId: 'script-step-test',
    config: {
      version: 1,
      project: { type: 'node' },
      pipeline: ['x'],
      settings: { failFast: false, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    },
    ...overrides,
  };
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: 'npm',
    args: [],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    failed: false,
    ...overrides,
  };
}

function recorder(outcome: ProcessResult = result()): {
  exec: ProcessExecutor;
  calls: Array<{ executable: string; args: readonly string[]; options: RunProcessOptions }>;
} {
  const calls: Array<{ executable: string; args: readonly string[]; options: RunProcessOptions }> = [];
  const exec: ProcessExecutor = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return outcome;
  };
  return { exec, calls };
}

describe('createScriptStep: what gets executed', () => {
  it.each<[ScriptRunner]>([['npm'], ['pnpm'], ['yarn']])('runs `%s run <script>` as an argument vector', async (manager) => {
    const { exec, calls } = recorder();
    const step = createScriptStep({ id: 'lint', name: 'Lint', packageManager: manager, script: 'lint:ci', exec });

    const stepResult = await step.run(context());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe(manager);
    expect(calls[0]?.args).toEqual(['run', 'lint:ci']);
    expect(stepResult.command).toBe(`${manager} run lint:ci`);
    expect(stepResult.status).toBe('PASS');
  });

  it('passes the script name as one argument, never splitting or quoting it', async () => {
    const { exec, calls } = recorder();
    // Names the schema allows can still contain characters a shell would treat
    // specially in other positions; they must stay a single argv entry.
    for (const script of ['test:e2e', 'a/b', 'build.prod', 'x-y_z']) {
      await createScriptStep({ id: 's', packageManager: 'npm', script, exec }).run(context());
    }
    expect(calls.map((call) => call.args)).toEqual([
      ['run', 'test:e2e'],
      ['run', 'a/b'],
      ['run', 'build.prod'],
      ['run', 'x-y_z'],
    ]);
  });

  it('never asks the executor for a shell', async () => {
    const { exec, calls } = recorder();
    await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(context());
    expect(Object.keys(calls[0]?.options ?? {})).not.toContain('shell');
  });

  it('runs in the project working directory', async () => {
    const { exec, calls } = recorder();
    await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(context({ cwd: '/some/project' }));
    expect(calls[0]?.options.cwd).toBe('/some/project');
  });
});

describe('createScriptStep: outcomes', () => {
  it('reports FAIL with the real exit code and captured output', async () => {
    const { exec } = recorder(
      result({ exitCode: 3, failed: true, stderr: '3 tests failed', stdout: 'running', error: 'Process exited with code 3.' }),
    );
    const stepResult = await createScriptStep({ id: 'test', packageManager: 'npm', script: 'test', exec }).run(context());

    expect(stepResult.status).toBe('FAIL');
    expect(stepResult.exitCode).toBe(3);
    expect(stepResult.stderr).toBe('3 tests failed');
    expect(stepResult.stdout).toBe('running');
    expect(stepResult.error).toBe('Process exited with code 3.');
  });

  it('reports CANCELLED, not FAIL, when the executor was cancelled', async () => {
    const { exec } = recorder(result({ exitCode: null, signal: 'SIGKILL', cancelled: true, failed: true, error: 'cancelled' }));
    const stepResult = await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(context());
    expect(stepResult.status).toBe('CANCELLED');
    expect(stepResult.cancelled).toBe(true);
  });

  it('flags a timeout on the step result', async () => {
    const { exec } = recorder(result({ exitCode: null, signal: 'SIGKILL', timedOut: true, failed: true, error: 'timed out' }));
    const stepResult = await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(context());
    expect(stepResult.status).toBe('FAIL');
    expect(stepResult.timedOut).toBe(true);
  });
});

describe('createScriptStep: timeouts and cancellation', () => {
  it('uses the pipeline timeout by default', async () => {
    const { exec, calls } = recorder();
    await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(context({}, 1_800_000));
    expect(calls[0]?.options.timeoutMs).toBe(1_800_000);
  });

  it('lets the step timeout override the pipeline timeout', async () => {
    const { exec, calls } = recorder();
    await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', timeoutMs: 5_000, exec }).run(
      context({}, 1_800_000),
    );
    expect(calls[0]?.options.timeoutMs).toBe(5_000);
  });

  it('is not cut short by the runner when its own timeout is longer than the pipeline timeout', async () => {
    // The executor finishes after the pipeline timeout but inside the step's.
    const exec: ProcessExecutor = (_executable, _args, options) =>
      new Promise((resolve) => setTimeout(() => resolve(result({ stdout: 'done' })), 600)).then((value) => {
        expect(options.timeoutMs).toBe(5_000);
        return value as ProcessResult;
      });
    const step = createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', timeoutMs: 5_000, exec });

    const stepResult = await runStep(step, context({}, 200));

    expect(stepResult.timedOut).not.toBe(true);
    expect(stepResult.status).toBe('PASS');
    expect(stepResult.stdout).toBe('done');
  });

  it('is still stopped by the runner at its own timeout when that is shorter', async () => {
    const exec: ProcessExecutor = () => new Promise(() => undefined);
    const step = createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', timeoutMs: 200, exec });
    // A step that never reports back must not hold the runner for the grace period.
    const stepResult = await runStep(step, context({}, 60_000), { abortGraceMs: 0 });

    expect(stepResult.status).toBe('FAIL');
    expect(stepResult.timedOut).toBe(true);
    expect(stepResult.error).toContain('200ms');
  });

  it('hands the run signal to the executor so cancellation reaches the process', async () => {
    const { exec, calls } = recorder();
    const controller = new AbortController();
    await createScriptStep({ id: 's', packageManager: 'npm', script: 'lint', exec }).run(
      context({ signal: controller.signal }),
    );
    expect(calls[0]?.options.signal).toBe(controller.signal);
  });

  it('cancels a real running script and reports CANCELLED with its output', async () => {
    const controller = new AbortController();
    const step = createScriptStep({
      id: 'slow',
      name: 'Slow',
      packageManager: 'npm',
      script: 'slow',
      exec: (_executable, _args, options) =>
        // Run node directly: the point is the signal path, not npm start-up.
        import('../../src/core/process-runner.js').then(({ runProcess }) =>
          runProcess(process.execPath, ['-e', "console.log('started'); setTimeout(() => {}, 60000)"], options),
        ),
    });

    const pending = runStep(step, context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 700);
    const stepResult = await pending;

    expect(stepResult.status).toBe('CANCELLED');
    expect(stepResult.cancelled).toBe(true);
    expect(stepResult.stdout).toContain('started');
  }, 30_000);
});

describe('createMissingScriptStep', () => {
  it('reports UNSUPPORTED naming the script, and runs nothing', async () => {
    const step = createMissingScriptStep('e2e', 'E2E', 'test:e2e');
    const stepResult = await step.run(context());

    expect(stepResult.status).toBe('UNSUPPORTED');
    expect(stepResult.error).toContain('"test:e2e"');
    expect(stepResult.error).toContain('"e2e"');
    expect(stepResult.command).toBeUndefined();
    expect(stepResult.durationMs).toBe(0);
  });
});
