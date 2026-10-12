/**
 * Node engine-range checker.
 *
 * Two groups. "Existing behaviour" pins what the checker already did correctly
 * and must keep doing (it passes on the pre-fix code). The rest is the F-13
 * regression: whitespace after an operator turned `>= 18` into an exact match
 * for `18`, and every whitespace-separated token was treated as an
 * alternative, so `>=18 <21` was satisfied by Node 22.
 */

import { describe, expect, it } from 'vitest';
import { parseNvmrc, parseVersion, satisfies, type RangeVerdict } from '../../src/env/semver.js';

function verdict(version: string, range: string): RangeVerdict {
  return satisfies(version, range).verdict;
}

describe('existing behaviour (preserved)', () => {
  it.each([
    ['20.5.0', '>=20', 'satisfied'],
    ['18.19.0', '>=20', 'violated'],
    ['20.0.0', '>=20.0.0', 'satisfied'],
    ['20.5.0', '>=20.5.0', 'satisfied'],
    ['20.4.9', '>=20.5.0', 'violated'],
    ['26.7.0', '>=20', 'satisfied'],
    ['26.7.0', '<1.0.0', 'violated'],
    ['18.2.0', '<19', 'satisfied'],
    ['20.11.0', '20.11.0', 'satisfied'],
    ['20.11.1', '20.11.0', 'violated'],
    ['20.11.0', 'v20.11.0', 'satisfied'],
    ['20.11.0', '20', 'satisfied'],
    ['21.0.0', '20', 'violated'],
    ['20.5.0', '^18.19.0 || >=20.5.0', 'satisfied'],
    ['20.5.0', '', 'satisfied'],
    ['20.5.0', '*', 'satisfied'],
    ['26.7.0', 'ancient-magic', 'unknown'],
    ['26.7.0', 'lts/*', 'unknown'],
    ['26.7.0', 'node', 'unknown'],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(verdict(version, range)).toBe(expected);
  });

  it('reports the failing comparator and version in the reason', () => {
    expect(satisfies('18.0.0', '>=20')).toMatchObject({
      verdict: 'violated',
      comparator: '>=20',
      reason: '">=20" is not satisfied by 18.0.0.',
    });
  });

  it('never reports an unrecognised version as satisfying anything', () => {
    expect(verdict('not-a-version', '>=20')).toBe('unknown');
  });
});

describe('whitespace in ranges (F-13)', () => {
  it.each([
    ['26.7.0', '>= 18', 'satisfied'],
    ['26.7.0', '>=  18', 'satisfied'],
    ['26.7.0', '>= 18.0.0', 'satisfied'],
    ['20.5.0', '>= 20.5.0', 'satisfied'],
    ['20.4.0', '>= 20.5.0', 'violated'],
    ['17.9.0', '>= 18', 'violated'],
    ['26.7.0', ' >=18 ', 'satisfied'],
    ['26.7.0', '> 18', 'satisfied'],
    ['18.9.0', '> 18', 'violated'],
    ['19.0.0', '> 18', 'satisfied'],
    ['26.7.0', '< 30', 'satisfied'],
    ['26.7.0', '<= 26.7.0', 'satisfied'],
    ['26.7.0', '= 26.7.0', 'satisfied'],
    ['20.5.0', '>= v20.5.0', 'satisfied'],
    ['26.7.0', '>= 14.6', 'satisfied'],
    ['26.7.0', '^ 20.0.0', 'violated'],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(verdict(version, range)).toBe(expected);
  });

  it('gives the same answer with and without spaces after the operator', () => {
    for (const version of ['16.20.2', '18.0.0', '20.5.0', '22.12.0', '26.7.0']) {
      for (const range of ['>=18', '>=18.0.0', '>=20.5.0', '>18', '<22', '<=20.5.0', '>=18 <22', '^18.19.0 || >=20.5.0']) {
        const spaced = range.replace(/(>=|<=|>|<)/g, '$1 ');
        expect(verdict(version, spaced), `${version} against ${JSON.stringify(spaced)}`).toBe(verdict(version, range));
      }
    }
  });

  it('does not mistake a spaced range for an exact match', () => {
    // Before the fix `>= 18` was split into ">=" (unknown) and "18" (exact).
    expect(verdict('26.7.0', '>= 18')).not.toBe('violated');
  });
});

describe('partial versions with < and <= (third defect: `<19` was anchored at 20.0.0)', () => {
  it.each([
    ['18.9.0', '<19', 'satisfied'],
    ['19.0.0', '<19', 'violated'],
    ['19.5.0', '<19', 'violated'],
    ['18.2.0', '<18', 'violated'],
    ['17.9.9', '<18', 'satisfied'],
    ['18.9.0', '<=18', 'satisfied'],
    ['19.0.0', '<=18', 'violated'],
    ['18.2.9', '<18.3', 'satisfied'],
    ['18.3.0', '<18.3', 'violated'],
    ['18.3.9', '<=18.3', 'satisfied'],
    ['18.4.0', '<=18.3', 'violated'],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(verdict(version, range)).toBe(expected);
  });
});

describe('compound ranges (AND within a group, OR between groups)', () => {
  it.each([
    ['22.0.0', '>=18 <21', 'violated'],
    ['20.0.0', '>=18 <21', 'satisfied'],
    ['17.0.0', '>=18 <21', 'violated'],
    ['22.0.0', '>=18, <21', 'violated'],
    ['20.0.0', '>=18, <21', 'satisfied'],
    ['22.0.0', '>= 18 < 21', 'violated'],
    ['20.0.0', '>= 18 < 21', 'satisfied'],
    ['22.0.0', '>=18 <21 || >=22', 'satisfied'],
    ['21.5.0', '>=18 <21 || >=22', 'violated'],
    ['26.7.0', '>=18 <21 || >=24', 'satisfied'],
    ['16.0.0', '>=18 <21 || >=24', 'violated'],
    ['20.5.0', '>=20.5.0 <21', 'satisfied'],
    ['20.4.0', '>=20.5.0 <21', 'violated'],
    ['20.5.0', '^18.19.0 || >= 20.5.0', 'satisfied'],
    ['19.0.0', '^18.19.0 || >= 20.5.0', 'violated'],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(verdict(version, range)).toBe(expected);
  });

  it('is violated when any member of an AND group fails, even if another is unknown', () => {
    expect(verdict('22.0.0', '<21 lts/*')).toBe('violated');
  });

  it('is unknown, not satisfied, when an AND member cannot be evaluated', () => {
    expect(verdict('22.0.0', '>=18 lts/*')).toBe('unknown');
  });

  it('is unknown when a violated branch sits next to an unreadable alternative', () => {
    expect(verdict('22.0.0', '<18 || lts/*')).toBe('unknown');
  });

  it.each(['<18 ||', '|| <18', '<18 || || <19'])('a failing branch next to an empty alternative (%j) is unknown', (range) => {
    expect(verdict('22.0.0', range)).toBe('unknown');
  });

  it('is satisfied when one OR branch holds even if another is unreadable', () => {
    expect(verdict('22.0.0', '>=18 || lts/*')).toBe('satisfied');
  });
});

describe('caret, tilde and x-ranges', () => {
  it.each([
    ['20.5.0', '^20.0.0', 'satisfied'],
    ['20.99.0', '^20.0.0', 'satisfied'],
    ['21.0.0', '^20.0.0', 'violated'],
    ['19.9.9', '^20.0.0', 'violated'],
    ['18.19.0', '^18.19.0', 'satisfied'],
    ['18.18.9', '^18.19.0', 'violated'],
    ['18.20.4', '^18.19.0', 'satisfied'],
    ['0.2.5', '^0.2.3', 'satisfied'],
    ['0.3.0', '^0.2.3', 'violated'],
    ['0.0.3', '^0.0.3', 'satisfied'],
    ['0.0.4', '^0.0.3', 'violated'],
    ['18.5.0', '^18', 'satisfied'],
    ['19.0.0', '^18', 'violated'],
    ['20.5.7', '~20.5.0', 'satisfied'],
    ['20.6.0', '~20.5.0', 'violated'],
    ['20.9.0', '~20.5', 'violated'],
    ['20.5.2', '~20.5', 'satisfied'],
    ['20.9.0', '~20', 'satisfied'],
    ['21.0.0', '~20', 'violated'],
    ['20.5.0', '20.x', 'satisfied'],
    ['21.0.0', '20.x', 'violated'],
    ['20.5.0', '20.5.x', 'satisfied'],
    ['20.6.0', '20.5.x', 'violated'],
    ['20.5.0', '20.X', 'satisfied'],
    ['20.5.0', 'x', 'satisfied'],
    ['20.5.0', '>=18.x', 'satisfied'],
    ['26.7.0', '>18.x', 'satisfied'],
    ['18.9.0', '>18.x', 'violated'],
    ['18.9.0', '<=18.x', 'satisfied'],
    ['19.0.0', '<=18.x', 'violated'],
    ['18.2.0', '>18.2', 'violated'],
    ['18.3.0', '>18.2', 'satisfied'],
  ] as const)('%s against %j is %s', (version, range, expected) => {
    expect(verdict(version, range)).toBe(expected);
  });
});

describe('invalid and unsupported ranges are unknown, never satisfied', () => {
  it.each([
    '>=',
    '>= ',
    '>=abc',
    '>=18.x.y.z',
    '18.0.0.0',
    '18 - 20',
    '>*',
    '@18',
    '>=1e3',
    '!18',
    '>=18; rm -rf /',
    'latest-ish',
  ])('%j', (range) => {
    expect(verdict('26.7.0', range)).toBe('unknown');
  });

  it('explains why an unreadable range could not be evaluated', () => {
    const result = satisfies('26.7.0', 'ancient-magic');
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('ancient-magic');
  });
});

describe('the running Node.js', () => {
  const running = process.versions.node;
  const major = Number(running.split('.')[0]);

  it('is a version the checker can parse', () => {
    expect(parseVersion(running)).not.toBeNull();
  });

  it.each([
    [`>=${major}`, 'satisfied'],
    [`>= ${major}`, 'satisfied'],
    [`>=${running}`, 'satisfied'],
    [`>= ${running}`, 'satisfied'],
    [`>=${major + 1}`, 'violated'],
    [`>= ${major + 1}`, 'violated'],
    [`^${major}.0.0`, 'satisfied'],
    [`>=${major - 1} <${major + 1}`, 'satisfied'],
    [`>= ${major - 1} < ${major + 1}`, 'satisfied'],
    [`>=${major + 1} <${major + 5}`, 'violated'],
    [`${major}.x`, 'satisfied'],
    ['>=20.5.0', 'satisfied'],
    ['>= 20.5.0', 'satisfied'],
  ] as const)('is %j -> %s', (range, expected) => {
    expect(verdict(running, range)).toBe(expected);
  });
});

describe('prerelease versions', () => {
  it('sorts a prerelease before its release', () => {
    expect(verdict('20.5.0-rc.1', '>=20.5.0')).toBe('violated');
    expect(verdict('20.5.0', '>=20.5.0-rc.1')).toBe('satisfied');
  });
});

describe('parseNvmrc', () => {
  it('reads the first meaningful line', () => {
    expect(parseNvmrc('# comment\n\n v20.11.0 \n')).toBe('v20.11.0');
    expect(parseNvmrc('\n# only comments\n')).toBeNull();
  });
});
