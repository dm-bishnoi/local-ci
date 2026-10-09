import { describe, expect, it } from 'vitest';
import { formatConsoleReport } from '../../src/reporters/console.js';
import { formatCoverage, formatDuration } from '../../src/reporters/format.js';
import { makeBuilt, makeStep } from '../helpers/reports.js';

function render(steps: Parameters<typeof makeBuilt>[0], options = {}): string {
  return formatConsoleReport(makeBuilt(steps, options).report);
}

describe('formatConsoleReport', () => {
  it('renders the documented structure', () => {
    const output = render([
      makeStep('install', 'PASS', { durationMs: 12_400 }),
      makeStep('typecheck', 'PASS', { durationMs: 8_100 }),
      makeStep('test', 'PASS', { durationMs: 31_700 }),
      makeStep('coverage', 'UNSUPPORTED', { durationMs: 0, error: 'No coverage provider declared.' }),
      makeStep('lint', 'UNSUPPORTED', { durationMs: 0, error: 'No lint script.' }),
      makeStep('build', 'FAIL', { durationMs: 14_800, exitCode: 1, error: 'Process exited with code 1.' }),
      makeStep('security', 'PASS', { durationMs: 4_100 }),
    ]);

    expect(output).toContain('LOCAL CI REPORT');
    expect(output).toContain('Project:         my-angular-app');
    expect(output).toContain('Framework:       angular');
    expect(output).toContain('Package Manager: npm');
    expect(output).toContain('Result:          FAIL');
    expect(output).toContain('Duration:        1m 16s');
    expect(output).toContain('Run ID:          20261008-123456-abcd1234');
    expect(output).toContain('Passed:          4');
    expect(output).toContain('Failed:          1');
    expect(output).toContain('Unsupported:     2');
    expect(output).toContain('Skipped:         0');
  });

  it('adds an Outcome line when the canonical outcome exceeds what the status says', () => {
    // Engine status is FAIL; the canonical outcome is BLOCKED. Printing only
    // FAIL would hide the fact the reader needs most.
    const blocked = render([makeStep('build', 'BLOCKED', { error: 'DATABASE_URL is required.' })]);
    expect(blocked).toContain('Result:          FAIL');
    expect(blocked).toContain('Outcome:         BLOCKED');

    // When both agree, no redundant line is added.
    const plain = render([makeStep('build', 'FAIL', { error: 'boom' })]);
    expect(plain).not.toContain('Outcome:');

    const passing = render([makeStep('build', 'PASS')]);
    expect(passing).not.toContain('Outcome:');
  });

  it('states every status as a word, not only as an icon or a colour', () => {
    const output = render([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'boom' }),
      makeStep('lint', 'UNSUPPORTED', { error: 'nope' }),
      makeStep('security', 'SKIPPED', { error: 'failFast' }),
      makeStep('test', 'CANCELLED', { error: 'interrupted' }),
    ]);

    // Readable with all colour stripped: no ANSI, icons are decoration only.
    expect(output).not.toMatch(/\[/);
    expect(output).toMatch(/PASS/);
    expect(output).toMatch(/FAIL/);
    expect(output).toMatch(/UNSUPPORTED/);
    expect(output).toMatch(/SKIPPED/);
    expect(output).toMatch(/CANCELLED/);
  });

  it('gives each step a row with a name, a status and a duration', () => {
    const output = render([makeStep('install', 'PASS', { durationMs: 12_400, exitCode: 0 })]);

    expect(output).toMatch(/Dependencies\s+PASS\s+12\.4s/);
  });

  it('shows no duration for a step that never ran', () => {
    const output = render([makeStep('lint', 'UNSUPPORTED', { durationMs: 0, error: 'No lint script.' })]);
    expect(output).toMatch(/Lint\s+UNSUPPORTED\s+—/);
  });

  it('names the failed step and explains why', () => {
    const output = render([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'Process exited with code 1.' }),
    ]);

    expect(output).toContain('Failed step:');
    expect(output).toContain('Production Build');
    expect(output).toContain('Reason:');
    expect(output).toContain('Process exited with code 1.');
  });

  it('separates unsupported steps from failed steps', () => {
    const output = render([
      makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' }),
      makeStep('build', 'FAIL', { error: 'boom' }),
    ]);

    expect(output).toContain('Unsupported step:');
    expect(output).toContain('No "lint" script in package.json.');
    // The unsupported step must not be presented as the failed one.
    expect(output.indexOf('Unsupported step:')).toBeGreaterThan(output.indexOf('Failed step:'));
  });

  it('reports a cancelled step under the failure heading', () => {
    const output = render([makeStep('test', 'CANCELLED', { error: 'Step was cancelled.', cancelled: true })]);

    expect(output).toContain('Result:          CANCELLED');
    expect(output).toContain('Cancelled:       1');
    expect(output).toContain('Failed step:');
    expect(output).toContain('Unit Tests');
  });

  it('shows the exit code and timeout flag for a failing step', () => {
    const output = render([
      makeStep('test', 'FAIL', { timedOut: true, exitCode: null, signal: 'SIGTERM', error: 'Step timed out after 300s' }),
    ]);

    expect(output).toContain('signal SIGTERM');
    expect(output).toContain('timed out');
  });

  it('shows a measured coverage percentage', () => {
    const output = render([makeStep('coverage', 'PASS')], {
      coveragePercent: 84.72,
      coverageSource: 'coverage/coverage-summary.json',
    });

    expect(output).toContain('Coverage:        84.72%');
  });

  it('never shows 0% when coverage was not measured', () => {
    const output = render([makeStep('coverage', 'PASS')]);

    expect(output).not.toContain('0.00%');
    expect(output).toContain('Coverage:        unavailable');
  });

  it('says UNSUPPORTED when the adapter declined to run coverage', () => {
    const output = render([makeStep('coverage', 'UNSUPPORTED', { error: 'No provider declared.' })]);
    expect(output).toContain('Coverage:        UNSUPPORTED');
  });

  it('handles a run with no steps at all', () => {
    const output = render([]);
    expect(output).toContain('(no steps were executed)');
    expect(output).toContain('Result:          PASS');
  });

  it('is quiet about a clean run', () => {
    const output = render([makeStep('install', 'PASS'), makeStep('build', 'PASS')]);

    expect(output).not.toContain('Failed step:');
    expect(output).not.toContain('Unsupported step:');
  });

  it('renders a stored report read back from disk', async () => {
    const { decodeRunReport } = await import('../../src/reporters/report-model.js');
    const built = makeBuilt([makeStep('build', 'FAIL', { error: 'boom', exitCode: 1 })]);
    const restored = decodeRunReport(JSON.parse(JSON.stringify(built.report)));

    expect(formatConsoleReport(restored)).toBe(formatConsoleReport(built.report));
  });
});

describe('formatDuration', () => {
  it('keeps millisecond precision below one second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders seconds and minutes', () => {
    expect(formatDuration(1_240)).toBe('1.2s');
    expect(formatDuration(12_400)).toBe('12.4s');
    expect(formatDuration(59_900)).toBe('59.9s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(76_000)).toBe('1m 16s');
    expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
  });

  it('never renders a negative or meaningless duration', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatCoverage', () => {
  it('renders only measured percentages', () => {
    expect(formatCoverage('available', 84.72)).toBe('84.72%');
    expect(formatCoverage('available', 0)).toBe('0.00%');
    expect(formatCoverage('available', 100)).toBe('100.00%');
  });

  it('distinguishes unsupported from unavailable', () => {
    expect(formatCoverage('unsupported', null)).toBe('UNSUPPORTED');
    expect(formatCoverage('unavailable', null)).toBe('unavailable');
  });

  it('will not print a percentage for a state that has none', () => {
    expect(formatCoverage('unavailable', 42)).toBe('unavailable');
    expect(formatCoverage('unsupported', 42)).toBe('UNSUPPORTED');
    expect(formatCoverage('available', null)).toBe('unavailable');
  });
});