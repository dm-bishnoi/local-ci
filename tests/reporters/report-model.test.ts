import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepResult } from '../../src/core/step-runner.js';
import {
  DEFAULT_EXCERPT_LIMIT,
  REPORT_SCHEMA_VERSION,
  buildRunReport,
  countSteps,
  decodeRunReport,
  excerpt,
  exitCodeForStatus,
  maskCredentialUrls,
  wasExecuted,
  ReportFormatError,
} from '../../src/reporters/report-model.js';
import { TEST_METADATA, makeBuilt, makeRunResult, makeStep, withEnv, withTempProject } from '../helpers/reports.js';

const SECRET = 'sk-live-9f2a7c1b4e8d';

describe('wasExecuted', () => {
  it('is true only for steps that were dispatched to the runner', () => {
    expect(wasExecuted('PASS')).toBe(true);
    expect(wasExecuted('FAIL')).toBe(true);
    expect(wasExecuted('CANCELLED')).toBe(true);
  });

  it('is false for steps that were synthesized without running anything', () => {
    expect(wasExecuted('UNSUPPORTED')).toBe(false);
    expect(wasExecuted('SKIPPED')).toBe(false);
  });
});

describe('exitCodeForStatus', () => {
  it('is zero for exactly one case', () => {
    expect(exitCodeForStatus('PASS')).toBe(0);
    expect(exitCodeForStatus('FAIL')).toBe(1);
    expect(exitCodeForStatus('CANCELLED')).toBe(1);
  });
});

describe('countSteps', () => {
  it('counts every status distinctly', () => {
    const counts = countSteps([
      makeStep('install', 'PASS'),
      makeStep('test', 'PASS'),
      makeStep('build', 'FAIL'),
      makeStep('lint', 'UNSUPPORTED'),
      makeStep('security', 'SKIPPED'),
      makeStep('coverage', 'CANCELLED'),
    ]);

    expect(counts).toEqual({ total: 6, passed: 2, failed: 1, unsupported: 1, skipped: 1, cancelled: 1, blocked: 0, error: 0, timeout: 0 });
  });

  it('handles an empty pipeline', () => {
    expect(countSteps([])).toEqual({ total: 0, passed: 0, failed: 0, unsupported: 0, skipped: 0, cancelled: 0, blocked: 0, error: 0, timeout: 0 });
  });
});

describe('excerpt', () => {
  it('keeps short output verbatim', () => {
    expect(excerpt('all good', 100)).toEqual({ text: 'all good', truncated: false });
  });

  it('keeps the tail, where failures announce themselves', () => {
    const result = excerpt('a'.repeat(50) + 'TAIL', 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('TAIL');
    expect(result.text).toContain('omitted');
  });

  it('handles absent and empty output', () => {
    expect(excerpt(undefined, 10)).toEqual({ text: '', truncated: false });
    expect(excerpt('', 10)).toEqual({ text: '', truncated: false });
  });

  it('never returns more than the limit plus its marker', () => {
    const result = excerpt('x'.repeat(10_000), 100);
    expect(result.text.length).toBeLessThan(200);
  });
});

describe('buildRunReport', () => {
  it('derives every documented field of a complete run', () => {
    const built = makeBuilt([
      makeStep('install', 'PASS', { durationMs: 12_400, exitCode: 0, command: 'npm ci', stdout: 'added 412 packages' }),
      makeStep('test', 'PASS', { durationMs: 31_700, exitCode: 0, command: 'npm run test', stdout: '12 passing' }),
      makeStep('build', 'PASS', { durationMs: 14_800, exitCode: 0, command: 'npm run build' }),
    ]);

    expect(built.report).toMatchObject({
      schemaVersion: REPORT_SCHEMA_VERSION,
      runId: '20261008-123456-abcd1234',
      projectName: 'my-angular-app',
      projectType: 'angular',
      framework: 'angular',
      packageManager: 'npm',
      status: 'PASS',
      cancelled: false,
      durationMs: 76_000,
      exitCode: 0,
      generatedAt: '2026-10-08T12:36:13.000Z',
    });
  });

  it('marks only executed steps with a log path', () => {
    const built = makeBuilt([
      makeStep('install', 'PASS'),
      makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' }),
      makeStep('security', 'SKIPPED', { error: 'Skipped because failFast is enabled.' }),
      makeStep('build', 'CANCELLED'),
    ]);

    const [install, lint, security, build] = built.report.steps;
    expect(install?.logPath).toBe('logs/install.log');
    expect(install?.executed).toBe(true);
    expect(lint?.logPath).toBeUndefined();
    expect(lint?.executed).toBe(false);
    expect(security?.logPath).toBeUndefined();
    expect(security?.executed).toBe(false);
    // A cancelled step did start, so it is still evidence.
    expect(build?.logPath).toBe('logs/build.log');
  });

  it('preserves the five step statuses without collapsing them', () => {
    const built = makeBuilt([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'Build failed', exitCode: 1 }),
      makeStep('lint', 'UNSUPPORTED', { error: 'Not implemented' }),
      makeStep('security', 'SKIPPED', { error: 'failFast' }),
      makeStep('coverage', 'CANCELLED', { cancelled: true }),
    ]);

    expect(built.report.steps.map((step) => step.status)).toEqual([
      'PASS',
      'FAIL',
      'UNSUPPORTED',
      'SKIPPED',
      'CANCELLED',
    ]);
    expect(built.report.counts).toEqual({ total: 5, passed: 1, failed: 1, unsupported: 1, skipped: 1, cancelled: 1, blocked: 0, error: 0, timeout: 0 });
  });

  it('records timeout and cancellation state separately from status', () => {
    const built = makeBuilt([
      makeStep('test', 'FAIL', { timedOut: true, error: 'Step timed out after 300s', exitCode: null, signal: 'SIGTERM' }),
    ]);

    const [step] = built.report.steps;
    expect(step?.status).toBe('FAIL');
    expect(step?.timedOut).toBe(true);
    expect(step?.cancelled).toBe(false);
    expect(step?.signal).toBe('SIGTERM');
  });

  it('derives cancelled from a CANCELLED status even when the flag is absent', () => {
    const built = makeBuilt([makeStep('test', 'CANCELLED', { error: 'Step was cancelled.' })]);
    expect(built.report.steps[0]?.cancelled).toBe(true);
    expect(built.report.cancelled).toBe(true);
  });

  it('never reports PASS for a failed, unsupported or cancelled run', () => {
    for (const status of ['FAIL', 'UNSUPPORTED', 'CANCELLED'] as const) {
      const built = makeBuilt([makeStep('build', status)]);
      expect(built.report.exitCode).toBe(1);
    }
  });

  it('bounds embedded output but keeps the complete text for the log file', () => {
    const huge = 'x'.repeat(50_000);
    const built = makeBuilt([makeStep('build', 'FAIL', { stdout: huge, stderr: huge })], {
      excerptLimit: 500,
    });

    const [step] = built.report.steps;
    expect(step?.stdout.length).toBeLessThan(600);
    expect(step?.stdoutTruncated).toBe(true);
    expect(step?.stderrTruncated).toBe(true);

    // The log source still holds everything, so nothing was actually lost.
    const [source] = built.logs;
    expect(source?.step.stdout).toHaveLength(huge.length);
    expect(source?.step.stderr).toHaveLength(huge.length);
  });

  it('keeps the report itself serializable and bounded', () => {
    const built = makeBuilt([makeStep('build', 'PASS', { stdout: 'y'.repeat(200_000) })]);
    const json = JSON.stringify(built.report);

    expect(json.length).toBeLessThan(DEFAULT_EXCERPT_LIMIT * 2);
    expect(json).not.toContain('y'.repeat(20_000));
  });

  it('exposes no log source for a step that never ran', () => {
    const built = makeBuilt([
      makeStep('install', 'PASS'),
      makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script.' }),
      makeStep('security', 'SKIPPED', { error: 'failFast' }),
    ]);

    expect(built.logs.map((entry) => entry.id)).toEqual(['install']);
  });

  it('is pure: building twice yields identical reports', () => {
    const steps = [makeStep('install', 'PASS'), makeStep('build', 'FAIL', { error: 'boom' })];
    const first = makeBuilt(steps);
    const second = makeBuilt(steps);
    expect(first.report).toEqual(second.report);
  });

  it('does not mutate the step results it was given', () => {
    const steps: StepResult[] = [makeStep('build', 'FAIL', { stdout: 'original output' })];
    const snapshot = structuredClone(steps);
    makeBuilt(steps);
    expect(steps).toEqual(snapshot);
  });
});

describe('buildRunReport redaction', () => {
  it('masks a secret supplied to the builder', () => {
    const built = makeBuilt(
      [
        makeStep('build', 'FAIL', {
          stdout: `deploying with ${SECRET}`,
          stderr: `denied: ${SECRET}`,
          error: `token ${SECRET} rejected`,
          command: `npm run deploy --token ${SECRET}`,
        }),
      ],
      { secrets: [SECRET] },
    );

    const serialized = JSON.stringify(built.report);
    expect(serialized).not.toContain(SECRET);

    const [step] = built.report.steps;
    expect(step?.stdout).not.toContain(SECRET);
    expect(step?.stderr).not.toContain(SECRET);
    expect(step?.error).not.toContain(SECRET);
    expect(step?.command).not.toContain(SECRET);

    const [source] = built.logs;
    expect(JSON.stringify(source)).not.toContain(SECRET);
  });

  it('masks a secret found in the ambient environment', async () => {
    await withEnv('LOCAL_CI_TEST_API_TOKEN', SECRET, () => {
      const built = makeBuilt([
        makeStep('build', 'FAIL', {
          stdout: `using ${SECRET}`,
          stderr: `header: Bearer ${SECRET}`,
          error: `failed with ${SECRET}`,
        }),
      ]);

      const serialized = JSON.stringify(built.report);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).toContain('***');
      expect(JSON.stringify(built.logs)).not.toContain(SECRET);
    });
  });

  it('masks before truncating, so a partial secret can never survive', async () => {
    await withEnv('LOCAL_CI_TEST_API_TOKEN', SECRET, () => {
      const built = makeBuilt([makeStep('build', 'FAIL', { stdout: `${SECRET}${'z'.repeat(5_000)}` })], {
        excerptLimit: 200,
      });

      const [step] = built.report.steps;
      expect(step?.stdoutTruncated).toBe(true);
      expect(step?.stdout).not.toContain(SECRET);
      expect(step?.stdout).not.toContain(SECRET.slice(0, 6));
    });
  });

  it('never serializes the process environment', () => {
    const built = makeBuilt([makeStep('build', 'PASS')]);
    const serialized = JSON.stringify(built.report).toLowerCase();

    expect(serialized).not.toContain('process.env');
    expect(serialized).not.toContain('"env"');
    expect(built.report).not.toHaveProperty('env');
  });

  it('never includes .env file contents', async () => {
    await withTempProject(async (cwd) => {
      // A real .env with a real secret in it. Nothing in the reporting path
      // opens this file, so none of it can reach any artifact.
      await writeFile(
        join(cwd, '.env'),
        'DATABASE_URL=postgres://admin:hunter2@db.internal/app\nAPI_TOKEN=env-file-secret\n',
        'utf8',
      );

      const built = buildRunReport({
        result: makeRunResult([makeStep('build', 'PASS', { stdout: 'build complete' })]),
        metadata: TEST_METADATA,
      });

      const serialized = `${JSON.stringify(built.report)}${JSON.stringify(built.logs)}`;
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('env-file-secret');
      expect(serialized).not.toContain('DATABASE_URL');
    });
  });

  it('masks credential-style command arguments', async () => {
    await withEnv('LOCAL_CI_TEST_API_TOKEN', SECRET, () => {
      const built = makeBuilt([
        makeStep('security', 'FAIL', { command: `npm audit --token=${SECRET} --api-key ${SECRET} --registry public` }),
      ]);

      const command = built.report.steps[0]?.command ?? '';
      expect(command).not.toContain(SECRET);
      expect(command).toContain('--registry public');
    });
  });

  it('masks a password embedded in a URL, which value-based masking cannot know', () => {
    const built = makeBuilt([
      makeStep('security', 'FAIL', {
        stderr: 'connect ECONNREFUSED postgres://admin:s3cr3t-db-pw@db.internal:5432/app',
        error: 'could not reach postgres://admin:s3cr3t-db-pw@db.internal/app',
      }),
    ]);

    const [step] = built.report.steps;
    expect(step?.stderr).not.toContain('s3cr3t-db-pw');
    expect(step?.error).not.toContain('s3cr3t-db-pw');
    // The host and user stay: they identify the failure without being secret.
    expect(step?.stderr).toContain('db.internal:5432');
    expect(step?.stderr).toContain('postgres://admin:***@');
    expect(JSON.stringify(built.logs)).not.toContain('s3cr3t-db-pw');
  });

  it('leaves ordinary URLs and hosts untouched', () => {
    const cases = [
      'http://localhost:4200',
      'https://registry.npmjs.org/npm',
      '  Server running at http://127.0.0.1:8080/api ',
      'file:///C:/project/dist',
      'failed to resolve git@github.com:org/repo.git',
      'connected to redis://cache-host:6379',
    ];

    for (const value of cases) {
      expect(maskCredentialUrls(value)).toBe(value);
    }
  });

  it('leaves a user-only URL intact, because a username is not a secret', () => {
    expect(maskCredentialUrls('git+ssh://git@github.com/org/repo')).toBe('git+ssh://git@github.com/org/repo');
  });
});

describe('decodeRunReport', () => {
  it('round-trips a report this process wrote', () => {
    const built = makeBuilt([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'boom', exitCode: 1 }),
      makeStep('lint', 'UNSUPPORTED', { error: 'nope' }),
    ]);

    const decoded = decodeRunReport(JSON.parse(JSON.stringify(built.report)));

    expect(decoded.runId).toBe(built.report.runId);
    expect(decoded.status).toBe('FAIL');
    expect(decoded.steps.map((step) => step.status)).toEqual(['PASS', 'FAIL', 'UNSUPPORTED']);
    expect(decoded.counts).toEqual(built.report.counts);
  });

  it('round-trips BLOCKED, ERROR and TIMEOUT without collapsing them into PASS or FAIL', () => {
    const built = makeBuilt([
      makeStep('test', 'BLOCKED', { error: 'DATABASE_URL is required but not set.' }),
      makeStep('build', 'ERROR', { error: 'spawn failed' }),
      makeStep('e2e', 'FAIL', { timedOut: true, error: 'Step timed out after 300s', exitCode: null, signal: 'SIGTERM' }),
    ]);

    const decoded = decodeRunReport(JSON.parse(JSON.stringify(built.report)));

    // The engine reports a timeout as status FAIL + timedOut; `outcome` is where
    // it becomes the first-class TIMEOUT. Both must survive serialization.
    expect(decoded.steps.map((step) => step.status)).toEqual(['BLOCKED', 'ERROR', 'FAIL']);
    expect(decoded.steps.map((step) => step.outcome)).toEqual(['BLOCKED', 'ERROR', 'TIMEOUT']);
    expect(decoded.steps[2]?.timedOut).toBe(true);
    // BLOCKED never executed; it is not a pass and not a failure of the step itself.
    expect(decoded.steps[0]?.executed).toBe(false);
    expect(decoded.exitCode).not.toBe(0);
    expect(decoded.status).not.toBe('PASS');
  });

  it('rejects data that is not a report', () => {
    expect(() => decodeRunReport(null)).toThrow(ReportFormatError);
    expect(() => decodeRunReport('nope')).toThrow(ReportFormatError);
    expect(() => decodeRunReport({})).toThrow(/runId/);
  });

  it('degrades an unknown status to FAIL rather than passing it through', () => {
    const decoded = decodeRunReport({ runId: 'r', status: 'WEIRD', steps: [] });
    expect(decoded.status).toBe('FAIL');
    expect(decoded.exitCode).toBe(1);
  });

  it('tolerates missing optional fields', () => {
    const decoded = decodeRunReport({ runId: 'r', status: 'PASS', steps: [{ id: 'build' }] });

    expect(decoded.projectName).toBe('unknown project');
    expect(decoded.framework).toBeNull();
    expect(decoded.steps[0]?.status).toBe('FAIL');
    expect(decoded.steps[0]?.stdout).toBe('');
  });

  it('never invents a coverage percentage', () => {
    const decoded = decodeRunReport({ runId: 'r', status: 'PASS', steps: [], coverage: { state: 'unavailable' } });
    expect(decoded.coverage.percent).toBeNull();
    expect(decoded.coverage.state).toBe('unavailable');
  });
});

describe('buildRunReport coverage integration', () => {
  it('surfaces a measured percentage', () => {
    const built = makeBuilt([makeStep('coverage', 'PASS', { stdout: 'ok' })], {
      coveragePercent: 84.72,
      coverageSource: 'coverage/coverage-summary.json',
    });

    expect(built.report.coverage).toMatchObject({ state: 'available', percent: 84.72 });
  });

  it('never invents coverage for an unsupported step', () => {
    const built = makeBuilt([makeStep('coverage', 'UNSUPPORTED', { error: 'No provider declared.' })], {
      coveragePercent: 99,
    });

    // The adapter declined, so even a percentage on disk is not adopted.
    expect(built.report.coverage.state).toBe('unsupported');
    expect(built.report.coverage.percent).toBeNull();
  });

  it('leaves coverage unsupported when the pipeline omits it', () => {
    const built = makeBuilt([makeStep('build', 'PASS')]);
    expect(built.report.coverage.state).toBe('unsupported');
    expect(built.report.coverage.percent).toBeNull();
  });
});

describe('buildRunReport honours an explicit exit code', () => {
  it('can force a non-zero code without altering the pipeline status', () => {
    const built = buildRunReport({
      result: makeRunResult([makeStep('build', 'PASS')]),
      metadata: TEST_METADATA,
      exitCode: 3,
    });

    expect(built.report.exitCode).toBe(3);
    expect(built.report.status).toBe('PASS');
  });
});