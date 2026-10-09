/**
 * `local-ci report <run-id>` — reopens a stored run.
 *
 * A stored report is data this process did not write, and the run id is a
 * user-supplied string on its way into a filesystem path. Both are treated as
 * untrusted: the id is validated before it is joined, and every failure — no
 * id, an invalid id, an unknown id, a corrupt file — produces one readable
 * sentence instead of a stack trace.
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { printConsoleReport } from '../../reporters/console.js';
import { ReportFormatError, decodeRunReport, type RunReport } from '../../reporters/report-model.js';
import { isSafeRunId, listRunIds, reportHtmlPath, reportJsonPath } from '../../reporters/paths.js';

const RECENT_LIMIT = 10;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shows the most recent runs so an unknown id can be corrected immediately. */
async function printAvailableRuns(cwd: string, headline?: string): Promise<void> {
  if (headline) console.error(`\n${headline}`);

  const runIds = await listRunIds(cwd);
  if (runIds.length === 0) {
    console.error('\nNo stored reports were found. Run "local-ci run" first.');
    return;
  }

  console.error('\nAvailable runs (most recent first):');
  for (const runId of runIds.slice(0, RECENT_LIMIT)) console.error(`  ${runId}`);
  if (runIds.length > RECENT_LIMIT) console.error(`  ... and ${runIds.length - RECENT_LIMIT} more`);
}

export async function reportCommand(cwd: string, runId?: string): Promise<number> {
  if (!runId || runId.trim() === '') {
    console.error('Usage: local-ci report <run-id>');
    await printAvailableRuns(cwd, 'No run id was supplied.');
    return 1;
  }

  if (!isSafeRunId(runId)) {
    console.error(
      `"${runId}" is not a valid run id. A run id may contain letters, digits, dots, dashes and underscores.`,
    );
    await printAvailableRuns(cwd);
    return 1;
  }

  const path = reportJsonPath(cwd, runId);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      await printAvailableRuns(cwd, `No report found for run "${runId}".`);
      return 1;
    }
    console.error(`Unable to read the report for run "${runId}": ${message(error)}`);
    return 1;
  }

  let decoded: RunReport;
  try {
    decoded = decodeRunReport(JSON.parse(raw) as unknown);
  } catch (error) {
    const reason =
      error instanceof SyntaxError
        ? 'the file is not valid JSON'
        : error instanceof ReportFormatError
          ? error.message
          : message(error);
    console.error(`The stored report for run "${runId}" could not be read: ${reason}.`);
    console.error(`Location: ${path}`);
    return 1;
  }

  printConsoleReport(decoded);

  console.log(`\nStored report: ${relative(cwd, path) || path}`);
  console.log(`HTML report:   ${relative(cwd, reportHtmlPath(cwd, decoded.runId))}`);

  // Displaying a stored run succeeded. The pipeline's own exit code is a
  // historical fact about that run, not about this command.
  return 0;
}