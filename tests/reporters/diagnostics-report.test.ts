/**
 * Reports carrying diagnostic context.
 *
 * Phase 4.5 extends the Phase 4 report with two facts that make it
 * self-describing: the environment fingerprint and the preflight that gated
 * the run. These tests pin that they survive the single derivation in
 * `buildRunReport` and reach every reporter — and that neither of them can
 * carry a secret.
 */

import { describe, expect, it } from 'vitest';
import { buildRunReport, decodeRunReport } from '../../src/reporters/report-model.js';
import { formatConsoleReport } from '../../src/reporters/console.js';
import { renderHtmlReport } from '../../src/reporters/html.js';
import { buildSummaryReport } from '../../src/reporters/summary.js';
import { buildDiagnosticReport, type Diagnostic } from '../../src/diagnostics/types.js';
import { buildFingerprint, FINGERPRINT_KEYS } from '../../src/env/fingerprint.js';
import { TEST_METADATA, makeBuilt, makeRunResult, makeStep, withEnv, withTempProject } from '../helpers/reports.js';

const SECRET = 'sk-live-9f2a7c1b4e8d';

const PASS_DIAGNOSTIC: Diagnostic = {
  id: 'node-version',
  label: 'Node version',
  severity: 'PASS',
  category: 'environment',
  detail: 'Node satisfies >=20.',
};

const BLOCKED_DIAGNOSTIC: Diagnostic = {
  id: 'env-vars',
  label: 'Environment variables',
  severity: 'BLOCKED',
  category: 'requirements',
  detail: 'Required environment variable(s) not set: DATABASE_URL.',
  recommendation: 'Set DATABASE_URL before running the pipeline.',
};

async function fingerprint(cwd: string) {
  return buildFingerprint({
    cwd,
    projectName: 'my-angular-app',
    projectType: 'angular',
    detection: null,
    packageManagerVersion: null,
    gitVersion: null,
    browsers: [],
    installedAngularVersion: null,
    capturedAt: new Date('2026-10-08T00:00:00.000Z'),
  });
}

describe('report with preflight and environment', () => {
  it('carries the preflight verdict and diagnostics through buildRunReport', async () => {
    await withTempProject(async (cwd) => {
      const built = buildRunReport({
        result: makeRunResult([makeStep('install', 'PASS')]),
        metadata: TEST_METADATA,
        preflight: buildDiagnosticReport('preflight', [PASS_DIAGNOSTIC, BLOCKED_DIAGNOSTIC]),
        environment: await fingerprint(cwd),
      });

      expect(built.report.preflight?.command).toBe('preflight');
      expect(built.report.preflight?.verdict).toBe('BLOCKED');
      expect(built.report.preflight?.diagnostics).toHaveLength(2);
      expect(built.report.environment?.schemaVersion).toBe(1);
    });
  });

  it('omits both sections when neither was collected, without inventing defaults', () => {
    const built = makeBuilt([makeStep('install', 'PASS')]);
    expect(built.report.preflight).toBeUndefined();
    expect(built.report.environment).toBeUndefined();
  });

  it('renders the preflight and environment in the console report', async () => {
    await withTempProject(async (cwd) => {
      const built = buildRunReport({
        result: makeRunResult([makeStep('install', 'PASS')]),
        metadata: TEST_METADATA,
        preflight: buildDiagnosticReport('preflight', [PASS_DIAGNOSTIC, BLOCKED_DIAGNOSTIC]),
        environment: await fingerprint(cwd),
      });

      const text = formatConsoleReport(built.report);

      expect(text).toContain('PREFLIGHT');
      expect(text).toContain('Required environment variable(s) not set: DATABASE_URL.');
      expect(text).toContain('Set DATABASE_URL before running the pipeline.');
      expect(text).toContain('Node');
      expect(text).toContain('Platform');
    });
  });

  it('renders blocked conditions and the environment footer in the HTML report', async () => {
    await withTempProject(async (cwd) => {
      const built = buildRunReport({
        result: makeRunResult([makeStep('build', 'BLOCKED', { error: 'DATABASE_URL is required.' })]),
        metadata: TEST_METADATA,
        preflight: buildDiagnosticReport('preflight', [BLOCKED_DIAGNOSTIC]),
        environment: await fingerprint(cwd),
      });

      const html = renderHtmlReport(built.report);

      expect(html).toContain('BLOCKED');
      expect(html).toContain('DATABASE_URL is required.');
      expect(html).toContain('Environment:');
      expect(html).toContain('local environment');
    });
  });

  it('includes preflight and environment in summary.json output', async () => {
    await withTempProject(async (cwd) => {
      const built = buildRunReport({
        result: makeRunResult([makeStep('install', 'PASS')]),
        metadata: TEST_METADATA,
        preflight: buildDiagnosticReport('preflight', [PASS_DIAGNOSTIC]),
        environment: await fingerprint(cwd),
      });

      const summary = buildSummaryReport(built.report);

      expect(summary.preflight?.verdict).toBe('PASS');
      expect(summary.environment?.schemaVersion).toBe(1);
    });
  });

  it('round-trips preflight and environment through report.json decoding', async () => {
    await withTempProject(async (cwd) => {
      const built = buildRunReport({
        result: makeRunResult([makeStep('install', 'PASS')]),
        metadata: TEST_METADATA,
        preflight: buildDiagnosticReport('preflight', [BLOCKED_DIAGNOSTIC]),
        environment: await fingerprint(cwd),
      });

      const decoded = decodeRunReport(JSON.parse(JSON.stringify(built.report)) as unknown);

      expect(decoded.preflight?.verdict).toBe('BLOCKED');
      expect(decoded.preflight?.diagnostics[0]?.id).toBe('env-vars');
      expect(decoded.environment?.project.name).toBe('my-angular-app');
    });
  });
});

describe('diagnostic context never leaks secrets', () => {
  it('keeps ambient secret values out of every serialized form', async () => {
    await withTempProject(async (cwd) => {
      await withEnv('LOCAL_CI_TEST_AUTH_TOKEN', SECRET, async () => {
        const built = buildRunReport({
          result: makeRunResult([makeStep('install', 'PASS', { stdout: `token=${SECRET}` })]),
          metadata: TEST_METADATA,
          preflight: buildDiagnosticReport('preflight', [PASS_DIAGNOSTIC]),
          environment: await fingerprint(cwd),
        });

        const serialized = JSON.stringify(built.report);
        expect(serialized).not.toContain(SECRET);

        expect(JSON.stringify(buildSummaryReport(built.report))).not.toContain(SECRET);
        expect(formatConsoleReport(built.report)).not.toContain(SECRET);
        expect(renderHtmlReport(built.report)).not.toContain(SECRET);
      });
    });
  });

  it('has a fingerprint whose key set cannot hold environment values', async () => {
    await withTempProject(async (cwd) => {
      const env = await fingerprint(cwd);

      expect(Object.keys(env).sort()).toEqual([...FINGERPRINT_KEYS].sort());
      // The only environment-derived field is a boolean marker.
      expect(typeof env.runningInCi).toBe('boolean');
      expect(JSON.stringify(env)).not.toContain('PATH=');
    });
  });

  it('keeps variable names visible in diagnostics without any value', () => {
    const report = buildDiagnosticReport('preflight', [BLOCKED_DIAGNOSTIC]);
    const text = JSON.stringify(report);

    expect(text).toContain('DATABASE_URL');
    // The detail and recommendation state what to do; neither carries a value.
    expect(BLOCKED_DIAGNOSTIC.detail).not.toMatch(/=[^\s]/);
    expect(report.diagnostics.every((diagnostic) => !('value' in diagnostic))).toBe(true);
  });
});
