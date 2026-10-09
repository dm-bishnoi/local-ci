/**
 * `report.html` — a self-contained, dashboard-style view of a run.
 *
 * Constraints that shaped this file:
 *
 * - **No frontend framework and no new dependency.** The output is hand-written
 *   HTML plus one inline `<style>`, so the file opens correctly from disk, from
 *   an emailed attachment, or from a static file server, forever, with nothing
 *   to install and no network fetch.
 * - **Escaped, always.** Every value interpolated into markup goes through
 *   {@link escapeHtml}. Build errors contain `<`, `&` and quotes constantly, and
 *   an unescaped one would both corrupt the page and become an injection point
 *   when the report is opened locally.
 * - **Bounded.** Only the excerpts carried by the model are embedded, and log
 *   bodies are never inlined — they are linked. A 200k-character build log makes
 *   the page bigger, not the file.
 * - **Status is never colour alone.** Every status is rendered as a word in a
 *   labelled pill, and the failure/skip/unsupported sections are separated so a
 *   capability gap never reads as an execution failure.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import {
  formatCoverage,
  formatDuration,
  formatExitCode,
  formatTimestamp,
  overallLabel,
} from './format.js';
import type { ReportStep, RunReport } from './report-model.js';
import { reportHtmlPath, runReportDir } from './paths.js';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const STYLES = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1b1f23;--muted:#57606a;--line:#d8dee4;--card:#f6f8fa;
--pass:#0a7d28;--fail:#b00020;--unsup:#9a6700;--skip:#57606a;--cancel:#8250df;}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--card:#161b22;
--pass:#3fb950;--fail:#f85149;--unsup:#d29922;--skip:#9198a1;--cancel:#bc8cff;}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:32px 20px;line-height:1.5}
main{max-width:1100px;margin:0 auto}
header.top{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}
h1{font-size:1.6rem;margin:0 0 4px}
.sub{color:var(--muted);font-size:.9rem;margin:0}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 24px;margin-top:20px}
.meta div{display:flex;flex-direction:column}
.meta dt{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;margin:0}
.meta dd{margin:2px 0 0;font-weight:600;word-break:break-word}
section{margin:28px 0}
h2{font-size:1.1rem;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card .n{font-size:1.6rem;font-weight:700;line-height:1.2}
.card .l{color:var(--muted);font-size:.8rem}
.card.pass .n{color:var(--pass)}.card.fail .n{color:var(--fail)}
.card.unsupported .n{color:var(--unsup)}.card.cancelled .n{color:var(--cancel)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.76rem;font-weight:700;letter-spacing:.03em;border:1px solid}
.pill.pass{color:var(--pass);border-color:var(--pass)}
.pill.fail{color:var(--fail);border-color:var(--fail)}
.pill.unsupported{color:var(--unsup);border-color:var(--unsup)}
.pill.skipped{color:var(--skip);border-color:var(--skip)}
.pill.cancelled{color:var(--cancel);border-color:var(--cancel)}
.detail{color:var(--muted);font-size:.86rem;margin:2px 0 0;word-break:break-word}
.flag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:4px;background:var(--card);
border:1px solid var(--line);color:var(--muted);font-size:.72rem}
.note{border-left:3px solid var(--line);padding:10px 14px;background:var(--card);border-radius:0 6px 6px 0;margin:10px 0}
.note.fail{border-left-color:var(--fail)}
.note.unsupported{border-left-color:var(--unsup)}
.note p{margin:0 0 6px}
.note p:last-child{margin:0}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;
max-height:420px;font-size:.82rem;white-space:pre-wrap;word-break:break-word}
details.log{margin:10px 0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
details.log>summary{cursor:pointer;padding:9px 12px;background:var(--card);font-weight:600;font-size:.9rem}
details.log>summary:hover{filter:brightness(.97)}
details.log .body{padding:12px}
.muted{color:var(--muted)}
a{color:inherit}
.empty{color:var(--muted);font-style:italic}
footer{color:var(--muted);font-size:.8rem;border-top:1px solid var(--line);padding-top:14px;margin-top:32px}
`;

/** Lower-cased status used for CSS class names and `id` fragments. */
function statusKey(status: string): string {
  return status.toLowerCase();
}

function pill(status: string): string {
  const key = statusKey(status);
  return `<span class="pill ${key}">${escapeHtml(status)}</span>`;
}

function flags(step: ReportStep): string {
  const parts: string[] = [];
  if (step.timedOut) parts.push('timed out');
  if (step.cancelled && !step.timedOut) parts.push('cancelled');
  if (step.signal) parts.push(`signal ${step.signal}`);
  return parts.map((flag) => `<span class="flag">${escapeHtml(flag)}</span>`).join('');
}

function shortDetail(step: ReportStep): string {
  if (step.error) return `<p class="detail">${escapeHtml(step.error.split(/\r?\n/)[0] ?? '')}</p>`;
  if (!step.executed && step.status === 'SKIPPED') {
    return '<p class="detail">Not run.</p>';
  }
  return '';
}

function stepRow(step: ReportStep): string {
  const cells = [
    `<td>${escapeHtml(step.name)}</td>`,
    `<td>${pill(step.status)}${flags(step)}</td>`,
    `<td class="num">${escapeHtml(step.executed ? formatDuration(step.durationMs) : '—')}</td>`,
    `<td class="num">${escapeHtml(formatExitCode(step.exitCode))}</td>`,
    `<td>${shortDetail(step)}${step.logPath ? logLink(step) : '<span class="muted">no log</span>'}</td>`,
  ];
  return `<tr>${cells.join('')}</tr>`;
}

function logLink(step: ReportStep): string {
  const href = step.logPath ?? '';
  return `<a href="${escapeHtml(href)}">log</a>`;
}

function renderStepTable(steps: readonly ReportStep[]): string {
  if (steps.length === 0) return '<p class="empty">No steps were recorded for this run.</p>';

  const rows = steps.map(stepRow).join('');
  return `<table><thead><tr><th>Step</th><th>Status</th><th>Duration</th><th>Exit code</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Streams are embedded as text, so only render the ones that exist. */
function stream(title: string, body: string, truncated: boolean, id: string): string {
  if (!body.trim()) return '';
  const note = truncated
    ? `<p class="detail">Showing the end of the captured output; the complete text is in the step log.</p>`
    : '';
  return `<h3>${escapeHtml(title)}</h3>${note}<pre id="${escapeHtml(id)}">${escapeHtml(body)}</pre>`;
}

function renderStepDetail(step: ReportStep): string {
  const body = [
    `<div class="note fail"><p>${pill(step.status)} <strong>${escapeHtml(step.name)}</strong></p>`,
    `<p class="detail">Exit code: ${escapeHtml(formatExitCode(step.exitCode))}`,
    step.signal ? ` · Signal: ${escapeHtml(step.signal)}` : '',
    ` · Timed out: ${step.timedOut ? 'yes' : 'no'}`,
    ` · Cancelled: ${step.cancelled ? 'yes' : 'no'}`,
    '</p>',
    step.command ? `<p class="detail">Command: <code>${escapeHtml(step.command)}</code></p>` : '',
    step.error ? `<p class="detail">Error: ${escapeHtml(step.error)}</p>` : '',
    '</div>',
    stream('STDERR', step.stderr, step.stderrTruncated, `${statusKey(step.id)}-stderr`),
    stream('STDOUT', step.stdout, step.stdoutTruncated, `${statusKey(step.id)}-stdout`),
  ]
    .filter(Boolean)
    .join('');

  return `<details class="log"><summary>${escapeHtml(step.name)} — ${escapeHtml(step.status)} (${escapeHtml(formatDuration(step.durationMs))})</summary><div class="body">${body}</div></details>`;
}

function renderFailedSteps(steps: readonly ReportStep[]): string {
  const failed = steps.filter((step) => step.status === 'FAIL' || step.status === 'CANCELLED');
  if (failed.length === 0) {
    return '<section><h2>Failed steps</h2><p class="empty">None. Every step that ran completed successfully.</p></section>';
  }

  return `<section><h2>Failed steps (${failed.length})</h2>${failed.map(renderStepDetail).join('')}</section>`;
}

function renderTimedOutSteps(steps: readonly ReportStep[]): string {
  const timedOut = steps.filter((step) => step.outcome === 'TIMEOUT');
  if (timedOut.length === 0) return '';

  const items = timedOut
    .map(
      (step) =>
        `<div class="note fail"><p>${pill('TIMEOUT')} <strong>${escapeHtml(step.name)}</strong></p>` +
        `<p class="detail">Exit code: ${escapeHtml(formatExitCode(step.exitCode))}` +
        (step.signal ? ` · Signal: ${escapeHtml(step.signal)}` : '') +
        ` · Timed out: yes` +
        ` · Cancelled: ${step.cancelled ? 'yes' : 'no'}` +
        '</p>' +
        (step.command ? `<p class="detail">Command: <code>${escapeHtml(step.command)}</code></p>` : '') +
        (step.error ? `<p class="detail">Error: ${escapeHtml(step.error)}</p>` : '') +
        '</div>' +
        stream('STDERR', step.stderr, step.stderrTruncated, `${statusKey(step.id)}-stderr`) +
        stream('STDOUT', step.stdout, step.stdoutTruncated, `${statusKey(step.id)}-stdout`), 
    )
    .join('');

  return `<section><h2>Timed out (${timedOut.length})</h2>${items}</section>`;
}

function renderBlockedSteps(steps: readonly ReportStep[]): string {
  const blocked = steps.filter((step) => step.status === 'BLOCKED');
  if (blocked.length === 0) return '';

  const items = blocked
    .map(
      (step) =>
        `<div class="note blocked"><p>${pill('BLOCKED')} <strong>${escapeHtml(step.name)}</strong></p>` +
        `<p class="detail">Exit code: ${escapeHtml(formatExitCode(step.exitCode))}` +
        (step.signal ? ` · Signal: ${escapeHtml(step.signal)}` : '') +
        ` · Timed out: ${step.timedOut ? 'yes' : 'no'}` +
        ` · Cancelled: ${step.cancelled ? 'yes' : 'no'}` +
        '</p>' +
        (step.command ? `<p class="detail">Command: <code>${escapeHtml(step.command)}</code></p>` : '') +
        (step.error ? `<p class="detail">Error: ${escapeHtml(step.error)}</p>` : '') +
        '</div>' +
        stream('STDERR', step.stderr, step.stderrTruncated, `${statusKey(step.id)}-stderr`) +
        stream('STDOUT', step.stdout, step.stdoutTruncated, `${statusKey(step.id)}-stdout`), 
    )
    .join('');

  return `<section><h2>Blocked steps (${blocked.length})</h2>${items}</section>`;
}

function renderErroredSteps(steps: readonly ReportStep[]): string {
  const errored = steps.filter((step) => step.status === 'ERROR');
  if (errored.length === 0) return '';

  const items = errored
    .map(
      (step) =>
        `<div class="note error"><p>${pill('ERROR')} <strong>${escapeHtml(step.name)}</strong></p>` +
        `<p class="detail">Exit code: ${escapeHtml(formatExitCode(step.exitCode))}` +
        (step.signal ? ` · Signal: ${escapeHtml(step.signal)}` : '') +
        ` · Timed out: ${step.timedOut ? 'yes' : 'no'}` +
        ` · Cancelled: ${step.cancelled ? 'yes' : 'no'}` +
        '</p>' +
        (step.command ? `<p class="detail">Command: <code>${escapeHtml(step.command)}</code></p>` : '') +
        (step.error ? `<p class="detail">Error: ${escapeHtml(step.error)}</p>` : '') +
        '</div>' +
        stream('STDERR', step.stderr, step.stderrTruncated, `${statusKey(step.id)}-stderr`) +
        stream('STDOUT', step.stdout, step.stdoutTruncated, `${statusKey(step.id)}-stdout`), 
    )
    .join('');

  return `<section><h2>Errored steps (${errored.length})</h2>${items}</section>`;
}

/**
 * Unsupported steps are deliberately not listed as failures.
 *
 * A capability this build does not implement is not something that went wrong
 * during the run, and the wording here says so.
 */
function renderUnsupportedSteps(steps: readonly ReportStep[]): string {
  const unsupported = steps.filter((step) => step.status === 'UNSUPPORTED');
  if (unsupported.length === 0) return '';

  const items = unsupported
    .map(
      (step) =>
        `<div class="note unsupported"><p>${pill('UNSUPPORTED')} <strong>${escapeHtml(step.name)}</strong></p>` +
        `<p class="detail">${escapeHtml(step.error ?? 'No reason was reported.')}</p></div>`,
    )
    .join('');

  return (
    `<section><h2>Unsupported capabilities (${unsupported.length})</h2>` +
    '<p class="muted">These steps were not run. Local CI does not implement them for this project, ' +
    'which is different from a step that ran and failed.</p>' +
    `${items}</section>`
  );
}

function renderSkippedSteps(steps: readonly ReportStep[]): string {
  const skipped = steps.filter((step) => step.status === 'SKIPPED');
  if (skipped.length === 0) return '';

  const items = skipped
    .map(
      (step) =>
        `<li>${pill('SKIPPED')} <strong>${escapeHtml(step.name)}</strong> — ${escapeHtml(step.error ?? 'Not run.')}</li>`,
    )
    .join('');

  return `<section><h2>Skipped steps (${skipped.length})</h2><ul>${items}</ul></section>`;
}

function renderLogs(steps: readonly ReportStep[]): string {
  const executed = steps.filter((step) => step.logPath);
  if (executed.length === 0) {
    return '<section><h2>Logs</h2><p class="empty">No step produced a log, because nothing was executed.</p></section>';
  }

  const items = executed
    .map(
      (step) =>
        `<li>${escapeHtml(step.name)} — <a href="${escapeHtml(step.logPath ?? '')}">${escapeHtml(step.logPath ?? '')}</a></li>`,
    )
    .join('');

  return `<section><h2>Logs</h2><ul>${items}</ul></section>`;
}

function renderSummaryCards(report: RunReport): string {
  const { counts } = report;
  const card = (label: string, value: number, key: string): string =>
    `<div class="card ${key}"><div class="n">${value}</div><div class="l">${escapeHtml(label)}</div></div>`;

  return `<section><h2>Summary</h2><div class="cards">${[
    card('Total steps', counts.total, ''),
    card('Passed', counts.passed, 'pass'),
    card('Failed', counts.failed, 'fail'),
    card('Timed out', counts.timeout, 'fail'),
    card('Blocked', counts.blocked, 'fail'),
    card('Errors', counts.error, 'fail'),
    card('Unsupported', counts.unsupported, 'unsupported'),
    card('Skipped', counts.skipped, 'skipped'),
    card('Cancelled', counts.cancelled, 'cancelled'),
  ].join('')}</div></section>`;
}

function renderCoverage(report: RunReport): string {
  const { coverage } = report;
  const value = formatCoverage(coverage.state, coverage.percent);
  const detail =
    coverage.state === 'available' && coverage.source
      ? `<p class="detail">Source: ${escapeHtml(coverage.source)}</p>`
      : coverage.reason
        ? `<p class="detail">${escapeHtml(coverage.reason)}</p>`
        : '';

  return `<section><h2>Coverage</h2><p><strong>${escapeHtml(value)}</strong></p>${detail}</section>`;
}

function renderHeader(report: RunReport): string {
  const item = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

  return `<header class="top"><h1>Local CI Runner</h1><p class="sub">${escapeHtml(overallLabel(report.status))} · ${escapeHtml(report.projectName)}</p><dl class="meta">${[
    item('Run ID', report.runId),
    item('Project', report.projectName),
    item('Framework', report.framework ?? 'unknown'),
    item('Package Manager', report.packageManager ?? 'unknown'),
    item('Started', formatTimestamp(report.startedAt)),
    item('Duration', formatDuration(report.durationMs)),
    item('Exit code', String(report.exitCode)),
    item('Generated', formatTimestamp(report.generatedAt)),
  ].join('')}</dl></header>`;
}

/**
 * Footer: the environment fingerprint, when one was collected.
 *
 * This is what makes a saved report self-describing months later — the reader
 * can see which machine and which toolchain produced it without trusting the
 * filename. The fingerprint carries versions and platform facts only; it has no
 * field that could hold a secret.
 */
function renderFooter(report: RunReport): string {
  const environment = report.environment;
  if (!environment) return '';

  const parts = [
    `Node ${environment.runtime.version ?? 'unknown'}`,
    `${environment.os.platform} ${environment.os.arch}`,
    environment.packageManager.name
      ? `${environment.packageManager.name}${environment.packageManager.version ? ` ${environment.packageManager.version}` : ''}`
      : null,
    environment.git.version ? `git ${environment.git.version}` : null,
    ...environment.browsers.map((browser) => `${browser.name}${browser.version ? ` ${browser.version}` : ''}`),
    environment.runningInCi ? 'CI environment detected' : 'local environment',
  ].filter((part): part is string => part !== null);

  return `<footer>Environment: ${escapeHtml(parts.join(' · '))} · captured ${escapeHtml(formatTimestamp(environment.capturedAt))}</footer>`;
}

/** Renders the complete HTML document for a run. */
export function renderHtmlReport(report: RunReport): string {
  const sections = [
    renderHeader(report),
    renderSummaryCards(report),
    renderCoverage(report),
    renderStepTable(report.steps),
    renderFailedSteps(report.steps),
    renderTimedOutSteps(report.steps),
    renderBlockedSteps(report.steps),
    renderErroredSteps(report.steps),
    renderUnsupportedSteps(report.steps),
    renderSkippedSteps(report.steps),
    renderLogs(report.steps),
    renderFooter(report),
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local CI Report — ${escapeHtml(report.runId)}</title>
  <style>${STYLES}</style>
</head>
<body>
${sections.join('')}
</body>
</html>`;
}

export async function writeHtmlReport(cwd: string, report: RunReport): Promise<string> {
  await mkdir(runReportDir(cwd, report.runId), { recursive: true });
  const path = reportHtmlPath(cwd, report.runId);
  await writeFile(path, renderHtmlReport(report), 'utf8');
  return path;
}