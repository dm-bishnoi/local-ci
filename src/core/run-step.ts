import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveProjectDir } from '../config/projects.js';
import { BARE_EXECUTABLE, type RunStepDefinition } from '../config/schema.js';
import type { PipelineContext } from './context.js';
import type { ProcessExecutor } from './process-runner.js';
import { PROCESS_ABORT_GRACE_MS, createProcessStep } from './process-step.js';
import { describeCommand } from './redaction.js';
import {
  WINDOWS_EXECUTABLE_EXTENSIONS,
  isBatchFile,
  isExecutableFile,
  resolveOnPath,
  windowsCandidates,
  type ResolveOptions,
} from './resolve-executable.js';
import type { PipelineStep, StepResult } from './step-runner.js';

/**
 * Custom `run: [exe, ...args]` steps.
 *
 * Threat model: the configuration file is written by the project, but it is
 * checked into a repository other people can change, and it must never become a
 * way to run something the author did not literally write. So:
 *
 * - There is no shell. The executable and each argument reach the operating
 *   system as separate values; nothing is split, quoted, expanded or globbed.
 * - The executable is resolved here, to an absolute path, from PATH (absolute
 *   entries only) or from inside the project. The current directory is never
 *   searched, and a project-relative path must stay inside the project after
 *   symlinks are resolved.
 * - `cwd` must be an existing directory inside the project.
 * - The environment cannot be set from configuration.
 * - On Windows a `.cmd`/`.bat` target is started through cmd.exe by the runtime,
 *   and batch files re-parse their arguments, so quoting cannot make arbitrary
 *   text safe. Arguments containing any cmd metacharacter are therefore
 *   rejected (BLOCKED) rather than escaped. There is no fallback that relaxes
 *   this. Call the underlying `.exe` or `node` script instead.
 */

/** Characters that cmd.exe or a batch file may interpret. Rejected in arguments of batch targets. */
export const BATCH_UNSAFE_ARGUMENT = /[%!^&|<>"()\r\n]/;
/** Same set minus parentheses, which are common in install paths such as "Program Files (x86)". */
const BATCH_UNSAFE_PATH = /[%!^&|<>"\r\n]/;

export interface PreparedRun {
  ok: true;
  /** Absolute path of the executable that will be spawned. */
  executable: string;
  args: string[];
  /** Absolute working directory. */
  cwd: string;
  /** True when the target is a Windows batch file. */
  batch: boolean;
}

export type PrepareResult = PreparedRun | { ok: false; reason: string };

export interface PrepareOptions extends ResolveOptions {
  /** Test seam: pretend to be another platform for the extension rules. */
  platform?: NodeJS.Platform;
}

function blocked(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' ? !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) : true;
}

async function resolveProjectRelative(
  realProject: string,
  exe: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): Promise<string | { error: string }> {
  const base = resolve(realProject, exe);
  const candidates = platform === 'win32' && extname(exe) === '' ? windowsCandidates(base, pathExt) : [base];
  // An extension-less file is still looked up, so the later extension check can explain why it cannot run.
  if (platform === 'win32' && extname(exe) === '') candidates.push(base);

  for (const candidate of candidates) {
    let real: string;
    try {
      real = await realpath(candidate);
      if (!(await stat(real)).isFile()) continue;
    } catch {
      continue;
    }
    if (!inside(realProject, real)) {
      return { error: `Executable "${exe}" resolves outside the project directory, which is not allowed.` };
    }
    return real;
  }
  return { error: `Executable "${exe}" does not exist inside the project.` };
}

/**
 * Validates and resolves a `run` step against the file system. Pure with respect
 * to the process: nothing is started.
 */
export async function prepareRunStep(
  definition: RunStepDefinition,
  projectDir: string,
  options: PrepareOptions = {},
): Promise<PrepareResult> {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const [exe = '', ...args] = definition.run;

  let realProject: string;
  try {
    realProject = await realpath(projectDir);
  } catch {
    return blocked(`Project directory "${projectDir}" does not exist.`);
  }

  let cwd = realProject;
  if (definition.cwd !== undefined) {
    const resolved = await resolveProjectDir(realProject, definition.cwd);
    if (!resolved.ok) return blocked(`cwd: ${resolved.reason}`);
    cwd = resolved.dir;
  }

  let executable: string;
  if (/[\\/]/.test(exe)) {
    const found = await resolveProjectRelative(realProject, exe, platform, options.pathExt ?? process.env['PATHEXT']);
    if (typeof found !== 'string') return blocked(found.error);
    executable = found;
  } else {
    if (!BARE_EXECUTABLE.test(exe)) return blocked(`"${exe}" is not a valid executable name.`);
    const found = await resolveOnPath(exe, { ...options, platform });
    if (found === null) {
      return blocked(
        `"${exe}" was not found on PATH. Install it, or give a project-relative path to the executable.`,
      );
    }
    executable = found;
  }

  const extension = extname(executable).toLowerCase();
  if (extension === '.ps1') {
    return blocked(`"${exe}" is a PowerShell script. Run it explicitly: run: [pwsh, -File, ${exe}].`);
  }
  if (windows) {
    if (!(WINDOWS_EXECUTABLE_EXTENSIONS as readonly string[]).includes(extension)) {
      return blocked(
        `"${exe}" cannot be started directly on Windows (only .exe, .com, .cmd and .bat can). ` +
          `Run it through its interpreter, for example run: [bash, ${exe}] or run: [node, ${exe}].`,
      );
    }
  } else if (!(await isExecutableFile(executable, platform))) {
    return blocked(`"${exe}" is not executable. Run "chmod +x" on it, or run it through its interpreter.`);
  }

  const batch = windows && isBatchFile(executable);
  if (batch) {
    if (BATCH_UNSAFE_PATH.test(executable)) {
      return blocked(
        `"${exe}" is a batch file whose path contains characters cmd.exe interprets (% ! ^ & | < > "). Move it to a plain path.`,
      );
    }
    const offending = args.findIndex((arg) => BATCH_UNSAFE_ARGUMENT.test(arg));
    if (offending !== -1) {
      return blocked(
        `Argument ${offending + 1} of "${exe}" contains a character that cmd.exe interprets (one of % ! ^ & | < > " ( ) or a line break). ` +
          'Batch files re-parse their arguments, so these cannot be passed safely and the step was not run. ' +
          'Call the underlying .exe or a node script directly, or put the value in a file the script reads.',
      );
    }
  }

  return { ok: true, executable, args, cwd, batch };
}

export interface RunStepOptions {
  id: string;
  name?: string;
  definition: RunStepDefinition;
  projectDir: string;
  /** Substitutes process execution. Used by tests. */
  exec?: ProcessExecutor;
  prepare?: PrepareOptions;
}

/**
 * A step backed by a `run` definition. Preparation happens when the step runs
 * (and again in preflight for diagnostics), so a file replaced between the two
 * is validated at the moment it matters. Everything after preparation is the
 * shared process step: timeout, cancellation, tree kill, capture and redaction.
 */
export function createRunStep(options: RunStepOptions): PipelineStep {
  const name = options.name ?? options.id;
  const [exe = '', ...args] = options.definition.run;

  return {
    id: options.id,
    name,
    abortGraceMs: PROCESS_ABORT_GRACE_MS,
    ...(options.definition.timeoutMs !== undefined ? { timeoutMs: options.definition.timeoutMs } : {}),
    async run(context: PipelineContext): Promise<StepResult> {
      const prepared = await prepareRunStep(options.definition, options.projectDir, options.prepare);
      if (!prepared.ok) {
        return { id: options.id, name, status: 'BLOCKED', durationMs: 0, error: prepared.reason };
      }

      const inner = createProcessStep({
        id: options.id,
        name,
        command: prepared.executable,
        args: prepared.args,
        cwd: prepared.cwd,
        ...(options.definition.timeoutMs !== undefined ? { timeoutMs: options.definition.timeoutMs } : {}),
        ...(options.exec !== undefined ? { exec: options.exec } : {}),
      });
      const result = await inner.run(context);
      // Report the command as written, not the absolute path it resolved to.
      return { ...result, command: describeCommand(exe, args) };
    },
  };
}
