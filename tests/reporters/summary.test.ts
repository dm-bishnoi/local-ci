import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSummaryReport, writeSummaryReport } from '../../src/reporters/summary.js';
import { makeBuilt, makeStep, withTempProject } from '../helpers/reports.js';

describe('buildSummaryReport', () => {
  it('produces the documented shape', () => {
    const summary = buildSummaryReport(makeBuilt([makeStep('install', 'PASS'), makeStep('build', 'FAIL')]).report);

    expect(summary).toMatchObject({
      runId: '20261008-123456-abcd1234',
      status: 'FAIL',
      durationMs: 76_000,
      exitCode: 1,
      steps: { total: 2, passed: 1, failed: 1, unsupported: 0, skipped: 0, cancelled: 0, blocked: 0, error: 0, timeout: 0 },
    });
  });

  it('counts every status distinctly', () => {
    const summary = buildSummaryReport(
      makeBuilt([
        makeStep('install', 'PASS'),
        makeStep('test', 'PASS'),
        makeStep('build', 'FAIL'),
        makeStep('lint', 'UNSUPPORTED'),
        makeStep('security', 'SKIPPED'),
        makeStep('coverage', 'CANCELLED'),
      ]).report,
    );

    expect(summary.steps).toEqual({ total: 6, passed: 2, failed: 1, unsupported: 1, skipped: 1, cancelled: 1, blocked: 0, error: 0, timeout: 0 });
  });

  it('reports a total duration and the run id', () => {
    const summary = buildSummaryReport(makeBuilt([makeStep('build', 'PASS')]).report);

    expect(summary.durationMs).toBe(76_000);
    expect(summary.runId).toBe('20261008-123456-abcd1234');
    expect(summary.startedAt).toBe('2026-10-08T12:34:56.000Z');
    expect(summary.endedAt).toBe('2026-10-08T12:36:12.000Z');
  });

  it('lists failures and unsupported steps with a one-line reason', () => {
    const summary = buildSummaryReport(
      makeBuilt([
        makeStep('build', 'FAIL', { error: 'Process exited with code 1.\n  at build()' }),
        makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' }),
        makeStep('install', 'PASS'),
      ]).report,
    );

    expect(summary.failures).toEqual([
      { id: 'build', name: 'Production Build', outcome: 'FAIL', reason: 'Process exited with code 1.' },
      { id: 'lint', name: 'Lint', outcome: 'UNSUPPORTED', reason: 'No "lint" script in package.json.' },
    ]);
  });

  it('stays small: no step output is duplicated into it', () => {
    const built = makeBuilt([
      makeStep('build', 'FAIL', { stdout: 'q'.repeat(100_000), stderr: 'w'.repeat(100_000), error: 'boom' }),
    ]);
    const summary = buildSummaryReport(built.report);

    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
    expect(JSON.stringify(summary)).not.toContain('qqqq');
  });

  it('carries coverage without inventing a percentage', () => {
    expect(buildSummaryReport(makeBuilt([makeStep('build', 'PASS')]).report).coverage).toEqual({
      status: 'unsupported',
      percent: null,
    });

    const measured = buildSummaryReport(
      makeBuilt([makeStep('coverage', 'PASS')], { coveragePercent: 84.72, coverageSource: 'coverage/coverage-summary.json' })
        .report,
    );
    expect(measured.coverage).toEqual({ status: 'available', percent: 84.72 });
  });

  it('has no failures for a fully passing run', () => {
    const summary = buildSummaryReport(
      makeBuilt([makeStep('install', 'PASS'), makeStep('build', 'PASS')]).report,
    );

    expect(summary.status).toBe('PASS');
    expect(summary.exitCode).toBe(0);
    expect(summary.failures).toEqual([]);
  });
});

describe('writeSummaryReport', () => {
  it('writes summary.json into the run directory', async () => {
    const built = makeBuilt([makeStep('build', 'FAIL', { error: 'boom' })]);
    const path = await writeSummaryReport('/project', built.report);

    expect(path).toBe(join('/project', '.local-ci', 'reports', '20261008-123456-abcd1234', 'summary.json'));
  });

  it('produces a file another tool can read without the full report', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('install', 'PASS'),
        makeStep('build', 'FAIL', { error: 'Process exited with code 1.' }),
      ]);
      const path = await writeSummaryReport(cwd, built.report);
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { status: string; steps: { failed: number } };

      expect(parsed.status).toBe('FAIL');
      expect(parsed.steps.failed).toBe(1);
    });
  });
});