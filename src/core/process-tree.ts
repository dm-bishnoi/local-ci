/**
 * Process-tree termination.
 *
 * The problem this solves: killing a process is not the same as stopping the
 * work it started. A pipeline step is usually a package-manager shim —
 * `npm run build` — which itself launches `node`, which may launch a bundler.
 * Terminating only the direct child leaves those descendants running, and they
 * hold the inherited stdout/stderr handles open, so the CLI keeps waiting on a
 * process it already declared dead. Phase 4 observed exactly this: a step that
 * timed out after 3 seconds kept the command alive for 60 more.
 *
 * Two platform mechanisms are used, both standard:
 *
 * - **Windows** — `taskkill /T /F` terminates the process *tree* rooted at the
 *   given pid. Windows has no process groups in the POSIX sense, and `taskkill`
 *   is the supported way to reach descendants.
 * - **macOS / Linux** — the child is spawned as its own process-group leader
 *   (`detached: true`), so a negative-pid signal reaches the whole group.
 *   Without the detached spawn there is no group to signal and the same leak
 *   appears.
 *
 * Every method here is best-effort and total: it must never throw, because it
 * runs on a path where something has already gone wrong and a second failure
 * would replace a useful report with a useless one.
 */

import { execFile } from 'node:child_process';

export type TreeSignal = 'TERM' | 'KILL';

export interface TreeTerminator {
  /** Terminates the tree rooted at `pid`. Never throws. */
  kill(pid: number, signal?: TreeSignal): Promise<boolean>;
  /** True when the platform mechanism can actually reach descendants. */
  readonly canKillTree: boolean;
  /** Short human-readable description of the mechanism, for diagnostics. */
  readonly description: string;
}

/**
 * Windows: `taskkill /T` walks the tree, `/F` avoids a graceful prompt.
 *
 * The command is spawned detached and with its own stdio so that killing a tree
 * can never recurse into another kill.
 */
const windowsTerminator: TreeTerminator = {
  canKillTree: true,
  description: 'taskkill /T /F (Windows process tree)',
  kill(pid: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = execFile(
          'taskkill',
          ['/pid', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: 10_000 },
          (error) => {
            // A non-zero exit means the tree was already gone, which is the
            // outcome we wanted anyway.
            resolve(error === null);
          },
        );
        child.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  },
};

/**
 * POSIX: signal the negated pid, which the kernel delivers to every process in
 * the group. Requires the child to be a group leader (see `DETACHED_CHILD`).
 */
const posixTerminator: TreeTerminator = {
  canKillTree: true,
  description: 'process group signal (POSIX process group)',
  kill(pid: number, signal: TreeSignal = 'TERM'): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // Negative pid addresses the process group whose id is |pid|.
        process.kill(-pid, signal);
        resolve(true);
      } catch {
        // ESRCH means it is already gone. Fall back to the direct child, which
        // covers the case where `detached` did not take effect.
        try {
          process.kill(pid, signal);
          resolve(true);
        } catch {
          resolve(false);
        }
      }
    });
  },
};

/**
 * Child processes are spawned as process-group leaders on POSIX.
 *
 * Without this, `process.kill(-pid)` has no group to target and grandchildren
 * survive — the exact bug this module exists to fix. On Windows `detached`
 * means "new console", which is not wanted here, so it is POSIX-only.
 */
export const DETACHED_CHILD = process.platform !== 'win32';

export function treeTerminatorFor(platform: NodeJS.Platform = process.platform): TreeTerminator {
  return platform === 'win32' ? windowsTerminator : posixTerminator;
}

/**
 * Terminates a tree, escalating when it does not die politely.
 *
 * The escalation matters: a tool handling `SIGTERM` may finish work first, and
 * a step that has already exceeded its timeout should not be allowed to extend
 * the wait indefinitely.
 */
export async function terminateTree(
  pid: number | undefined,
  terminator: TreeTerminator = treeTerminatorFor(),
  forceAfterMs = 2_000,
): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;

  const polite = await terminator.kill(pid, 'TERM');
  if (!polite) return false;

  await new Promise((resolve) => setTimeout(resolve, forceAfterMs));
  return terminator.kill(pid, 'KILL');
}

/** True when a pid names a process that currently exists. */
export function processIsAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}