/**
 * The console report — the one artifact a developer actually reads.
 *
 * Design rules:
 *
 * - **Status is never carried by colour alone.** Every row spells out its status
 *   in words next to its icon, so the report survives a pipe, a log file, a
 *   monochrome terminal and a copy-paste into an issue.
 * - **Failures come last and explain themselves.** A passing run stays quiet; a
 *   failing run says which step failed and why, without the reader opening a
 *   file.
 * - **Not noisy.** No spinners here. ora belongs to live progress while a step
 *   is running (see `createProgressReporter`); a finished report is plain text.
 */

import ora from 'ora';
import type { PipelineStep, StepStatus } from '../core/step-runner.js';
import {
  formatCoverage,
  formatDuration,
  formatStepDuration,
  overallLabel,
  padEnd,
  padStart,
  statusIcon,
  statusLabel,
} from './format.js';
import type { ReportStep, RunReport } from './report-model.js';
import { renderDiagnostics } from './diagnostics-format.js';

const RULE = '-'.repeat(46);
const NO_DETAIL = '(no further detail was reported)';

/** Exit code and terminal flags, only when they carry information. */
function stepDetail(step: ReportStep): string {
  if (!step.executed) return '';

  const parts: string[] = [];
  if (step.exitCode !== undefined && step.exitCode !== null) parts.push(`exit ${step.exitCode}`);
  else if (step.signal) parts.push(`signal ${step.signal}`);
  if (step.timedOut) parts.push('timed out');
  if (step.cancelled && !step.timedOut) parts.push('cancelled');
  return parts.join(', ');
}

function renderStepRows(steps: readonly ReportStep[]): string[] {
  const nameWidth = Math.max(...steps.map((step) => step.name.length), 0);
  const statusWidth = Math.max(...steps.map((step) => statusLabel(step.status).length), 0);

  return steps.map((step) => {
    const row = [
      `${statusIcon(step.status)} ${padEnd(step.name, nameWidth)}`,
      padEnd(statusLabel(step.status), statusWidth),
      padStart(formatStepDuration(step.durationMs, step.executed), 8),
    ].join('  ');

    const detail = stepDetail(step);
    return detail ? `${row}  ${detail}` : row;
  });
}

/**
 * Aligns a `Label: value` line. The width is one past the longest label
 * (`Package Manager:`) so every value starts in the same column.
 */
function field(label: string, value: string): string {
  return `${padEnd(`${label}:`, 17)}${value}`;
}

function indent(text: string, prefix = '  '): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * Renders the full console report as a string.
 *
 * Pure, so the exact output can be asserted in tests instead of being captured
 * from a mocked stdout.
 */
export function formatConsoleReport(report: RunReport): string {
  const { counts } = report;
  const lines: string[] = ['LOCAL CI REPORT', ''];

  lines.push(field('Project', report.projectName));
  lines.push(field('Framework', report.framework ?? 'unknown'));
  lines.push(field('Package Manager', report.packageManager ?? 'unknown'));
  lines.push(field('Coverage', formatCoverage(report.coverage.state, report.coverage.percent)));

  if (report.environment) {
    lines.push(field('Node', report.environment.runtime.version ?? 'unknown'));
    lines.push(field('Platform', `${report.environment.os.platform} ${report.environment.os.arch}`));
  }

  lines.push('');

  // Preflight is printed before the steps: it explains why the run looked the
  // way it did, which is the whole point of running it at all.
  if (report.preflight) lines.push(...renderDiagnostics('PREFLIGHT', report.preflight.diagnostics), '');

  if (report.steps.length === 0) lines.push('(no steps were executed)');
  else lines.push(...renderStepRows(report.steps));

  lines.push('', RULE, '');
  lines.push(field('Result', overallLabel(report.status)));
  // The canonical outcome says *why* the run did not pass. It is shown whenever
  // it adds information the plain status cannot carry: a run whose steps were
  // BLOCKED or UNSUPPORTED is a FAIL at the engine level, and printing only
  // that would hide the fact the reader needs most.
  if (report.outcome !== report.status) {
    lines.push(field('Outcome', report.outcome));
  }
  lines.push(field('Duration', formatDuration(report.durationMs)));
  lines.push(field('Run ID', report.runId));
  lines.push(field('Passed', String(counts.passed)));
  lines.push(field('Failed', String(counts.failed)));
  // Timeouts, blocked steps and errors each get their own counter, because
  // "failed" alone would hide why they did not pass.
  if (counts.timeout > 0) lines.push(field('Timed out', String(counts.timeout)));
  if (counts.blocked > 0) lines.push(field('Blocked', String(counts.blocked)));
  if (counts.error > 0) lines.push(field('Errors', String(counts.error)));
  lines.push(field('Unsupported', String(counts.unsupported)));
  lines.push(field('Skipped', String(counts.skipped)));
  // Cancellation is only surfaced when it happened; five fixed counters for
  // every run would be noise.
  if (counts.cancelled > 0) lines.push(field('Cancelled', String(counts.cancelled)));

  for (const step of report.steps.filter((s) => s.status === 'FAIL' || s.status === 'CANCELLED')) {
    lines.push('', 'Failed step:', step.name, 'Reason:', indent(step.error ?? NO_DETAIL));
  }

  for (const step of report.steps.filter((s) => s.outcome === 'TIMEOUT')) {
    lines.push('', 'Timed out:', step.name, 'Reason:', indent(step.error ?? NO_DETAIL));
  }

  for (const step of report.steps.filter((s) => s.status === 'BLOCKED')) {
    lines.push('', 'Blocked step:', step.name, 'Reason:', indent(step.error ?? NO_DETAIL));
  }

  for (const step of report.steps.filter((s) => s.status === 'UNSUPPORTED')) {
    lines.push('', 'Unsupported step:', step.name, 'Reason:', indent(step.error ?? NO_DETAIL));
  }

  for (const step of report.steps.filter((s) => s.status === 'ERROR')) {
    lines.push('', 'Errored step:', step.name, 'Reason:', indent(step.error ?? NO_DETAIL));
  }

  // Only explain an absence when there is an explanation to give.
  if (report.coverage.state !== 'available' && report.coverage.reason) {
    lines.push('', 'Coverage:', indent(report.coverage.reason));
  }

  return lines.join('\n');
}

export function printConsoleReport(report: RunReport): void {
  console.log(`\n${formatConsoleReport(report)}\n`);
}

/**
 * Live progress for a running pipeline.
 *
 * This is the only place ora is used, and only while work is genuinely in
 * flight. When stdout is not a TTY the spinner is disabled outright, so piping a
 * run to a file produces clean output instead of thousands of escape sequences.
 */
export interface ProgressReporter {
  onStepStart(step: PipelineStep): void;
  onStepEnd(result: { name: string; status: StepStatus }): void;
  stop(): void;
}

export function createProgressReporter(): ProgressReporter {
  // `isSilent` is what actually suppresses a non-interactive run. `isEnabled`
  // alone is not enough: ora still writes a `- started` line and a final
  // status line for a disabled spinner, which is pure noise in a redirected
  // log and makes the report harder to read, not easier.
  const interactive = Boolean(process.stdout.isTTY);
  const spinner = ora({ isEnabled: interactive, isSilent: !interactive, discardStdin: false });

  return {
    onStepStart(step: PipelineStep): void {
      spinner.start(step.name);
    },
    onStepEnd(result: { name: string; status: StepStatus }): void {
      const label = `${statusIcon(result.status)} ${result.name} — ${statusLabel(result.status)}`;
      if (result.status === 'PASS') spinner.succeed(label);
      else if (result.status === 'FAIL') spinner.fail(label);
      else if (result.status === 'CANCELLED' || result.status === 'UNSUPPORTED') spinner.warn(label);
      else spinner.stop();
    },
    stop(): void {
      spinner.stop();
    },
  };
}