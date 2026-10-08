import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineRunResult } from '../core/pipeline-runner.js';
import type { StepResult } from '../core/step-runner.js';

/**
 * Persists per-step logs next to the run's JSON/HTML reports.
 *
 * This is deliberately separate from ProcessRunner: the engine produces data,
 * this module decides how that data is written to disk. ProcessRunner has no
 * knowledge of reports, HTML or log layout.
 */

/** Defensive filename sanitization; step ids are schema-constrained but a
 * registry may hold any id. */
export function toLogFileName(stepId: string): string {
  const safe = stepId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${safe || 'step'}.log`;
}

function section(title: string, body: string | undefined): string | undefined {
  if (!body || body.trim() === '') return undefined;
  return `--- ${title} ---\n${body.replace(/\s+$/, '')}\n`;
}

export function formatStepLog(step: StepResult): string {
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

/** Writes `logs/<step-id>.log` for every step of a run. Returns the log directory. */
export async function writeRunLogs(cwd: string, result: PipelineRunResult): Promise<string> {
  const dir = join(cwd, '.local-ci', 'reports', result.runId, 'logs');
  await mkdir(dir, { recursive: true });

  await Promise.all(
    result.steps.map((step) => writeFile(join(dir, toLogFileName(step.id)), formatStepLog(step), 'utf8')),
  );

  return dir;
}