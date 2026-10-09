/**
 * Process-tree termination.
 *
 * What is platform-independent is tested directly with injected terminators;
 * what is platform-specific (taskkill vs. process-group signal) is tested
 * through the same interface with fakes, and the real end-to-end kill path is
 * exercised with a real grandchild process — skipped only where the current OS
 * cannot host the scenario deterministically.
 */

import { describe, expect, it } from 'vitest';
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
    const os = require('node:os');
    const path = require('node:path');
    const file = path.join(os.tmpdir(), 'local-ci-orphan-' + process.pid + '.json');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000); console.log("grandchild ready")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {
      fs.writeFileSync(file, JSON.stringify({ grandchild: child.pid }));
    });
    setTimeout(() => {}, 60000);
  `;

  it('timeout terminates the grandchild, not just the direct child', async () => {
    const { readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const result = await runProcess(process.execPath, ['-e', PARENT_SCRIPT], {
      cwd: process.cwd(),
      timeoutMs: 1_500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.failed).toBe(true);

    // The marker is named after the *parent* child's pid, which we do not know
    // up front; scan the tmpdir for any marker written recently.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tmpdir());
    const markers = entries.filter((name) => name.startsWith('local-ci-orphan-') && name.endsWith('.json'));

    let grandchild: number | undefined;
    for (const name of markers) {
      try {
        const parsed = JSON.parse(await readFile(join(tmpdir(), name), 'utf8')) as { grandchild?: number };
        if (typeof parsed.grandchild === 'number') grandchild = parsed.grandchild;
        await rm(join(tmpdir(), name), { force: true });
      } catch {
        /* a torn marker is not the assertion's problem */
      }
    }

    // The whole point of the test: a grandchild was spawned, and it must be
    // gone. If no marker appeared, this is a hard failure rather than a skip —
    // a silently skipped orphan test cannot catch the leak it exists for.
    expect(grandchild, 'grandchild process was never spawned').toBeDefined();

    // Termination is asynchronous and escalates after a grace period, so the
    // liveness check is polled briefly.
    const deadline = Date.now() + 8_000;
    while (processIsAlive(grandchild) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(processIsAlive(grandchild)).toBe(false);
  }, 30_000);

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
});
