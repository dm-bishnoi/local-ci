import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressReporter, formatConsoleReport } from '../../src/reporters/console.js';
import { makeBuilt, makeStep } from '../helpers/reports.js';

/** Runs `body` with `isTTY` forced to `value`, restoring it afterwards. */
async function withTty<T>(value: boolean, body: () => T | Promise<T>): Promise<T> {
  const descriptor = process.stdout;
  const original = Object.getOwnPropertyDescriptor(descriptor, 'isTTY');
  Object.defineProperty(descriptor, 'isTTY', { value, configurable: true });
  try {
    return await body();
  } finally {
    if (original) Object.defineProperty(descriptor, 'isTTY', original);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createProgressReporter', () => {
  it('writes nothing at all when stdout is not a TTY', async () => {
    await withTty(false, () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const progress = createProgressReporter();
      progress.onStepStart({ id: 'build', name: 'Production Build', run: async () => ({ id: 'build', name: 'Production Build', status: 'PASS', durationMs: 1 }) });
      progress.onStepEnd({ name: 'Production Build', status: 'PASS' });
      progress.stop();

      // A redirected run must contain the report and nothing else.
      expect(write).not.toHaveBeenCalled();
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  it('reports progress when stdout is a TTY', async () => {
    await withTty(true, () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const progress = createProgressReporter();
      progress.onStepStart({ id: 'build', name: 'Production Build', run: async () => ({ id: 'build', name: 'Production Build', status: 'PASS', durationMs: 1 }) });
      progress.onStepEnd({ name: 'Production Build', status: 'PASS' });
      progress.stop();

      expect(write).toHaveBeenCalled();
    });
  });

  it('survives every status without throwing', async () => {
    await withTty(true, () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const progress = createProgressReporter();

      for (const status of ['PASS', 'FAIL', 'UNSUPPORTED', 'SKIPPED', 'CANCELLED'] as const) {
        progress.onStepEnd({ name: `Step ${status}`, status });
      }
      progress.stop();
    });
  });

  it('never throws out of a progress callback', async () => {
    await withTty(false, () => {
      const progress = createProgressReporter();
      const step = { id: 'x', name: 'X', run: async () => ({ id: 'x', name: 'X', status: 'PASS' as const, durationMs: 0 }) };

      expect(() => {
        progress.onStepStart(step);
        progress.onStepEnd({ name: 'X', status: 'PASS' });
        progress.stop();
      }).not.toThrow();
    });
  });
});

describe('printConsoleReport noise', () => {
  it('emits exactly one report block, with no per-step chatter', () => {
    const report = makeBuilt([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'boom' }),
    ]).report;

    const output = formatConsoleReport(report);

    expect(output.match(/LOCAL CI REPORT/g)).toHaveLength(1);
    expect(output).not.toMatch(/\[/);
  });
});