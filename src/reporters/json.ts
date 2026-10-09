/**
 * `report.json` — the complete, machine-readable record of a run.
 *
 * Serializes the {@link RunReport} verbatim. Because the model already bounds
 * every excerpt and masks every string, there is no second sanitising pass here
 * that could disagree with the one the HTML and log reporters see.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import type { RunReport } from './report-model.js';
import { reportJsonPath, runReportDir } from './paths.js';

export function serializeReport(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeJsonReport(cwd: string, report: RunReport): Promise<string> {
  await mkdir(runReportDir(cwd, report.runId), { recursive: true });
  const path = reportJsonPath(cwd, report.runId);
  await writeFile(path, serializeReport(report), 'utf8');
  return path;
}