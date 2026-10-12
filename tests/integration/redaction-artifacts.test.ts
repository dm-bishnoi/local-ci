/**
 * F-1 regression, end to end: credentials printed by a step never reach any
 * artifact on disk, and the reports directory keeps itself out of git.
 */

import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_ROOT_GITIGNORE, writeRunReports } from '../../src/reporters/artifact.js';
import { makeBuilt, makeStep, withTempProject } from '../helpers/reports.js';

const ENV_SECRETS: Record<string, string> = {
  GH_PAT: 'ghpatvalue-0123456789',
  AZURE_DEVOPS_EXT_PAT: 'azdo-pat-value-abcdefgh',
  STRIPE_KEY: 'sk_live_51abcdefghijk',
};

/** Credentials no environment variable reveals; only their format gives them away. */
const FORMAT_SECRETS = [
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  'ghp_aaaaBBBBccccDDDD1111eeeeFFFF',
  'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  'hunter2-db-password',
];

const OUTPUT = [
  ...Object.values(ENV_SECRETS),
  `Authorization: Bearer ${FORMAT_SECRETS[0]}`,
  `token ${FORMAT_SECRETS[1]}`,
  `//registry.npmjs.org/:_authToken=${FORMAT_SECRETS[2]}`,
  `Server=db;Password=${FORMAT_SECRETS[3]};`,
].join('\n');

afterEach(() => {
  for (const name of Object.keys(ENV_SECRETS)) delete process.env[name];
});

async function readTree(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const contents: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    contents.push(await readFile(join(parent, entry.name), 'utf8'));
  }
  return contents.join('\n');
}

describe('credential redaction across artifacts', () => {
  it('masks env-named and format-recognised credentials in logs, JSON, summary and HTML', async () => {
    Object.assign(process.env, ENV_SECRETS);

    await withTempProject(async (cwd) => {
      const built = makeBuilt([
        makeStep('test', 'FAIL', { stdout: OUTPUT, stderr: OUTPUT, error: OUTPUT, command: 'npm run test', exitCode: 1 }),
      ]);
      const result = await writeRunReports(cwd, built);
      expect(result.errors).toEqual([]);

      const everything = await readTree(join(cwd, '.local-ci'));
      expect(everything).toContain('***');
      for (const secret of [...Object.values(ENV_SECRETS), ...FORMAT_SECRETS]) {
        expect(everything, `secret leaked: ${secret}`).not.toContain(secret);
      }
      // The label survives so a reader knows what was masked.
      expect(everything).toContain('Authorization: Bearer ***');
    });
  });
});

describe('reports directory ignores itself (F-1)', () => {
  it('creates .local-ci/.gitignore on the first run', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toMatch(/^\*$/m);
    });
  });

  it('never overwrites an existing .local-ci/.gitignore', async () => {
    await withTempProject(async (cwd) => {
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));
      await writeFile(join(cwd, REPORT_ROOT_GITIGNORE), '# mine\nlogs/\n', 'utf8');
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toBe('# mine\nlogs/\n');
    });
  });

  it('never edits the project .gitignore', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, '.gitignore'), 'node_modules/\n', 'utf8');
      await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));
      expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    });
  });

  it('is honoured by git', async (context) => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      context.skip();
    }
    await withTempProject(async (cwd) => {
      execFileSync('git', ['init', '-q'], { cwd });
      const result = await writeRunReports(cwd, makeBuilt([makeStep('build', 'PASS')]));

      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
      expect(status).not.toContain('.local-ci');
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', result.paths.reportJson], { cwd, stdio: 'ignore' }),
      ).not.toThrow();
    });
  });
});
