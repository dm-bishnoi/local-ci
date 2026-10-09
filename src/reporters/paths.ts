/**
 * Deterministic on-disk layout for run artifacts.
 *
 * Everything a run produces lives under `<cwd>/.local-ci/reports/<run-id>/`, in
 * the project itself and never in an OS temp directory, so a report is still
 * readable after the run and can be archived, diffed or attached by hand.
 *
 * Run ids are treated as untrusted on the way back in: `local-ci report <run-id>`
 * passes a user-supplied string straight into a filesystem path, so it is
 * validated here rather than at each call site.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export const REPORT_ROOT_DIR = '.local-ci';
export const REPORTS_DIR_NAME = 'reports';
export const REPORT_JSON_FILE = 'report.json';
export const SUMMARY_JSON_FILE = 'summary.json';
export const REPORT_HTML_FILE = 'report.html';
export const LOGS_DIR_NAME = 'logs';

/** Raised for user-facing problems with a run id or an artifact path. */
export class ReportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPathError';
  }
}

/**
 * Allowed shape of a run id directory name.
 *
 * Anchored, and without a leading dot, so a run id can never be `..`, never
 * contain a path separator, and can never resolve outside the reports root.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Windows device names remain reserved even with an extension, so a directory
 * literally named `con` cannot be created there. Rejected everywhere for
 * consistent behaviour across platforms.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_PATTERN.test(runId) && !WINDOWS_RESERVED_NAME.test(runId);
}

/** Validates a run id, throwing a message meant to be shown to a user. */
export function assertSafeRunId(runId: unknown): string {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new ReportPathError('A run id is required. Usage: local-ci report <run-id>');
  }
  if (!isSafeRunId(runId)) {
    throw new ReportPathError(
      `"${runId}" is not a valid run id. A run id may contain letters, digits, dots, dashes and underscores.`,
    );
  }
  return runId;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Builds a run id: `YYYYMMDD-HHmmss-<8 hex>`.
 *
 * Local time and a UUID prefix, so ids sort chronologically as plain strings and
 * two runs in the same second still get distinct directories. The clock and the
 * random source are injectable so tests are deterministic.
 */
export function createRunId(now: Date = new Date(), random: () => string = defaultRandomSuffix): string {
  const date = `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${date}-${time}-${random().slice(0, 8)}`;
}

function defaultRandomSuffix(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}

export function reportsRoot(cwd: string): string {
  return join(cwd, REPORT_ROOT_DIR, REPORTS_DIR_NAME);
}

/** Artifact directory for a run. Throws for an unsafe run id. */
export function runReportDir(cwd: string, runId: string): string {
  return join(reportsRoot(cwd), assertSafeRunId(runId));
}

export function reportJsonPath(cwd: string, runId: string): string {
  return join(runReportDir(cwd, runId), REPORT_JSON_FILE);
}

export function summaryJsonPath(cwd: string, runId: string): string {
  return join(runReportDir(cwd, runId), SUMMARY_JSON_FILE);
}

export function reportHtmlPath(cwd: string, runId: string): string {
  return join(runReportDir(cwd, runId), REPORT_HTML_FILE);
}

export function logsDirPath(cwd: string, runId: string): string {
  return join(runReportDir(cwd, runId), LOGS_DIR_NAME);
}

/**
 * Maps a step id to its log file name.
 *
 * Defensive by design: step ids are schema-constrained, but a registry may hold
 * any string. The result can never contain a path separator and can never be a
 * hidden or traversal file name.
 */
export function toLogFileName(stepId: string): string {
  const safe = stepId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${safe || 'step'}.log`;
}

/** Run ids that have a directory on disk, newest first. */
export async function listRunIds(cwd: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(reportsRoot(cwd), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && isSafeRunId(entry.name))
    .map((entry) => entry.name)
    // Run ids start with a sortable timestamp, so a reverse lexicographic sort
    // is a reverse chronological one without touching the filesystem.
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}