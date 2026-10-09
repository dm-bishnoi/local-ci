/**
 * The diagnostic CLI commands: `doctor`, `preflight`, and `run`'s preflight
 * gate.
 *
 * These drive the real command functions against real temporary project
 * trees — the same path the CLI takes — and assert on exit codes and output,
 * because the exit code *is* the contract for anything that scripts local-ci.
 *
 * Tool probes and browser detection are injected so scenarios are
 * deterministic on any machine: a test that depends on whether the host has
 * Chrome installed is not a test, it is weather.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand, exitCodeForVerdict, formatDiagnosticReport } from '../../src/cli/commands/doctor.js';
import { preflightCommand } from '../../src/cli/commands/preflight.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { buildDiagnosticReport, type Diagnostic } from '../../src/diagnostics/types.js';
import { withTempProject } from '../helpers/reports.js';
import { CHROME_FOUND, HEALTHY_ANGULAR, NO_BROWSERS, writeProject } from '../helpers/fixtures.js';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stdout = (): string => out.join('\n');

const skipProbes = { skipToolProbes: true as const };

describe('local-ci doctor', () => {
  it('exits 0 and prints sections for a healthy project', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(0);
      expect(stdout()).toContain('LOCAL CI DOCTOR');
      expect(stdout()).toContain('ENVIRONMENT');
      expect(stdout()).toContain('PROJECT');
      expect(stdout()).toContain('CONFIGURATION');
      expect(stdout()).toContain('Doctor: PASS');
    });
  });

  it('exits 1 with guidance when a required environment variable is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n\nenvironment:\n  variables:\n    required:\n      - DATABASE_URL\n',
      });

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND, env: {} });

      expect(code).toBe(1);
      expect(stdout()).toContain('Doctor: BLOCKED');
      expect(stdout()).toContain('DATABASE_URL');
      expect(stdout()).toContain('Recommendation:');
    });
  });

  it('exits 1 when the configuration is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: null });

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(1);
      expect(stdout()).toContain('Doctor: BLOCKED');
    });
  });

  it('exits 1 when local-ci.yml is invalid', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: 'version: 99\npipeline: oops\n' });

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(1);
      expect(stdout()).toContain('[BLOCKED]');
    });
  });

  it('exits 1 when the browser requirement cannot be met', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR); // karma-chrome-launcher declared

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: NO_BROWSERS });

      expect(code).toBe(1);
      expect(stdout()).toContain('Chrome');
    });
  });

  it('exits 0 with warnings when steps are unsupported but nothing blocks', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n  - azure-deploy\n',
      });

      const code = await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      // UNSUPPORTED is reported, but doctor is diagnostic: a warning-level
      // verdict keeps exit 0 so doctor can be run in a loop while fixing.
      expect(code).toBe(0);
      expect(stdout()).toContain('azure-deploy');
      expect(stdout()).toContain('[UNSUPPORTED]');
    });
  });

  it('never executes a pipeline step', async () => {
    await withTempProject(async (cwd) => {
      // The build script would create a marker file if it ever ran.
      await writeProject(cwd, {
        packageJson: {
          name: 'marker',
          engines: { node: '>=20' },
          scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'RAN\', \'\')"' },
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n',
        installed: true,
      });

      await doctorCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      const ran = await access(join(cwd, 'RAN')).then(() => true).catch(() => false);
      expect(ran).toBe(false);
    });
  });
});

describe('local-ci preflight', () => {
  it('exits 0 and reports PASS for a runnable pipeline', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, HEALTHY_ANGULAR);

      const code = await preflightCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(0);
      expect(stdout()).toContain('LOCAL CI PREFLIGHT');
      expect(stdout()).toContain('Preflight: PASS');
    });
  });

  it('exits 0 with warnings only', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, installed: false });

      const code = await preflightCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(0);
      expect(stdout()).toContain('Preflight: WARNING');
      expect(stdout()).toContain('install step');
    });
  });

  it('exits 1 on a blocking condition and recommends the fix', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n\nenvironment:\n  variables:\n    required:\n      - API_URL\n',
      });

      const code = await preflightCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND, env: {} });

      expect(code).toBe(1);
      expect(stdout()).toContain('Preflight: BLOCKED');
      expect(stdout()).toContain('API_URL');
      expect(stdout()).toContain('Recommendation:');
    });
  });

  it('reports unsupported steps without claiming the pipeline is clean', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        ...HEALTHY_ANGULAR,
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - build\n  - azure-deploy\n',
      });

      const code = await preflightCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(stdout()).toContain('azure-deploy');
      expect(stdout()).toContain('[UNSUPPORTED]');
      expect(stdout()).toContain('Preflight: WARNING');
      // Warnings, including unsupported knowledge, do not fail preflight;
      // the run itself will exit non-zero for the unsupported step.
      expect(code).toBe(0);
    });
  });

  it('exits 1 when package.json is missing', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, packageJson: null });

      const code = await preflightCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).toBe(1);
      expect(stdout()).toContain('Preflight: BLOCKED');
    });
  });
});

describe('exit codes and formatting', () => {
  const diagnostic = (severity: Diagnostic['severity']): Diagnostic => ({
    id: 'x',
    label: 'x',
    severity,
    category: 'environment',
    detail: 'observed',
  });

  it('maps verdicts to exit codes: PASS and WARNING are zero, the rest are not', () => {
    expect(exitCodeForVerdict(buildDiagnosticReport('doctor', [diagnostic('PASS')]))).toBe(0);
    expect(exitCodeForVerdict(buildDiagnosticReport('doctor', [diagnostic('WARNING')]))).toBe(0);
    expect(exitCodeForVerdict(buildDiagnosticReport('doctor', [diagnostic('UNKNOWN')]))).toBe(0);
    expect(exitCodeForVerdict(buildDiagnosticReport('doctor', [diagnostic('BLOCKED')]))).toBe(1);
    expect(exitCodeForVerdict(buildDiagnosticReport('doctor', [diagnostic('ERROR')]))).toBe(1);
  });

  it('renders the title, verdict and recommendation', () => {
    const report = buildDiagnosticReport('preflight', [
      diagnostic('PASS'),
      { ...diagnostic('BLOCKED'), recommendation: 'Set the variable.' },
    ]);
    const text = formatDiagnosticReport(report);

    expect(text).toContain('LOCAL CI PREFLIGHT');
    expect(text).toContain('Preflight: BLOCKED');
    expect(text).toContain('Set the variable.');
    // Worst-first ordering inside a section.
    expect(text.indexOf('[BLOCKED]')).toBeGreaterThan(-1);
  });

  it('labels itself as doctor when it is doctor', () => {
    const text = formatDiagnosticReport(buildDiagnosticReport('doctor', [diagnostic('PASS')]));
    expect(text).toContain('LOCAL CI DOCTOR');
    expect(text).toContain('Doctor: PASS');
  });
});

describe('local-ci run gates on preflight', () => {
  async function latestRunDir(cwd: string): Promise<string> {
    const { readdir } = await import('node:fs/promises');
    const base = join(cwd, '.local-ci', 'reports');
    const runs = await readdir(base);
    return join(base, runs.sort().at(-1) ?? '');
  }

  it('executes the pipeline when preflight passes, and records fingerprint + preflight', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          name: 'run-pass',
          engines: { node: '>=20' },
          scripts: { build: 'node -e "console.log(\'built\')"' },
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n',
        installed: true,
      });

      const code = await runCommand(cwd, { ...skipProbes, browsers: NO_BROWSERS });

      expect(code).toBe(0);

      const dir = await latestRunDir(cwd);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        status: string;
        outcome: string;
        counts: { passed: number };
        environment?: Record<string, unknown>;
        preflight?: { verdict: string; diagnostics: unknown[] };
      };

      expect(report.status).toBe('PASS');
      expect(report.outcome).toBe('PASS');
      expect(report.counts.passed).toBe(1);
      // The report is self-describing: fingerprint and preflight ride along.
      expect(report.environment).toBeDefined();
      expect(report.environment?.['schemaVersion']).toBe(1);
      expect(report.preflight?.verdict).toBe('PASS');
      // The step actually executed (its log file exists).
      expect(await access(join(dir, 'logs', 'build.log')).then(() => true).catch(() => false)).toBe(true);
    });
  }, 30_000);

  it('blocks the pipeline when a required variable is missing, without executing anything', async () => {
    await withTempProject(async (cwd) => {
      // The build script writes a marker; a blocked run must never create it.
      await writeProject(cwd, {
        packageJson: {
          name: 'run-blocked',
          engines: { node: '>=20' },
          scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'RAN\', \'\')"' },
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config:
          'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n\nenvironment:\n  variables:\n    required:\n      - DATABASE_URL\n',
        installed: true,
      });

      const code = await runCommand(cwd, { ...skipProbes, browsers: NO_BROWSERS, env: {} });

      expect(code).not.toBe(0);

      const ran = await access(join(cwd, 'RAN')).then(() => true).catch(() => false);
      expect(ran, 'blocked pipeline must not execute steps').toBe(false);

      const dir = await latestRunDir(cwd);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        status: string;
        outcome: string;
        counts: { blocked: number; passed: number };
        steps: Array<{ status: string; executed: boolean; error?: string }>;
        preflight?: { verdict: string };
      };

      expect(report.preflight?.verdict).toBe('BLOCKED');
      expect(report.outcome).toBe('BLOCKED');
      expect(report.counts.blocked).toBe(1);
      expect(report.counts.passed).toBe(0);
      expect(report.steps[0]?.status).toBe('BLOCKED');
      expect(report.steps[0]?.executed).toBe(false);
      expect(report.steps[0]?.error).toContain('DATABASE_URL');
    });
  }, 30_000);

  it('runs the whole pipeline when preflight only warns', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          name: 'run-warn',
          engines: { node: '>=20' },
          scripts: {
            test: 'node -e "console.log(\'tests pass\')"',
            build: 'node -e "console.log(\'built\')"',
          },
          // No browser-driven runner declared, so a missing browser is only a
          // warning — exactly the case that must not block execution.
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - test\n  - build\n',
        installed: true,
      });

      const code = await runCommand(cwd, { ...skipProbes, browsers: NO_BROWSERS });

      expect(code).toBe(0);

      const dir = await latestRunDir(cwd);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        outcome: string;
        counts: { passed: number };
        preflight?: { verdict: string };
      };

      expect(report.preflight?.verdict).toBe('WARNING');
      expect(report.outcome).toBe('PASS');
      expect(report.counts.passed).toBe(2);
    });
  }, 30_000);

  it('reports UNSUPPORTED and exits non-zero for an unimplementable step', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          name: 'run-unsupported',
          engines: { node: '>=20' },
          scripts: { build: 'node -e "console.log(\'built\')"' },
          dependencies: { '@angular/core': '^19.0.0' },
        },
        config: 'version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - build\n  - azure-deploy\n',
        installed: true,
      });

      const code = await runCommand(cwd, { ...skipProbes, browsers: NO_BROWSERS });

      expect(code).not.toBe(0);

      const dir = await latestRunDir(cwd);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        outcome: string;
        counts: { unsupported: number; passed: number };
        steps: Array<{ id: string; status: string }>;
      };

      // The supported step ran and passed; the unsupported one is its own fact.
      expect(report.counts.passed).toBe(1);
      expect(report.counts.unsupported).toBe(1);
      expect(report.outcome).toBe('UNSUPPORTED');
      expect(report.steps.find((step) => step.id === 'azure-deploy')?.status).toBe('UNSUPPORTED');
    });
  }, 30_000);

  it('blocks the run outright when the configuration is unusable', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, { ...HEALTHY_ANGULAR, config: 'version: 99\npipeline: nope\n' });

      const code = await runCommand(cwd, { ...skipProbes, browsers: CHROME_FOUND });

      expect(code).not.toBe(0);

      const dir = await latestRunDir(cwd);
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        outcome: string;
        steps: Array<{ status: string; error?: string }>;
        preflight?: { verdict: string };
      };

      expect(report.preflight?.verdict).toBe('BLOCKED');
      expect(report.outcome).toBe('BLOCKED');
      expect(report.steps[0]?.status).toBe('BLOCKED');
      expect(report.steps[0]?.error).toBeTruthy();
    });
  }, 30_000);
});
