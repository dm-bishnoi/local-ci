import { runProcess, type ProcessExecutor, type ProcessResult } from './process-runner.js';
import { describeCommand } from './redaction.js';
import type { PipelineContext } from './context.js';
import type { PipelineStep, StepResult } from './step-runner.js';

/**
 * A verdict on output, applied only to a process that exited 0 and was neither
 * cancelled nor timed out. It can turn a pass into a failure (a formatter that
 * lists files and still exits 0); it can never turn anything into a pass.
 */
export type ProcessEvaluator = (result: ProcessResult) => { status: 'PASS' } | { status: 'FAIL'; error: string };

export interface ProcessStepOptions {
  id: string;
  name?: string;
  /** Executable to launch. Never passed through a shell. */
  command: string;
  args?: readonly string[];
  /** Defaults to the project working directory. */
  cwd?: string;
  /** Extra environment. Never serialized into reports. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the pipeline-wide timeout for this step. */
  timeoutMs?: number;
  input?: string;
  /**
   * Overrides how the process is executed. Defaults to the real executor.
   * Adapters pass this through so a command can be observed without spawning.
   */
  exec?: ProcessExecutor;
  /** Judges the output of a process that exited 0. */
  evaluate?: ProcessEvaluator;
}

/**
 * How long the step runner waits, after a timeout or cancellation, for the
 * process to be terminated and its captured output returned.
 *
 * Process termination is itself bounded (a polite kill, a grace period, then a
 * forced kill), so in practice this returns in well under a second; the cap
 * only matters if a descendant escapes the tree kill and keeps stdio open.
 */
export const PROCESS_ABORT_GRACE_MS = 15_000;

/**
 * Builds a framework-agnostic {@link PipelineStep} backed by a single child
 * process. This is the generic bridge between the execution engine and any
 * adapter: adapters describe *which* command to run, this factory describes
 * *how* it is run (timeout, cancellation, capture, redaction).
 *
 * No shell is involved and arguments are passed as a vector, so values are
 * never interpolated into a command string.
 */
export function createProcessStep(options: ProcessStepOptions): PipelineStep {
  const args = options.args ?? [];

  return {
    id: options.id,
    name: options.name ?? options.id,
    abortGraceMs: PROCESS_ABORT_GRACE_MS,
    // The runner enforces the limit too, so it must see the step's own value.
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async run(context: PipelineContext): Promise<StepResult> {
      const execute = options.exec ?? runProcess;
      const result = await execute(options.command, args, {
        cwd: options.cwd ?? context.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? context.config.settings.timeoutMs,
        signal: context.signal,
        input: options.input,
      });

      let status: 'PASS' | 'FAIL' | 'CANCELLED' = result.cancelled ? 'CANCELLED' : result.failed ? 'FAIL' : 'PASS';
      const verdict = status === 'PASS' && !result.timedOut ? options.evaluate?.(result) : undefined;
      if (verdict?.status === 'FAIL') status = 'FAIL';
      const stepResult: StepResult = {
        id: options.id,
        name: options.name ?? options.id,
        status,
        durationMs: result.durationMs,
        command: describeCommand(options.command, args),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        stdout: result.stdout,
        stderr: result.stderr,
      };

      // Only surface stderr as the headline error when the process said nothing
      // more specific on stdout.
      if (verdict?.status === 'FAIL') stepResult.error = verdict.error;
      else if (result.error) stepResult.error = result.error;
      else if (result.stderr.trim()) stepResult.error = result.stderr.trim();

      return stepResult;
    },
  };
}