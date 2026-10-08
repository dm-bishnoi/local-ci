import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config/loader.js';
import { PipelineRunner } from '../../core/pipeline-runner.js';
import { StepRegistry } from '../../core/step-runner.js';
import { writeHtmlReport } from '../../reporters/html.js';
import { printConsoleReport } from '../../reporters/console.js';
import { writeJsonReport } from '../../reporters/json.js';

export async function runCommand(cwd: string): Promise<number> {
  const config = await loadConfig(cwd);
  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runner = new PipelineRunner(new StepRegistry());
  const result = await runner.run({ cwd, config, runId });
  printConsoleReport(result);
  const json = await writeJsonReport(cwd, result);
  const html = await writeHtmlReport(cwd, result);
  console.log(`\nJSON: ${json}`);
  console.log(`HTML: ${html}`);
  return result.status === 'PASS' ? 0 : 1;
}
