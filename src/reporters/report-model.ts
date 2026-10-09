/**
 * The report model: one derivation of a finished run into a shape every
 * reporter can render.
 *
 * ```
 * PipelineRunner
 *      ↓
 * collected StepResults
 *      ↓
 * buildRunReport()          ← this module: derive, redact, bound
 *      ↓
 *      ├── Console
 *      ├── JSON          (report.json)
 *      ├── Summary       (summary.json)
 *      ├── HTML          (report.html)
 *      └── Logs          (logs/<step-id>.log)
 * ```
 *
 * Everything that is security-relevant or size-relevant happens exactly once,
 * here. Reporters never re-derive a status, never re-redact a string and never
 * re-truncate output, so two reporters cannot disagree and a reporter cannot
 * accidentally serialize more than the model allows.
 *
 * Two properties are guaranteed by construction here:
 *
 * - **Bounded.** `RunReport` holds excerpted output only, so `JSON.stringify` on
 *   it cannot produce a multi-megabyte document. The untruncated, redacted
 *   output that the log files need travels beside the model in `BuiltReport`,
 *   not inside it.
 * - **Redacted.** Every string that came from a child process is masked again on
 *   the way in, against the ambient environment's secret values. Phase 2 already
 *   masks at capture time; this is a second, independent barrier, because a step
 *   is free to produce output by some other route (an in-process check, an
 *   injected executor, a framework adapter) and must still be reportable
 *   without leaking.
 */

import type { PipelineRunResult, PipelineStatus } from '../core/pipeline-runner.js';
import type { StepResult, StepStatus } from '../core/step-runner.js';
import { aggregateOutcomes, outcomeOf, RUN_OUTCOMES, type RunOutcome } from '../core/status.js';
import { REDACTED, redact, sensitiveEnvValues } from '../core/redaction.js';
import type { EnvironmentFingerprint } from '../env/fingerprint.js';
import type { DiagnosticReport } from '../diagnostics/types.js';
import type { CoverageInfo } from './coverage.js';
import { normalizeCoverage } from './coverage.js';
import { toLogFileName } from './paths.js';

/** Bumped when the on-disk shape of `report.json` changes incompatibly. */
export const REPORT_SCHEMA_VERSION = 1;

export const REPORT_JSON_VERSION = 1;
export const SUMMARY_JSON_VERSION = 1;

/**
 * Maximum characters of stdout/stderr embedded in `report.json` and
 * `report.html`. The full, redacted output still goes to `logs/<step>.log`, so
 * nothing is lost — it is simply not duplicated into two more files.
 */
export const DEFAULT_EXCERPT_LIMIT = 8_000;

/** Facts about the project that the run itself does not carry. */
export interface RunMetadata {
  /** `name` from package.json, falling back to the directory name. */
  projectName: string;
  /** `project.type` from .local-ci.yml. */
  projectType: string;
  /** Detected framework, e.g. `angular`. */
  framework: string | null;
  /** Detected package manager, e.g. `npm`. */
  packageManager: string | null;
}

/**
 * True when a step was dispatched to the runner.
 *
 * Results synthesized *without* dispatching anything — UNSUPPORTED, SKIPPED,
 * BLOCKED, ERROR — never get a log file. This is the single rule that keeps
 * placeholder logs out of an artifact directory. Adding a new non-executed
 * status means adding it here, which is deliberate: a fabricated log for a step
 * that never ran is exactly the kind of dishonesty this project exists to avoid.
 */
export function wasExecuted(status: StepStatus): boolean {
  return status === 'PASS' || status === 'FAIL' || status === 'CANCELLED';
}

export interface ReportStep {
  id: string;
  name: string;
  status: StepStatus;
  /**
   * Canonical classification, including `TIMEOUT`.
   *
   * `status` is the engine's verdict and is kept for backwards compatibility;
   * `outcome` is what consumers should branch on, because it separates a timeout
   * from an ordinary failure and adds BLOCKED and ERROR.
   */
  outcome: RunOutcome;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  /** Command line with credential arguments masked. */
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** True when the step exceeded its timeout. */
  timedOut: boolean;
  /** True when the step was interrupted by cancellation. */
  cancelled: boolean;
  /** False for UNSUPPORTED, SKIPPED, BLOCKED and ERROR steps, which never ran. */
  executed: boolean;
  error?: string;
  /** Log path relative to the run directory; absent when nothing was executed. */
  logPath?: string;
  /** Excerpted stderr, bounded to the excerpt limit. */
  stderr: string;
  /** Excerpted stdout, bounded to the excerpt limit. */
  stdout: string;
  /** True when stderr was longer than the excerpt limit. */
  stderrTruncated: boolean;
  /** True when stdout was longer than the excerpt limit. */
  stdoutTruncated: boolean;
}

export interface StepCounts {
  total: number;
  passed: number;
  failed: number;
  unsupported: number;
  skipped: number;
  cancelled: number;
  blocked: number;
  error: number;
  /** Steps that exceeded their timeout. */
  timeout: number;
}

export interface RunReport {
  schemaVersion: number;
  runId: string;
  projectName: string;
  projectType: string;
  framework: string | null;
  packageManager: string | null;
  status: PipelineStatus;
  cancelled: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Process exit code this run maps to. */
  exitCode: number;
  coverage: CoverageInfo;
  counts: StepCounts;
  /** Canonical classification of the run as a whole. */
  outcome: RunOutcome;
  /**
   * Machine and project fingerprint.
   *
   * Present whenever a fingerprint was collected. It is what makes a report
   * self-describing and what a later local-versus-CI comparison will diff.
   * Contains no environment variable values, no file contents and no secrets.
   */
  environment?: EnvironmentFingerprint;
  /** Result of the preflight that gated this run, when one ran. */
  preflight?: DiagnosticReport;
  steps: ReportStep[];
  /** When the report itself was produced. */
  generatedAt: string;
}

/** Full, redacted step output for the log writer. Never serialized. */
export interface StepLogSource {
  id: string;
  step: StepResult;
}

export interface BuiltReport {
  /** Bounded and directly serializable. */
  report: RunReport;
  /** Log bodies, for the files that are expected to hold complete output. */
  logs: StepLogSource[];
}

export interface BuildRunReportOptions {
  result: PipelineRunResult;
  metadata: RunMetadata;
  /** Coverage facts as measured from a real coverage summary. */
  coveragePercent?: number | null;
  coverageSource?: string | null;
  /** Extra secret values to mask beyond the ambient environment. */
  secrets?: readonly string[];
  /** Overrides the process exit code; defaults to the status mapping. */
  exitCode?: number;
  /** Characters of stdout/stderr kept in the report. */
  excerptLimit?: number;
  /** Machine and project fingerprint, when one was collected. */
  environment?: EnvironmentFingerprint;
  /** Preflight that gated this run, when one ran. */
  preflight?: DiagnosticReport;
  /** Clock injection point for deterministic tests. */
  now?: () => Date;
}

/** Exit code a run maps to. Success is exactly one thing: overall PASS. */
export function exitCodeForStatus(status: PipelineStatus): number {
  return status === 'PASS' ? 0 : 1;
}

export interface Excerpt {
  text: string;
  truncated: boolean;
}

/**
 * Keeps the tail of a stream.
 *
 * Failures announce themselves at the end of a build log, and the end is also
 * where a truncated tool reports what it dropped. The head of a 200k-character
 * Angular build log is the least useful part of it.
 */
export function excerpt(text: string | undefined, limit: number = DEFAULT_EXCERPT_LIMIT): Excerpt {
  if (!text) return { text: '', truncated: false };
  if (limit <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= limit) return { text, truncated: false };

  const dropped = text.length - limit;
  return { text: `... [${dropped} earlier character(s) omitted]\n${text.slice(text.length - limit)}`, truncated: true };
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === '' ? undefined : value;
}

/**
 * Credentials embedded in a URL, e.g. `postgres://admin:s3cr3t@db.internal`.
 *
 * Value-based redaction can only mask secrets it already knows about — values
 * found in the environment, or flags this process built. A tool that prints its
 * own connection string tells us nothing to match against, and the password is
 * plainly right there in the text.
 *
 * This is not a heuristic over arbitrary text: userinfo is a defined part of the
 * URL grammar, so "there are credentials before the `@`" is a fact about the
 * format rather than a guess. It is deliberately narrow — the host part of
 * `http://localhost:4200` cannot match, because a userinfo section must come
 * before any `/`.
 */
const URL_CREDENTIALS = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]+))?@/g;

/** Masks the password of a credential-bearing URL, leaving host and user. */
export function maskCredentialUrls(text: string): string {
  return text.replace(URL_CREDENTIALS, (_match, scheme: string, user: string, password?: string) =>
    password === undefined ? `${scheme}${user}@` : `${scheme}${user}:${REDACTED}@`,
  );
}

/**
 * The single masking step applied to every string that came from a child
 * process. Structure is masked first, then known values.
 *
 * Callers bound the result separately, and always *after* masking: cutting text
 * at a limit first could slice a mask in half and leave a partial secret visible.
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return redact(maskCredentialUrls(text), secrets);
}

function toCount(step: StepResult, counts: StepCounts): void {
  counts.total += 1;
  switch (outcomeOf(step)) {
    case 'PASS': counts.passed += 1; break;
    case 'FAIL': counts.failed += 1; break;
    case 'TIMEOUT': counts.timeout += 1; break;
    case 'UNSUPPORTED': counts.unsupported += 1; break;
    case 'SKIPPED': counts.skipped += 1; break;
    case 'CANCELLED': counts.cancelled += 1; break;
    case 'BLOCKED': counts.blocked += 1; break;
    case 'ERROR': counts.error += 1; break;
  }
}

/**
 * Tallies step outcomes.
 *
 * Counts the *outcome*, not the raw status, so a timeout is counted as a timeout
 * and never folded into `failed`. A reader looking at this table should be able
 * to tell "the tests failed" apart from "the tests never finished", and they
 * cannot do that if both land in one bucket.
 */
export function countSteps(steps: readonly StepResult[]): StepCounts {
  const counts: StepCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    unsupported: 0,
    skipped: 0,
    cancelled: 0,
    blocked: 0,
    error: 0,
    timeout: 0,
  };
  for (const step of steps) toCount(step, counts);
  return counts;
}

function toReportStep(step: StepResult, secrets: readonly string[], excerptLimit: number): ReportStep {
  const executed = wasExecuted(step.status);
  const stderr = excerpt(maskSecrets(step.stderr ?? '', secrets), excerptLimit);
  const stdout = excerpt(maskSecrets(step.stdout ?? '', secrets), excerptLimit);

  return {
    id: step.id,
    name: step.name,
    status: step.status,
    outcome: outcomeOf(step),
    durationMs: Number.isFinite(step.durationMs) && step.durationMs >= 0 ? step.durationMs : 0,
    ...(optional(step.startedAt) ? { startedAt: step.startedAt } : {}),
    ...(optional(step.endedAt) ? { endedAt: step.endedAt } : {}),
    ...(optional(maskSecrets(step.command ?? '', secrets)) ? { command: maskSecrets(step.command ?? '', secrets) } : {}),
    ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    ...(step.signal !== undefined ? { signal: step.signal } : {}),
    timedOut: step.timedOut === true,
    cancelled: step.cancelled === true || step.status === 'CANCELLED',
    executed,
    ...(optional(maskSecrets(step.error ?? '', secrets)) ? { error: maskSecrets(step.error ?? '', secrets) } : {}),
    ...(executed ? { logPath: `${'logs'}/${toLogFileName(step.id)}` } : {}),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

/**
 * Derives the full report from a finished run.
 *
 * Pure: it performs no I/O and mutates nothing, so a report can be built for a
 * cancelled run, a failed run and a run that never started its first step, with
 * identical treatment.
 */
export function buildRunReport(options: BuildRunReportOptions): BuiltReport {
  const { result, metadata } = options;
  const now = options.now ?? ((): Date => new Date());
  const excerptLimit = options.excerptLimit ?? DEFAULT_EXCERPT_LIMIT;

  // Read sensitive values only to mask them. They are never stored, never
  // serialized and never written to disk.
  const secrets: string[] = [...sensitiveEnvValues(process.env), ...(options.secrets ?? [])];

  const steps = result.steps.map((step) => toReportStep(step, secrets, excerptLimit));
  const counts = countSteps(result.steps);
  // The run's overall outcome is derived from the steps, not from the status
  // alone, so a run whose status is PASS but whose steps include a BLOCKED
  // result can never be presented as a clean pass.
  const outcome: RunOutcome =
    result.status === 'CANCELLED'
      ? 'CANCELLED'
      : aggregateOutcomes(steps.map((step) => step.outcome));

  const report: RunReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: result.runId,
    projectName: metadata.projectName,
    projectType: metadata.projectType,
    framework: metadata.framework,
    packageManager: metadata.packageManager,
    status: result.status,
    cancelled: result.status === 'CANCELLED',
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0,
    exitCode: options.exitCode ?? exitCodeForStatus(result.status),
    coverage: normalizeCoverage({
      percent: options.coveragePercent ?? null,
      source: options.coverageSource ?? null,
      steps: result.steps,
    }),
    counts,
    outcome,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    steps,
    generatedAt: now().toISOString(),
  };

  // Only steps that actually ran contribute a log body.
  const logs: StepLogSource[] = result.steps
    .filter((step) => wasExecuted(step.status))
    .map((step) => ({
      id: step.id,
      step: {
        ...step,
        // The log file is the one artifact that carries complete output, so it
        // is masked here too — masking is not a property of the excerpt.
        stdout: maskSecrets(step.stdout ?? '', secrets),
        stderr: maskSecrets(step.stderr ?? '', secrets),
        error: maskSecrets(step.error ?? '', secrets),
        command: maskSecrets(step.command ?? '', secrets),
      },
    }));

  return { report, logs };
}

const RUN_STATUSES: readonly PipelineStatus[] = ['PASS', 'FAIL', 'CANCELLED'];
const STEP_STATUSES: readonly StepStatus[] = [
  'PASS',
  'FAIL',
  'UNSUPPORTED',
  'SKIPPED',
  'CANCELLED',
  'BLOCKED',
  'ERROR',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(source: Record<string, unknown>, key: string, fallback = 0): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNullableNumber(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function readNullableString(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function readStatus(source: Record<string, unknown>): StepStatus {
  const status = source['status'];
  return typeof status === 'string' && (STEP_STATUSES as readonly string[]).includes(status)
    ? (status as StepStatus)
    : 'FAIL';
}

function readOutcome(source: Record<string, unknown>, status: StepStatus, timedOut: boolean): RunOutcome {
  const value = source['outcome'];
  // A report written before `outcome` existed is still readable: it is
  // re-derived from the status and the timeout flag rather than rejected.
  return typeof value === 'string' && (RUN_OUTCOMES as readonly string[]).includes(value)
    ? (value as RunOutcome)
    : outcomeOf({ status, timedOut });
}

function decodeStep(value: unknown): ReportStep {
  const source = isRecord(value) ? value : {};
  const status = readStatus(source);
  const executed = typeof source['executed'] === 'boolean' ? source['executed'] : wasExecuted(status);
  const timedOut = readBoolean(source, 'timedOut');

  return {
    id: readString(source, 'id', 'step'),
    name: readString(source, 'name', 'step'),
    status,
    outcome: readOutcome(source, status, timedOut),
    durationMs: readNumber(source, 'durationMs'),
    ...(readString(source, 'startedAt') ? { startedAt: readString(source, 'startedAt') } : {}),
    ...(readString(source, 'endedAt') ? { endedAt: readString(source, 'endedAt') } : {}),
    ...(readString(source, 'command') ? { command: readString(source, 'command') } : {}),
    ...(readNullableNumber(source, 'exitCode') !== undefined
      ? { exitCode: readNullableNumber(source, 'exitCode') }
      : {}),
    ...(readNullableString(source, 'signal') !== undefined ? { signal: readNullableString(source, 'signal') } : {}),
    timedOut,
    cancelled: readBoolean(source, 'cancelled'),
    executed,
    ...(readString(source, 'error') ? { error: readString(source, 'error') } : {}),
    ...(readString(source, 'logPath') ? { logPath: readString(source, 'logPath') } : {}),
    stdout: readString(source, 'stdout'),
    stderr: readString(source, 'stderr'),
    stdoutTruncated: readBoolean(source, 'stdoutTruncated'),
    stderrTruncated: readBoolean(source, 'stderrTruncated'),
  };
}

export class ReportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportFormatError';
  }
}

/**
 * Rebuilds a {@link RunReport} from stored JSON.
 *
 * Used by `local-ci report`, which reads a file this process did not write and
 * must therefore treat as untrusted: missing fields fall back to safe defaults,
 * and an unrecognised status degrades to `FAIL` rather than being passed
 * through. A corrupt file becomes one clear message, never a stack trace.
 */
export function decodeRunReport(value: unknown): RunReport {
  if (!isRecord(value)) {
    throw new ReportFormatError('The stored report is not a JSON object.');
  }
  if (readString(value, 'runId') === '') {
    throw new ReportFormatError('The stored report has no runId.');
  }

  const status = readString(value, 'status');
  const resolvedStatus: PipelineStatus = (RUN_STATUSES as readonly string[]).includes(status)
    ? (status as PipelineStatus)
    : 'FAIL';

  const rawSteps = Array.isArray(value['steps']) ? (value['steps'] as unknown[]) : [];
  const steps = rawSteps.map(decodeStep);

  const coverage = isRecord(value['coverage']) ? value['coverage'] : {};
  const coverageState = readString(coverage, 'state');
  const coveragePercent = readNullableNumber(coverage, 'percent') ?? null;

  return {
    schemaVersion: readNumber(value, 'schemaVersion', REPORT_SCHEMA_VERSION),
    runId: readString(value, 'runId'),
    projectName: readString(value, 'projectName', 'unknown project'),
    projectType: readString(value, 'projectType', 'unknown'),
    framework: readString(value, 'framework') || null,
    packageManager: readString(value, 'packageManager') || null,
    status: resolvedStatus,
    cancelled: readBoolean(value, 'cancelled', resolvedStatus === 'CANCELLED'),
    startedAt: readString(value, 'startedAt'),
    endedAt: readString(value, 'endedAt'),
    durationMs: readNumber(value, 'durationMs'),
    exitCode: readNumber(value, 'exitCode', exitCodeForStatus(resolvedStatus)),
    coverage: {
      state:
        coverageState === 'available' || coverageState === 'unsupported'
          ? coverageState
          : 'unavailable',
      percent: coveragePercent,
      source: readString(coverage, 'source') || null,
      reason: readString(coverage, 'reason') || null,
    },
    counts: isRecord(value['counts'])
      ? {
          total: readNumber(value['counts'], 'total', steps.length),
          passed: readNumber(value['counts'], 'passed'),
          failed: readNumber(value['counts'], 'failed'),
          unsupported: readNumber(value['counts'], 'unsupported'),
          skipped: readNumber(value['counts'], 'skipped'),
          cancelled: readNumber(value['counts'], 'cancelled'),
          // Added in Phase 4.5; older reports have no such key and default to 0.
          blocked: readNumber(value['counts'], 'blocked'),
          error: readNumber(value['counts'], 'error'),
          timeout: readNumber(value['counts'], 'timeout'),
        }
      : countSteps(steps as unknown as StepResult[]),
    outcome: ((): RunOutcome => {
      const value2 = value['outcome'];
      return resolvedStatus === 'CANCELLED'
        ? 'CANCELLED'
        : typeof value2 === 'string' && (RUN_OUTCOMES as readonly string[]).includes(value2)
          ? (value2 as RunOutcome)
          : aggregateOutcomes(steps.map((step) => step.outcome));
    })(),
    ...(isRecord(value['environment']) ? { environment: value['environment'] as unknown as EnvironmentFingerprint } : {}),
    ...(isRecord(value['preflight']) ? { preflight: value['preflight'] as unknown as DiagnosticReport } : {}),
    steps,
    generatedAt: readString(value, 'generatedAt'),
  };
}