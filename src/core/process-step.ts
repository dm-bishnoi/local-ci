import { runProcess, type ProcessExecutor } from './process-runner.js';
import { describeCommand } from './redaction.js';
import type { PipelineContext } from './context.js';
import type { PipelineStep, StepResult } from './step-runner.js';

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
}

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
    async run(context: PipelineContext): Promise<StepResult> {
      const execute = options.exec ?? runProcess;
      const result = await execute(options.command, args, {
        cwd: options.cwd ?? context.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? context.config.settings.timeoutMs,
        signal: context.signal,
        input: options.input,
      });

      const status = result.cancelled ? 'CANCELLED' : result.failed ? 'FAIL' : 'PASS';
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
      if (result.error) stepResult.error = result.error;
      else if (result.stderr.trim()) stepResult.error = result.stderr.trim();

      return stepResult;
    },
  };
}