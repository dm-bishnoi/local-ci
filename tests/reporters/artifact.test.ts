import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeReportErrors, writeRunReports } from '../../src/reporters/artifact.js';
import { REPORT_HTML_FILE, REPORT_JSON_FILE, SUMMARY_JSON_FILE, runReportDir } from '../../src/reporters/paths.js';
import { makeBuilt, makeStep, withTempProject } from '../helpers/reports.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

describe('writeRunReports', () => {
  it('writes the complete artifact set for a passing run', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('install', 'PASS'), makeStep('build', 'PASS')]);
      const result = await writeRunReports(cwd, built);

      expect(result.errors).toEqual([]);
      expect(result.written).toEqual(['logs/', REPORT_JSON_FILE, SUMMARY_JSON_FILE, REPORT_HTML_FILE]);

      for (const path of [
        result.paths.reportJson,
        result.paths.summaryJson,
        result.paths.reportHtml,
        join(result.paths.logsDirectory, 'install.log'),
        join(result.paths.logsDirectory, 'build.log'),
      ]) {
        expect(await exists(path), `${path} was not written`).toBe(true);
      }
    });
  });

  it('writes artifacts for a failed run — the case that matters most', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('install', 'PASS'),
        makeStep('build', 'FAIL', { error: 'Process exited with code 1.', stderr: 'ERROR: build failed' }),
      ]);
      const result = await writeRunReports(cwd, built);

      expect(result.errors).toEqual([]);
      expect(built.report.status).toBe('FAIL');
      expect(built.report.exitCode).toBe(1);
      expect(await readFile(result.paths.reportHtml, 'utf8')).toContain('ERROR: build failed');
    });
  });

  it('writes artifacts for a cancelled run', async () => {
    await withTempProject(async (cwd) => {
      const result = await writeRunReports(
        cwd,
        makeBuilt([
          makeStep('install', 'PASS'),
          makeStep('build', 'CANCELLED', { cancelled: true, error: 'Step was cancelled.' }),
          makeStep('security', 'SKIPPED', { error: 'Pipeline was cancelled.' }),
        ]),
      );

      expect(result.errors).toEqual([]);
      const html = await readFile(result.paths.reportHtml, 'utf8');
      expect(html).toContain('CANCELLED');
      expect(html).toContain('Skipped steps (1)');
    });
  });

  it('writes artifacts for a timed-out run', async () => {
    await withTempProject(async (cwd) => {
      const result = await writeRunReports(
        cwd,
        makeBuilt([makeStep('test', 'FAIL', { timedOut: true, error: 'Step timed out after 300s' })]),
      );

      expect(result.errors).toEqual([]);
      expect(await readFile(result.paths.reportJson, 'utf8')).toContain('"timedOut": true');
    });
  });

  it('writes artifacts for an unsupported run and fabricates no log', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' })]);
      const result = await writeRunReports(cwd, built);

      expect(result.errors).toEqual([]);
      expect(built.report.status).toBe('FAIL');
      expect(await exists(join(result.paths.logsDirectory, 'lint.log'))).toBe(false);
    });
  });

  it('creates every artifact under .local-ci/reports/<run-id>', async () => {
    await withTempProject(async (cwd) => {
      const result = await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      for (const path of [result.paths.directory, result.paths.reportJson, result.paths.reportHtml]) {
        expect(path.startsWith(join(cwd, '.local-ci', 'reports'))).toBe(true);
      }
      expect(result.paths.directory.endsWith('20261008-123456-abcd1234')).toBe(true);
    });
  });

  it('keeps going when one artifact cannot be written', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('build', 'FAIL', { error: 'boom' })]);
      const runDir = runReportDir(cwd, built.report.runId);
      await mkdir(runDir, { recursive: true });
      // A directory where a file belongs makes exactly one write fail, and
      // fails the same way on every platform.
      await mkdir(join(runDir, REPORT_HTML_FILE));

      const result = await writeRunReports(cwd, built);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.artifact).toBe(REPORT_HTML_FILE);
      expect(result.errors[0]?.message).toBeTruthy();

      // Everything that could be written, still was.
      expect(result.written).toEqual(['logs/', REPORT_JSON_FILE, SUMMARY_JSON_FILE]);
      expect(await exists(result.paths.reportJson)).toBe(true);
      expect(await exists(result.paths.summaryJson)).toBe(true);
      expect(await exists(join(result.paths.logsDirectory, 'build.log'))).toBe(true);
    });
  });

  it('reports every failure instead of throwing when nothing can be written', async () => {
    await withTempProject(async (cwd) => {
      // The run directory's parent is a regular file, so no write can succeed.
      await writeFile(join(cwd, '.local-ci'), 'not a directory', 'utf8');

      const result = await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      expect(result.written).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error.artifact).toBeTruthy();
        expect(error.message).toBeTruthy();
      }
    });
  });

  it('creates the report tree in a project directory that does not exist yet', async () => {
    await withTempProject(async (root) => {
      const cwd = join(root, 'nested', 'fresh');
      const result = await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      expect(result.errors).toEqual([]);
      expect(await exists(result.paths.reportJson)).toBe(true);
    });
  });
});

describe('describeReportErrors', () => {
  it('names every artifact that failed and why', () => {
    const text = describeReportErrors([
      { artifact: 'report.html', message: 'EISDIR: illegal operation on a directory' },
      { artifact: 'summary.json', message: 'ENOSPC: no space left on device' },
    ]);

    expect(text).toContain('2 report artifact(s)');
    expect(text).toContain('report.html: EISDIR: illegal operation on a directory');
    expect(text).toContain('summary.json: ENOSPC: no space left on device');
  });
});