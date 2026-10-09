import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeReport, writeJsonReport } from '../../src/reporters/json.js';
import { decodeRunReport } from '../../src/reporters/report-model.js';
import { makeBuilt, makeStep, withEnv, withTempProject } from '../helpers/reports.js';

const SECRET = 'sk-live-9f2a7c1b4e8d';

const FULL_RUN = [
  makeStep('install', 'PASS', { durationMs: 12_400, exitCode: 0, command: 'npm ci', stdout: 'added 412 packages' }),
  makeStep('typecheck', 'PASS', { durationMs: 8_100, exitCode: 0 }),
  makeStep('test', 'PASS', { durationMs: 31_700, exitCode: 0 }),
  makeStep('lint', 'UNSUPPORTED', { durationMs: 0, error: 'No "lint" script in package.json.' }),
  makeStep('build', 'FAIL', {
    durationMs: 14_800,
    exitCode: 1,
    command: 'npm run build',
    error: 'Process exited with code 1.',
    stderr: 'ERROR: Build failed',
    stdout: 'compiling...',
  }),
];

async function writeAndRead(cwd: string, steps: Parameters<typeof makeBuilt>[0]): Promise<string> {
  const built = makeBuilt(steps);
  const path = await writeJsonReport(cwd, built.report);
  return readFile(path, 'utf8');
}

describe('writeJsonReport', () => {
  it('writes report.json into the run directory', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt(FULL_RUN);
      const path = await writeJsonReport(cwd, built.report);

      expect(path).toBe(join(cwd, '.local-ci', 'reports', '20261008-123456-abcd1234', 'report.json'));
      expect(path.startsWith(cwd)).toBe(true);
    });
  });

  it('records every documented run-level field', async () => {
    await withTempProject(async (cwd) => {
      const raw = await writeAndRead(cwd, FULL_RUN);
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      for (const key of [
        'runId',
        'projectName',
        'projectType',
        'framework',
        'packageManager',
        'status',
        'startedAt',
        'endedAt',
        'durationMs',
        'exitCode',
        'coverage',
        'counts',
        'steps',
      ]) {
        expect(parsed, `report.json is missing ${key}`).toHaveProperty(key);
      }

      expect(parsed['runId']).toBe('20261008-123456-abcd1234');
      expect(parsed['projectName']).toBe('my-angular-app');
      expect(parsed['framework']).toBe('angular');
      expect(parsed['packageManager']).toBe('npm');
      expect(parsed['status']).toBe('FAIL');
      expect(parsed['exitCode']).toBe(1);
    });
  });

  it('records every documented step field', async () => {
    await withTempProject(async (cwd) => {
      const raw = await writeAndRead(cwd, [makeStep('build', 'FAIL', { exitCode: 2, signal: null })]);
      const [step] = (JSON.parse(raw) as { steps: Record<string, unknown>[] }).steps;

      for (const key of ['id', 'name', 'status', 'durationMs', 'timedOut', 'cancelled', 'executed']) {
        expect(step, `step is missing ${key}`).toHaveProperty(key);
      }
      expect(step).toHaveProperty('exitCode');
      expect(step).toHaveProperty('logPath');
    });
  });

  it('preserves stdout and stderr for a failed step', async () => {
    await withTempProject(async (cwd) => {
      const parsed = JSON.parse(await writeAndRead(cwd, FULL_RUN)) as {
        steps: Array<{ id: string; stdout: string; stderr: string; error: string }>;
      };
      const build = parsed.steps.find((step) => step.id === 'build');

      expect(build?.stdout).toBe('compiling...');
      expect(build?.stderr).toBe('ERROR: Build failed');
      expect(build?.error).toBe('Process exited with code 1.');
    });
  });

  it('records an unsupported step as UNSUPPORTED with its reason', async () => {
    await withTempProject(async (cwd) => {
      const parsed = JSON.parse(await writeAndRead(cwd, [makeStep('lint', 'UNSUPPORTED', { error: 'No lint script.' })]));

      expect(parsed.steps[0]).toMatchObject({
        status: 'UNSUPPORTED',
        error: 'No lint script.',
        executed: false,
      });
      expect(parsed.steps[0]).not.toHaveProperty('logPath');
      expect(parsed.status).toBe('FAIL');
    });
  });

  it('records a skipped step as SKIPPED with its reason', async () => {
    await withTempProject(async (cwd) => {
      const parsed = JSON.parse(await writeAndRead(cwd, [makeStep('build', 'SKIPPED', { error: 'failFast is enabled.' })]));

      expect(parsed.steps[0]).toMatchObject({ status: 'SKIPPED', executed: false });
      expect(parsed.steps[0].error).toBe('failFast is enabled.');
    });
  });

  it('records a cancelled step and the run', async () => {
    await withTempProject(async (cwd) => {
      const parsed = JSON.parse(
        await writeAndRead(cwd, [
          makeStep('test', 'PASS'),
          makeStep('build', 'CANCELLED', { cancelled: true, error: 'Step was cancelled.' }),
        ]),
      );

      expect(parsed.status).toBe('CANCELLED');
      expect(parsed.cancelled).toBe(true);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.steps[1]).toMatchObject({ status: 'CANCELLED', cancelled: true });
    });
  });

  it('records a timeout distinctly from an ordinary failure', async () => {
    await withTempProject(async (cwd) => {
      const parsed = JSON.parse(
        await writeAndRead(cwd, [makeStep('test', 'FAIL', { timedOut: true, exitCode: null, error: 'Step timed out after 300s' })]),
      );

      expect(parsed.steps[0]).toMatchObject({ status: 'FAIL', timedOut: true, cancelled: false, exitCode: null });
      expect(parsed.steps[0].error).toContain('timed out');
    });
  });

  it('round-trips through decodeRunReport', async () => {
    await withTempProject(async (cwd) => {
      const decoded = decodeRunReport(JSON.parse(await writeAndRead(cwd, FULL_RUN)));

      expect(decoded.steps.map((step) => step.status)).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'UNSUPPORTED',
        'FAIL',
      ]);
      expect(decoded.counts.failed).toBe(1);
      expect(decoded.counts.unsupported).toBe(1);
    });
  });

  it('never leaks a secret', async () => {
    await withTempProject(async (cwd) => {
      await withEnv('LOCAL_CI_TEST_AUTH_TOKEN', SECRET, async () => {
        const raw = await writeAndRead(cwd, [
          makeStep('build', 'FAIL', {
            stdout: `using ${SECRET}`,
            stderr: `Authorization: Bearer ${SECRET}`,
            error: `token ${SECRET} rejected`,
            command: `npm run build --token ${SECRET}`,
          }),
        ]);

        expect(raw).not.toContain(SECRET);
        expect(raw).toContain('***');
      });
    });
  });

  it('stays bounded for a step with enormous output', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('build', 'PASS', { stdout: 'z'.repeat(500_000) })], { excerptLimit: 1_000 });
      const path = await writeJsonReport(cwd, built.report);
      const raw = await readFile(path, 'utf8');

      expect(raw.length).toBeLessThan(5_000);
    });
  });

  it('ends with a trailing newline', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('build', 'PASS')]);
      const path = await writeJsonReport(cwd, built.report);
      expect(await readFile(path, 'utf8')).toMatch(/\n$/);
    });
  });
});

describe('serializeReport', () => {
  it('produces indented, parseable JSON', () => {
    const built = makeBuilt([makeStep('build', 'PASS')]);
    const raw = serializeReport(built.report);

    expect(raw).toContain('\n  "runId"');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});