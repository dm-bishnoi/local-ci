import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/core/process-runner.js';

/**
 * Every command is run through the current Node binary so the suite is portable
 * across Windows, macOS and Linux and needs no external tool, network or
 * project configuration.
 */
const NODE = process.execPath;

function node(script: string): [string, string[]] {
  return [NODE, ['-e', script]];
}

describe('runProcess', () => {
  it('runs a successful command and reports exit code 0', async () => {
    const result = await runProcess(...node('process.exit(0)'), { cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    expect(result.failed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('captures stdout', async () => {
    const result = await runProcess(...node("process.stdout.write('hello world')"), { cwd: process.cwd() });

    expect(result.stdout).toBe('hello world');
    expect(result.failed).toBe(false);
  });

  it('captures stderr', async () => {
    const result = await runProcess(...node("process.stderr.write('something broke')"), { cwd: process.cwd() });

    expect(result.stderr).toBe('something broke');
    expect(result.failed).toBe(false);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runProcess(...node('process.exit(3)'), { cwd: process.cwd() });

    expect(result.exitCode).toBe(3);
    expect(result.failed).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it('runs in the requested working directory', async () => {
    const result = await runProcess(...node('process.stdout.write(process.cwd())'), {
      cwd: process.env['TEMP'] ?? process.env['TMP'] ?? process.cwd(),
    });

    expect(result.stdout).toBe(process.env['TEMP'] ?? process.env['TMP']);
  });

  it('passes environment variables to the child', async () => {
    const result = await runProcess(...node('process.stdout.write(process.env.LOCAL_CI_TEST_VAR)'), {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_CI_TEST_VAR: 'present' },
    });

    expect(result.stdout).toBe('present');
  });

  it('measures a non-negative duration', async () => {
    const result = await runProcess(...node('void 0'), { cwd: process.cwd() });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('terminates a process that exceeds its timeout', async () => {
    const started = Date.now();
    const result = await runProcess(...node('setTimeout(() => {}, 30000)'), {
      cwd: process.cwd(),
      timeoutMs: 400,
    });

    expect(result.timedOut).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.error).toContain('timed out');
    // The child must actually be gone, not merely reported as timed out.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('terminates a process when its signal is aborted', async () => {
    const controller = new AbortController();
    const pending = runProcess(...node('setTimeout(() => {}, 30000)'), {
      cwd: process.cwd(),
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 200);
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(true);
  }, 15_000);

  it('does not spawn anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess(...node("process.stdout.write('should not run')"), {
      cwd: process.cwd(),
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBeNull();
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runProcess('local-ci-no-such-executable-9f3a2b', [], { cwd: process.cwd() });

    expect(result.failed).toBe(true);
    expect(result.error).toBeTruthy();
    // POSIX surfaces the spawn errno; Windows reports a plain failure exit.
    if (process.platform !== 'win32') expect(result.errorCode).toBe('ENOENT');
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('reports a signal- or spawn-terminated process without inventing an exit code', async () => {
    const result = await runProcess(...node('setTimeout(() => {}, 30000)'), {
      cwd: process.cwd(),
      timeoutMs: 300,
    });

    expect(result.timedOut).toBe(true);
    // Phase 1 reported a fake exit code of 1 for a killed process.
    expect(result.exitCode === null || result.exitCode !== 1).toBe(true);
  }, 15_000);

  it('does not interpret shell metacharacters in arguments', async () => {
    const marker = 'local-ci-shell-marker';
    const result = await runProcess(NODE, ['-e', 'process.stdout.write(process.argv[1])', `; echo ${marker}`], {
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`; echo ${marker}`);
    expect(result.stdout).not.toContain(marker + '\n');
  });

  it('masks secret-looking environment values in captured output', async () => {
    const secret = 'super-secret-token-value-1234';
    const result = await runProcess(...node('process.stdout.write(process.env.LOCAL_CI_TEST_TOKEN)'), {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_CI_TEST_TOKEN: secret },
    });

    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain('***');
  });

  it('truncates very large captured output', async () => {
    const result = await runProcess(...node("process.stdout.write('x'.repeat(5000))"), {
      cwd: process.cwd(),
      maxCaptureChars: 100,
    });

    expect(result.stdout.length).toBeLessThan(200);
    expect(result.stdout).toContain('truncated');
  });
});