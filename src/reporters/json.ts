import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineRunResult } from '../core/pipeline-runner.js';

export async function writeJsonReport(cwd: string, result: PipelineRunResult): Promise<string> {
  const dir = join(cwd, '.local-ci', 'reports', result.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'report.json');
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}
