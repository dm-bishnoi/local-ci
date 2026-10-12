import { describe, expect, it } from 'vitest';
import {
  describeCommand,
  isSensitiveName,
  maskTokenPatterns,
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
/**
 * F-1 regression: common CI credential names, and credentials recognisable by
 * format, are masked; ordinary names and build output are left alone.
 */
describe('redaction coverage (F-1)', () => {
  it.each([
    'GH_PAT',
    'AZURE_DEVOPS_EXT_PAT',
    'ADO_PAT',
    'STRIPE_KEY',
    'SIGNING_KEY',
    'DB_PWD',
    'SMTP_PASS',
    'SENTRY_DSN',
    'SQL_CONNECTION_STRING',
    'SLACK_WEBHOOK_URL',
    'SYSTEM_ACCESSTOKEN',
  ])('treats %s as sensitive', (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each(['PATH', 'PATHEXT', 'KEYBOARD_LAYOUT', 'MONKEY_MODE', 'COMPASS', 'NODE_ENV', 'CI'])(
    'does not treat %s as sensitive',
    (name) => {
      expect(isSensitiveName(name)).toBe(false);
    },
  );

  it.each([
    ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer ***'],
    ['authorization=Basic dXNlcjpwYXNz', 'authorization=Basic ***'],
    ['curl -H "Authorization: token ghx123"', 'curl -H "Authorization: token ***"'],
    ['sent bearer AbCdEfGhIjKlMnOpQrSt', 'sent bearer ***'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def done', 'jwt *** done'],
    ['token ghp_aaaaBBBBccccDDDD1111eeee in log', 'token *** in log'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '***'],
    ['npm_abcdefghijklmnopqrstuvwxyz0123456789', '***'],
    ['//registry.npmjs.org/:_authToken=s3cr3t-value', '//registry.npmjs.org/:_authToken=***'],
    ['xoxb-1234567890-abcdefghij', '***'],
    ['key AKIAABCDEFGHIJKLMNOP used', 'key *** used'],
    ['Server=db;User Id=sa;Password=hunter2;', 'Server=db;User Id=sa;Password=***;'],
    ['AccountName=acct;AccountKey=abc+def/ghi==;', 'AccountName=acct;AccountKey=***;'],
  ])('masks %j by format', (input, expected) => {
    expect(maskTokenPatterns(input)).toBe(expected);
  });

  it.each([
    'Compiled successfully in 4.2s',
    'Local: http://localhost:4200/',
    '> npm run build',
    'password strength check passed',
    'Bearer of bad news',
    'authorization failed for user',
    'Tests: 42 passed, 0 failed',
  ])('leaves ordinary output %j untouched', (input) => {
    expect(maskTokenPatterns(input)).toBe(input);
  });

  it('collects values of newly covered names from the environment', () => {
    const secrets = sensitiveEnvValues({ GH_PAT: 'pat-value-1234', PATH: '/usr/bin', STRIPE_KEY: 'sk_live_abcd' });
    expect(secrets).toEqual(expect.arrayContaining(['pat-value-1234', 'sk_live_abcd']));
    expect(secrets).not.toContain('/usr/bin');
  });
});
