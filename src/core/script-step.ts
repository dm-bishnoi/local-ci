import { createProcessStep } from './process-step.js';
import type { ProcessExecutor } from './process-runner.js';
import type { PipelineStep } from './step-runner.js';

/** Package managers that can run a package.json script as `<manager> run <script>`. */
export type ScriptRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ScriptStepOptions {
  id: string;
  name?: string;
  /** Package manager that owns the project's scripts. */
  packageManager: ScriptRunner;
  /** package.json script name. Validated by the configuration schema. */
  script: string;
  /** Overrides the pipeline-wide timeout for this step. */
  timeoutMs?: number;
  /** Project directory; defaults to the run's working directory. */
  cwd?: string;
  /** Substitutes process execution. Used by tests. */
  exec?: ProcessExecutor;
}

/**
 * A step that runs one of the project's own package.json scripts.
 *
 * The command is an executable plus an argument vector — `npm run <script>` —
 * and goes through {@link createProcessStep}, so timeout, cancellation,
 * process-tree cleanup, output capture, secret masking and exit-code handling
 * are exactly those of every other step. This function adds no execution
 * logic of its own.
 */
export function createScriptStep(options: ScriptStepOptions): PipelineStep {
  return createProcessStep({
    id: options.id,
    ...(options.name !== undefined ? { name: options.name } : {}),
    command: options.packageManager,
    args: ['run', options.script],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.exec !== undefined ? { exec: options.exec } : {}),
  });
}

/**
 * The step for a script that does not exist in package.json.
 *
 * Reported as UNSUPPORTED, the status the Angular adapter uses for "no such
 * script", rather than launching the package manager just to watch it fail:
 * nothing is executed, and the reason names the script.
 */
export function createMissingScriptStep(id: string, name: string, script: string): PipelineStep {
  const error = `package.json has no script named "${script}", so step "${id}" cannot run. Add the script, or fix the name in .local-ci.yml.`;
  return {
    id,
    name,
    async run() {
      return { id, name, status: 'UNSUPPORTED', durationMs: 0, error };
    },
  };
}
