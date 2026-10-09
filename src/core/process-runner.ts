import { execa, type ResultPromise } from 'execa';
import { redact, sensitiveEnvValues, truncate } from './redaction.js';
import { DETACHED_CHILD, terminateTree, treeTerminatorFor, type TreeTerminator } from './process-tree.js';

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
  /** Overrides the process-tree terminator. Tests inject a fake here. */
  treeTerminator?: TreeTerminator;
  /** Grace period between the polite and forced tree kill. */
  forceKillAfterMs?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_CHARS = 200_000;
/** Grace period between the polite and forced tree kill. */
const FORCE_KILL_DELAY_MS = 2_000;
/**
 * Reported as the terminating signal when local-ci itself kills a process tree.
 *
 * Windows force-kills with `taskkill /F`, which has no signal name; SIGKILL is
 * the POSIX term for the same outcome and keeps the field meaningful on every
 * platform.
 */
const FORCED_TERMINATION_SIGNAL = 'SIGKILL';

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
/**
 * Injection seam for process execution.
 *
 * Adapters and tests can substitute an executor to observe or fake a command
 * without spawning anything. The default is {@link runProcess}, which is the
 * only implementation that touches a real child process.
 */
export type ProcessExecutor = (
  executable: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

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

  // Termination is managed here rather than delegated to execa. execa's own
  // timeout and cancel only reach the direct child; a package-manager shim would
  // leave its own children running, holding the inherited stdio handles open and
  // keeping this promise alive long after the step was declared over.
  //
  // `detached` gives POSIX children their own process group so a single signal
  // can reach the whole tree.
  const terminator = options.treeTerminator ?? treeTerminatorFor();
  const child: ResultPromise = execa(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    // Rejecting is disabled so every outcome resolves rather than throws.
    reject: false,
    shell: false,
    extendEnv: true,
    cleanup: true,
    detached: DETACHED_CHILD,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  });

  const pid = child.pid;
  const stop = new TreeStop();

  let timedOut = false;
  let cancelled = false;

  const terminate = (): void => {
    void terminateTree(pid, terminator, options.forceKillAfterMs ?? FORCE_KILL_DELAY_MS);
  };

  if (options.timeoutMs !== undefined) {
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    // A pending timer must never hold the event loop open after the step ended.
    timer.unref?.();
    stop.add(() => clearTimeout(timer));
  }

  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  stop.add(() => options.signal?.removeEventListener('abort', onAbort));

  let raw: RawResult;
  try {
    raw = (await child) as unknown as RawResult;
  } finally {
    stop.dispose();
  }

  // A terminated process has no exit status of its own.
  //
  // When *we* terminate the process (timeout or cancellation) the value the OS
  // reports describes our kill, not the program's intent: a force-killed
  // Windows process reports exit code 1, which would read as "the tool exited
  // 1" when in fact it never got to exit. Reporting null alongside the signal
  // keeps the two facts separate and avoids inventing an exit code.
  const observedExitCode = toNumberOrNull(raw.exitCode);
  const observedSignal = toStringOrNull(raw.signal);
  const terminatedByUs = timedOut || cancelled;
  const exitCode = terminatedByUs ? null : observedExitCode;
  const signal = terminatedByUs ? (observedSignal ?? FORCED_TERMINATION_SIGNAL) : observedSignal;
  const failed = exitCode !== 0;

  const result: ProcessResult = {
    command: executable,
    args: [...args],
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
    result.error = redact(
      truncate(describeFailure(executable, { timedOut, cancelled, exitCode, signal }), maxCaptureChars),
      secrets,
    );
    const code = toStringOrNull((raw as RawResult).code);
    if (code) result.errorCode = code;
  }

  return result;
}

/** Runs cleanup callbacks exactly once, in reverse registration order. */
class TreeStop {
  private actions: Array<() => void> = [];
  private done = false;

  add(action: () => void): void {
    this.actions.push(action);
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const action of this.actions.reverse()) {
      try {
        action();
      } catch {
        /* cleanup must never mask the original result */
      }
    }
    this.actions = [];
  }
}

function describeFailure(
  executable: string,
  info: { timedOut: boolean; cancelled: boolean; exitCode: number | null; signal: string | null },
): string {
  // The message is composed here rather than taken from execa's `shortMessage`,
  // because termination is now driven by this module rather than by execa and
  // execa no longer knows why the process ended.
  if (info.timedOut) return `Step timed out and "${executable}" was terminated.`;
  if (info.cancelled) return `Execution was cancelled and "${executable}" was terminated.`;
  if (info.signal !== null) return `Process was terminated by ${info.signal}.`;
  if (info.exitCode !== null) return `Process exited with code ${info.exitCode}.`;
  return 'Process failed to run.';
}