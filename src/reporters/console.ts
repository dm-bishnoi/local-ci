import ora from 'ora';
import type { PipelineRunResult } from '../core/pipeline-runner.js';

export function printConsoleReport(result: PipelineRunResult): void {
  const spinner = ora({ isEnabled: process.stdout.isTTY });
  spinner.stop();
  console.log('\nLOCAL CI REPORT\n');
  for (const step of result.steps) {
    const icon = step.status === 'PASS' ? '✓' : step.status === 'SKIPPED' ? '○' : step.status === 'UNSUPPORTED' ? '!' : '✗';
    const suffix = step.status === 'UNSUPPORTED' ? ' [UNSUPPORTED]' : step.status === 'SKIPPED' ? ' [SKIPPED]' : '';
    console.log(`${icon} ${step.name}${suffix}`);
    if (step.error) console.log(`  ${step.error}`);
  }
  console.log(`\nResult: ${result.status}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
}
