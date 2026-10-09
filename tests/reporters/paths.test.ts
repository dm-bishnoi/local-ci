import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeRunId,
  createRunId,
  isSafeRunId,
  listRunIds,
  logsDirPath,
  reportHtmlPath,
  reportJsonPath,
  reportsRoot,
  runReportDir,
  toLogFileName,
  ReportPathError,
} from '../../src/reporters/paths.js';
import { withTempProject } from '../helpers/reports.js';

describe('run id creation', () => {
  it('builds a sortable, filesystem-safe id', () => {
    const runId = createRunId(new Date(2026, 9, 8, 12, 34, 56), () => 'abcdef1234567890');

    expect(runId).toBe('20261008-123456-abcdef12');
    expect(isSafeRunId(runId)).toBe(true);
  });

  it('pads single-digit components so ids stay fixed width', () => {
    const runId = createRunId(new Date(2026, 0, 2, 3, 4, 5), () => '0123456789abcdef');
    expect(runId).toBe('20260102-030405-01234567');
  });

  it('produces distinct ids for two runs in the same second', () => {
    const at = new Date(2026, 9, 8, 12, 34, 56);
    expect(createRunId(at, () => 'aaaaaaaaaaaa')).not.toBe(createRunId(at, () => 'bbbbbbbbbbbb'));
  });

  it('sorts chronologically as a plain string', () => {
    const older = createRunId(new Date(2026, 9, 8, 12, 34, 56), () => 'aaaaaaaa');
    const newer = createRunId(new Date(2026, 9, 8, 12, 35, 56), () => 'aaaaaaaa');
    expect(older < newer).toBe(true);
  });
});

describe('run id safety', () => {
  it('rejects anything that could escape the reports directory', () => {
    for (const hostile of [
      '../escape',
      '..\\escape',
      'a/b',
      'a\\b',
      '/absolute',
      'C:\\windows',
      '.',
      '..',
      '.hidden',
      '',
      '   ',
    ]) {
      expect(isSafeRunId(hostile)).toBe(false);
    }
  });

  it('rejects Windows device names', () => {
    for (const reserved of ['CON', 'con', 'PRN', 'nul', 'COM1', 'LPT9']) {
      expect(isSafeRunId(reserved)).toBe(false);
    }
  });

  it('rejects over-long ids', () => {
    expect(isSafeRunId('a'.repeat(129))).toBe(false);
    expect(isSafeRunId('a'.repeat(128))).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(isSafeRunId(undefined)).toBe(false);
    expect(isSafeRunId(42)).toBe(false);
    expect(isSafeRunId(null)).toBe(false);
  });

  it('throws a user-facing error rather than a raw exception', () => {
    expect(() => assertSafeRunId('../escape')).toThrow(ReportPathError);
    expect(() => assertSafeRunId('../escape')).toThrow(/not a valid run id/i);
    expect(() => assertSafeRunId('')).toThrow(/run id is required/i);
  });
});

describe('artifact paths', () => {
  const cwd = '/project';

  it('keeps every artifact under .local-ci/reports/<run-id>', () => {
    const runId = '20261008-123456-abcd1234';
    const dir = runReportDir(cwd, runId);

    expect(dir).toBe(join(cwd, '.local-ci', 'reports', runId));
    expect(reportJsonPath(cwd, runId)).toBe(join(dir, 'report.json'));
    expect(reportHtmlPath(cwd, runId)).toBe(join(dir, 'report.html'));
    expect(logsDirPath(cwd, runId)).toBe(join(dir, 'logs'));
  });

  it('refuses to build a path from an unsafe run id', () => {
    expect(() => runReportDir(cwd, '../../etc')).toThrow(ReportPathError);
    expect(() => reportJsonPath(cwd, 'a/b')).toThrow(ReportPathError);
  });

  it('never uses a temp directory', () => {
    expect(reportsRoot(cwd)).toBe(join(cwd, '.local-ci', 'reports'));
    expect(reportsRoot(cwd)).not.toContain('tmp');
  });
});

describe('toLogFileName', () => {
  it('maps a step id to a safe file name', () => {
    expect(toLogFileName('install')).toBe('install.log');
    expect(toLogFileName('')).toBe('step.log');
  });

  it('neutralizes traversal and hidden names', () => {
    const hostile = toLogFileName('../../escape');
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain('\\');
    expect(hostile.startsWith('.')).toBe(false);
    expect(hostile.endsWith('.log')).toBe(true);
  });
});

describe('listRunIds', () => {
  it('returns nothing when no reports exist', async () => {
    await withTempProject(async (cwd) => {
      expect(await listRunIds(cwd)).toEqual([]);
    });
  });

  it('lists run directories newest first and ignores unsafe names', async () => {
    await withTempProject(async (cwd) => {
      const root = reportsRoot(cwd);
      for (const name of ['20260101-000000-aaaaaaaa', '20261008-123456-abcd1234', '20260202-000000-bbbbbbbb']) {
        await mkdir(join(root, name), { recursive: true });
      }
      // A stray file and an unsafe directory must not be offered as run ids.
      await writeFile(join(root, 'stray.txt'), 'not a run', 'utf8');
      await mkdir(join(root, '..evil'), { recursive: true });

      expect(await listRunIds(cwd)).toEqual([
        '20261008-123456-abcd1234',
        '20260202-000000-bbbbbbbb',
        '20260101-000000-aaaaaaaa',
      ]);
    });
  });

  it('lists a run whose directory name is used verbatim as a path', async () => {
    await withTempProject(async (cwd) => {
      const runId = '20261008-123456-abcd1234';
      await mkdir(reportsRoot(cwd) + '/' + runId, { recursive: true });
      const [found] = await listRunIds(cwd);
      expect(found).toBe(runId);
      expect(isSafeRunId(found)).toBe(true);
      expect(relative(reportsRoot(cwd), runReportDir(cwd, found ?? ''))).toBe(runId);
    });
  });
});