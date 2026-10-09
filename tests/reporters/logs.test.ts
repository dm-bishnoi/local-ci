import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStepLog, toLogFileName, writeRunLogs } from '../../src/reporters/logs.js';
import { logsDirPath } from '../../src/reporters/paths.js';
import { makeBuilt, makeStep, withEnv, withTempProject } from '../helpers/reports.js';

const SECRET = 'sk-live-9f2a7c1b4e8d';

async function listLogs(cwd: string): Promise<string[]> {
  return (await readdir(logsDirPath(cwd, '20261008-123456-abcd1234'))).sort();
}

async function readLog(cwd: string, file: string): Promise<string> {
  return readFile(join(logsDirPath(cwd, '20261008-123456-abcd1234'), file), 'utf8');
}

// ---------------------------------------------------------------------------
// Phase 3 tests — preserved unchanged.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Phase 4 tests — artifact layout, executed-only logs, redaction.
// ---------------------------------------------------------------------------

describe('writeRunLogs', () => {
  it('writes one log per executed step', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('install', 'PASS'),
        makeStep('test', 'PASS'),
        makeStep('build', 'PASS'),
      ]);

      const { files, dir } = await writeRunLogs(cwd, built);

      expect(files).toEqual(['install.log', 'test.log', 'build.log']);
      expect(dir).toBe(logsDirPath(cwd, built.report.runId));
      expect(await listLogs(cwd)).toEqual(['build.log', 'install.log', 'test.log']);
    });
  });

  it('writes no log for a step that never executed', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('install', 'PASS'),
        makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' }),
        makeStep('security', 'SKIPPED', { error: 'Skipped because failFast is enabled.' }),
      ]);

      await writeRunLogs(cwd, built);

      expect(await listLogs(cwd)).toEqual(['install.log']);
    });
  });

  it('writes a log for a failed, timed-out or cancelled step, because those ran', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('build', 'FAIL', { error: 'boom', stderr: 'stack trace' }),
        makeStep('test', 'FAIL', { timedOut: true, error: 'Step timed out after 300s' }),
        makeStep('install', 'CANCELLED', { cancelled: true, error: 'Step was cancelled.' }),
      ]);

      await writeRunLogs(cwd, built);
      expect(await listLogs(cwd)).toEqual(['build.log', 'install.log', 'test.log']);
    });
  });

  it('writes logs for a failed run', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(cwd, makeBuilt([makeStep('build', 'FAIL', { error: 'boom', stderr: 'ERROR: nope' })]));

      const log = await readLog(cwd, 'build.log');
      expect(log).toContain('status: FAIL');
      expect(log).toContain('--- stderr ---');
      expect(log).toContain('ERROR: nope');
    });
  });

  it('keeps a failed step log independent of the others', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(
        cwd,
        makeBuilt([
          makeStep('install', 'PASS', { stdout: 'installed' }),
          makeStep('build', 'FAIL', { error: 'build broke', stderr: 'tsc: error TS2345' }),
        ]),
      );

      expect(await readLog(cwd, 'install.log')).toContain('installed');
      const build = await readLog(cwd, 'build.log');
      expect(build).toContain('tsc: error TS2345');
      expect(build).not.toContain('installed');
    });
  });

  it('records status, duration, command, exit code and flags', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(
        cwd,
        makeBuilt([
          makeStep('build', 'FAIL', {
            durationMs: 14_800,
            command: 'npm run build',
            exitCode: 1,
            timedOut: true,
            stderr: 'error TS2345',
            stdout: 'building...',
            error: 'Process exited with code 1.',
          }),
        ]),
      );

      const log = await readLog(cwd, 'build.log');
      expect(log).toContain('status: FAIL');
      expect(log).toContain('duration: 14800 ms');
      expect(log).toContain('command: npm run build');
      expect(log).toContain('exitCode: 1');
      expect(log).toContain('timedOut: true');
      expect(log).toContain('--- error ---');
      expect(log).toContain('--- stdout ---');
      expect(log).toContain('--- stderr ---');
      expect(log).toContain('error TS2345');
    });
  });

  it('records the cancellation state of an interrupted step', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(cwd, makeBuilt([makeStep('test', 'CANCELLED', { cancelled: true, error: 'Step was cancelled.' })]));

      const log = await readLog(cwd, 'test.log');
      expect(log).toContain('status: CANCELLED');
      expect(log).toContain('cancelled: true');
      expect(log).toContain('Step was cancelled.');
    });
  });

  it('carries the complete captured output, not the report excerpt', async () => {
    await withTempProject(async (cwd) => {
      const stdout = 'z'.repeat(20_000);
      await writeRunLogs(cwd, makeBuilt([makeStep('build', 'PASS', { stdout })], { excerptLimit: 500 }));

      // The log is the one artifact that holds everything the step produced.
      expect(await readLog(cwd, 'build.log')).toContain('z'.repeat(20_000));
    });
  });

  it('redacts a secret from the environment', async () => {
    await withTempProject(async (cwd) => {
      await withEnv('LOCAL_CI_TEST_AUTH_TOKEN', SECRET, async () => {
        await writeRunLogs(
          cwd,
          makeBuilt([
            makeStep('build', 'FAIL', {
              stdout: `using ${SECRET}`,
              stderr: `Authorization: Bearer ${SECRET}`,
              error: `token ${SECRET} rejected`,
              command: `npm run build --token ${SECRET}`,
            }),
          ]),
        );

        const log = await readLog(cwd, 'build.log');
        expect(log).not.toContain(SECRET);
        expect(log).toContain('***');
      });
    });
  });

  it('redacts a password embedded in a connection string', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(
        cwd,
        makeBuilt([makeStep('security', 'FAIL', { stderr: 'cannot reach postgres://admin:s3cr3t-pw@db.internal/app' })]),
      );

      const log = await readLog(cwd, 'security.log');
      expect(log).not.toContain('s3cr3t-pw');
      expect(log).toContain('postgres://admin:***@db.internal/app');
    });
  });

  it('creates the log directory even when nothing executed', async () => {
    await withTempProject(async (cwd) => {
      const { files } = await writeRunLogs(cwd, makeBuilt([makeStep('lint', 'UNSUPPORTED', { error: 'nope' })]));

      expect(files).toEqual([]);
      expect(await listLogs(cwd)).toEqual([]);
    });
  });

  it('distinguishes a missing exit code from a terminated one', async () => {
    await withTempProject(async (cwd) => {
      await writeRunLogs(cwd, makeBuilt([makeStep('test', 'FAIL', { exitCode: null, signal: 'SIGTERM' })]));

      const log = await readLog(cwd, 'test.log');
      expect(log).toContain('exitCode: none');
      expect(log).toContain('signal: SIGTERM');
    });
  });
});