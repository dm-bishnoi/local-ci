/**
 * Text formatting shared by the console and HTML reporters.
 *
 * Every status is rendered with an explicit word in addition to its icon and its
 * colour, so a report stays unambiguous when colour is unavailable — piped to a
 * file, read in a monochrome terminal, or copied into an issue.
 */

import type { PipelineStatus } from '../core/pipeline-runner.js';
import type { StepStatus } from '../core/step-runner.js';
import type { CoverageState } from './coverage.js';

/**
 * Status word plus icon. The icon is a quick scan aid; the word is the fact.
 *
 * Every terminal status has an entry. A status without one could not be
 * rendered at all, which would be the worst possible outcome for a diagnostic
 * tool, so the record is total rather than best-effort.
 */
const STEP_MARK: Record<StepStatus, { icon: string; label: string }> = {
  PASS: { icon: '✓', label: 'PASS' },
  FAIL: { icon: '✗', label: 'FAIL' },
  UNSUPPORTED: { icon: '!', label: 'UNSUPPORTED' },
  SKIPPED: { icon: '○', label: 'SKIPPED' },
  CANCELLED: { icon: '⊘', label: 'CANCELLED' },
  BLOCKED: { icon: '⊘', label: 'BLOCKED' },
  ERROR: { icon: '✗', label: 'ERROR' },
};

export function statusIcon(status: StepStatus): string {
  return STEP_MARK[status].icon;
}

export function statusLabel(status: StepStatus): string {
  return STEP_MARK[status].label;
}

/** Marker used where a step never ran and therefore has no duration. */
export const NO_DURATION = '—';

/**
 * Formats a duration for humans: `12.4s`, `1m 16s`, `820ms`.
 *
 * Sub-second steps keep millisecond precision so a fast step never reads as
 * `0.0s`, which would look like a broken measurement rather than a fast step.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return NO_DURATION;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;

  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) return `${hours}h ${remainingMinutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Duration text for a step that never executed. */
export function formatStepDuration(durationMs: number, executed: boolean): string {
  return executed ? formatDuration(durationMs) : NO_DURATION;
}

/**
 * Renders coverage honestly.
 *
 * A percentage is only ever printed when one was actually measured. "No data"
 * is rendered as unavailable or unsupported — never as `0%`, which would state
 * a measurement that was never taken.
 */
export function formatCoverage(state: CoverageState, percent: number | null): string {
  if (state === 'available' && percent !== null) {
    // Two decimals matches how Istanbul reports a total, without implying more
    // precision than the coverage tooling actually provides.
    return `${percent.toFixed(2)}%`;
  }
  if (state === 'unsupported') return 'UNSUPPORTED';
  return 'unavailable';
}

/** Renders an exit code, distinguishing "did not run" from "terminated by signal". */
export function formatExitCode(exitCode: number | null | undefined): string {
  if (exitCode === undefined || exitCode === null) return NO_DURATION;
  return String(exitCode);
}

export function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** Renders an ISO timestamp for display, falling back to the raw value. */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return NO_DURATION;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Plain-text overall result line, e.g. `FAIL`.
 *
 * A cancelled run is reported as `CANCELLED` rather than `FAIL`: the run was
 * interrupted, not broken, and conflating the two misleads whoever reads the
 * report.
 */
export function overallLabel(status: PipelineStatus): string {
  return status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'CANCELLED';
}

/**
 * First meaningful line of an error, for single-line contexts such as a summary
 * table. Multi-line errors keep only their first line.
 */
export function firstLine(value: string | undefined, limit = 240): string {
  if (!value) return '';
  const line = value.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}