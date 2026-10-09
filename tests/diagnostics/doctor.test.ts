/**
 * Doctor: the full diagnostic surface.
 *
 * Each scenario from the Phase 4.5 spec gets its own case, and every assertion
 * checks the severity the spec demands — in particular that a condition which
 * could not be verified never comes back as PASS.
 */

import { describe, expect, it } from 'vitest';
import { runDoctorChecks } from '../../src/diagnostics/doctor.js';
import { buildDiagnosticReport, verdictOf, type Diagnostic, type Severity } from '../../src/diagnostics/types.js';
import { withTempProject } from '../helpers/reports.js';
import { CHROME_FOUND, HEALTHY_ANGULAR, NO_BROWSERS, writeProject } from '../helpers/fixtures.js';

const noProbes = { skipToolProbes: true as const };

function severityOf(diagnostics: readonly Diagnostic[], id: string): Severity | undefined {
  return diagnostics.find((diagnostic) => diagnostic.id === id)?.severity;
}

function detailOf(diagnostics: readonly Diagnostic[], id: string): string {
  return diagnostics.find((diagnostic) => diagnostic.id === id)?.detail ?? '';
}

describe('doctor: healthy environment', () => {
  it('reports PASS for a complete Angular project', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      // Every check must have an answer, and the verdict must be a clean pass.
      expect(verdictOf(diagnostics)).toBe('PASS');
      expect(diagnostics.every((diagnostic) => diagnostic.severity === 'PASS')).toBe(true);
      expect(severityOf(diagnostics, 'package-json')).toBe('PASS');
      expect(severityOf(diagnostics, 'config')).toBe('PASS');
      expect(severityOf(diagnostics, 'angular')).toBe('PASS');
      expect(severityOf(diagnostics, 'lockfile')).toBe('PASS');
      expect(severityOf(diagnostics, 'browser')).toBe('PASS');
      expect(severityOf(diagnostics, 'dependencies')).toBe('PASS');
    });
  });
});

describe('doctor: Node version requirement', () => {
  it('is BLOCKED when the declared engines range is violated', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { ...HEALTHY_ANGULAR.packageJson, engines: { node: '<1.0.0' } },
      });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'node-version')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
      const node = diagnostics.find((diagnostic) => diagnostic.id === 'node-version');
      expect(node?.recommendation).toMatch(/nvm|switch/i);
    });
  });

  it('is WARNING when no requirement is declared to check against', async () => {
    await withTempProject(async (cwd) => {
      const { engines: _engines, ...withoutEngines } = HEALTHY_ANGULAR.packageJson as Record<string, unknown>;
      await writeProject(cwd, { ...HEALTHY_ANGULAR, packageJson: withoutEngines });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      // No engines field and no .nvmrc: the check exists, but there is nothing
      // to verify against. That is a warning prompting declaration, never PASS.
      expect(severityOf(diagnostics, 'node-version')).toBe('WARNING');
      expect(verdictOf(diagnostics)).toBe('WARNING');
    });
  });

  it('honours .nvmrc when engines is absent', async () => {
    await withTempProject(async (cwd) => {
      const { engines: _engines, ...withoutEngines } = HEALTHY_ANGULAR.packageJson as Record<string, unknown>;
      await writeProject(cwd, { ...HEALTHY_ANGULAR, packageJson: withoutEngines });
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(join(cwd, '.nvmrc'), 'v99.0.0', 'utf8');

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'node-version')).toBe('BLOCKED');
    });
  });
});

describe('doctor: browser', () => {
  it('is BLOCKED when a browser-driven runner is declared but no browser exists', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR); // declares karma-chrome-launcher

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: NO_BROWSERS });

      expect(severityOf(diagnostics, 'browser')).toBe('BLOCKED');
      // Scoped: the browser blocks tests, not the whole machine.
      const browser = diagnostics.find((diagnostic) => diagnostic.id === 'browser');
      expect(browser?.steps).toEqual(['test', 'coverage', 'e2e']);
      expect(browser?.recommendation).toMatch(/install chrome/i);
    });
  });

  it('is PASS when a browser was found', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'browser')).toBe('PASS');
      expect(detailOf(diagnostics, 'browser')).toContain('chrome');
    });
  });

  it('passes with wording that records the browser was absent and not required', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { name: 'plain', scripts: { build: 'tsc' }, dependencies: {} },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n',
      });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: NO_BROWSERS });

      // A missing browser with no requirement for one is a benign observation —
      // but it is recorded as an observation, with wording that says so.
      expect(severityOf(diagnostics, 'browser')).toBe('PASS');
      expect(detailOf(diagnostics, 'browser')).toContain('does not appear to require one');
    });
  });
});

describe('doctor: required environment variables', () => {
  it('is BLOCKED when a required variable is absent, without reading values', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n\nenvironment:\n  variables:\n    required:\n      - DATABASE_URL\n',
      });

      const diagnostics = await runDoctorChecks(cwd, {
        ...noProbes,
        browsers: CHROME_FOUND,
        env: { PATH: '/usr/bin' },
      });

      expect(severityOf(diagnostics, 'env-vars')).toBe('BLOCKED');
      expect(detailOf(diagnostics, 'env-vars')).toContain('DATABASE_URL');
      // Presence only: the detail must never contain the value of anything.
      expect(detailOf(diagnostics, 'env-vars')).not.toContain('/usr/bin');
    });
  });

  it('is PASS when every required variable is present', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n\nenvironment:\n  variables:\n    required:\n      - API_URL\n',
      });

      const diagnostics = await runDoctorChecks(cwd, {
        ...noProbes,
        browsers: CHROME_FOUND,
        env: { API_URL: 'https://internal.example.test' },
      });

      expect(severityOf(diagnostics, 'env-vars')).toBe('PASS');
      // The value exists in the env we passed; it must not appear in output.
      const all = JSON.stringify(diagnostics);
      expect(all).not.toContain('https://internal.example.test');
    });
  });
});

describe('doctor: project configuration', () => {
  it('is BLOCKED when local-ci.yml is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: null });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'config')).toBe('BLOCKED');
      expect(detailOf(diagnostics, 'config')).toContain('.local-ci.yml');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });

  it('is BLOCKED when local-ci.yml is invalid', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: 'version: 99\npipeline: not-a-list\n' });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'config')).toBe('BLOCKED');
      expect(detailOf(diagnostics, 'config')).toMatch(/version|pipeline/i);
    });
  });

  it('is BLOCKED when package.json is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, packageJson: null });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'package-json')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });
});

describe('doctor: unsupported pipeline steps', () => {
  it('identifies an unknown step as UNSUPPORTED, never PASS', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - azure-deploy\n',
      });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'step:azure-deploy')).toBe('UNSUPPORTED');
      // UNSUPPORTED alone must not read as a clean pass.
      expect(verdictOf(diagnostics)).toBe('WARNING');
    });
  });

  it('identifies a known step with no backing script as UNSUPPORTED', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { name: 'no-scripts', scripts: {}, dependencies: { '@angular/core': '^19.0.0' } },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - lint\n',
      });

      const diagnostics = await runDoctorChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'step:lint')).toBe('UNSUPPORTED');
    });
  });
});

describe('doctor: verdicts', () => {
  it('maps severities to verdicts without ever promoting a problem to PASS', async () => {
    const base = (severity: Severity): Diagnostic => ({
      id: 'x',
      label: 'x',
      severity,
      category: 'environment',
      detail: 'x',
    });

    expect(verdictOf([base('PASS')])).toBe('PASS');
    expect(verdictOf([base('PASS'), base('UNKNOWN')])).toBe('WARNING');
    expect(verdictOf([base('PASS'), base('UNSUPPORTED')])).toBe('WARNING');
    expect(verdictOf([base('WARNING')])).toBe('WARNING');
    expect(verdictOf([base('BLOCKED')])).toBe('BLOCKED');
    expect(verdictOf([base('BLOCKED'), base('ERROR')])).toBe('ERROR');
    expect(verdictOf([])).toBe('PASS');
  });

  it('builds a report with counts for every severity', () => {
    const report = buildDiagnosticReport('doctor', [
      { id: 'a', label: 'a', severity: 'PASS', category: 'environment', detail: 'ok' },
      { id: 'b', label: 'b', severity: 'BLOCKED', category: 'project', detail: 'no' },
    ]);

    expect(report.command).toBe('doctor');
    expect(report.verdict).toBe('BLOCKED');
    expect(report.counts.PASS).toBe(1);
    expect(report.counts.BLOCKED).toBe(1);
    expect(report.counts.ERROR).toBe(0);
    expect(typeof report.checkedAt).toBe('string');
  });
});
