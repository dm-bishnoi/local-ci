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
  /**
   * Steps that preflight determined must not execute, mapped to the reason.
   *
   * A blocked step is reported without dispatching anything: the requirement
   * that prevents execution is known, so attempting the step would only
   * produce a confusing failure for a reason the tool already understands.
   * This is the run-side half of the DETECT → SOLVE/GUIDE → VERIFY loop — the
   * gate lives in the CLI, and the runner simply honours its verdict.
   */
  blockedSteps?: ReadonlyMap<string, string>;
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
 * A step that was never dispatched because a known requirement was missing.
 *
 * Distinct from {@link unsupportedStep}: `UNSUPPORTED` means this build cannot
 * do the job at all, while `BLOCKED` means the job is supported and this machine
 * is not currently able to do it — a missing tool, an unset required variable,
 * uninstalled dependencies. Neither is ever a pass.
 */
export function blockedStep(id: string, name: string, reason: string): StepResult {
  return { id, name, status: 'BLOCKED', durationMs: 0, error: reason };
}

/** A step that could not produce a meaningful verdict because of an internal fault. */
export function errorStep(id: string, name: string, reason: string): StepResult {
  return { id, name, status: 'ERROR', durationMs: 0, error: reason };
}

/**
 * Statuses that make the overall pipeline non-successful.
 *
 * `SKIPPED` is intentionally excluded from the *list of blocking statuses* but is
 * still disqualifying here: `isSuccessful` demands that every step is `PASS`, so
 * a skipped step can never be read as a successful one. Skipping is a
 * consequence of an earlier failure or of cancellation, and the run is already
 * non-successful by then.
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

        // A known requirement prevents execution. Checked before failFast so
        // the real reason is reported instead of a generic "skipped".
        const blockedReason = this.options.blockedSteps?.get(id);
        if (blockedReason !== undefined) {
          const blocked = blockedStep(id, this.registry.get(id)?.name ?? id, blockedReason);
          steps.push(blocked);
          failed = true;
          safeNotify(this.options.onStepEnd, blocked);
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
        } else if (result.status !== 'PASS') {
          // FAIL, UNSUPPORTED, BLOCKED and ERROR all mean the run did not
          // succeed. Only PASS is success, so this stays a single negative test
          // rather than an enumeration that can fall out of date.
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
        status: 'ERROR',
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