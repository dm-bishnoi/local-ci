import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../../src/cli/commands/report.js';
import { runReportDir, summaryJsonPath } from '../../src/reporters/paths.js';
import { writeRunReports } from '../../src/reporters/artifact.js';
import { makeBuilt, makeStep, withTempProject } from '../helpers/reports.js';

const RUN_ID = '20261008-123456-abcd1234';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

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
const stderr = (): string => err.join('\n');

describe('reportCommand', () => {
  it('displays a stored run', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(
        cwd,
        makeBuilt([
          makeStep('install', 'PASS', { durationMs: 12_400 }),
          makeStep('build', 'FAIL', { durationMs: 14_800, exitCode: 1, error: 'Process exited with code 1.' }),
        ]),
      );

      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(0);
      expect(stdout()).toContain('LOCAL CI REPORT');
      expect(stdout()).toContain('20261008-123456-abcd1234');
      expect(stdout()).toContain('Result:          FAIL');
      expect(stdout()).toContain('Production Build');
      expect(stdout()).toContain('Process exited with code 1.');
    });
  });

  it('points at the stored HTML report', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));
      await reportCommand(cwd, RUN_ID);

      expect(stdout()).toContain('report.html');
    });
  });

  it('prints a useful error and fails when no run id is supplied', async () => {
    await withTempProject(async (cwd) => {
      const code = await reportCommand(cwd);

      expect(code).toBe(1);
      expect(stderr()).toContain('Usage: local-ci report <run-id>');
      expect(stdout()).not.toContain('LOCAL CI REPORT');
    });
  });

  it('lists available runs when none is supplied', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      await reportCommand(cwd);
      expect(stderr()).toContain(RUN_ID);
    });
  });

  it('fails clearly and lists runs for an unknown run id', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      const code = await reportCommand(cwd, '20260101-000000-deadbeef');

      expect(code).toBe(1);
      expect(stderr()).toContain('No report found for run "20260101-000000-deadbeef"');
      expect(stderr()).toContain(RUN_ID);
    });
  });

  it('says so plainly when there are no stored reports at all', async () => {
    await withTempProject(async (cwd) => {
      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(1);
      expect(stderr()).toContain('Run "local-ci run" first');
    });
  });

  it('rejects a traversal attempt without touching the filesystem', async () => {
    await withTempProject(async (cwd) => {
      const code = await reportCommand(cwd, '../../../etc/passwd');

      expect(code).toBe(1);
      expect(stderr()).toContain('not a valid run id');
      expect(stdout()).not.toContain('LOCAL CI REPORT');
    });
  });

  it('rejects a Windows device name', async () => {
    await withTempProject(async (cwd) => {
      const code = await reportCommand(cwd, 'CON');
      expect(code).toBe(1);
      expect(stderr()).toContain('not a valid run id');
    });
  });

  it('reports a corrupt report without a stack trace', async () => {
    await withTempProject(async (cwd) => {
      const dir = runReportDir(cwd, RUN_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'report.json'), '{ this is not json', 'utf8');

      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(1);
      expect(stderr()).toContain('not valid JSON');
      expect(stderr()).not.toContain('at Object.');
      expect(stderr()).not.toContain('SyntaxError:');
    });
  });

  it('reports a report that is valid JSON but not a report', async () => {
    await withTempProject(async (cwd) => {
      const dir = runReportDir(cwd, RUN_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'report.json'), '{"unrelated":true}', 'utf8');

      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(1);
      expect(stderr()).toContain('could not be read');
      expect(stderr()).not.toContain('at Object.');
    });
  });

  it('renders a partially written report without crashing', async () => {
    await withTempProject(async (cwd) => {
      const dir = runReportDir(cwd, RUN_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'report.json'),
        JSON.stringify({ runId: RUN_ID, status: 'PASS', steps: [{ id: 'build' }] }),
        'utf8',
      );

      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(0);
      expect(stdout()).toContain('LOCAL CI REPORT');
      // An unknown step status degrades to FAIL rather than reading as a pass.
      expect(stdout()).toContain('FAIL');
    });
  });

  it('displays the five statuses without collapsing them', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(
        cwd,
        makeBuilt([
          makeStep('install', 'PASS'),
          makeStep('build', 'FAIL', { error: 'boom' }),
          makeStep('lint', 'UNSUPPORTED', { error: 'nope' }),
          makeStep('security', 'SKIPPED', { error: 'failFast' }),
          makeStep('test', 'CANCELLED', { error: 'interrupted' }),
        ]),
      );

      await reportCommand(cwd, RUN_ID);
      const text = stdout();

      for (const status of ['PASS', 'FAIL', 'UNSUPPORTED', 'SKIPPED', 'CANCELLED']) {
        expect(text).toContain(status);
      }
    });
  });

  it('reads report.json, not summary.json, so step details survive', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'FAIL', { error: 'detailed reason here' })]));
      await rm(join(runReportDir(cwd, RUN_ID), 'report.json'), { force: true });

      const code = await reportCommand(cwd, RUN_ID);

      expect(code).toBe(1);
      expect(stderr()).toContain('No report found');
      // The summary still exists; it is simply not silently substituted for
      // the full report, because it cannot answer a per-step question.
      expect(await exists(summaryJsonPath(cwd, RUN_ID))).toBe(true);
    });
  });
});