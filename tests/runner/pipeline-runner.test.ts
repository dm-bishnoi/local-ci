import { describe, expect, it } from 'vitest';
import { PipelineRunner } from '../../src/core/pipeline-runner.js';
import { StepRegistry, type PipelineStep } from '../../src/core/step-runner.js';
import type { PipelineContext } from '../../src/core/context.js';

const context: PipelineContext = {
  cwd: process.cwd(),
  runId: 'test-run',
  config: {
    version: 1,
    project: { type: 'test' },
    pipeline: ['ok', 'missing'],
    settings: { failFast: false },
  },
};

const okStep: PipelineStep = {
  id: 'ok',
  name: 'OK',
  async run() { return { id: 'ok', name: 'OK', status: 'PASS', durationMs: 0 }; },
};

describe('PipelineRunner', () => {
  it('never treats an unregistered step as PASS', async () => {
    const registry = new StepRegistry().register(okStep);
    const result = await new PipelineRunner(registry).run(context);
    expect(result.status).toBe('FAIL');
    expect(result.steps.map((step) => step.status)).toEqual(['PASS', 'UNSUPPORTED']);
  });

  it('honors failFast', async () => {
    const failStep: PipelineStep = {
      id: 'fail', name: 'Fail', async run() { return { id: 'fail', name: 'Fail', status: 'FAIL', durationMs: 0 }; },
    };
    const registry = new StepRegistry().register(failStep);
    const failFastContext = { ...context, config: { ...context.config, pipeline: ['fail', 'later'], settings: { failFast: true } } };
    const result = await new PipelineRunner(registry).run(failFastContext);
    expect(result.steps.map((step) => step.status)).toEqual(['FAIL', 'SKIPPED']);
  });
});

// --- Phase 2 coverage -------------------------------------------------

function makeContext(pipeline: string[], failFast = false): PipelineContext {
  return {
    cwd: process.cwd(),
    runId: 'phase2-run',
    config: {
      version: 1,
      project: { type: 'test' },
      pipeline,
      settings: { failFast },
    },
  };
}

function status(name: string, value: 'PASS' | 'FAIL'): PipelineStep {
  return {
    id: name,
    name,
    async run() {
      return { id: name, name, status: value, durationMs: 0 };
    },
  };
}

const never = (id: string): PipelineStep => ({
  id,
  name: id,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return { id, name: id, status: 'PASS', durationMs: 0 };
  },
});

describe('PipelineRunner (Phase 2)', () => {
  it('executes steps sequentially in configured order', async () => {
    const order: string[] = [];
    const track = (id: string): PipelineStep => ({
      id,
      name: id,
      async run() {
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${id}`);
        return { id, name: id, status: 'PASS', durationMs: 0 };
      },
    });

    const registry = new StepRegistry().register(track('a')).register(track('b'));
    const result = await new PipelineRunner(registry).run(makeContext(['a', 'b']));

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    expect(result.status).toBe('PASS');
  });

  it('reports PASS only when every step passes', async () => {
    const registry = new StepRegistry().register(status('a', 'PASS')).register(status('b', 'PASS'));
    const result = await new PipelineRunner(registry).run(makeContext(['a', 'b']));

    expect(result.status).toBe('PASS');
    expect(result.steps.every((step) => step.status === 'PASS')).toBe(true);
  });

  it('failFast=false continues executing later steps after a failure', async () => {
    const executed: string[] = [];
    const track = (id: string, value: 'PASS' | 'FAIL'): PipelineStep => ({
      id,
      name: id,
      async run() {
        executed.push(id);
        return { id, name: id, status: value, durationMs: 0 };
      },
    });

    const registry = new StepRegistry()
      .register(track('install', 'PASS'))
      .register(track('test', 'FAIL'))
      .register(track('coverage', 'PASS'))
      .register(track('lint', 'PASS'));

    const result = await new PipelineRunner(registry).run(makeContext(['install', 'test', 'coverage', 'lint']));

    expect(executed).toEqual(['install', 'test', 'coverage', 'lint']);
    expect(result.steps.map((step) => step.status)).toEqual(['PASS', 'FAIL', 'PASS', 'PASS']);
    expect(result.status).toBe('FAIL');
  });

  it('failFast=true marks later steps SKIPPED and never runs them', async () => {
    const executed: string[] = [];
    const track = (id: string, value: 'PASS' | 'FAIL'): PipelineStep => ({
      id,
      name: id,
      async run() {
        executed.push(id);
        return { id, name: id, status: value, durationMs: 0 };
      },
    });

    const registry = new StepRegistry()
      .register(track('install', 'PASS'))
      .register(track('test', 'FAIL'))
      .register(track('lint', 'PASS'));

    const result = await new PipelineRunner(registry).run(makeContext(['install', 'test', 'lint'], true));

    expect(executed).toEqual(['install', 'test']);
    expect(result.steps.map((step) => step.status)).toEqual(['PASS', 'FAIL', 'SKIPPED']);
    expect(result.steps[2]?.error).toContain('failFast');
    expect(result.status).toBe('FAIL');
  });

  it('treats an unsupported step as a pipeline failure', async () => {
    const registry = new StepRegistry().register(status('known', 'PASS'));
    const result = await new PipelineRunner(registry).run(makeContext(['known', 'not-registered']));

    expect(result.steps[1]?.status).toBe('UNSUPPORTED');
    expect(result.status).toBe('FAIL');
  });

  it('stops on an unsupported step when failFast is enabled', async () => {
    const registry = new StepRegistry().register(status('known', 'PASS'));
    const result = await new PipelineRunner(registry).run(makeContext(['not-registered', 'known'], true));

    expect(result.steps.map((step) => step.status)).toEqual(['UNSUPPORTED', 'SKIPPED']);
    expect(result.status).toBe('FAIL');
  });

  it('marks the running step CANCELLED and the rest SKIPPED on cancellation', async () => {
    const controller = new AbortController();
    const registry = new StepRegistry().register(never('slow')).register(status('later', 'PASS'));

    const pending = new PipelineRunner(registry).run({
      ...makeContext(['slow', 'later']),
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    expect(result.steps.map((step) => step.status)).toEqual(['CANCELLED', 'SKIPPED']);
    expect(result.status).toBe('CANCELLED');
    expect(result.cancelled).toBe(true);
  }, 15_000);

  it('skips every step when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;

    const registry = new StepRegistry().register({
      id: 'a',
      name: 'a',
      async run() {
        executed = true;
        return { id: 'a', name: 'a', status: 'PASS', durationMs: 0 };
      },
    });

    const result = await new PipelineRunner(registry).run({ ...makeContext(['a']), signal: controller.signal });

    expect(executed).toBe(false);
    expect(result.steps[0]?.status).toBe('SKIPPED');
    expect(result.status).toBe('CANCELLED');
  });

  it('reports overall duration and timestamps', async () => {
    const registry = new StepRegistry().register(status('a', 'PASS'));
    const result = await new PipelineRunner(registry).run(makeContext(['a']));

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.endedAt)).not.toBeNaN();
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it('applies the configured timeout to steps', async () => {
    const registry = new StepRegistry().register(never('slow'));
    const ctx = makeContext(['slow']);
    ctx.config.settings.timeoutMs = 200;

    const result = await new PipelineRunner(registry).run(ctx);

    expect(result.steps[0]?.status).toBe('FAIL');
    expect(result.steps[0]?.timedOut).toBe(true);
    expect(result.status).toBe('FAIL');
  }, 15_000);

  it('emits progress callbacks for start and end', async () => {
    const started: string[] = [];
    const ended: string[] = [];
    const registry = new StepRegistry().register(status('a', 'PASS')).register(status('b', 'FAIL'));

    await new PipelineRunner(registry, {
      onStepStart: (step) => started.push(step.id),
      onStepEnd: (result) => ended.push(result.id),
    }).run(makeContext(['a', 'b']));

    expect(started).toEqual(['a', 'b']);
    expect(ended).toEqual(['a', 'b']);
  });

  it('isolates a throwing progress callback instead of losing the run', async () => {
    const registry = new StepRegistry().register(status('a', 'PASS'));
    const runner = new PipelineRunner(registry, {
      onStepEnd: () => {
        throw new Error('callback exploded');
      },
    });

    // Reporting is presentation: the run must complete unaffected.
    const result = await runner.run(makeContext(['a']));

    expect(result.steps.map((step) => step.status)).toEqual(['PASS']);
    expect(result.status).toBe('PASS');
  });

  it('survives an unexpected runner-level error without losing collected results', async () => {
    class ExplodingRegistry extends StepRegistry {
      private calls = 0;
      override get(id: string): PipelineStep | undefined {
        this.calls += 1;
        if (this.calls > 1) throw new Error('registry exploded');
        return super.get(id);
      }
    }

    const registry = new ExplodingRegistry().register(status('a', 'PASS'));
    const result = await new PipelineRunner(registry).run(makeContext(['a', 'b']));

    expect(result.status).toBe('FAIL');
    expect(result.steps[0]?.id).toBe('a');
    expect(result.steps[0]?.status).toBe('PASS');
    expect(result.steps.at(-1)?.id).toBe('pipeline');
    expect(result.steps.at(-1)?.error).toContain('Unexpected pipeline error');
  });
});