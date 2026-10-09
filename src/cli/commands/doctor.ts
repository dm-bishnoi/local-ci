/**
 * `local-ci doctor` — the command surface for `diagnostics/doctor`.
 *
 * Diagnostic only: it never executes a pipeline step, never installs anything
 * and never modifies the project. Its output is grouped by category, ordered
 * worst-first inside each group, and ends with a single verdict plus the next
 * action when there is one.
 *
 * Exit code rules (and they are deliberately few):
 * - `PASS` and `WARNING` → 0. A warning informs; it does not fail a diagnostic.
 * - `BLOCKED` and `ERROR` → 1. A known blocker, or a check that could not be
 *   answered, must never look like success to a script.
 */

import { runDoctorChecks } from '../../diagnostics/doctor.js';
import type { BrowserSearchResult } from '../../env/browser.js';
import {
  buildDiagnosticReport,
  type Diagnostic,
  type DiagnosticCategory,
  type DiagnosticReport,
} from '../../diagnostics/types.js';
import { renderDiagnostics, renderRecommendation } from '../../reporters/diagnostics-format.js';

const SECTION_TITLES: Record<DiagnosticCategory, string> = {
  environment: 'ENVIRONMENT',
  project: 'PROJECT',
  configuration: 'CONFIGURATION',
  requirements: 'REQUIREMENTS',
  pipeline: 'PIPELINE',
};

const SECTION_ORDER: DiagnosticCategory[] = [
  'environment',
  'project',
  'configuration',
  'requirements',
  'pipeline',
];

/** Exit code for a diagnostic report. Only PASS and WARNING are zero. */
export function exitCodeForVerdict(report: DiagnosticReport): number {
  return report.verdict === 'PASS' || report.verdict === 'WARNING' ? 0 : 1;
}

/**
 * Renders a diagnostic report as grouped sections plus a verdict line.
 *
 * Shared by `doctor` and `preflight` so the two commands cannot drift apart in
 * how they present the same check.
 */
export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  const title = report.command === 'doctor' ? 'LOCAL CI DOCTOR' : 'LOCAL CI PREFLIGHT';

  lines.push(title, '');

  for (const category of SECTION_ORDER) {
    const diagnostics = report.diagnostics.filter((diagnostic) => diagnostic.category === category);
    if (diagnostics.length === 0) continue;
    lines.push(...renderDiagnostics(SECTION_TITLES[category], diagnostics));
  }

  const verdictLabel = report.command === 'doctor' ? 'Doctor' : 'Preflight';
  lines.push(`${verdictLabel}: ${report.verdict}`);

  // The single most useful next action, when something needs one.
  const firstRecommendation = report.diagnostics.find(
    (diagnostic) =>
      diagnostic.recommendation !== undefined &&
      (diagnostic.severity === 'ERROR' ||
        diagnostic.severity === 'BLOCKED' ||
        diagnostic.severity === 'WARNING' ||
        diagnostic.severity === 'UNKNOWN'),
  );
  if (firstRecommendation?.recommendation) {
    lines.push(...renderRecommendation(firstRecommendation.recommendation));
  }

  return lines.join('\n');
}

export interface DoctorCommandOptions {
  /** Skip probes that execute external tools. Used by tests. */
  skipToolProbes?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Browser search override, used by tests. */
  browsers?: BrowserSearchResult;
}

export async function doctorCommand(cwd: string, options: DoctorCommandOptions = {}): Promise<number> {
  const diagnostics: Diagnostic[] = await runDoctorChecks(cwd, {
    ...(options.skipToolProbes !== undefined ? { skipToolProbes: options.skipToolProbes } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.browsers !== undefined ? { browsers: options.browsers } : {}),
  });
  const report = buildDiagnosticReport('doctor', diagnostics);

  console.log(`\n${formatDiagnosticReport(report)}\n`);
  return exitCodeForVerdict(report);
}
