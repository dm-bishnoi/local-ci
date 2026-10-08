import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineRunResult } from '../../core/pipeline-runner.js';
import { printConsoleReport } from '../../reporters/console.js';

export async function reportCommand(cwd: string, runId?: string): Promise<void> {
  if (!runId) throw new Error('Usage: local-ci report <run-id>');
  const path = join(cwd, '.local-ci', 'reports', runId, 'report.json');
  const result = JSON.parse(await readFile(path, 'utf8')) as PipelineRunResult;
  printConsoleReport(result);
}
