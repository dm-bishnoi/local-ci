/**
 * The canonical result vocabulary.
 *
 * This is the single place that defines what a run *means*. Two concepts are
 * kept deliberately separate, because conflating them loses information:
 *
 * - {@link StepStatus} is the **engine's verdict**. It is what a step runner
 *   observed and returned. It is small, stable, and is what `PipelineRunner`
 *   aggregates on.
 * - {@link RunOutcome} is the **canonical classification** used for reporting,
 *   aggregation and success decisions. It can distinguish outcomes the engine's
 *   verdict folds together — most importantly `TIMEOUT`, which the engine
 *   reports as `FAIL` with `timedOut: true`.
 *
 * The split exists so `TIMEOUT` can be a first-class, non-`PASS` outcome
 * everywhere it matters (console, HTML, JSON counts, exit codes) without
 * changing the engine's long-standing wire format.
 *
 * The invariant that matters above all others:
 *
 *     BLOCKED     != PASS
 *     UNSUPPORTED != PASS
 *     SKIPPED     != PASS
 *     TIMEOUT     != PASS
 *     CANCELLED   != PASS
 *     ERROR       != PASS
 *
 * A missing capability, a missing requirement, a timeout, an interruption and
 * an internal fault are five different facts. None of them is success, and none
 * of them may be presented as success.
 */

/** Terminal states a step can end in, as observed by the engine. */
export type StepStatus =
  | 'PASS'
  | 'FAIL'
  | 'UNSUPPORTED'
  | 'SKIPPED'
  | 'CANCELLED'
  /** A known requirement (tool, environment variable, capability) prevented execution. */
  | 'BLOCKED'
  /** An unexpected internal or system error prevented a meaningful verdict. */
  | 'ERROR';

/** Every terminal state, in the order used for reporting. */
export const STEP_STATUSES: readonly StepStatus[] = [
  'PASS',
  'FAIL',
  'UNSUPPORTED',
  'SKIPPED',
  'BLOCKED',
  'CANCELLED',
  'ERROR',
];

/**
 * The canonical classification of a step or a whole run.
 *
 * Superset of {@link StepStatus} plus `TIMEOUT`, which the engine expresses as
 * `FAIL` + `timedOut`.
 */
export type RunOutcome =
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED'
  | 'BLOCKED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'ERROR';

/** Every canonical outcome, in reporting order. */
export const RUN_OUTCOMES: readonly RunOutcome[] = [
  'PASS',
  'FAIL',
  'SKIPPED',
  'BLOCKED',
  'UNSUPPORTED',
  'TIMEOUT',
  'CANCELLED',
  'ERROR',
];

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value);
}

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === 'string' && (RUN_OUTCOMES as readonly string[]).includes(value);
}

/** The minimum a step must expose to be classified. */
export interface ClassifiableResult {
  status: StepStatus;
  timedOut?: boolean;
}

/**
 * Classifies a step into its canonical outcome.
 *
 * A timeout is a failure of a particular kind, not a generic failure: the work
 * was attempted and ran out of time. Surfacing it as its own outcome keeps the
 * cause visible to a reader instead of hiding it inside `FAIL`.
 */
export function outcomeOf(result: ClassifiableResult): RunOutcome {
  if (result.status === 'FAIL' && result.timedOut === true) return 'TIMEOUT';
  return result.status;
}

/**
 * The only success condition.
 *
 * `SKIPPED` is not a success: a step that was intentionally not executed
 * provides no evidence that the project works. A run is successful when its
 * overall status is `PASS` **and** every step it classified is `PASS`.
 */
export function isSuccess(outcome: RunOutcome): boolean {
  return outcome === 'PASS';
}

/** True for any outcome that means "this did not succeed, and did not run". */
export function isNotExecuted(outcome: RunOutcome): boolean {
  return outcome === 'SKIPPED' || outcome === 'UNSUPPORTED' || outcome === 'BLOCKED';
}

/**
 * Aggregates step outcomes into one run outcome.
 *
 * Severity order, most serious first: `ERROR` > `CANCELLED` > `BLOCKED` >
 * `FAIL`/`TIMEOUT` > `UNSUPPORTED` > `SKIPPED` > `PASS`.
 *
 * An empty set of steps is not a pass. A run that executed nothing and was not
 * explicitly cancelled reports `SKIPPED`, never `PASS`, so that "nothing ran"
 * can never be mistaken for "everything worked".
 */
export function aggregateOutcomes(outcomes: readonly RunOutcome[]): RunOutcome {
  if (outcomes.length === 0) return 'SKIPPED';

  const severity: RunOutcome[] = ['ERROR', 'CANCELLED', 'BLOCKED', 'FAIL', 'TIMEOUT', 'UNSUPPORTED', 'SKIPPED', 'PASS'];
  for (const candidate of severity) {
    if (outcomes.includes(candidate)) return candidate;
  }
  return 'SKIPPED';
}

/** Per-outcome tallies. Every outcome is present, so counts never surprise. */
export type OutcomeCounts = Record<RunOutcome, number>;

export function countOutcomes(outcomes: readonly RunOutcome[]): OutcomeCounts {
  const counts: OutcomeCounts = {
    PASS: 0,
    FAIL: 0,
    SKIPPED: 0,
    BLOCKED: 0,
    UNSUPPORTED: 0,
    TIMEOUT: 0,
    CANCELLED: 0,
    ERROR: 0,
  };
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

/** Process exit code for an outcome. Only `PASS` is zero. */
export function exitCodeForOutcome(outcome: RunOutcome): number {
  return isSuccess(outcome) ? 0 : 1;
}