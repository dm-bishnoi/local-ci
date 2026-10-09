/**
 * External tool probing.
 *
 * Every probe follows the same rule, inherited from the original `doctor`: a
 * tool that could not be checked is **never** reported as present. A sandbox
 * that denies `where`/`which` is a fact about the check, not about the tool, and
 * conflating the two produces a diagnostic that is confidently wrong.
 *
 * Each probe therefore returns a three-state result: found, missing, or blocked
 * (the check itself was not permitted).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROBE_TIMEOUT_MS = 8_000;
/** Most `--version` flags print on the first line; cap it so output stays bounded. */
const MAX_VERSION_CHARS = 64;

export type ProbeOutcome = 'ok' | 'missing' | 'blocked';

export interface ProbeResult {
  outcome: ProbeOutcome;
  /** Version string when one could be read, otherwise undefined. */
  version?: string;
  /** Human-readable explanation, always present when not `ok`. */
  detail: string;
}

/**
 * The errno-style code of a spawn-level failure (ENOENT, EPERM, EACCES...).
 *
 * Only *string* codes count. An ordinary non-zero exit surfaces `code: 1` as a
 * number, and stringifying it would make "the tool ran and said no" look like
 * "the tool could not be launched" — which is how a missing `yarn` used to be
 * reported as a blocked check instead of a missing one.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isSpawnFailure(error: unknown): boolean {
  return errorCode(error) !== undefined;
}

/**
 * Reduces a tool's `--version` output to a short, single-line token.
 *
 * `npm --version` prints `10.9.2`, `git --version` prints `git version 2.47.1`,
 * Node prints `v22.3.0`. Trimming to one line keeps a fingerprint comparable and
 * keeps an unexpectedly chatty tool from bloating every report.
 */
export function extractVersion(output: string): string | undefined {
  const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return undefined;

  const digits = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/.exec(first);
  const value = digits?.[1] ?? first;
  return value.slice(0, MAX_VERSION_CHARS);
}

/**
 * Like {@link extractVersion}, but refuses anything without a version number.
 *
 * Used on the non-zero-exit fallback, where the output is often an error
 * message ("'yarn' is not recognized..."). Accepting the first line of such a
 * message as a version would report a missing tool as a present one with a
 * nonsense version — precisely the false pass this module exists to prevent.
 */
function extractVersionStrict(output: string): string | undefined {
  const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return undefined;

  const digits = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/.exec(first);
  if (!digits?.[1]) return undefined;
  return digits[1].slice(0, MAX_VERSION_CHARS);
}

/**
 * Probes an executable by running `<tool> --version`.
 *
 * Executing the tool is preferred over a bare `where`/`which` because it yields
 * the version too, and a version is what makes a diagnostic actionable.
 */
export async function probeTool(name: string, versionArgs: readonly string[] = ['--version']): Promise<ProbeResult> {
  try {
    // On Windows, npm/pnpm/yarn are `.cmd` shims, and a `.cmd` file cannot be
    // spawned directly — Node refuses without a shell. The whole invocation is
    // therefore passed as one command string (which also avoids Node's
    // args-plus-shell deprecation). This is safe because the executable name
    // comes from this module's callers' fixed vocabulary and the arguments are
    // constants, never configuration or user input. Without this, every package
    // manager would read as ENOENT on Windows while `git` (a real .exe) passed.
    const useShell = process.platform === 'win32';
    const { stdout } = useShell
      ? await execFileAsync([name, ...versionArgs].join(' '), {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024,
          shell: true,
        })
      : await execFileAsync(name, [...versionArgs], {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        });
    const version = extractVersion(String(stdout));
    return version
      ? { outcome: 'ok', version, detail: version }
      : { outcome: 'ok', version: 'unknown', detail: `${name} responded but printed no recognizable version.` };
  } catch (error) {
    if (isSpawnFailure(error)) {
      const code = errorCode(error);
      const blocked = code === 'EPERM' || code === 'EACCES';
      return {
        outcome: 'blocked',
        detail: blocked
          ? `${name} could not be checked: process execution was blocked (${code}).`
          : `${name} could not be checked: ${code ?? 'spawn failed'}.`,
      };
    }

    // A non-zero exit from `--version` still means the executable exists: many
    // tools exit non-zero while still printing their version on stderr. Only a
    // real version number counts — see extractVersionStrict.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const stdout = String((error as { stdout?: unknown }).stdout ?? '');
    const version = extractVersionStrict(stderr) ?? extractVersionStrict(stdout);
    if (version) return { outcome: 'ok', version, detail: version };

    return { outcome: 'missing', detail: `${name} was not found on PATH.` };
  }
}

/** Locates an executable without running it, for tools with no version flag. */
export async function probeExecutable(name: string): Promise<ProbeResult> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(locator, [name], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return { outcome: 'ok', version: 'unknown', detail: name };
  } catch (error) {
    if (isSpawnFailure(error)) {
      const code = errorCode(error);
      const blocked = code === 'EPERM' || code === 'EACCES';
      return {
        outcome: 'blocked',
        detail: blocked
          ? `${name} could not be checked: process execution was blocked (${code}).`
          : `${name} could not be checked: ${code ?? 'spawn failed'}.`,
      };
    }
    // `where` found nothing but still ran successfully on Windows.
    const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
    return stdout
      ? { outcome: 'ok', version: 'unknown', detail: name }
      : { outcome: 'missing', detail: `${name} was not found on PATH.` };
  }
}