import { describe, expect, it } from 'vitest';
import { runStep, type PipelineStep, type StepResult } from '../../src/core/step-runner.js';
import type { PipelineContext } from '../../src/core/context.js';

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    cwd: process.cwd(),
    runId: 'step-runner-test',
    config: {
      version: 1,
      project: { type: 'test' },
      pipeline: ['x'],
      settings: { failFast: false },
    },
    ...overrides,
  };
}

function step(id: string, run: PipelineStep['run']): PipelineStep {
  return { id, name: id.toUpperCase(), run };
}

function pass(id = 'ok'): PipelineStep {
  return step(id, async () => ({ id, name: id, status: 'PASS', durationMs: 0 }));
}

describe('runStep', () => {
  it('records a successful step with a structured result', async () => {
    const result = await runStep(pass(), makeContext());

    expect(result.status).toBe('PASS');
    expect(result.id).toBe('ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeTruthy();
    expect(result.endedAt).toBeTruthy();
  });

  it('keeps a failing step failing', async () => {
    const result = await runStep(
      step('bad', async () => ({ id: 'bad', name: 'bad', status: 'FAIL', durationMs: 0, error: 'nope' })),
      makeContext(),
    );

    expect(result.status).toBe('FAIL');
    expect(result.error).toBe('nope');
  });

  it('converts a thrown error into a structured failure, never PASS', async () => {
    const result = await runStep(
      step('boom', async () => {
        throw new Error('exploded');
      }),
      makeContext(),
    );

    expect(result.status).toBe('FAIL');
    expect(result.error).toBe('exploded');
  });

  it('normalizes a thrown non-Error value', async () => {
    const result = await runStep(
      step('boom', async () => {
        throw 'a string failure';
      }),
      makeContext(),
    );

    expect(result.status).toBe('FAIL');
    expect(result.error).toBe('a string failure');
  });

  it('rejects a step that returns no valid status instead of trusting it', async () => {
    const bogus = { id: 'bogus', name: 'bogus', durationMs: 0 } as unknown as StepResult;
    const result = await runStep(step('bogus', async () => bogus), makeContext());

    expect(result.status).toBe('FAIL');
    expect(result.error).toContain('no valid status');
  });

  it('measures duration of a slow step', async () => {
    const result = await runStep(
      step('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { id: 'slow', name: 'slow', status: 'PASS', durationMs: 0 };
      }),
      makeContext(),
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('fails a step that exceeds its timeout and says so', async () => {
    const result = await runStep(
      step('hangs', async () => new Promise<StepResult>(() => {})),
      makeContext(),
      { timeoutMs: 150 },
    );

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe('Step timed out after 150ms');
  });

  it('does not hang when a step ignores cancellation', async () => {
    const result = await runStep(step('stubborn', async () => new Promise<StepResult>(() => {})), makeContext(), {
      timeoutMs: 150,
    });

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
  });

  it('marks a step CANCELLED when the run is aborted', async () => {
    const controller = new AbortController();
    const pending = runStep(
      step('long', async (context) => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return { id: 'long', name: 'long', status: 'PASS', durationMs: 0 };
      }),
      makeContext({ signal: controller.signal }),
    );

    setTimeout(() => controller.abort(), 100);
    const result = await pending;

    expect(result.status).toBe('CANCELLED');
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it('does not start a step whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;

    const result = await runStep(
      step('never', async () => {
        started = true;
        return { id: 'never', name: 'never', status: 'PASS', durationMs: 0 };
      }),
      makeContext({ signal: controller.signal }),
    );

    expect(started).toBe(false);
    expect(result.status).toBe('CANCELLED');
  });

  it('passes a derived signal to the step so a step timeout does not cancel the run', async () => {
    const parent = new AbortController();
    let inner: AbortSignal | undefined;

    await runStep(
      step('inner', async (context) => {
        inner = context.signal;
        return { id: 'inner', name: 'inner', status: 'PASS', durationMs: 0 };
      }),
      makeContext({ signal: parent.signal }),
      { timeoutMs: 5000 },
    );

    expect(inner).toBeDefined();
    expect(inner).not.toBe(parent.signal);
    expect(parent.signal.aborted).toBe(false);
  });

  it('honours a step that reports its own cancellation', async () => {
    const result = await runStep(
      step('selfcancel', async () => ({
        id: 'selfcancel',
        name: 'selfcancel',
        status: 'PASS',
        durationMs: 0,
        cancelled: true,
      })),
      makeContext(),
    );

    expect(result.status).toBe('CANCELLED');
  });

  it('invokes onStart for lifecycle reporting', async () => {
    const seen: string[] = [];
    await runStep(pass('observed'), makeContext(), { onStart: (s) => seen.push(s.id) });
    expect(seen).toEqual(['observed']);
  });

  it('does not leak the timer for a fast step', async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await runStep(pass(), makeContext(), { timeoutMs: 60_000 });
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    expect(after).toBeLessThanOrEqual(before);
  });
});

/**
 * F-2 regression: a step with bounded cleanup reports what it ran and printed
 * even when it is stopped by a timeout or a cancellation.
 */
describe('runStep abort evidence', () => {
  /** Honours its signal, then reports the evidence a real process step would. */
  function cooperative(cleanupMs = 20): PipelineStep {
    return {
      id: 'coop',
      name: 'Coop',
      abortGraceMs: 2_000,
      run: (context) =>
        new Promise<StepResult>((resolve) => {
          context.signal?.addEventListener('abort', () => {
            setTimeout(
              () =>
                resolve({
                  id: 'coop',
                  name: 'Coop',
                  status: 'CANCELLED',
                  durationMs: 1,
                  command: 'node script.js',
                  exitCode: null,
                  signal: 'SIGKILL',
                  stdout: 'printed before the timeout',
                  stderr: 'warning before the timeout',
                  cancelled: true,
                }),
              cleanupMs,
            );
          });
        }),
    };
  }

  it('keeps command, exit details and output of a timed-out step', async () => {
    const result = await runStep(cooperative(), makeContext(), { timeoutMs: 150 });

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.error).toBe('Step timed out after 150ms');
    expect(result.command).toBe('node script.js');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout).toBe('printed before the timeout');
    expect(result.stderr).toBe('warning before the timeout');
  });

  it('keeps the evidence of a cancelled step and still reports CANCELLED', async () => {
    const controller = new AbortController();
    const pending = runStep(cooperative(), makeContext({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.status).toBe('CANCELLED');
    expect(result.cancelled).toBe(true);
    expect(result.stdout).toBe('printed before the timeout');
    expect(result.command).toBe('node script.js');
  });

  it('never lets an aborted step promote itself to PASS', async () => {
    const liar: PipelineStep = {
      id: 'liar',
      name: 'Liar',
      abortGraceMs: 1_000,
      run: (context) =>
        new Promise<StepResult>((resolve) => {
          context.signal?.addEventListener('abort', () =>
            resolve({ id: 'liar', name: 'Liar', status: 'PASS', durationMs: 0, stdout: 'all good' }),
          );
        }),
    };
    const result = await runStep(liar, makeContext(), { timeoutMs: 100 });

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('all good');
  });

  it('waits for the step to finish cleaning up before returning', async () => {
    let cleanedAt = 0;
    const slowCleanup: PipelineStep = {
      ...cooperative(),
      run: (context) =>
        new Promise<StepResult>((resolve) => {
          context.signal?.addEventListener('abort', () => {
            setTimeout(() => {
              cleanedAt = Date.now();
              resolve({ id: 'coop', name: 'Coop', status: 'CANCELLED', durationMs: 0 });
            }, 300);
          });
        }),
    };
    const result = await runStep(slowCleanup, makeContext(), { timeoutMs: 100 });

    expect(cleanedAt).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThanOrEqual(cleanedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(350);
  });

  it('gives up after the grace period and says the output could not be captured', async () => {
    const stuck: PipelineStep = {
      id: 'stuck',
      name: 'Stuck',
      abortGraceMs: 200,
      run: async () => new Promise<StepResult>(() => {}),
    };
    const started = Date.now();
    const result = await runStep(stuck, makeContext(), { timeoutMs: 100 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBeUndefined();
    expect(result.error).toContain('Step timed out after 100ms');
    expect(result.error).toContain('could not be captured');
  });
});