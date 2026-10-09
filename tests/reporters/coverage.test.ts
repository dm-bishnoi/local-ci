import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepResult } from '../../src/core/step-runner.js';
import {
  COVERAGE_SUMMARY_FILE,
  COVERAGE_STEP_ID,
  istanbulTotalLinesPercent,
  normalizeCoverage,
  readIstanbulCoverageSummary,
  readRunCoverage,
} from '../../src/reporters/coverage.js';
import { makeStep, withTempProject } from '../helpers/reports.js';

async function writeSummary(cwd: string, contents: string, relativePath = COVERAGE_SUMMARY_FILE): Promise<void> {
  const path = join(cwd, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

const VALID_SUMMARY = JSON.stringify({
  total: { lines: { total: 250, covered: 212, skipped: 0, pct: 84.8 }, statements: {}, functions: {}, branches: {} },
});

describe('istanbulTotalLinesPercent', () => {
  it('reads total.lines.pct from a well-formed summary', () => {
    expect(istanbulTotalLinesPercent(JSON.parse(VALID_SUMMARY))).toBe(84.8);
  });

  it('accepts the extremes', () => {
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: 0 } } })).toBe(0);
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: 100 } } })).toBe(100);
  });

  it('refuses anything that is not a documented total.lines.pct', () => {
    expect(istanbulTotalLinesPercent(null)).toBeNull();
    expect(istanbulTotalLinesPercent('84.8%')).toBeNull();
    expect(istanbulTotalLinesPercent([])).toBeNull();
    expect(istanbulTotalLinesPercent({})).toBeNull();
    expect(istanbulTotalLinesPercent({ total: {} })).toBeNull();
    expect(istanbulTotalLinesPercent({ total: { lines: {} } })).toBeNull();
  });

  it('refuses values that are not real percentages', () => {
    // A coverage tool writes null/unknown when it could not compute a value.
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: null } } })).toBeNull();
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: '84.8' } } })).toBeNull();
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: Number.NaN } } })).toBeNull();
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: -1 } } })).toBeNull();
    expect(istanbulTotalLinesPercent({ total: { lines: { pct: 101 } } })).toBeNull();
  });

  it('does not fall back to another coverage total', () => {
    // branches/statements percentages exist in the file, but collapsing them
    // into "the" coverage number would be invented data.
    expect(istanbulTotalLinesPercent({ total: { branches: { pct: 91.2 }, statements: { pct: 88.1 } } })).toBeNull();
  });
});

describe('readIstanbulCoverageSummary', () => {
  it('reads a real summary file', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, VALID_SUMMARY);
      expect(await readIstanbulCoverageSummary(cwd)).toBe(84.8);
    });
  });

  it('returns null when the file is missing', async () => {
    await withTempProject(async (cwd) => {
      expect(await readIstanbulCoverageSummary(cwd)).toBeNull();
    });
  });

  it('returns null for invalid JSON instead of throwing', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, '{ not json');
      expect(await readIstanbulCoverageSummary(cwd)).toBeNull();
    });
  });

  it('tolerates a UTF-8 BOM', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, `﻿${VALID_SUMMARY}`);
      expect(await readIstanbulCoverageSummary(cwd)).toBe(84.8);
    });
  });
});

describe('normalizeCoverage', () => {
  const coverageStep = (status: StepResult['status'], error?: string): StepResult =>
    makeStep(COVERAGE_STEP_ID, status, { ...(error ? { error } : {}) });

  it('reports a measured percentage', () => {
    const info = normalizeCoverage({
      percent: 84.72,
      source: COVERAGE_SUMMARY_FILE,
      steps: [coverageStep('PASS')],
    });

    expect(info).toEqual({
      state: 'available',
      percent: 84.72,
      source: COVERAGE_SUMMARY_FILE,
      reason: null,
    });
  });

  it('never turns a missing measurement into 0%', () => {
    const info = normalizeCoverage({ percent: null, steps: [coverageStep('PASS')] });

    expect(info.state).toBe('unavailable');
    expect(info.percent).toBeNull();
  });

  it('distinguishes unsupported from unavailable', () => {
    const unsupported = normalizeCoverage({
      percent: null,
      steps: [coverageStep('UNSUPPORTED', 'No known coverage provider was found.')],
    });
    expect(unsupported.state).toBe('unsupported');
    expect(unsupported.percent).toBeNull();
    expect(unsupported.reason).toContain('No known coverage provider');
    expect(unsupported.reason).not.toMatch(/0%/);
  });

  it('is unsupported when the pipeline has no coverage step', () => {
    const info = normalizeCoverage({ steps: [makeStep('build', 'PASS')] });
    expect(info.state).toBe('unsupported');
    expect(info.reason).toContain('does not include a coverage step');
  });

  it('is unavailable when the coverage step did not complete', () => {
    const info = normalizeCoverage({ percent: null, steps: [coverageStep('FAIL')] });
    expect(info.state).toBe('unavailable');
    expect(info.reason).toContain('did not complete');
  });

  it('rejects an out-of-range percentage instead of trusting it', () => {
    for (const percent of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      const info = normalizeCoverage({ percent, steps: [coverageStep('PASS')] });
      expect(info.state).toBe('unavailable');
      expect(info.percent).toBeNull();
    }
  });

  it('survives being called with no input at all', () => {
    expect(normalizeCoverage().state).toBe('unsupported');
  });
});

describe('readRunCoverage', () => {
  it('reads the summary only when the coverage step passed', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, VALID_SUMMARY);
      const passed = await readRunCoverage(cwd, [makeStep(COVERAGE_STEP_ID, 'PASS')]);
      expect(passed.percent).toBe(84.8);
      expect(passed.source).toBe(COVERAGE_SUMMARY_FILE);
    });
  });

  it('never adopts a stale summary from a run whose coverage step failed', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, VALID_SUMMARY);

      const failed = await readRunCoverage(cwd, [makeStep(COVERAGE_STEP_ID, 'FAIL')]);
      expect(failed.percent).toBeNull();

      const unsupported = await readRunCoverage(cwd, [makeStep(COVERAGE_STEP_ID, 'UNSUPPORTED')]);
      expect(unsupported.percent).toBeNull();
    });
  });

  it('never adopts a summary when the pipeline has no coverage step', async () => {
    await withTempProject(async (cwd) => {
      await writeSummary(cwd, VALID_SUMMARY);
      const info = await readRunCoverage(cwd, [makeStep('build', 'PASS')]);
      expect(info.percent).toBeNull();
    });
  });

  it('reports no measurement when the step passed but wrote no summary', async () => {
    await withTempProject(async (cwd) => {
      const info = await readRunCoverage(cwd, [makeStep(COVERAGE_STEP_ID, 'PASS')]);
      expect(info.percent).toBeNull();
      expect(info.source).toBeNull();
    });
  });
});