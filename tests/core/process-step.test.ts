import { describe, expect, it } from 'vitest';
import { createProcessStep } from '../../src/core/process-step.js';
import { runStep } from '../../src/core/step-runner.js';
import type { PipelineContext } from '../../src/core/context.js';

const NODE = process.execPath;

function context(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    cwd: process.cwd(),
    runId: 'process-step-test',
    config: {
      version: 1,
      project: { type: 'test' },
      pipeline: ['x'],
      settings: { failFast: false },
    },
    ...overrides,
  };
}

describe('createProcessStep', () => {
  it('reports PASS and captures output for a successful process', async () => {
    const step = createProcessStep({
      id: 'greet',
      name: 'Greet',
      command: NODE,
      args: ['-e', "process.stdout.write('hi')"],
    });

    const result = await runStep(step, context());

    expect(result.status).toBe('PASS');
    expect(result.stdout).toBe('hi');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it('reports FAIL with the exit code for a failing process', async () => {
    const step = createProcessStep({
      id: 'fail',
      command: NODE,
      args: ['-e', "process.stderr.write('boom'); process.exit(2)"],
    });

    const result = await runStep(step, context());

    expect(result.status).toBe('FAIL');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('boom');
  });

  it('reports FAIL when the executable does not exist', async () => {
    const step = createProcessStep({ id: 'missing', command: 'local-ci-not-a-command-4b7e' });

    const result = await runStep(step, context());

    expect(result.status).toBe('FAIL');
    expect(result.error).toBeTruthy();
  });

  it('records a masked command line rather than raw credentials', async () => {
    const step = createProcessStep({
      id: 'secret',
      command: NODE,
      args: ['-e', 'void 0', '--token', 'ghp_shouldnotappear'],
    });

    const result = await runStep(step, context());

    expect(result.command).toContain('--token ***');
    expect(result.command).not.toContain('ghp_shouldnotappear');
  });

  it('applies the pipeline-wide timeout to a slow process', async () => {
    const step = createProcessStep({
      id: 'slow',
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
    });

    // The step declares no timeout of its own; the pipeline-wide setting must apply.
    const ctx = context();
    ctx.config.settings.timeoutMs = 300;

    const result = await runStep(step, ctx);

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
  }, 40_000);

  it('reports CANCELLED when the pipeline signal fires', async () => {
    const controller = new AbortController();
    const step = createProcessStep({
      id: 'slow',
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
    });

    const pending = runStep(step, context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);

    const result = await pending;

    expect(result.status).toBe('CANCELLED');
    expect(result.cancelled).toBe(true);
  }, 40_000);

  it('honours a step-level timeout override', async () => {
    const step = createProcessStep({
      id: 'slow',
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 200,
    });

    const result = await runStep(step, context());

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
  }, 40_000);
});