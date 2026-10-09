/**
 * `summary.json` — the small, machine-readable digest of a run.
 *
 * The point of this file is that another tool can decide whether a run passed
 * without parsing `report.json`, loading an HTML document, or understanding the
 * full step model. It is therefore deliberately flat, deliberately complete for
 * the questions it answers, and free of anything derived from process output.
 */

import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { isSuccess, outcomeOf } from '../core/status.js';
import { firstLine } from './format.js';
import { SUMMARY_JSON_VERSION, type RunReport } from './report-model.js';
import { runReportDir, summaryJsonPath } from './paths.js';

export interface SummaryFailure {
  id: string;
  name: string;
  /** Canonical outcome, e.g. `TIMEOUT`. */
  outcome: string;
  /** First line of the failure reason, for a one-line consumer. */
  reason: string;
}

export interface SummaryReport {
  schemaVersion: number;
  runId: string;
  /** Pipeline status, same as the original run. */
  status: string;
  exitCode: number;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  projectName: string;
  framework: string | null;
  packageManager: string | null;
  coverage: { status: string; percent: number | null };
  /** Steps counts as reported in the full report, with BLOCKED/ERROR/TIMEOUT */
  steps: {
    total: number;
    passed: number;
    failed: number;
    unsupported: number;
    skipped: number;
    cancelled: number;
    blocked: number;
    error: number;
    timeout: number;
  };
  /** Steps that did not pass, most actionable first. */
  failures: SummaryFailure[];
  /**
   * Machine and project fingerprint.
   *
   * Present whenever a fingerprint was collected. It is what makes a report
   * self-describing and what a later local-versus-CI comparison will diff.
   * Contains no environment variable values, no file contents and no secrets.
   */
  environment?: any;
  /** Result of the preflight that gated this run, when one ran. */
  preflight?: any;
}

export function buildSummaryReport(report: RunReport): SummaryReport {
  const failures = report.steps
    .filter((step) => !isSuccess(outcomeOf(step)))
    .map((step) => ({
      id: step.id,
      name: step.name,
      outcome: step.outcome,
      reason: firstLine(step.error),
    }));

  return {
    schemaVersion: SUMMARY_JSON_VERSION,
    runId: report.runId,
    status: report.status,
    exitCode: report.exitCode,
    durationMs: report.durationMs,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    projectName: report.projectName,
    framework: report.framework,
    packageManager: report.packageManager,
    coverage: { status: report.coverage.state, percent: report.coverage.percent },
    steps: { ...report.counts },
    failures,
    ...(report.environment ? { environment: report.environment } : {}),
    ...(report.preflight ? { preflight: report.preflight } : {}),
  };
}

export async function writeSummaryReport(cwd: string, report: RunReport): Promise<string> {
  await mkdir(runReportDir(cwd, report.runId), { recursive: true });
  const path = summaryJsonPath(cwd, report.runId);
  await writeFile(path, JSON.stringify(buildSummaryReport(report), null, 2), 'utf8');
  return path;
}