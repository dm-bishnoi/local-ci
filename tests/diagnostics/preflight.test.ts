/**
 * Preflight: "can this configured pipeline reasonably run here?"
 *
 * The distinction under test throughout: WARNING never blocks, BLOCKED always
 * does, UNSUPPORTED is its own fact, and nothing that could not be checked is
 * ever reported as PASS.
 */

import { describe, expect, it } from 'vitest';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import {
  blockingDiagnostics,
  buildDiagnosticReport,
  stepsBlockedBy,
  verdictOf,
  type Diagnostic,
  type Severity,
} from '../../src/diagnostics/types.js';
import { withTempProject } from '../helpers/reports.js';
import { CHROME_FOUND, HEALTHY_ANGULAR, NO_BROWSERS, writeProject } from '../helpers/fixtures.js';

const noProbes = { skipToolProbes: true as const };

function severityOf(diagnostics: readonly Diagnostic[], id: string): Severity | undefined {
  return diagnostics.find((diagnostic) => diagnostic.id === id)?.severity;
}

function detailOf(diagnostics: readonly Diagnostic[], id: string): string {
  return diagnostics.find((diagnostic) => diagnostic.id === id)?.detail ?? '';
}

describe('preflight: all checks pass', () => {
  it('returns PASS with no blockers for a healthy project', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(verdictOf(diagnostics)).toBe('PASS');
      expect(blockingDiagnostics(diagnostics)).toEqual([]);
      expect(stepsBlockedBy(diagnostics, ['install', 'test', 'build']).size).toBe(0);
      expect(severityOf(diagnostics, 'package-json')).toBe('PASS');
      expect(severityOf(diagnostics, 'config')).toBe('PASS');
      expect(severityOf(diagnostics, 'dependencies')).toBe('PASS');
      expect(severityOf(diagnostics, 'pipeline')).toBe('PASS');
      expect(severityOf(diagnostics, 'env-vars')).toBe('PASS');
    });
  });
});

describe('preflight: warning only', () => {
  it('never blocks on a missing node_modules when an install step will populate it', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, installed: false });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'dependencies')).toBe('WARNING');
      expect(verdictOf(diagnostics)).toBe('WARNING');
      // The critical invariant: a warning is not a blocker.
      expect(blockingDiagnostics(diagnostics)).toEqual([]);
      expect(stepsBlockedBy(diagnostics, ['install', 'test', 'build']).size).toBe(0);
    });
  });

  it('blocks on a missing node_modules when the pipeline has no install step', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n',
        installed: false,
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'dependencies')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
      expect(stepsBlockedBy(diagnostics, ['build']).size).toBe(1);
    });
  });

  it('warns about a browser when tests run but no browser-driven runner is declared', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'node-tests', scripts: { test: 'vitest', build: 'tsc' }, dependencies: {} },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - test\n  - build\n',
        installed: true,
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: NO_BROWSERS });

      expect(severityOf(diagnostics, 'browser')).toBe('WARNING');
      expect(blockingDiagnostics(diagnostics)).toEqual([]);
    });
  });
});

describe('preflight: blocked requirement', () => {
  it('blocks every step when a required environment variable is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - test\n  - build\n\nenvironment:\n  variables:\n    required:\n      - DATABASE_URL\n',
      });

      const diagnostics = await runPreflightChecks(cwd, {
        ...noProbes,
        browsers: CHROME_FOUND,
        env: {},
      });

      expect(severityOf(diagnostics, 'env-vars')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');

      // A global blocker blocks the whole pipeline...
      const blocked = stepsBlockedBy(diagnostics, ['install', 'test', 'build']);
      expect(blocked).toEqual(new Set(['install', 'test', 'build']));

      // ...and the detail names the variable without exposing any value.
      expect(detailOf(diagnostics, 'env-vars')).toContain('DATABASE_URL');
      expect(detailOf(diagnostics, 'env-vars')).not.toContain('postgres://');
    });
  });

  it('does not block when the required variable is present', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n\nenvironment:\n  variables:\n    required:\n      - API_URL\n',
      });

      const diagnostics = await runPreflightChecks(cwd, {
        ...noProbes,
        browsers: CHROME_FOUND,
        env: { API_URL: 'set' },
      });

      expect(severityOf(diagnostics, 'env-vars')).toBe('PASS');
      expect(stepsBlockedBy(diagnostics, ['install', 'build']).size).toBe(0);
    });
  });

  it('blocks only the test steps when a browser is required but missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR); // karma-chrome-launcher declared

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: NO_BROWSERS });

      expect(severityOf(diagnostics, 'browser')).toBe('BLOCKED');
      const blocked = stepsBlockedBy(diagnostics, ['install', 'test', 'build']);
      // Scoped blocker: install and build must still be allowed to run.
      expect(blocked).toEqual(new Set(['test']));
      expect(blockingDiagnostics(diagnostics, 'install')).toEqual([]);
      expect(blockingDiagnostics(diagnostics, 'test').length).toBe(1);
    });
  });
});

describe('preflight: unsupported step', () => {
  it('reports an unknown step as UNSUPPORTED without blocking execution', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n  - azure-deploy\n',
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'step:azure-deploy')).toBe('UNSUPPORTED');
      // UNSUPPORTED is not BLOCKED: the rest of the pipeline can still run.
      expect(blockingDiagnostics(diagnostics)).toEqual([]);
      // But the verdict must not be a clean pass — the run will not fully pass.
      expect(verdictOf(diagnostics)).toBe('WARNING');
      expect(severityOf(diagnostics, 'pipeline')).toBe('WARNING');
    });
  });

  it('reports a known step with no backing script as UNSUPPORTED', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { name: 'no-lint', scripts: { build: 'ng build' }, dependencies: { '@angular/core': '^19.0.0' } },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - lint\n  - build\n',
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'step:lint')).toBe('UNSUPPORTED');
      expect(blockingDiagnostics(diagnostics)).toEqual([]);
    });
  });
});

describe('preflight: missing dependency installation', () => {
  it('blocks when node_modules is empty and no install step exists', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - test\n  - build\n',
        installed: false,
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'dependencies')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });
});

describe('preflight: project configuration problems', () => {
  it('blocks when the configuration is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: null });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'config')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });

  it('blocks when package.json is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, packageJson: null });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'package-json')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });

  it('blocks when the project type is angular but no Angular project was found', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'not-angular', scripts: { build: 'tsc' }, dependencies: {} },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n',
        angularJson: null,
        installed: true,
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: NO_BROWSERS });

      expect(severityOf(diagnostics, 'angular')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });
});

describe('preflight: node version requirement', () => {
  it('blocks when the declared engines range is violated', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { ...HEALTHY_ANGULAR.packageJson, engines: { node: '<1.0.0' } },
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      expect(severityOf(diagnostics, 'node-version')).toBe('BLOCKED');
      expect(verdictOf(diagnostics)).toBe('BLOCKED');
    });
  });

  it('reports UNKNOWN rather than PASS when the declared range cannot be evaluated', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        packageJson: { ...HEALTHY_ANGULAR.packageJson, engines: { node: 'ancient-magic' } },
      });

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });

      // Not verifiable → not PASS. UNKNOWN downgrades the verdict to WARNING.
      expect(severityOf(diagnostics, 'node-version')).toBe('UNKNOWN');
      expect(verdictOf(diagnostics)).toBe('WARNING');
    });
  });
});

describe('preflight: report shape', () => {
  it('builds a preflight report with a full severity census', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const diagnostics = await runPreflightChecks(cwd, { ...noProbes, browsers: CHROME_FOUND });
      const report = buildDiagnosticReport('preflight', diagnostics);

      expect(report.command).toBe('preflight');
      const total = Object.values(report.counts).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(report.diagnostics.length);
    });
  });
});
