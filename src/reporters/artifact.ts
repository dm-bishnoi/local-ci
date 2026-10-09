/**
 * Writes every artifact of one run, without letting a reporting failure destroy
 * the result the reporting was meant to describe.
 *
 * The invariant this module exists to guarantee:
 *
 * > A failed, timed-out or cancelled pipeline must always produce its reports,
 * > and a failure while writing them must never turn into a reported PASS or
 * > hide the original pipeline result.
 *
 * Each artifact is written independently inside its own guard, so a full disk
 * taking out `report.html` does not also cost `report.json`. Failures are
 * collected and returned rather than thrown; the caller decides what to print
 * and what exit code to return.
 */

import type { BuiltReport } from './report-model.js';
import { writeHtmlReport } from './html.js';
import { writeJsonReport } from './json.js';
import { writeRunLogs } from './logs.js';
import {
  LOGS_DIR_NAME,
  REPORT_HTML_FILE,
  REPORT_JSON_FILE,
  SUMMARY_JSON_FILE,
  logsDirPath,
  reportHtmlPath,
  reportJsonPath,
  runReportDir,
  summaryJsonPath,
} from './paths.js';
import { writeSummaryReport } from './summary.js';

export interface ArtifactError {
  /** Human-readable artifact name, e.g. `report.json`. */
  artifact: string;
  message: string;
}

export interface ReportArtifactPaths {
  directory: string;
  reportJson: string;
  summaryJson: string;
  reportHtml: string;
  logsDirectory: string;
}

export interface WriteReportsResult {
  paths: ReportArtifactPaths;
  /** Artifacts that were written successfully, in write order. */
  written: string[];
  /** Artifacts that failed. Empty on a fully successful write. */
  errors: ArtifactError[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeRunReports(cwd: string, built: BuiltReport): Promise<WriteReportsResult> {
  const { runId } = built.report;
  const paths: ReportArtifactPaths = {
    directory: runReportDir(cwd, runId),
    reportJson: reportJsonPath(cwd, runId),
    summaryJson: summaryJsonPath(cwd, runId),
    reportHtml: reportHtmlPath(cwd, runId),
    logsDirectory: logsDirPath(cwd, runId),
  };

  const written: string[] = [];
  const errors: ArtifactError[] = [];

  const guard = async (artifact: string, write: () => Promise<unknown>): Promise<void> => {
    try {
      await write();
      written.push(artifact);
    } catch (error) {
      errors.push({ artifact, message: describe(error) });
    }
  };

  // Logs first: they are the evidence a failing run is judged by, and they are
  // the only artifact holding complete output.
  await guard(`${LOGS_DIR_NAME}/`, async () => {
    await writeRunLogs(cwd, built);
  });
  await guard(REPORT_JSON_FILE, async () => {
    await writeJsonReport(cwd, built.report);
  });
  await guard(SUMMARY_JSON_FILE, async () => {
    await writeSummaryReport(cwd, built.report);
  });
  await guard(REPORT_HTML_FILE, async () => {
    await writeHtmlReport(cwd, built.report);
  });

  return { paths, written, errors };
}

/** Human-readable summary of a partial or total write failure. */
export function describeReportErrors(errors: readonly ArtifactError[]): string {
  const lines = errors.map((error) => `  - ${error.artifact}: ${error.message}`);
  return `local-ci could not write ${errors.length} report artifact(s):\n${lines.join('\n')}`;
}