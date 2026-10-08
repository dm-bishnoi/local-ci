import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config/loader.js';
import { createRunCancellation } from '../../core/cancellation.js';
import { PipelineRunner } from '../../core/pipeline-runner.js';
import { StepRegistry } from '../../core/step-runner.js';
import { writeHtmlReport } from '../../reporters/html.js';
import { printConsoleReport } from '../../reporters/console.js';
import { writeJsonReport } from '../../reporters/json.js';
import { writeRunLogs } from '../../reporters/logs.js';

function createRunId(): string {
  return `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export async function runCommand(cwd: string): Promise<number> {
  const config = await loadConfig(cwd);
  const runId = createRunId();
  const runner = new PipelineRunner(new StepRegistry());

  // One cancellation object per invocation, always disposed, so repeated
  // commands never accumulate SIGINT/SIGTERM listeners.
  const cancellation = createRunCancellation((reason) => {
    console.error(`\nlocal-ci: ${reason} Cancelling run...`);
  });

  let result;
  try {
    result = await runner.run({ cwd, config, runId, signal: cancellation.signal });
  } finally {
    cancellation.dispose();
  }

  printConsoleReport(result);

  // Persist artifacts even for a failed or cancelled run: the evidence is most
  // valuable exactly when something went wrong.
  const logs = await writeRunLogs(cwd, result);
  const json = await writeJsonReport(cwd, result);
  const html = await writeHtmlReport(cwd, result);

  console.log(`\nLogs: ${logs}`);
  console.log(`JSON: ${json}`);
  console.log(`HTML: ${html}`);

  // 0 only when the pipeline genuinely succeeded.
  return result.status === 'PASS' ? 0 : 1;
}