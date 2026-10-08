import ora from 'ora';
import type { PipelineRunResult } from '../core/pipeline-runner.js';
import type { StepStatus } from '../core/step-runner.js';

const ICONS: Record<StepStatus, string> = {
  PASS: '✓',
  FAIL: '✗',
  UNSUPPORTED: '!',
  SKIPPED: '○',
  CANCELLED: '⊘',
};

function describeFlags(step: { timedOut?: boolean; cancelled?: boolean; exitCode?: number | null; signal?: string | null }): string {
  const flags: string[] = [];
  if (step.timedOut) flags.push('timed out');
  if (step.cancelled) flags.push('cancelled');
  if (step.signal) flags.push(`signal ${step.signal}`);
  return flags.length > 0 ? ` [${flags.join(', ')}]` : '';
}

export function printConsoleReport(result: PipelineRunResult): void {
  const spinner = ora({ isEnabled: process.stdout.isTTY });
  spinner.stop();
  console.log('\nLOCAL CI REPORT\n');

  for (const step of result.steps) {
    console.log(`${ICONS[step.status]} ${step.name} [${step.status}]${describeFlags(step)} (${step.durationMs} ms)`);
    if (step.error) console.log(`  ${step.error}`);
  }

  console.log(`\nResult: ${result.status}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(`Run ID: ${result.runId}`);
}