/**
 * `local-ci preflight` — "can this configured pipeline reasonably run here?"
 *
 * Preflight is the gate that `run` consults before executing anything. As a
 * standalone command it answers the same question for a human, with the same
 * checks, the same severities and the same exit-code rules as the gate inside
 * `run` — two implementations of "should this run" would eventually disagree.
 *
 * Exit codes:
 * - `PASS`, `WARNING` → 0. Warnings inform; they never fail a preflight.
 * - `BLOCKED`, `ERROR` → 1. A known requirement prevents execution, or a check
 *   could not be answered; neither may look like success to a script.
 * - `UNSUPPORTED` findings do not change the exit code on their own: the
 *   pipeline can still be attempted, and the affected steps will report
 *   `UNSUPPORTED` (and a non-zero run) where it matters. They are reported
 *   here so the user can decide to remove the step first.
 */

import { runPreflightChecks } from '../../diagnostics/preflight.js';
import { buildDiagnosticReport, type Diagnostic } from '../../diagnostics/types.js';
import type { BrowserSearchResult } from '../../env/browser.js';
import { exitCodeForVerdict, formatDiagnosticReport } from './doctor.js';

export interface PreflightCommandOptions {
  /** Skip probes that execute external tools. Used by tests. */
  skipToolProbes?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Browser search override, used by tests. */
  browsers?: BrowserSearchResult;
}

export async function preflightCommand(cwd: string, options: PreflightCommandOptions = {}): Promise<number> {
  const diagnostics: Diagnostic[] = await runPreflightChecks(cwd, {
    ...(options.skipToolProbes !== undefined ? { skipToolProbes: options.skipToolProbes } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.browsers !== undefined ? { browsers: options.browsers } : {}),
  });
  const report = buildDiagnosticReport('preflight', diagnostics);

  console.log(`\n${formatDiagnosticReport(report)}\n`);
  return exitCodeForVerdict(report);
}
