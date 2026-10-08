import { execa, type ResultPromise } from 'execa';
import { redact, sensitiveEnvValues, truncate } from './redaction.js';

/**
 * Structured outcome of a single child process.
 *
 * Everything here is JSON-serializable and safe to place in a report: captured
 * output has been truncated and masked, and the environment is never included.
 */
export interface ProcessResult {
  /** Executable that was launched. */
  command: string;
  /** Arguments passed to the executable (as given, not masked). */
  args: string[];
  /** Exit code, or `null` when the process was signalled or never spawned. */
  exitCode: number | null;
  /** Terminating signal, or `null`. */
  signal: string | null;
  /** Captured stdout, truncated and redacted. */
  stdout: string;
  /** Captured stderr, truncated and redacted. */
  stderr: string;
  /** Wall-clock duration of the process. */
  durationMs: number;
  /** True when the process was terminated because the timeout elapsed. */
  timedOut: boolean;
  /** True when the process was terminated because its AbortSignal fired. */
  cancelled: boolean;
  /** True when the process did not complete successfully. */
  failed: boolean;
  /** Human-readable failure description, absent on success. */
  error?: string;
  /** Underlying OS/code error such as `ENOENT`, when one exists. */
  errorCode?: string;
}

export interface RunProcessOptions {
  cwd: string;
  /** Extra environment for the child. Never serialized into results. */
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Terminates the child process when aborted. */
  signal?: AbortSignal;
  /** Written to the child's stdin. */
  input?: string;
  /** Hard cap on buffered output before the child is failed. */
  maxBufferBytes?: number;
  /** Maximum characters retained per stream in the result. */
  maxCaptureChars?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_CHARS = 200_000;
/** Grace period between the termination signal and a forced kill. */
const FORCE_KILL_DELAY_MS = 2_000;

/**
 * execa's result type is conditional on the `reject` option, which erases the
 * error-related fields to `unknown` when `reject: false`. Coercing through this
 * shape keeps the runner honest without fighting the generic types.
 */
interface RawResult {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  timedOut?: unknown;
  isCanceled?: unknown;
  failed?: unknown;
  shortMessage?: unknown;
  message?: unknown;
  code?: unknown;
  durationMs?: unknown;
}

/**
 * Normalizes execa output (string | Uint8Array | string[] | undefined)
 * to plain text for reports without leaking raw binary shapes.
 */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  if (Array.isArray(value)) return value.map((entry) => toText(entry)).join('\n');
  if (value == null) return '';
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cancelledBeforeStart(command: string, args: readonly string[]): ProcessResult {
  return {
    command,
    args: [...args],
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    cancelled: true,
    failed: true,
    error: 'Process was cancelled before it started.',
  };
}

/**
 * Executes a fixed executable + argument vector. The core never evaluates a
 * shell string, which avoids accidental shell interpretation by default.
 *
 * Never throws for process-level failures: a missing executable, a non-zero
 * exit, a timeout and a cancellation all resolve to a structured
 * {@link ProcessResult} so callers can report them distinctly.
 */
export async function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  // Never spawn anything once the caller has already given up.
  if (options.signal?.aborted) return cancelledBeforeStart(executable, args);

  const maxCaptureChars = options.maxCaptureChars ?? DEFAULT_MAX_CAPTURE_CHARS;
  // Read sensitive values from the ambient and supplied environments purely to
  // mask them from captured output. They are never stored or serialized.
  const secrets = [...sensitiveEnvValues(process.env), ...sensitiveEnvValues(options.env)];

  const started = performance.now();
  const child: ResultPromise = execa(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeoutMs,
    cancelSignal: options.signal,
    reject: false,
    shell: false,
    extendEnv: true,
    cleanup: true,
    forceKillAfterDelay: FORCE_KILL_DELAY_MS,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  });

  const raw = (await child) as unknown as RawResult;

  const timedOut = raw.timedOut === true;
  const cancelled = raw.isCanceled === true;
  const exitCode = toNumberOrNull(raw.exitCode);
  const signal = toStringOrNull(raw.signal);
  const failed = raw.failed === true || exitCode === null || exitCode !== 0;

  const result: ProcessResult = {
    command: executable,
    args: [...args],
    // A signalled process has no exit code. Report null rather than inventing 0.
    exitCode,
    signal,
    stdout: redact(truncate(toText(raw.stdout), maxCaptureChars), secrets),
    stderr: redact(truncate(toText(raw.stderr), maxCaptureChars), secrets),
    durationMs: toNumberOrNull(raw.durationMs) ?? Math.round(performance.now() - started),
    timedOut,
    cancelled,
    failed,
  };

  if (failed) {
    // execa's shortMessage echoes the command line, so it is masked and
    // truncated exactly like captured output.
    result.error = redact(
      truncate(describeFailure(raw, { timedOut, cancelled, exitCode, signal }), maxCaptureChars),
      secrets,
    );
    const code = toStringOrNull(raw.code);
    if (code) result.errorCode = code;
  }

  return result;
}

function describeFailure(
  raw: RawResult,
  info: { timedOut: boolean; cancelled: boolean; exitCode: number | null; signal: string | null },
): string {
  const short = toStringOrNull(raw.shortMessage) ?? toStringOrNull(raw.message);

  if (info.timedOut) return short ?? 'Process timed out and was terminated.';
  if (info.cancelled) return short ?? 'Process was cancelled and terminated.';
  if (short) return short;
  if (info.signal !== null) return `Process was terminated by ${info.signal}.`;
  if (info.exitCode !== null) return `Process exited with code ${info.exitCode}.`;
  return 'Process failed to run.';
}