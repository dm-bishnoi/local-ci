/**
 * Rendering for diagnostic checks, shared by the console reporter and the
 * `doctor` / `preflight` commands.
 *
 * Both surfaces show the same facts in the same words. A diagnostic tool whose
 * two views disagree is worse than one that only has one.
 */

import { SEVERITY_ICON, type Diagnostic } from '../diagnostics/types.js';
import { padEnd } from './format.js';

function indent(text: string, prefix = '      '): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `${prefix}${line}` : ''))
    .join('\n');
}

/**
 * Renders one check as three lines: the severity, what was observed, and — when
 * there is one — what to do about it.
 *
 * The recommendation is the part that turns a report into guidance, which is
 * why it is not optional formatting: DETECT only becomes SOLVE/GUIDE when the
 * reader is told the next action.
 */
export function renderDiagnostic(diagnostic: Diagnostic): string[] {
  const icon = SEVERITY_ICON[diagnostic.severity];
  const head = `  ${icon} ${padEnd(diagnostic.label, 24)}${diagnostic.severity === 'PASS' ? '' : `[${diagnostic.severity}]`}`;

  const lines = [head, indent(diagnostic.detail)];
  if (diagnostic.recommendation) lines.push(indent(`→ ${diagnostic.recommendation}`));
  return lines;
}

/**
 * Renders a titled block of diagnostics, ordered worst-first.
 *
 * Problems before passes is what makes a terminal scroll useful: the thing that
 * needs attention appears before the long tail of things that were fine.
 */
export function renderDiagnostics(title: string, diagnostics: readonly Diagnostic[]): string[] {
  if (diagnostics.length === 0) return [];

  const order = { ERROR: 0, BLOCKED: 1, WARNING: 2, UNKNOWN: 3, UNSUPPORTED: 4, PASS: 5 } as const;
  const sorted = [...diagnostics].sort((a, b) => order[a.severity] - order[b.severity]);

  return [title, ...sorted.flatMap(renderDiagnostic), ''];
}

/** The single line that states what to do next. */
export function renderRecommendation(recommendation: string): string[] {
  return ['', 'Recommendation:', indent(recommendation, '  ')];
}