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
}

export interface StepRunOptions {
  /** Overrides the configured timeout for this step. */
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? context.config.settings.timeoutMs;

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
  try {
    const stepPromise = step.run({ ...context, signal: controller.signal });
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

  const base = baseResult(step, startedAt, started);

  if (outcome.kind === 'aborted') {
    if (timedOut) {
      return {
        ...base,
        status: 'FAIL',
        timedOut: true,
        cancelled: false,
        error: `Step timed out after ${formatTimeout(timeoutMs ?? 0)}`,
      };
    }
    return {
      ...base,
      status: 'CANCELLED',
      timedOut: false,
      cancelled: true,
      error: 'Step was cancelled.',
    };
  }

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