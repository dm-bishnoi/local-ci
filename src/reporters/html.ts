import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineRunResult } from '../core/pipeline-runner.js';

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export async function writeHtmlReport(cwd: string, result: PipelineRunResult): Promise<string> {
  const dir = join(cwd, '.local-ci', 'reports', result.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'report.html');
  const rows = result.steps.map((step) => `<tr><td>${escape(step.name)}</td><td>${escape(step.status)}</td><td>${step.durationMs} ms</td><td>${escape(step.error ?? '')}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local CI ${escape(result.runId)}</title><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}</style></head><body><h1>Local CI Report</h1><p>Result: <strong>${escape(result.status)}</strong></p><p>Duration: ${(result.durationMs / 1000).toFixed(2)}s</p><table><thead><tr><th>Step</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  await writeFile(path, html, 'utf8');
  return path;
}
