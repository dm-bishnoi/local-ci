/**
 * The diagnostic vocabulary shared by `doctor` and `preflight`.
 *
 * Both commands answer the same kind of question — "can this machine run this
 * project?" — so they share one severity model rather than inventing two that
 * would then drift apart.
 *
 * The severity set is the heart of DETECT → SOLVE/GUIDE → VERIFY:
 *
 * | Severity      | Meaning                                                      |
 * |---------------|--------------------------------------------------------------|
 * | `PASS`        | Verified good. The check actually ran and the answer is yes.   |
 * | `WARNING`     | Something is missing or off, but the pipeline can still run.   |
 * | `BLOCKED`     | A known requirement prevents execution. Must not run.          |
 * | `UNSUPPORTED` | Local CI cannot perform this capability, on any machine.        |
 * | `ERROR`       | The check itself failed; the answer is genuinely unknown.      |
 * | `UNKNOWN`     | Deliberate: we could not determine this, and will not guess.   |
 *
 * `UNKNOWN` is what makes the whole thing honest. Anything that could not be
 * verified is reported as unverified rather than optimistically passed.
 */

/** Ordered from most severe to least, so a section can show the worst first. */
export const SEVERITIES = ['ERROR', 'BLOCKED', 'WARNING', 'UNKNOWN', 'UNSUPPORTED', 'PASS'] as const;

export type Severity = (typeof SEVERITIES)[number];

/** Grouping used to lay out diagnostic output. */
export type DiagnosticCategory =
  | 'environment'
  | 'project'
  | 'requirements'
  | 'pipeline'
  | 'configuration';

export interface Diagnostic {
  /** Stable identifier, e.g. `node-version` or `env-var:DATABASE_URL`. */
  id: string;
  /** Short label for a list of checks, e.g. `Node version`. */
  label: string;
  severity: Severity;
  category: DiagnosticCategory;
  /** One-line factual statement of what was observed. */
  detail: string;
  /** What the user should do about it. Present whenever there is something to do. */
  recommendation?: string;
  /**
   * Pipeline step ids this diagnostic applies to.
   *
   * Absent means it is global. A scoped blocker blocks only those steps, which
   * is what lets a missing browser block `test` without blocking `build`.
   */
  steps?: string[];
}

/** Overall verdict of a diagnostic run. The worst severity present. */
export type DiagnosticVerdict = 'PASS' | 'WARNING' | 'BLOCKED' | 'ERROR';

export interface DiagnosticReport {
  /** `doctor` or `preflight`. */
  command: 'doctor' | 'preflight';
  verdict: DiagnosticVerdict;
  diagnostics: Diagnostic[];
  counts: Record<Severity, number>;
  /** When the diagnostic ran. */
  checkedAt: string;
}

export const SEVERITY_ICON: Record<Severity, string> = {
  PASS: '✓',
  WARNING: '⚠',
  BLOCKED: '⊘',
  UNSUPPORTED: '!',
  ERROR: '✗',
  UNKNOWN: '?',
};

/** `ERROR` and `BLOCKED` both prevent execution; the rest do not. */
export function isBlocking(severity: Severity): boolean {
  return severity === 'BLOCKED' || severity === 'ERROR';
}

/**
 * Derives the overall verdict from the diagnostics.
 *
 * Only `PASS` when every check genuinely passed. A report containing a single
 * `UNKNOWN` is a `WARNING`, never a `PASS`: an unverifiable check is exactly the
 * case the product principle exists to handle.
 */
export function verdictOf(diagnostics: readonly Diagnostic[]): DiagnosticVerdict {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'ERROR')) return 'ERROR';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'BLOCKED')) return 'BLOCKED';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'WARNING')) return 'WARNING';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'UNKNOWN')) return 'WARNING';
  // An unsupported capability is not a clean pass either: the pipeline as
  // configured cannot fully run. It is a warning rather than a blocker because
  // execution may still be attempted — the affected step reports UNSUPPORTED.
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'UNSUPPORTED')) return 'WARNING';
  return 'PASS';
}

export function countSeverities(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    PASS: 0,
    WARNING: 0,
    BLOCKED: 0,
    UNSUPPORTED: 0,
    ERROR: 0,
    UNKNOWN: 0,
  };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

/** Diagnostics that prevent execution, optionally narrowed to one step. */
export function blockingDiagnostics(
  diagnostics: readonly Diagnostic[],
  stepId?: string,
): Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      isBlocking(diagnostic.severity) && (stepId === undefined || diagnostic.steps === undefined || diagnostic.steps.includes(stepId)),
  );
}

/** Steps blocked by at least one scoped or global blocker. */
export function stepsBlockedBy(diagnostics: readonly Diagnostic[], pipeline: readonly string[]): Set<string> {
  const blockers = diagnostics.filter((diagnostic) => isBlocking(diagnostic.severity));
  const blocked = new Set<string>();

  const configured = new Set(pipeline);
  for (const blocker of blockers) {
    // A global blocker (no `steps`) blocks the entire pipeline.
    if (blocker.steps === undefined) {
      for (const step of pipeline) blocked.add(step);
    } else {
      // A scoped blocker only matters for steps this pipeline actually runs;
      // reporting `e2e` as blocked in a pipeline that has no e2e step would be
      // noise the reader cannot act on.
      for (const step of blocker.steps) if (configured.has(step)) blocked.add(step);
    }
  }

  return blocked;
}

/** Builds a report from a list of diagnostics. */
export function buildDiagnosticReport(
  command: 'doctor' | 'preflight',
  diagnostics: readonly Diagnostic[],
  checkedAt: Date = new Date(),
): DiagnosticReport {
  return {
    command,
    verdict: verdictOf(diagnostics),
    diagnostics: [...diagnostics],
    counts: countSeverities(diagnostics),
    checkedAt: checkedAt.toISOString(),
  };
}

/** Human-readable label for a verdict. */
export function verdictLabel(verdict: DiagnosticVerdict): string {
  return verdict;
}