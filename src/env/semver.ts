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

type Operator = '>=' | '>' | '<=' | '<' | '=';

/** One plain comparison, the only form the evaluator understands. */
interface Primitive {
  operator: Operator;
  version: Version;
}

/**
 * A comparator after parsing. `any` is a wildcard (`*`, `x`), `unknown` is
 * something this checker refuses to interpret, and `primitives` is the rule
 * expressed as plain comparisons that must all hold.
 */
type Parsed =
  | { kind: 'any' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'primitives'; primitives: Primitive[] };

/** A version with optional components: `18`, `18.2`, `18.x`, `18.2.3-rc.1`. */
interface PartialVersion {
  major: number | undefined;
  minor: number | undefined;
  patch: number | undefined;
  prerelease: string | undefined;
}

const WILDCARD = /^[xX*]$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses a partial version. A wildcard component makes every component after
 * it a wildcard too, so `1.x.3` is read as `1.x.x`.
 */
function parsePartial(raw: string): PartialVersion | null {
  const match = PARTIAL.exec(raw);
  if (!match) return null;

  const numbers: Array<number | undefined> = [];
  let open = true;
  for (const component of [match[1], match[2], match[3]]) {
    if (component === undefined || WILDCARD.test(component)) open = false;
    numbers.push(open && component !== undefined ? Number(component) : undefined);
  }

  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease: match[4] };
}

function version(major: number, minor: number, patch: number, prerelease?: string): Version {
  return { major, minor, patch, ...(prerelease ? { prerelease } : {}) };
}

const unknown = (reason: string): Parsed => ({ kind: 'unknown', reason });
const primitives = (...list: Primitive[]): Parsed => ({ kind: 'primitives', primitives: list });

/**
 * Rewrites a comparator as plain comparisons, following npm's range rules:
 * `18` is `>=18.0.0 <19.0.0`, `>18` is `>=19.0.0`, `<=18` is `<19.0.0`,
 * `^1.2.3` is `>=1.2.3 <2.0.0` and `~1.2.3` is `>=1.2.3 <1.3.0`.
 */
function desugar(operator: Operator | '^' | '~', partial: PartialVersion): Parsed {
  const { major, minor, patch, prerelease } = partial;

  if (major === undefined) {
    // A bare wildcard matches everything. `>*` and `<*` match nothing useful.
    return operator === '>' || operator === '<' ? unknown('A wildcard with ">" or "<" cannot be evaluated.') : { kind: 'any' };
  }

  const floor = version(major, minor ?? 0, patch ?? 0, prerelease);
  const full = minor !== undefined && patch !== undefined;
  // First version above everything the partial names: 18 -> 19.0.0, 18.2 -> 18.3.0.
  const ceiling = minor === undefined ? version(major + 1, 0, 0) : version(major, minor + 1, 0);

  switch (operator) {
    case '=':
      return full
        ? primitives({ operator: '=', version: floor })
        : primitives({ operator: '>=', version: floor }, { operator: '<', version: ceiling });
    case '>=':
      return primitives({ operator: '>=', version: floor });
    case '>':
      return full ? primitives({ operator: '>', version: floor }) : primitives({ operator: '>=', version: ceiling });
    case '<':
      return primitives({ operator: '<', version: floor });
    case '<=':
      return full ? primitives({ operator: '<=', version: floor }) : primitives({ operator: '<', version: ceiling });
    case '~':
      return primitives({ operator: '>=', version: floor }, { operator: '<', version: ceiling });
    case '^': {
      // Caret allows changes that do not touch the left-most non-zero component.
      const upper =
        major > 0
          ? version(major + 1, 0, 0)
          : minor === undefined
            ? version(1, 0, 0)
            : minor > 0 || patch === undefined
              ? version(0, minor + 1, 0)
              : version(0, 0, patch + 1);
      return primitives({ operator: '>=', version: floor }, { operator: '<', version: upper });
    }
  }
}

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?(.*)$/;

function parseComparator(token: string): Parsed {
  const match = COMPARATOR.exec(token);
  const operator = (match?.[1] ?? '=') as Operator | '^' | '~';
  const partial = parsePartial((match?.[2] ?? '').trim());
  if (!partial) return unknown(`"${token}" is outside the comparators this checker supports.`);
  return desugar(operator, partial);
}

function holds(base: Version, { operator, version: target }: Primitive): boolean {
  const order = compare(base, target);
  switch (operator) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '=':
      return order === 0;
  }
}

/**
 * Operators may be separated from their version by whitespace (`>= 18`), and
 * comma is accepted as an AND separator. Both are normalised before the group
 * is split into comparators, so the split can never separate an operator from
 * its operand.
 */
function tokenize(group: string): string[] {
  return group
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function formatVersion(value: Version): string {
  return `${value.major}.${value.minor}.${value.patch}${value.prerelease ? `-${value.prerelease}` : ''}`;
}

interface GroupResult {
  verdict: RangeVerdict;
  comparator?: string;
  reason?: string;
}

/**
 * A group is an AND of comparators: one failure fails it, whatever else is in
 * it; an unreadable member leaves an otherwise passing group unknown.
 */
function evaluateGroup(base: Version, group: string): GroupResult {
  const tokens = tokenize(group);
  if (tokens.length === 0) return { verdict: 'unknown', reason: 'The range contains an empty alternative.' };
  if (tokens.includes('-')) {
    return { verdict: 'unknown', reason: 'Hyphen ranges are outside the comparators this checker supports.' };
  }

  let unreadable: string | undefined;
  for (const token of tokens) {
    const parsed = parseComparator(token);
    if (parsed.kind === 'unknown') {
      unreadable ??= parsed.reason;
      continue;
    }
    if (parsed.kind === 'primitives' && !parsed.primitives.every((primitive) => holds(base, primitive))) {
      return { verdict: 'violated', comparator: token, reason: `"${token}" is not satisfied by ${formatVersion(base)}.` };
    }
  }

  return unreadable === undefined
    ? { verdict: 'satisfied', comparator: group.trim() }
    : { verdict: 'unknown', reason: unreadable };
}

/**
 * Evaluates a version against an npm-style range.
 *
 * A range is alternatives separated by `||`; each alternative is comparators
 * that must all hold (separated by whitespace or commas). Supported
 * comparators: `>=`, `>`, `<=`, `<`, `=`, bare versions, partial versions
 * (`18`, `18.2`), x-ranges (`18.x`, `*`), caret (`^18.19.0`) and tilde
 * (`~18.19.0`), with optional whitespace after the operator.
 *
 * Anything else — dist-tags, hyphen ranges, text — returns `unknown` with a
 * reason, so the caller can warn rather than assert a compatibility it did not
 * actually verify. `unknown` is never promoted to `satisfied`.
 */
export function satisfies(versionText: string, range: string): RangeResult {
  const base = parseVersion(versionText);
  if (!base) return { verdict: 'unknown', reason: `"${versionText}" is not a recognizable version.` };

  const trimmedRange = range.trim();
  if (trimmedRange === '' || trimmedRange === '*' || trimmedRange === 'latest') {
    return { verdict: 'satisfied', reason: 'no version constraint is declared.' };
  }

  const results = trimmedRange.split('||').map((group) => evaluateGroup(base, group));

  // Alternatives are ORed: one satisfied branch settles it; otherwise an
  // unreadable branch means the answer is not knowable; only when every branch
  // was read and failed is the range violated.
  const satisfied = results.find((result) => result.verdict === 'satisfied');
  if (satisfied) return { verdict: 'satisfied', ...(satisfied.comparator ? { comparator: satisfied.comparator } : {}) };

  const undecided = results.find((result) => result.verdict === 'unknown');
  if (undecided) return { verdict: 'unknown', ...(undecided.reason ? { reason: undecided.reason } : {}) };

  const failed = results[0];
  return {
    verdict: 'violated',
    ...(failed?.comparator ? { comparator: failed.comparator } : {}),
    ...(failed?.reason ? { reason: failed.reason } : {}),
  };
}

/** Reads a `.nvmrc` body, tolerating comments and surrounding whitespace. */
export function parseNvmrc(contents: string): string | null {
  const line = contents
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'));

  return line === undefined || line === '' ? null : line;
}
