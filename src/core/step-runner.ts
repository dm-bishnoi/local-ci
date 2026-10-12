import type { PipelineContext } from './context.js';
import { isStepStatus, type StepStatus } from './status.js';

/**
 * The canonical vocabulary lives in `status.ts` so that the engine and the
 * reporting layer cannot drift apart. Re-exported here because callers already
 * import step types from this module.
 */
export { isStepStatus, type StepStatus } from './status.js';

/**
 * Observable lifecycle of a step. `PENDING` and `RUNNING` are transient and are
 * only surfaced through {@link StepRunOptions.onStart} / the runner's progress
 * callbacks — they never appear on a recorded result.
 */
export type StepLifecycle = 'PENDING' | 'RUNNING' | StepStatus;

/**
 * JSON-serializable record of one executed step. Optional fields are omitted
 * rather than set to null when they carry no information for that step.
 */
export interface StepResult {
  id: string;
  name: string;
  status: StepStatus;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  /** Command line, with credential arguments masked. */
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** True when the step exceeded its timeout. */
  timedOut?: boolean;
  /** True when the step was interrupted by cancellation. */
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface PipelineStep {
  id: string;
  name: string;
  run(context: PipelineContext): Promise<StepResult>;
  /**
   * This step's own time limit. When set it replaces `settings.timeoutMs` for
   * this step, so it can be longer as well as shorter than the pipeline limit.
   */
  timeoutMs?: number;
  /**
   * How long the runner may wait, after a timeout or cancellation, for this
   * step to finish its own cleanup and return what it observed (command, exit
   * details, output captured before termination).
   *
   * Only a step whose cleanup is itself bounded should set this. Absent or 0
   * means the runner returns the moment the step is aborted, so a step that
   * ignores its signal can never hold up the pipeline.
   */
  abortGraceMs?: number;
}

export interface StepRunOptions {
  /** Overrides the configured timeout for this step. */
  timeoutMs?: number;
  /** Overrides {@link PipelineStep.abortGraceMs}. */
  abortGraceMs?: number;
  /** Cancels the step when aborted. Defaults to `context.signal`. */
  signal?: AbortSignal;
  onStart?: (step: PipelineStep) => void;
}

const TERMINAL_STATUSES: readonly StepStatus[] = ['PASS', 'FAIL', 'UNSUPPORTED', 'SKIPPED', 'CANCELLED', 'BLOCKED', 'ERROR'];

/** Human-readable timeout description, e.g. `30s` or `1500ms`. */
export function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

export class StepRegistry {
  private readonly steps = new Map<string, PipelineStep>();

  register(step: PipelineStep): this {
    if (this.steps.has(step.id)) {
      throw new Error(`Pipeline step already registered: ${step.id}`);
    }
    this.steps.set(step.id, step);
    return this;
  }

  get(id: string): PipelineStep | undefined {
    return this.steps.get(id);
  }

  has(id: string): boolean {
    return this.steps.has(id);
  }
}

interface RaceOutcome {
  kind: 'settled' | 'aborted';
  result?: StepResult;
}

/**
 * Waits up to `graceMs` for an aborted step to settle. Resolves to its result,
 * or `undefined` when it rejected, returned nothing valid, or ran out of time.
 */
async function settleWithin(promise: Promise<StepResult>, graceMs: number): Promise<StepResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (result) => (result && isStepStatus(result.status) ? result : undefined),
        () => undefined,
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The evidence an aborted step can still contribute: what ran and what it
 * printed before it was stopped. The verdict itself is never taken from it —
 * the runner already knows the step timed out or was cancelled.
 */
function abortEvidence(result: StepResult | undefined): Partial<StepResult> {
  if (!result) return {};
  const evidence: Partial<StepResult> = {};
  if (result.command !== undefined) evidence.command = result.command;
  if (result.exitCode !== undefined) evidence.exitCode = result.exitCode;
  if (result.signal !== undefined) evidence.signal = result.signal;
  if (result.stdout !== undefined) evidence.stdout = result.stdout;
  if (result.stderr !== undefined) evidence.stderr = result.stderr;
  return evidence;
}

function baseResult(step: PipelineStep, startedAt: Date, started: number): StepResult {
  return {
    id: step.id,
    name: step.name,
    status: 'FAIL',
    durationMs: Math.round(performance.now() - started),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
  };
}

/**
 * Executes a single step with a hard timeout and cancellation support.
 *
 * Guarantees:
 * - Always resolves to a {@link StepResult}; it never rejects.
 * - A thrown exception, a timeout and a cancellation are three distinct,
 *   reportable outcomes and can never be reported as PASS.
 * - When a step ignores its signal, this function still returns on time; the
 *   orphaned promise has a rejection handler attached so it cannot surface as an
 *   unhandled rejection later.
 */
export async function runStep(
  step: PipelineStep,
  context: PipelineContext,
  options: StepRunOptions = {},
): Promise<StepResult> {
  const startedAt = new Date();
  const started = performance.now();
  const parentSignal = options.signal ?? context.signal;
  const timeoutMs = options.timeoutMs ?? step.timeoutMs ?? context.config.settings.timeoutMs;

  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  let timedOut = false;
  let cancelled = false;

  if (parentSignal) {
    if (parentSignal.aborted) {
      cancelled = true;
    } else {
      const onAbort = (): void => {
        cancelled = true;
        controller.abort(new Error('Pipeline cancelled'));
      };
      parentSignal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => parentSignal.removeEventListener('abort', onAbort));
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!cancelled && timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Step timed out after ${formatTimeout(timeoutMs)}`));
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }

  // Progress reporting must never break the step it is reporting on.
  try {
    options.onStart?.(step);
  } catch {
    /* ignored on purpose */
  }

  const finish = (): void => {
    for (const cleanup of cleanups) cleanup();
  };

  // Already cancelled: never start the step at all.
  if (cancelled) {
    finish();
    return {
      ...baseResult(step, startedAt, started),
      status: 'CANCELLED',
      timedOut: false,
      cancelled: true,
      error: 'Step was cancelled before it started.',
    };
  }

  let outcome: RaceOutcome;
  let stepPromise: Promise<StepResult> | undefined;
  try {
    stepPromise = step.run({ ...context, signal: controller.signal });
    // Orphan guard: if we stop awaiting first, a late rejection must not crash.
    stepPromise.catch(() => undefined);

    outcome = await Promise.race<RaceOutcome>([
      stepPromise.then(
        (result): RaceOutcome => ({ kind: 'settled', result }),
        (error): RaceOutcome => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      ),
      new Promise<RaceOutcome>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ kind: 'aborted' });
          return;
        }
        controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
      }),
    ]);
  } catch (error) {
    // Unexpected exception inside the step: normalize to a structured failure.
    return {
      ...baseResult(step, startedAt, started),
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    finish();
  }

  if (outcome.kind === 'aborted') {
    // Give a step with bounded cleanup the chance to report what it ran and
    // printed. Without this a timed-out step — the case where output matters
    // most — would be reported with no command and no output at all.
    const graceMs = options.abortGraceMs ?? step.abortGraceMs ?? 0;
    const late = graceMs > 0 && stepPromise ? await settleWithin(stepPromise, graceMs) : undefined;
    const evidence = abortEvidence(late);
    const unreported =
      graceMs > 0 && late === undefined
        ? ` The step did not report back within ${formatTimeout(graceMs)} of being stopped, so its output could not be captured.`
        : '';
    const base = baseResult(step, startedAt, started);

    if (timedOut) {
      return {
        ...base,
        ...evidence,
        status: 'FAIL',
        timedOut: true,
        cancelled: false,
        error: `Step timed out after ${formatTimeout(timeoutMs ?? 0)}${unreported}`,
      };
    }
    return {
      ...base,
      ...evidence,
      status: 'CANCELLED',
      timedOut: false,
      cancelled: true,
      error: `Step was cancelled.${unreported}`,
    };
  }

  const base = baseResult(step, startedAt, started);

  const returned = outcome.result;
  if (!returned || !isStepStatus(returned.status)) {
    return {
      ...base,
      status: 'FAIL',
      error: `Step "${step.id}" returned no valid status.`,
    };
  }

  // A step that reports its own cancellation is honoured as a cancellation even
  // if it noticed before the signal propagated to this runner. An upstream
  // cancellation (Ctrl+C) wins over the step's own verdict, because the run was
  // interrupted rather than genuinely failing.
  const cancelledByCaller = cancelled && !timedOut;
  let status: StepStatus = returned.status;
  if (cancelledByCaller || (status === 'PASS' && returned.cancelled === true)) {
    status = 'CANCELLED';
  }

  const normalized: StepResult = {
    ...base,
    ...returned,
    id: step.id,
    name: step.name,
    status,
    durationMs: base.durationMs,
    startedAt: base.startedAt,
    endedAt: base.endedAt,
    timedOut: returned.timedOut === true || timedOut,
    cancelled: status === 'CANCELLED' || returned.cancelled === true || cancelledByCaller,
  };

  // An unparseable duration from a step must not corrupt the report.
  if (typeof normalized.durationMs !== 'number' || !Number.isFinite(normalized.durationMs)) {
    normalized.durationMs = base.durationMs;
  }

  return normalized;
}