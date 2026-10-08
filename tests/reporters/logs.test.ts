import { describe, expect, it } from 'vitest';
import { formatStepLog, toLogFileName } from '../../src/reporters/logs.js';

describe('step log formatting', () => {
  it('produces a safe file name from a step id', () => {
    expect(toLogFileName('install')).toBe('install.log');
    expect(toLogFileName('')).toBe('step.log');

    // A hostile id must not escape the log directory or become a hidden file.
    const hostile = toLogFileName('../../escape');
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain('\\');
    expect(hostile.startsWith('.')).toBe(false);
    expect(hostile.endsWith('.log')).toBe(true);
  });

  it('records status, duration, command, exit code and flags', () => {
    const log = formatStepLog({
      id: 'build',
      name: 'Build',
      status: 'FAIL',
      durationMs: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.234Z',
      command: 'ng build',
      exitCode: 1,
      signal: null,
      timedOut: true,
      stdout: 'building...\ndone',
      stderr: 'error TS2345',
      error: 'Process exited with code 1.',
    });

    expect(log).toContain('status: FAIL');
    expect(log).toContain('duration: 1234 ms');
    expect(log).toContain('command: ng build');
    expect(log).toContain('exitCode: 1');
    expect(log).toContain('timedOut: true');
    expect(log).toContain('--- error ---');
    expect(log).toContain('--- stdout ---');
    expect(log).toContain('--- stderr ---');
    expect(log).toContain('error TS2345');
  });

  it('omits sections that carry no information', () => {
    const log = formatStepLog({
      id: 'skipped',
      name: 'skipped',
      status: 'SKIPPED',
      durationMs: 0,
    });

    expect(log).toContain('status: SKIPPED');
    expect(log).not.toContain('--- stdout ---');
    expect(log).not.toContain('exitCode:');
    expect(log).not.toContain('timedOut:');
  });

  it('never serializes an environment section', () => {
    const log = formatStepLog({
      id: 'x',
      name: 'x',
      status: 'PASS',
      durationMs: 1,
      stdout: 'fine',
    });

    expect(log.toLowerCase()).not.toContain('environment');
    expect(log).not.toContain('TOKEN');
  });
});