import type { ProcessEvaluator } from '../core/process-step.js';
import type { AvailableCapability } from './types.js';

/** How many offending files a failure message names. The full list is in the captured output. */
const LISTED_FILES = 20;

/**
 * `gofmt -l` prints the files whose formatting differs and exits 0 either way,
 * so the exit code says nothing. The verdict comes from stdout:
 *
 * - empty (ignoring vendored and test-data paths) -> PASS
 * - any file listed                               -> FAIL
 *
 * A non-zero exit never reaches this function: it is already a FAIL, and its
 * message is stderr (parse errors), which is deliberately kept apart from the
 * stdout file list. stderr on a zero exit is kept in the report and does not
 * change the verdict.
 */
export function gofmtListEvaluator(): ProcessEvaluator {
  return (result) => {
    const files = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .filter((line) => !line.replace(/\\/g, '/').split('/').some((segment) => segment === 'vendor' || segment === 'testdata'));

    if (files.length === 0) return { status: 'PASS' };

    const shown = files.slice(0, LISTED_FILES).join(', ');
    const more = files.length > LISTED_FILES ? `, and ${files.length - LISTED_FILES} more` : '';
    return {
      status: 'FAIL',
      error: `${files.length} file${files.length === 1 ? '' : 's'} need${files.length === 1 ? 's' : ''} formatting (gofmt -l): ${shown}${more}. Run "gofmt -w" to fix; local-ci never rewrites files.`,
    };
  };
}

export function evaluatorFor(name: AvailableCapability['evaluate']): ProcessEvaluator | undefined {
  switch (name) {
    case 'gofmt-list':
      return gofmtListEvaluator();
    default:
      return undefined;
  }
}
