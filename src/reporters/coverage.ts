/**
 * Coverage facts for a report.
 *
 * Two rules govern this module:
 *
 * 1. A percentage is reported only when a real coverage tool produced one. There
 *    is no default, no fallback and no "0% because nothing was found" — a missing
 *    measurement is `unavailable`, and a capability the adapter declined to run
 *    is `unsupported`. These are different facts and are kept distinct.
 * 2. Coverage is read from a *defined* format, never guessed out of free-form
 *    build output. The only source accepted here is the Istanbul
 *    `coverage-summary.json` report, whose schema is fixed and documented.
 *    Parsing console output with a regex would produce a number that looks like
 *    a measurement and is not one.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepResult } from '../core/step-runner.js';

/** Default Istanbul summary location, relative to the project root. */
export const COVERAGE_SUMMARY_FILE = join('coverage', 'coverage-summary.json');

export type CoverageState = 'available' | 'unavailable' | 'unsupported';

export interface CoverageInfo {
  state: CoverageState;
  /** Measured percentage. `null` unless `state` is `available`. */
  percent: number | null;
  /** Where the number came from, relative to the project root. */
  source: string | null;
  /** Why no number is available. `null` when `state` is `available`. */
  reason: string | null;
}

/** Step id that carries coverage in the Angular vocabulary. */
export const COVERAGE_STEP_ID = 'coverage';

/**
 * Reads a percentage out of an Istanbul `coverage-summary.json`.
 *
 * Returns `null` — never a guess — when the file is absent, unreadable, not
 * JSON, or does not match the documented schema. Only `total.lines.pct` is
 * accepted: statement/branch/function totals are reported separately by the
 * coverage tooling and collapsing them into one number would be invented data.
 */
export async function readIstanbulCoverageSummary(
  cwd: string,
  relativePath: string = COVERAGE_SUMMARY_FILE,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, relativePath), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    // Windows editors add a BOM; JSON.parse rejects it.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
  } catch {
    return null;
  }

  return istanbulTotalLinesPercent(parsed);
}

/** Extracts `total.lines.pct` from a parsed Istanbul summary, or `null`. */
export function istanbulTotalLinesPercent(summary: unknown): number | null {
  if (typeof summary !== 'object' || summary === null) return null;

  const total = (summary as { total?: unknown }).total;
  if (typeof total !== 'object' || total === null) return null;

  const lines = (total as { lines?: unknown }).lines;
  if (typeof lines !== 'object' || lines === null) return null;

  const pct = (lines as { pct?: unknown }).pct;
  // A coverage tool that could not compute a value writes `null` or omits it.
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct < 0 || pct > 100) return null;

  return pct;
}

interface CoverageStepView {
  id: string;
  status: string;
  error?: string;
}

export interface CoverageInput {
  /** Percentage read from a real coverage summary file, when one exists. */
  percent?: number | null;
  /** Project-relative path the percentage came from. */
  source?: string | null;
  /** The run's steps, used to tell unsupported apart from unavailable. */
  steps?: readonly CoverageStepView[];
}

/**
 * Derives the coverage fact for a run.
 *
 * The distinction between the three states is the whole point:
 * - `unsupported` — the pipeline has no coverage step, or the adapter declined
 *   to run one. Nothing was attempted.
 * - `unavailable` — coverage ran but produced no summary. Something is missing
 *   from the project; that is actionable and different from unsupported.
 * - `available` — a measured percentage, and only then a percentage.
 */
export function normalizeCoverage(input: CoverageInput = {}): CoverageInfo {
  const coverageStep = input.steps?.find((step) => step.id === COVERAGE_STEP_ID);

  if (!coverageStep) {
    return {
      state: 'unsupported',
      percent: null,
      source: null,
      reason: 'This pipeline does not include a coverage step.',
    };
  }

  if (coverageStep.status === 'UNSUPPORTED') {
    return {
      state: 'unsupported',
      percent: null,
      source: null,
      reason: coverageStep.error?.trim() || 'Coverage is not implemented for this project.',
    };
  }

  const percent = input.percent;
  if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    return { state: 'available', percent, source: input.source ?? COVERAGE_SUMMARY_FILE, reason: null };
  }

  if (coverageStep.status !== 'PASS') {
    // Coverage did not complete, so there is nothing to read. Reporting the
    // step's own status keeps the two facts consistent.
    return {
      state: 'unavailable',
      percent: null,
      source: null,
      reason: `The coverage step did not complete successfully (status ${coverageStep.status}).`,
    };
  }

  return {
    state: 'unavailable',
    percent: null,
    source: null,
    reason: `The coverage step ran but produced no ${COVERAGE_SUMMARY_FILE} to read.`,
  };
}

export interface DiscoveredCoverage {
  percent: number | null;
  source: string | null;
}

/**
 * Reads the coverage a run actually produced.
 *
 * A summary left over from an earlier run is never adopted: the file is only
 * consulted when this run's coverage step actually passed. Otherwise the run
 * either produced nothing, or produced something that did not finish, and both
 * of those mean "no measurement", not "the last known number".
 */
export async function readRunCoverage(
  cwd: string,
  steps: readonly StepResult[],
  relativePath: string = COVERAGE_SUMMARY_FILE,
): Promise<DiscoveredCoverage> {
  const coverageStep = steps.find((step) => step.id === COVERAGE_STEP_ID);
  if (!coverageStep || coverageStep.status !== 'PASS') return { percent: null, source: null };

  const percent = await readIstanbulCoverageSummary(cwd, relativePath);
  return { percent, source: percent === null ? null : relativePath };
}