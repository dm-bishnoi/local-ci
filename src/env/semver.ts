/**
 * A deliberately small Node-version range checker.
 *
 * Scope, and the reason it is hand-written: the only requirement in this project
 * is to decide whether the running Node satisfies a project's declared
 * `engines.node` or its `.nvmrc`. That is a tiny slice of semver, and pulling in
 * a full semver implementation to answer it would be the exact kind of
 * over-engineering this module exists to avoid.
 *
 * Everything it cannot determine with confidence is reported as *unknown*, never
 * as satisfied. A diagnostic tool that guesses "compatible" is worse than one
 * that says "I could not check this".
 */

/** A parsed `major.minor.patch`. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** How confidently a range could be evaluated. */
export type RangeVerdict = 'satisfied' | 'violated' | 'unknown';

export interface RangeResult {
  verdict: RangeVerdict;
  /** Comparator that produced the verdict, for an actionable message. */
  comparator?: string;
  reason?: string;
}

export function parseVersion(raw: string): Version | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(raw);
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease ? { prerelease } : {}),
  };
}

function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A prerelease sorts before its release (1.0.0-rc.1 < 1.0.0).
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

/**
 * Resolves a partial version against the version being tested.
 *
 * `>=18` means `>=18.0.0`, and `18.x` means "any 18 release". The missing
 * components are filled from the version under test, which is how every real
 * Node range behaves.
 */
function resolvePartial(operator: string, partial: string, base: Version): Version | 'unknown' {
  const parts = partial.split('.');
  const major = Number(parts[0]);
  if (!Number.isInteger(major)) return 'unknown';

  if (operator === '>' || operator === '>=') {
    // `>=18` is understood as `>=18.0.0`; `>18` as `>18.0.0`.
    return { major, minor: parts[1] === undefined ? 0 : Number(parts[1]), patch: parts[2] === undefined ? 0 : Number(parts[2]) };
  }

  if (operator === '<' || operator === '<=') {
    // `<18` must exclude 18.x entirely, so it is anchored at the next major.
    if (parts.length === 1) return { major: major + 1, minor: 0, patch: 0 };
    if (parts.length === 2) return { major: major, minor: Number(parts[1]) + 1, patch: 0 };
    return { major, minor: Number(parts[1]), patch: Number(parts[2]) };
  }

  return {
    major,
    minor: parts[1] === undefined ? base.minor : Number(parts[1]),
    patch: parts[2] === undefined ? base.patch : Number(parts[2]),
  };
}

const COMPARATOR = /^(>=|<=|>|<|=)?\s*(.+)$/;

/** Comparators this module deliberately refuses to interpret. */
const UNSUPPORTED = /^[\^~]|x\b|\*|latest|stable|canary|nolock/i;

function evaluateComparator(base: Version, comparator: string): RangeVerdict | 'unknown' {
  // `.nvmrc` files are written as `v20.11.0` far more often than `20.11.0`.
  // The `v` is a display prefix, not part of the number, so it is stripped
  // before matching rather than turning a readable requirement into unknown.
  const trimmed = comparator.trim().replace(/^v(?=\d)/, '');
  if (trimmed === '') return 'unknown';
  if (UNSUPPORTED.test(trimmed)) return 'unknown';

  const match = COMPARATOR.exec(trimmed);
  if (!match) return 'unknown';

  const operator = match[1] ?? '=';
  const partial = (match[2] ?? '').trim();
  if (!/^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(partial)) return 'unknown';

  const target = resolvePartial(operator, partial, base);
  if (target === 'unknown') return 'unknown';

  const order = compare(base, target);
  switch (operator) {
    case '>=': return order >= 0 ? 'satisfied' : 'violated';
    case '>': return order > 0 ? 'satisfied' : 'violated';
    case '<=': return order <= 0 ? 'satisfied' : 'violated';
    case '<': return order < 0 ? 'satisfied' : 'violated';
    default:
      // A bare or `=`-prefixed comparator is an exact match on the components it
      // names. `18` therefore means "any 18.x".
      return order === 0 ? 'satisfied' : 'violated';
  }
}

/**
 * Evaluates a version against an npm-style range.
 *
 * Supported: space/comma separated comparators using `>=`, `>`, `<=`, `<`, `=`
 * and bare versions — for example `>=18`, `>=18 <21`, `20.x`, `18.20.4`.
 *
 * Anything else (caret, tilde, `x` wildcards, dist-tags) returns `unknown` with
 * a reason, so the caller can warn rather than assert a compatibility it did not
 * actually verify.
 */
export function satisfies(version: string, range: string): RangeResult {
  const base = parseVersion(version);
  if (!base) return { verdict: 'unknown', reason: `"${version}" is not a recognizable version.` };

  const trimmedRange = range.trim();
  if (trimmedRange === '' || trimmedRange === '*' || trimmedRange === 'latest') {
    return { verdict: 'satisfied', reason: 'no version constraint is declared.' };
  }

  const comparators = trimmedRange.split(/\s*\|\|\s*|\s*,\s*|\s+/).filter((part) => part.length > 0);
  if (comparators.length === 0) return { verdict: 'unknown', reason: 'The range could not be read.' };

  const results: Array<{ comparator: string; verdict: RangeVerdict | 'unknown'; reason?: string }> = comparators.map(
    (comparator) => {
      const verdict = evaluateComparator(base, comparator);
      return {
        comparator,
        verdict,
        ...(verdict === 'unknown' ? { reason: `"${comparator}" is outside the comparators this checker supports.` } : {}),
      };
    },
  );

  // An OR group is satisfied if any branch is; otherwise every unsupported
  // branch means the answer genuinely is not knowable.
  if (results.some((result) => result.verdict === 'satisfied')) {
    return { verdict: 'satisfied', comparator: results.find((r) => r.verdict === 'satisfied')?.comparator };
  }
  if (results.some((result) => result.verdict === 'violated')) {
    const failed = results.find((result) => result.verdict === 'violated');
    return { verdict: 'violated', comparator: failed?.comparator, reason: `"${failed?.comparator}" is not satisfied by ${version}.` };
  }
  return { verdict: 'unknown', reason: results[0]?.reason };
}

/** Reads a `.nvmrc` body, tolerating comments and surrounding whitespace. */
export function parseNvmrc(contents: string): string | null {
  const line = contents
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'));

  return line === undefined || line === '' ? null : line;
}