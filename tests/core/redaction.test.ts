import { describe, expect, it } from 'vitest';
import {
  describeCommand,
  isSensitiveName,
  redact,
  sanitizeArgs,
  sensitiveEnvValues,
  truncate,
} from '../../src/core/redaction.js';

describe('redaction', () => {
  it('identifies sensitive names', () => {
    expect(isSensitiveName('GITHUB_TOKEN')).toBe(true);
    expect(isSensitiveName('db_password')).toBe(true);
    expect(isSensitiveName('MY_API_KEY')).toBe(true);
    expect(isSensitiveName('PATH')).toBe(false);
    expect(isSensitiveName('HOME')).toBe(false);
  });

  it('collects only sensitive environment values', () => {
    const secrets = sensitiveEnvValues({
      GITHUB_TOKEN: 'ghp_abcdefghijklmnop',
      PATH: '/usr/bin',
      DB_PASSWORD: 'hunter2hunter2',
    });

    expect(secrets).toContain('ghp_abcdefghijklmnop');
    expect(secrets).toContain('hunter2hunter2');
    expect(secrets).not.toContain('/usr/bin');
  });

  it('ignores short values that would over-mask', () => {
    expect(sensitiveEnvValues({ MY_SECRET: 'ab' })).toEqual([]);
  });

  it('masks known secrets in text', () => {
    const text = 'failed with token ghp_abcdefghijklmnop at line 3';
    const masked = redact(text, ['ghp_abcdefghijklmnop']);

    expect(masked).not.toContain('ghp_abcdefghijklmnop');
    expect(masked).toBe('failed with token *** at line 3');
  });

  it('masks every occurrence of a secret', () => {
    expect(redact('aaaa-secretvalue-b aaaa-secretvalue-b', ['secretvalue'])).toBe('aaaa-***-b aaaa-***-b');
  });

  it('masks credential arguments passed separately', () => {
    expect(sanitizeArgs(['login', '--token', 'ghp_realtoken', '--repo'])).toEqual([
      'login',
      '--token',
      '***',
      '--repo',
    ]);
  });

  it('masks inline credential arguments', () => {
    expect(sanitizeArgs(['--api-key=abcd1234', '--verbose'])).toEqual(['--api-key=***', '--verbose']);
  });

  it('leaves harmless arguments untouched', () => {
    expect(sanitizeArgs(['build', '--watch', 'src/index.ts'])).toEqual(['build', '--watch', 'src/index.ts']);
  });

  it('describes a command with masked credentials', () => {
    const described = describeCommand('git', ['push', '--token', 'ghp_realtokenvalue']);

    expect(described).toBe('git push --token ***');
    expect(described).not.toContain('ghp_realtokenvalue');
  });

  it('truncates long text with a marker', () => {
    const truncated = truncate('x'.repeat(50), 10);

    expect(truncated.startsWith('x'.repeat(10))).toBe(true);
    expect(truncated).toContain('truncated 40 character(s)');
  });

  it('leaves short text untouched', () => {
    expect(truncate('short', 100)).toBe('short');
  });
});