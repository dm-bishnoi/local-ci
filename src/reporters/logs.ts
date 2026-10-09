/**
 * `logs/<step-id>.log` — the complete output of the steps that actually ran.
 *
 * This is deliberately separate from ProcessRunner: the engine produces data,
 * this module decides how that data is written to disk. ProcessRunner has no
 * knowledge of reports, HTML or the log layout.
 *
 * Two rules:
 *
 * - A step that never executed gets no file. `UNSUPPORTED` and `SKIPPED` steps
 *   were never dispatched, so a log for them would be fabricated evidence. Their
 *   reason is carried in `report.json` and shown in the HTML report instead.
 * - This is the only artifact that carries untruncated output, and it inherits
 *   the Phase 2 capture cap. Output is masked on the way in, so the one file
 *   that holds the most text is also covered by redaction.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepStatus } from '../core/step-runner.js';
import type { BuiltReport } from './report-model.js';
import { logsDirPath, toLogFileName } from './paths.js';

export { toLogFileName } from './paths.js';

/**
 * The subset of a step result a log needs. Declared structurally rather than as
 * `StepResult` so both a raw engine result and a redacted log source satisfy it.
 */
export interface StepLogInput {
  id: string;
  name: string;
  status: StepStatus;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function section(title: string, body: string | undefined): string | undefined {
  if (!body || body.trim() === '') return undefined;
  return `--- ${title} ---\n${body.replace(/\s+$/, '')}\n`;
}

/**
 * Renders one step log.
 *
 * The header states what ran, how it ended and why, so a log file is
 * self-describing when read on its own — months later, out of context, or
 * pasted into an issue. Sections that carry no information are omitted rather
 * than written empty.
 */
export function formatStepLog(step: StepLogInput): string {
  const header = [
    `# step: ${step.name} (${step.id})`,
    `status: ${step.status}`,
    `duration: ${step.durationMs} ms`,
  ];

  if (step.startedAt) header.push(`startedAt: ${step.startedAt}`);
  if (step.endedAt) header.push(`endedAt: ${step.endedAt}`);
  if (step.command) header.push(`command: ${step.command}`);
  if (step.exitCode !== undefined) header.push(`exitCode: ${step.exitCode ?? 'none'}`);
  if (step.signal !== undefined) header.push(`signal: ${step.signal ?? 'none'}`);
  if (step.timedOut) header.push('timedOut: true');
  if (step.cancelled) header.push('cancelled: true');

  const sections = [
    step.error ? `--- error ---\n${step.error}\n` : undefined,
    section('stderr', step.stderr),
    section('stdout', step.stdout),
  ].filter((value): value is string => value !== undefined);

  return `${header.join('\n')}\n\n${sections.join('\n')}`;
}

/**
 * Writes one log per executed step. Returns the log directory and the file names
 * written, so callers can report what exists rather than assume.
 */
export async function writeRunLogs(cwd: string, built: BuiltReport): Promise<{ dir: string; files: string[] }> {
  const dir = logsDirPath(cwd, built.report.runId);
  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  for (const entry of built.logs) {
    const file = toLogFileName(entry.id);
    await writeFile(join(dir, file), formatStepLog(entry.step), 'utf8');
    written.push(file);
  }

  return { dir, files: written };
}