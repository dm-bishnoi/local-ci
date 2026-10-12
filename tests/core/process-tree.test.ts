/**
 * Process-tree termination.
 *
 * What is platform-independent is tested directly with injected terminators;
 * what is platform-specific (taskkill vs. process-group signal) is tested
 * through the same interface with fakes, and the real end-to-end kill path is
 * exercised with a real grandchild process — skipped only where the current OS
 * cannot host the scenario deterministically.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DETACHED_CHILD,
  processIsAlive,
  terminateTree,
  treeTerminatorFor,
  type TreeTerminator,
} from '../../src/core/process-tree.js';
import { runProcess } from '../../src/core/process-runner.js';

function recordingTerminator(alive = true): TreeTerminator & { calls: Array<{ pid: number; signal: string }> } {
  const calls: Array<{ pid: number; signal: string }> = [];
  return {
    calls,
    canKillTree: true,
    description: 'recording',
    kill(pid: number, signal = 'TERM') {
      calls.push({ pid, signal });
      return Promise.resolve(alive);
    },
  };
}

describe('treeTerminatorFor', () => {
  it('selects taskkill on Windows and a process-group signal elsewhere', () => {
    expect(treeTerminatorFor('win32').description).toContain('taskkill');
    expect(treeTerminatorFor('linux').description).toContain('process group');
    expect(treeTerminatorFor('darwin').description).toContain('process group');
  });

  it('spawns detached children only where a process group exists to signal', () => {
    // On POSIX, detached is what makes -pid meaningful. On Windows, detached
    // would allocate a new console, so taskkill /T is used instead.
    expect(DETACHED_CHILD).toBe(process.platform !== 'win32');
  });
});

describe('terminateTree', () => {
  it('asks politely first, then escalates to a forced kill', async () => {
    const terminator = recordingTerminator();
    await terminateTree(1234, terminator, 10);

    expect(terminator.calls).toEqual([
      { pid: 1234, signal: 'TERM' },
      { pid: 1234, signal: 'KILL' },
    ]);
  });

  it('does not force-kill when the polite kill reports the tree is gone', async () => {
    const terminator = recordingTerminator(false);
    const result = await terminateTree(1234, terminator, 10);

    expect(result).toBe(false);
    expect(terminator.calls).toEqual([{ pid: 1234, signal: 'TERM' }]);
  });

  it('refuses nonsense pids without signalling anything', async () => {
    const terminator = recordingTerminator();

    expect(await terminateTree(undefined, terminator, 10)).toBe(false);
    expect(await terminateTree(0, terminator, 10)).toBe(false);
    expect(await terminateTree(-5, terminator, 10)).toBe(false);
    expect(await terminateTree(Number.NaN, terminator, 10)).toBe(false);
    expect(terminator.calls).toEqual([]);
  });

  it('returns as soon as an observable tree is gone, without force-killing', async () => {
    const terminator = { ...recordingTerminator(), isAlive: () => false };
    const started = Date.now();

    expect(await terminateTree(1234, terminator, 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(terminator.calls).toEqual([{ pid: 1234, signal: 'TERM' }]);
  });

  it('still escalates when an observable tree survives the grace period', async () => {
    const terminator = { ...recordingTerminator(), isAlive: () => true };
    await terminateTree(1234, terminator, 100);

    expect(terminator.calls).toEqual([
      { pid: 1234, signal: 'TERM' },
      { pid: 1234, signal: 'KILL' },
    ]);
  });

  it('treats a throwing liveness probe as alive and escalates', async () => {
    const terminator = {
      ...recordingTerminator(),
      isAlive: () => {
        throw new Error('probe failed');
      },
    };
    await terminateTree(1234, terminator, 100);

    expect(terminator.calls.map((call) => call.signal)).toEqual(['TERM', 'KILL']);
  });
});

describe('runProcess waits for tree termination (F-8)', () => {
  it('does not resolve until the termination it started has finished', async () => {
    const real = treeTerminatorFor();
    let killFinishedAt = 0;
    const slowTerminator: TreeTerminator = {
      canKillTree: true,
      description: 'real kill, slow to report',
      async kill(pid, signal) {
        const outcome = await real.kill(pid, signal);
        await new Promise((resolve) => setTimeout(resolve, 400));
        killFinishedAt = Date.now();
        return outcome;
      },
      isAlive: (pid) => real.isAlive?.(pid) ?? processIsAlive(pid),
    };

    const result = await runProcess(process.execPath, ['-e', "console.log('ready'); setTimeout(() => {}, 60000)"], {
      cwd: process.cwd(),
      timeoutMs: 500,
      treeTerminator: slowTerminator,
      forceKillAfterMs: 2_000,
    });
    const resolvedAt = Date.now();

    expect(result.timedOut).toBe(true);
    expect(killFinishedAt).toBeGreaterThan(0);
    expect(resolvedAt).toBeGreaterThanOrEqual(killFinishedAt);
    expect(result.stdout).toContain('ready');
  }, 30_000);

  it('terminates only once when both the timeout and the abort signal fire', async () => {
    const calls: string[] = [];
    const real = treeTerminatorFor();
    const counting: TreeTerminator = {
      canKillTree: true,
      description: 'counting',
      kill(pid, signal = 'TERM') {
        calls.push(String(signal));
        return real.kill(pid, signal);
      },
      isAlive: (pid) => real.isAlive?.(pid) ?? processIsAlive(pid),
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 300,
      signal: controller.signal,
      treeTerminator: counting,
    });

    expect(calls.filter((signal) => signal === 'TERM')).toHaveLength(1);
  }, 30_000);
});

describe('processIsAlive', () => {
  it('reports the current process as alive and a bogus pid as dead', () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(0)).toBe(false);
    expect(processIsAlive(undefined)).toBe(false);
    // A pid that high cannot be allocated on a normal system.
    expect(processIsAlive(2 ** 30)).toBe(false);
  });
});

describe('runProcess tree cleanup (integration)', () => {
  /**
   * Spawns a child that itself spawns a grandchild, then returns the
   * grandchild's pid. This is the exact shape that leaked on Windows during
   * the Phase 4 E2E: killing the shim left the node grandchild alive.
   */
  const PARENT_SCRIPT = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const file = process.env.LOCAL_CI_ORPHAN_MARKER;
    // Detached on Windows only. A Node parent puts its children in a
    // kill-on-close Job Object, so they die with it even when the tree kill is
    // broken, so the test could not tell. A detached grandchild, like the child
    // of an npm .cmd shim, is not tied to its parent, so only a real tree kill
    // removes it. On POSIX it must stay in the process group the kill targets.
    // It lives far longer than any wait below, so a leak is never masked by
    // the grandchild simply finishing.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000); console.log("grandchild ready")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform === 'win32',
    });
    child.stdout.on('data', () => {
      fs.writeFileSync(file, JSON.stringify({ grandchild: child.pid, parent: process.pid }));
    });
    setTimeout(() => {}, 60000);
  `;

  interface Marker {
    grandchild?: number;
    parent?: number;
  }

  /**
   * A marker path owned by one run alone. Scanning the shared tmpdir for any
   * marker would let a stale file from an interrupted run supply a dead pid,
   * and the test would pass without having exercised cleanup at all.
   */
  async function markerDir(): Promise<{ dir: string; markerFile: string }> {
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'local-ci-tree-'));
    return { dir, markerFile: join(dir, 'grandchild.json') };
  }

  /** Bounded wait for the grandchild to report its pid. */
  async function waitForMarker(markerFile: string, withinMs: number): Promise<Marker> {
    const { readFile } = await import('node:fs/promises');
    // node:timers/promises is not affected by vi.useFakeTimers.
    const { setTimeout: sleep } = await import('node:timers/promises');
    const readyBy = Date.now() + withinMs;
    while (Date.now() < readyBy) {
      try {
        const marker = JSON.parse(await readFile(markerFile, 'utf8')) as Marker;
        if (typeof marker.grandchild === 'number') return marker;
      } catch {
        /* not written yet, or mid-write */
      }
      await sleep(25);
    }
    return {};
  }

  /** The guarantee itself: both the direct child and its grandchild are gone. */
  async function expectTreeGone(marker: Marker, cause: string): Promise<void> {
    const { setTimeout: sleep } = await import('node:timers/promises');
    // Termination is asynchronous and may escalate, so liveness is polled briefly.
    const deadline = Date.now() + 8_000;
    while ((processIsAlive(marker.grandchild) || processIsAlive(marker.parent)) && Date.now() < deadline) {
      await sleep(100);
    }
    expect(processIsAlive(marker.grandchild), `grandchild survived the ${cause}`).toBe(false);
    expect(processIsAlive(marker.parent), `direct child survived the ${cause}`).toBe(false);
  }

  /**
   * Runs on every exit path, including a failed precondition or assertion: no
   * process may outlive the test, and the run is awaited so the next test
   * never starts while this tree is still shutting down.
   */
  async function cleanUp(marker: Marker, pending: Promise<unknown> | undefined, dir: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    for (const pid of [marker.grandchild, marker.parent]) {
      if (!processIsAlive(pid)) continue;
      try {
        process.kill(pid as number, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await pending?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }

  it('timeout terminates the grandchild, not just the direct child', async () => {
    const { dir, markerFile } = await markerDir();
    let pending: ReturnType<typeof runProcess> | undefined;
    let marker: Marker = {};

    // The timeout must fire while the grandchild is running, or there is no
    // grandchild to clean up and the test proves nothing. Two cold Node
    // start-ups can take longer than any fixed timeout on a loaded machine, so
    // the timeout timer is captured and fired only once the grandchild has
    // confirmed it is up. It is the real timer callback, so the real timeout
    // path (timedOut -> terminate the tree) is what runs.
    //
    // Only setTimeout/clearTimeout are faked, and only until the timer fires:
    // the wait below uses node:timers/promises, which fake timers do not touch.
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let fired = false;
      try {
        pending = runProcess(process.execPath, ['-e', PARENT_SCRIPT], {
          cwd: process.cwd(),
          timeoutMs: 1_500,
          env: { LOCAL_CI_ORPHAN_MARKER: markerFile },
        });

        // Bounded wait for the precondition. Failing here is a different fact
        // from a leak, and says so.
        marker = await waitForMarker(markerFile, 30_000);
        expect(marker.grandchild, 'precondition: the grandchild never started within 30s').toBeTypeOf('number');
        expect(processIsAlive(marker.grandchild), 'precondition: the grandchild is running').toBe(true);

        vi.advanceTimersByTime(1_500);
        fired = true;
      } finally {
        // Even when the precondition fails, fire the captured timeout so the
        // tree is still terminated instead of left running.
        if (!fired) vi.advanceTimersByTime(1_500);
        vi.useRealTimers();
      }

      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.failed).toBe(true);
      await expectTreeGone(marker, 'timeout');
    } finally {
      await cleanUp(marker, pending, dir);
    }
  }, 60_000);

  it('cancellation terminates the process tree', async () => {
    const controller = new AbortController();
    const started = Date.now();

    const promise = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('cancellation terminates the grandchild, not just the direct child', async () => {
    const { dir, markerFile } = await markerDir();
    const controller = new AbortController();
    let pending: ReturnType<typeof runProcess> | undefined;
    let marker: Marker = {};

    try {
      pending = runProcess(process.execPath, ['-e', PARENT_SCRIPT], {
        cwd: process.cwd(),
        signal: controller.signal,
        env: { LOCAL_CI_ORPHAN_MARKER: markerFile },
      });

      // Abort only once the grandchild is up; the abort is under the test's
      // control, so there is no timing race to remove here.
      marker = await waitForMarker(markerFile, 10_000);
      expect(marker.grandchild, 'precondition: the grandchild never started within 10s').toBeTypeOf('number');
      expect(processIsAlive(marker.grandchild), 'precondition: the grandchild is running').toBe(true);

      controller.abort();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      await expectTreeGone(marker, 'cancellation');
    } finally {
      // Without a timeout, only the abort ends this run, so a failed
      // precondition must still abort it.
      controller.abort();
      await cleanUp(marker, pending, dir);
    }
  }, 30_000);
});

