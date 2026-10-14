import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { newestRunIds } from '../helpers/reports.js';

const execFileAsync = promisify(execFile);

/**
 * Real-toolchain tests use the actual compilers and package managers on this
 * machine and nothing is faked. They are the only evidence that an ecosystem
 * works against its real tool, so they must never pass by skipping in CI:
 * with LOCAL_CI_REAL_TOOLCHAINS=required a missing tool is a failure.
 */
export const REQUIRED = process.env['LOCAL_CI_REAL_TOOLCHAINS'] === 'required';

/** True when `command args` runs and exits 0. */
export async function toolWorks(command: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 20_000, shell: process.platform === 'win32', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * `describe` for one real tool. When the tool is missing the suite is skipped
 * (visibly, with the reason in its name) locally, and fails in required mode.
 */
export function describeReal(name: string, available: boolean, body: () => void): void {
  if (available) {
    describe(`real ${name}`, body);
  } else if (REQUIRED) {
    describe(`real ${name}`, () => {
      it('is installed (LOCAL_CI_REAL_TOOLCHAINS=required)', () => {
        expect.fail(`${name} is required for the real-toolchain tests but is not available on this machine.`);
      });
    });
  } else {
    describe.skip(`real ${name} (SKIPPED: not available on this machine)`, body);
  }
}

export interface RealReport {
  status: string;
  outcome: string;
  exitCode: number;
  steps: Array<{ id: string; status: string; exitCode?: number | null; stdout: string; stderr: string; error?: string; command?: string }>;
}

export async function lastReport(cwd: string): Promise<RealReport> {
  const base = join(cwd, '.local-ci', 'reports');
  const [runId] = await newestRunIds(base);
  return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as RealReport;
}

export const statuses = (report: RealReport): Array<[string, string]> => report.steps.map((s) => [s.id, s.status]);

/**
 * Runs `body` with npm pointed at empty user and global configuration.
 *
 * A developer's own ~/.npmrc is part of the machine, not of the project under
 * test: this machine's, for example, sets `allow-scripts`, which npm 11 rejects
 * in project-scoped installs and which fails `npm ci` in every directory. The
 * real-npm test is about local-ci running npm, so npm runs hermetically.
 * (This tests the test environment, not local-ci: a user who has that setting
 * hits the same npm error on their own, and local-ci reports npm's message.)
 */
export async function withHermeticNpm<T>(body: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-npmrc-'));
  // npm refuses to load one file as both the user and the global configuration.
  const userConfig = join(dir, 'user-npmrc');
  const globalConfig = join(dir, 'global-npmrc');
  await writeFile(userConfig, '', 'utf8');
  await writeFile(globalConfig, '', 'utf8');

  // `npm test` / `npx` export the developer's whole npm configuration as
  // npm_config_* variables, and the npm that local-ci then runs inherits them.
  const saved = Object.entries(process.env).filter(([key]) => /^npm_config_/i.test(key));
  for (const [key] of saved) delete process.env[key];
  process.env['npm_config_userconfig'] = userConfig;
  process.env['npm_config_globalconfig'] = globalConfig;
  try {
    return await body();
  } finally {
    delete process.env['npm_config_userconfig'];
    delete process.env['npm_config_globalconfig'];
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  }
}
