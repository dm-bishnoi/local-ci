import type { PipelineContext } from './context.js';
import { runStep, StepRegistry, type PipelineStep, type StepResult } from './step-runner.js';

export type PipelineStatus = 'PASS' | 'FAIL' | 'CANCELLED';

export interface PipelineRunResult {
  runId: string;
  status: PipelineStatus;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  /** True when the run was interrupted rather than completing normally. */
  cancelled: boolean;
  steps: StepResult[];
}

export interface PipelineRunnerOptions {
  /** Called as each step starts, before it is executed. */
  onStepStart?: (step: PipelineStep) => void;
  /** Called as each step finishes, with its structured result. */
  onStepEnd?: (result: StepResult) => void;
}

export function unsupportedStep(id: string): StepResult {
  return {
    id,
    name: id,
    status: 'UNSUPPORTED',
    durationMs: 0,
    error: `No local implementation is registered for pipeline step "${id}".`,
  };
}

export function skippedStep(id: string, reason: string): StepResult {
  return { id, name: id, status: 'SKIPPED', durationMs: 0, error: reason };
}

/**
 * Statuses that make the overall pipeline non-successful.
 *
 * `SKIPPED` is intentionally excluded: skipped steps are a consequence of an
 * earlier failure or of cancellation, and the run is already non-successful.
 */
export function isSuccessful(status: PipelineStatus, steps: readonly StepResult[]): boolean {
  if (status !== 'PASS') return false;
  return steps.every((step) => step.status === 'PASS');
}

/**
 * Invokes a progress callback defensively.
 *
 * Reporting is presentation: a broken or throwing progress callback must never
 * destroy a run that is already executing, and must never escape the runner's
 * own error handling.
 */
function safeNotify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  try {
    callback(value);
  } catch {
    /* ignored on purpose */
  }
}

export class PipelineRunner {
  constructor(
    private readonly registry: StepRegistry,
    private readonly options: PipelineRunnerOptions = {},
  ) {}

  async run(context: PipelineContext): Promise<PipelineRunResult> {
    const startedAt = new Date();
    const started = performance.now();
    const steps: StepResult[] = [];
    let failed = false;
    let cancelled = false;

    const finish = (status: PipelineStatus): PipelineRunResult => ({
      runId: context.runId,
      status,
      durationMs: Math.round(performance.now() - started),
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      cancelled: status === 'CANCELLED',
      steps,
    });

    try {
      for (const id of context.config.pipeline) {
        // Cancellation is checked first: a cancelled run never starts new work,
        // even when failFast is also enabled.
        if (context.signal?.aborted) {
          cancelled = true;
          failed = true;
          const skipped = skippedStep(id, 'Pipeline was cancelled before this step started.');
          steps.push(skipped);
          safeNotify(this.options.onStepEnd, skipped);
          continue;
        }

        if (failed && context.config.settings.failFast) {
          const skipped = skippedStep(id, 'Skipped because failFast is enabled.');
          steps.push(skipped);
          safeNotify(this.options.onStepEnd, skipped);
          continue;
        }

        const step = this.registry.get(id);
        const result = step
          ? await runStep(step, context, { onStart: this.options.onStepStart })
          : unsupportedStep(id);

        steps.push(result);
        safeNotify(this.options.onStepEnd, result);

        if (result.status === 'CANCELLED') {
          cancelled = true;
          failed = true;
        } else if (result.status === 'FAIL' || result.status === 'UNSUPPORTED') {
          failed = true;
        }
      }
    } catch (error) {
      // An unexpected runner-level error must not discard the results already
      // collected, and must never be reported as success.
      failed = true;
      const failure: StepResult = {
        id: 'pipeline',
        name: 'pipeline',
        status: 'FAIL',
        durationMs: 0,
        error: `Unexpected pipeline error: ${error instanceof Error ? error.message : String(error)}`,
      };
      steps.push(failure);
      // Reported through the same guarded path: re-throwing here would escape
      // the runner entirely and lose an already-completed run.
      safeNotify(this.options.onStepEnd, failure);
    }

    if (cancelled) return finish('CANCELLED');
    if (failed) return finish('FAIL');
    return finish(isSuccessful('PASS', steps) ? 'PASS' : 'FAIL');
  }
}