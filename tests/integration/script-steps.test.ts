/**
 * F-3 end to end: `steps` entries run real package.json scripts through the
 * real CLI path, with the same exit codes, timeouts, redaction and reports as
 * every other step. Scripts only use `node -e`, so the same fixtures behave
 * identically under cmd.exe and sh.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { runDoctorChecks } from '../../src/diagnostics/doctor.js';
import { runPreflightChecks } from '../../src/diagnostics/preflight.js';
import { NO_BROWSERS, writeProject } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';

interface ReportedStep {
  id: string;
  name: string;
  status: string;
  outcome: string;
  command?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  logPath?: string;
}
interface Report {
  status: string;
  counts: Record<string, number>;
  steps: ReportedStep[];
}

const options = { skipToolProbes: true, browsers: NO_BROWSERS };

/**
 * A timeout only has to be *exceeded* by a script that sleeps for a minute, but
 * it must also outlast package-manager start-up, which takes several seconds on
 * a loaded Windows machine. A value that is too small kills npm before the
 * script prints anything and the output assertions become a race.
 */
const STEP_TIMEOUT_MS = 10_000;
const node = (code: string): string => `node -e "${code}"`;

/** A `.local-ci.yml` for a non-Angular project that scripts every step. */
function nodeConfig(pipeline: string[], steps: Record<string, string | { script: string; timeoutMs?: number }>, settings = ''): string {
  const defs = Object.entries(steps)
    .map(([id, step]) => {
      const def = typeof step === 'string' ? { script: step } : step;
      return `  ${id}:\n    script: ${JSON.stringify(def.script)}\n${def.timeoutMs ? `    timeoutMs: ${def.timeoutMs}\n` : ''}`;
    })
    .join('');
  return `version: 1\nproject:\n  type: node\npipeline:\n${pipeline.map((id) => `  - ${id}\n`).join('')}steps:\n${defs}${settings}`;
}

async function project(
  cwd: string,
  scripts: Record<string, string>,
  config: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeProject(cwd, {
    packageJson: { name: 'script-fixture', private: true, scripts, ...extra },
    config,
    angularJson: null,
    lockfile: 'package-lock.json',
    installed: true,
  });
}

async function lastReport(cwd: string): Promise<{ report: Report; dir: string }> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = (await readdir(base)).sort().reverse();
  const dir = join(base, runId ?? '');
  return { report: JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Report, dir };
}

function stepOf(report: Report, id: string): ReportedStep {
  const step = report.steps.find((entry) => entry.id === id);
  if (!step) throw new Error(`no step ${id} in report`);
  return step;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['GH_PAT'];
});

describe('script steps: success', () => {
  it('runs several scripts in a non-Angular project and exits 0', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { lint: node('console.log(1)'), test: node('console.log(2)'), build: node('console.log(3)') },
        nodeConfig(['lint', 'test', 'build'], { lint: 'lint', test: 'test', build: 'build' }),
      );

      const code = await runCommand(cwd, options);
      const { report } = await lastReport(cwd);

      expect(code).toBe(0);
      expect(report.status).toBe('PASS');
      expect(report.counts['passed']).toBe(3);
      expect(report.steps.map((step) => [step.id, step.status])).toEqual([
        ['lint', 'PASS'],
        ['test', 'PASS'],
        ['build', 'PASS'],
      ]);
      expect(stepOf(report, 'test').command).toBe('npm run test');
      expect(stepOf(report, 'test').stdout).toContain('2');
    });
  }, 90_000);

  it('can run a script whose step id differs from the script name', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { 'test:e2e': node("console.log('e2e ran')") },
        nodeConfig(['e2e'], { e2e: 'test:e2e' }),
      );

      expect(await runCommand(cwd, options)).toBe(0);
      const { report } = await lastReport(cwd);
      expect(stepOf(report, 'e2e').command).toBe('npm run test:e2e');
      expect(stepOf(report, 'e2e').stdout).toContain('e2e ran');
    });
  }, 60_000);
});

describe('script steps: failure', () => {
  it('propagates the script exit code, output and a non-zero CLI exit', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { test: node("console.error('3 tests failed'); process.exit(3)"), build: node('0') },
        nodeConfig(['test', 'build'], { test: 'test', build: 'build' }),
      );

      const code = await runCommand(cwd, options);
      const { report, dir } = await lastReport(cwd);

      expect(code).toBe(1);
      expect(report.status).toBe('FAIL');
      const test = stepOf(report, 'test');
      expect(test.status).toBe('FAIL');
      expect(test.exitCode).toBe(3);
      expect(test.stderr).toContain('3 tests failed');
      // Without failFast the next step still runs and keeps its own verdict.
      expect(stepOf(report, 'build').status).toBe('PASS');

      const log = await readFile(join(dir, 'logs', 'test.log'), 'utf8');
      expect(log).toContain('exitCode: 3');
      expect(log).toContain('3 tests failed');
    });
  }, 90_000);

  it('reports a script that calls a missing executable as a failure, never a pass', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { lint: 'definitely-missing-tool-xyz --check' },
        nodeConfig(['lint'], { lint: 'lint' }),
      );

      const code = await runCommand(cwd, options);
      const { report } = await lastReport(cwd);

      expect(code).toBe(1);
      const lint = stepOf(report, 'lint');
      expect(lint.status).not.toBe('PASS');
      expect(lint.exitCode).not.toBe(0);
      expect(`${lint.stderr}${lint.stdout}`).toContain('definitely-missing-tool-xyz');
    });
  }, 60_000);

  it('stops after the first failure with failFast and never runs later scripts', async () => {
    await withTempProject(async (cwd) => {
      const marker = 'ran-after-failure.txt';
      await project(
        cwd,
        {
          first: node('process.exit(2)'),
          second: node(`require('fs').writeFileSync('${marker}', 'x')`),
          third: node(`require('fs').writeFileSync('${marker}', 'x')`),
        },
        nodeConfig(['first', 'second', 'third'], { first: 'first', second: 'second', third: 'third' }, 'settings:\n  failFast: true\n'),
      );

      const code = await runCommand(cwd, options);
      const { report } = await lastReport(cwd);

      expect(code).toBe(1);
      expect(report.steps.map((step) => step.status)).toEqual(['FAIL', 'SKIPPED', 'SKIPPED']);
      expect(await exists(join(cwd, marker))).toBe(false);
    });
  }, 60_000);
});

describe('script steps: missing scripts', () => {
  it('reports UNSUPPORTED, naming the script, without running anything', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { build: node('0') }, nodeConfig(['build', 'e2e'], { build: 'build', e2e: 'test:e2e' }));

      const code = await runCommand(cwd, options);
      const { report } = await lastReport(cwd);

      expect(code).toBe(1);
      const e2e = stepOf(report, 'e2e');
      expect(e2e.status).toBe('UNSUPPORTED');
      expect(e2e.error).toContain('"test:e2e"');
      expect(e2e.command).toBeUndefined();
      expect(e2e.logPath).toBeUndefined();
      expect(stepOf(report, 'build').status).toBe('PASS');
    });
  }, 60_000);

  it('treats an empty script body as missing', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { lint: '   ' }, nodeConfig(['lint'], { lint: 'lint' }));
      expect(await runCommand(cwd, options)).toBe(1);
      expect(stepOf((await lastReport(cwd)).report, 'lint').status).toBe('UNSUPPORTED');
    });
  }, 60_000);

  it('does not mistake an inherited object property for a script', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { build: node('0') }, nodeConfig(['constructor'], { constructor: 'constructor' }));
      expect(await runCommand(cwd, options)).toBe(1);
      const step = stepOf((await lastReport(cwd)).report, 'constructor');
      expect(step.status).toBe('UNSUPPORTED');
      // The display name must be the id, not an inherited Object member.
      expect(step.name).toBe('constructor');
    });
  }, 60_000);

  it('is flagged by preflight and doctor, scoped to the step', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { build: node('0') }, nodeConfig(['build', 'e2e'], { build: 'build', e2e: 'test:e2e' }));

      const preflight = await runPreflightChecks(cwd, options);
      const doctor = await runDoctorChecks(cwd, { skipToolProbes: true, browsers: NO_BROWSERS });

      for (const diagnostics of [preflight, doctor]) {
        const flagged = diagnostics.filter((diagnostic) => diagnostic.id === 'step:e2e');
        expect(flagged).toHaveLength(1);
        expect(flagged[0]?.severity).toBe('UNSUPPORTED');
        expect(flagged[0]?.detail).toContain('"test:e2e"');
        expect(flagged[0]?.steps).toEqual(['e2e']);
        expect(diagnostics.some((diagnostic) => diagnostic.id === 'step:build')).toBe(false);
      }
    });
  }, 60_000);

  it('does not flag a scripted step as having no implementation', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { lint: node('0') }, nodeConfig(['lint'], { lint: 'lint' }));

      for (const diagnostics of [
        await runPreflightChecks(cwd, options),
        await runDoctorChecks(cwd, { skipToolProbes: true, browsers: NO_BROWSERS }),
      ]) {
        expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'UNSUPPORTED')).toEqual([]);
        expect(diagnostics.some((diagnostic) => diagnostic.detail.includes('No implementation'))).toBe(false);
      }
    });
  }, 60_000);

  it('doctor still exits 0 for a healthy scripted project', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { lint: node('0') }, nodeConfig(['lint'], { lint: 'lint' }));
      expect(await doctorCommand(cwd, { skipToolProbes: true, browsers: NO_BROWSERS })).toBe(0);
    });
  }, 60_000);
});

describe('script steps: timeouts', () => {
  it('applies a per-step timeout, keeps the output, and leaves other steps alone', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { slow: node("console.log('slow started'); setTimeout(() => {}, 60000)"), fast: node('0') },
        nodeConfig(['slow', 'fast'], { slow: { script: 'slow', timeoutMs: STEP_TIMEOUT_MS }, fast: 'fast' }, 'settings:\n  timeoutMs: 600000\n'),
      );

      const started = Date.now();
      const code = await runCommand(cwd, options);
      const elapsed = Date.now() - started;
      const { report } = await lastReport(cwd);

      expect(code).toBe(1);
      expect(elapsed).toBeLessThan(60_000);
      const slow = stepOf(report, 'slow');
      expect(slow.outcome).toBe('TIMEOUT');
      expect(slow.stdout).toContain('slow started');
      expect(slow.error).toContain('timed out');
      expect(stepOf(report, 'fast').status).toBe('PASS');
      expect(report.counts['timeout']).toBe(1);
    });
  }, 90_000);

  it('uses the pipeline timeout for a step without its own', async () => {
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        { slow: node('setTimeout(() => {}, 60000)') },
        nodeConfig(['slow'], { slow: 'slow' }, `settings:\n  timeoutMs: ${STEP_TIMEOUT_MS}\n`),
      );
      expect(await runCommand(cwd, options)).toBe(1);
      expect(stepOf((await lastReport(cwd)).report, 'slow').outcome).toBe('TIMEOUT');
    });
  }, 90_000);

  it('lets a per-step timeout extend, not only shorten, the pipeline timeout', async () => {
    await withTempProject(async (cwd) => {
      // Outlives the pipeline timeout by several seconds, well within its own.
      const runMs = STEP_TIMEOUT_MS + 5_000;
      await project(
        cwd,
        { long: node(`setTimeout(() => console.log('long finished'), ${runMs})`) },
        nodeConfig(['long'], { long: { script: 'long', timeoutMs: 120_000 } }, `settings:\n  timeoutMs: ${STEP_TIMEOUT_MS}\n`),
      );

      const code = await runCommand(cwd, options);
      const long = stepOf((await lastReport(cwd)).report, 'long');

      expect(long.error).toBeUndefined();
      expect(long.status).toBe('PASS');
      expect(long.stdout).toContain('long finished');
      expect(code).toBe(0);
    });
  }, 90_000);
});

describe('script steps: secrets', () => {
  it('masks credentials printed by a script in the report, the log and the html', async () => {
    process.env['GH_PAT'] = 'ghpat-fixture-value-12345';
    await withTempProject(async (cwd) => {
      await project(
        cwd,
        {
          leak: node(
            "console.log('pat=' + process.env.GH_PAT); console.error('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'); process.exit(1)",
          ),
        },
        nodeConfig(['leak'], { leak: 'leak' }),
      );

      await runCommand(cwd, options);
      const { report, dir } = await lastReport(cwd);

      const files = [
        JSON.stringify(report),
        await readFile(join(dir, 'logs', 'leak.log'), 'utf8'),
        await readFile(join(dir, 'report.html'), 'utf8'),
      ].join('\n');
      expect(files).not.toContain('ghpat-fixture-value-12345');
      expect(files).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(files).toContain('pat=***');
      expect(files).toContain('Authorization: Bearer ***');
    });
  }, 60_000);
});

describe('script steps: unsupported project types keep their old behaviour', () => {
  it('still reports UNSUPPORTED for unscripted steps in a non-Angular project', async () => {
    await withTempProject(async (cwd) => {
      await project(cwd, { build: node('0') }, nodeConfig(['build', 'lint'], { build: 'build' }));
      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastReport(cwd);
      expect(stepOf(report, 'build').status).toBe('PASS');
      expect(stepOf(report, 'lint').status).toBe('UNSUPPORTED');
    });
  }, 60_000);

  it('reports nothing as passed when a non-Angular config scripts no steps', async () => {
    await withTempProject(async (cwd) => {
      // An unrecognised type keeps the 0.2.x behaviour: only `steps:` entries run.
      await project(cwd, { build: node('0') }, 'version: 1\nproject:\n  type: custom-thing\npipeline:\n  - build\n');
      expect(await runCommand(cwd, options)).toBe(1);
      expect(stepOf((await lastReport(cwd)).report, 'build').status).toBe('UNSUPPORTED');
    });
  }, 60_000);
});

describe('script steps alongside the Angular adapter', () => {
  const angularDeps = { dependencies: { '@angular/core': '^19.0.0' } };

  it('overrides a built-in step and leaves the others to the adapter', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: {
          name: 'angular-fixture',
          ...angularDeps,
          scripts: { build: node("console.log('adapter build')"), lint: node("console.log('adapter lint')"), 'lint:ci': node("console.log('ci lint')") },
        },
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n  - lint\nsteps:\n  lint:\n    script: "lint:ci"\n',
        lockfile: 'package-lock.json',
        installed: true,
      });

      expect(await runCommand(cwd, options)).toBe(0);
      const { report } = await lastReport(cwd);

      // Overridden: runs the configured script and keeps the readable name.
      const lint = stepOf(report, 'lint');
      expect(lint.command).toBe('npm run lint:ci');
      expect(lint.stdout).toContain('ci lint');
      expect(lint.name).toBe('Lint');
      // Not overridden: the adapter's own mapping, unchanged.
      expect(stepOf(report, 'build').command).toBe('npm run build');
      expect(stepOf(report, 'build').stdout).toContain('adapter build');
    });
  }, 90_000);

  it('adds a step the adapter does not know without disturbing the ones it does', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'angular-fixture', ...angularDeps, scripts: { build: node('0'), 'test:e2e': node("console.log('e2e ok')") } },
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n  - e2e\nsteps:\n  e2e:\n    script: "test:e2e"\n',
        lockfile: 'package-lock.json',
        installed: true,
      });

      expect(await runCommand(cwd, options)).toBe(0);
      const { report } = await lastReport(cwd);
      expect(report.steps.map((step) => [step.id, step.status])).toEqual([
        ['build', 'PASS'],
        ['e2e', 'PASS'],
      ]);
    });
  }, 90_000);

  it('leaves an Angular project without `steps` exactly as before', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'angular-fixture', ...angularDeps, scripts: { build: node('0') } },
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - build\n  - lint\n',
        lockfile: 'package-lock.json',
        installed: true,
      });

      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastReport(cwd);
      expect(stepOf(report, 'build').status).toBe('PASS');
      // No lint script, no override: the adapter's own UNSUPPORTED message.
      expect(stepOf(report, 'lint').status).toBe('UNSUPPORTED');
      expect(stepOf(report, 'lint').error).toContain('No "lint" script');
    });
  }, 90_000);

  it('still blocks the run when the project is not Angular, scripted steps or not', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'not-angular', scripts: { lint: node('0') } },
        config: 'version: 1\nproject:\n  type: angular\npipeline:\n  - lint\nsteps:\n  lint:\n    script: lint\n',
        angularJson: null,
        lockfile: 'package-lock.json',
        installed: true,
      });

      expect(await runCommand(cwd, options)).toBe(1);
      const { report } = await lastReport(cwd);
      expect(stepOf(report, 'detection').status).toBe('BLOCKED');
      expect(report.steps.some((step) => step.id === 'lint')).toBe(false);
    });
  }, 60_000);
});

describe('script steps: the package manager comes from the project', () => {
  it('uses the manager implied by the lockfile', async () => {
    await withTempProject(async (cwd) => {
      await writeProject(cwd, {
        packageJson: { name: 'pnpm-project', scripts: { lint: node('0') } },
        config: nodeConfig(['lint'], { lint: 'lint' }),
        angularJson: null,
        lockfile: 'pnpm-lock.yaml',
        installed: true,
      });
      const diagnostics = await runPreflightChecks(cwd, { skipToolProbes: true, browsers: NO_BROWSERS });
      // pnpm may not be installed here, so assert on the decision, not on running it.
      expect(diagnostics.find((diagnostic) => diagnostic.id === 'config')?.severity).toBe('PASS');
      const { collectProjectFacts } = await import('../../src/diagnostics/facts.js');
      expect((await collectProjectFacts(cwd)).angular?.packageManager).toBe('pnpm');
    });
  }, 60_000);
});
