import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineRunResult } from '../core/pipeline-runner.js';
import { toLogFileName } from './logs.js';

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export async function writeHtmlReport(cwd: string, result: PipelineRunResult): Promise<string> {
  const dir = join(cwd, '.local-ci', 'reports', result.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'report.html');

  const rows = result.steps
    .map((step) => {
      const flags = [step.timedOut ? 'timed out' : undefined, step.cancelled ? 'cancelled' : undefined]
        .filter(Boolean)
        .join(', ');
      const cells = [
        `<td>${escape(step.name)}</td>`,
        `<td class="s-${escape(step.status.toLowerCase())}">${escape(step.status)}</td>`,
        `<td>${step.durationMs} ms</td>`,
        `<td>${step.exitCode === undefined || step.exitCode === null ? '-' : escape(String(step.exitCode))}</td>`,
        `<td>${escape(flags)}</td>`,
        `<td>${escape(step.error ?? '')}</td>`,
        `<td><a href="logs/${escape(toLogFileName(step.id))}">log</a></td>`,
      ].join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local CI ${escape(result.runId)}</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.s-pass{color:#0a7d28;font-weight:600}.s-fail{color:#b00020;font-weight:600}.s-unsupported{color:#9a6700;font-weight:600}.s-cancelled{color:#8250df;font-weight:600}.s-skipped{color:#666}</style></head><body><h1>Local CI Report</h1><p>Result: <strong>${escape(result.status)}</strong></p><p>Duration: ${(result.durationMs / 1000).toFixed(2)}s</p><p>Run ID: ${escape(result.runId)}</p><table><thead><tr><th>Step</th><th>Status</th><th>Duration</th><th>Exit</th><th>Flags</th><th>Error</th><th>Log</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

  await writeFile(path, html, 'utf8');
  return path;
}