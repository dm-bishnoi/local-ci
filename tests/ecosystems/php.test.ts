import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { phpAdapter, type PhpDetection } from '../../src/ecosystems/php/index.js';
import type { AvailableCapability, Capability } from '../../src/ecosystems/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { newestRunIds, withTempProject } from '../helpers/reports.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, makeTree, writeTree } from '../helpers/tree.js';

// Detection tests scan real directories and look tools up on PATH. They take well under
// a second alone, but a loaded machine running the whole suite has been measured at 5 s+
// for them (the default limit). This is headroom, not a sign of slow code.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanupTrees);

const windows = process.platform === 'win32';
const detect = async (files: Record<string, string | object>): Promise<PhpDetection> =>
  (await phpAdapter.detect(await makeTree(files))) as PhpDetection;
const cap = (c: Capability | undefined): AvailableCapability => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return c;
};
const reason = (c: Capability | undefined): string => (c?.state === 'unavailable' ? c.reason : '');
const binName = (name: string): string => (windows ? `${name}.bat` : name);

/** Creates vendor/bin/<name> as a runnable fake (a .bat on Windows, a shell script elsewhere). */
async function vendorBin(dir: string, name: string, js: string): Promise<void> {
  const bin = join(dir, 'vendor', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, `${name}.js`), js, 'utf8');
  const file = join(bin, binName(name));
  await writeFile(file, windows ? `@echo off\r\nnode "%~dp0${name}.js" %*\r\n` : `#!/bin/sh\nexec node "\${0%/*}/${name}.js" "$@"\n`, 'utf8');
  if (!windows) await chmod(file, 0o755);
}

describe('PHP detection', () => {
  it('detects composer.json and records the lock file and scripts (string and array forms)', async () => {
    const d = await detect({
      'composer.json': { scripts: { test: 'phpunit', check: ['@lint', '@test'] } },
      'composer.lock': '{}',
    });
    expect(d).toMatchObject({ detected: true, lockfile: true, evidence: ['composer.json', 'composer.lock'] });
    expect(d.scripts).toEqual({ test: 'phpunit', check: '@lint && @test' });
  });

  it('is not detected without composer.json, with invalid JSON, or from other manifests', async () => {
    expect(await detect({ 'index.php': '<?php' })).toMatchObject({ detected: false, reason: expect.stringMatching(/No composer\.json/) });
    expect(await detect({ 'composer.json': '{ nope' })).toMatchObject({ detected: false, reason: expect.stringMatching(/not valid JSON/) });
    expect(await detect({ 'composer.json': '[]' })).toMatchObject({ detected: false, reason: expect.stringMatching(/JSON object/) });
    expect((await detect({ 'package.json': '{}', 'pom.xml': '' })).detected).toBe(false);
  });

  it('honours a safe config.bin-dir and ignores an escaping one', async () => {
    expect((await detect({ 'composer.json': { config: { 'bin-dir': 'bin' } } })).binDir).toBe('bin');
    expect((await detect({ 'composer.json': { config: { 'bin-dir': '../elsewhere' } } })).binDir).toBe('vendor/bin');
    expect((await detect({ 'composer.json': { config: { 'bin-dir': 'a b;c' } } })).binDir).toBe('vendor/bin');
  });
});

describe('install', () => {
  it('uses composer.lock only: non-interactive, with no composer timeout of its own', async () => {
    const d = await detect({ 'composer.json': {}, 'composer.lock': '{}' });
    const install = cap(d.capabilities['install']);
    expect([install.command, ...install.args]).toEqual(['composer', 'install', '--no-interaction', '--no-progress']);
    expect(install.env).toMatchObject({ COMPOSER_PROCESS_TIMEOUT: '0', COMPOSER_NO_INTERACTION: '1' });
    expect(install.requires).toContainEqual({ kind: 'lockfile', file: 'composer.lock' });
  });

  it('without a lock file it is unavailable rather than creating one', async () => {
    const d = await detect({ 'composer.json': {} });
    expect(reason(d.capabilities['install'])).toMatch(/No composer\.lock.*would create it/);
  });

  it('init installs only when vendor/ is absent', async () => {
    const without = await detect({ 'composer.json': { scripts: { test: 'phpunit' } }, 'composer.lock': '{}' });
    expect(phpAdapter.defaultPipeline(without).pipeline).toEqual(['install', 'test']);
    const withVendor = await detect({ 'composer.json': { scripts: { test: 'phpunit' } }, 'composer.lock': '{}', 'vendor/autoload.php': '' });
    const result = phpAdapter.defaultPipeline(withVendor);
    expect(result.pipeline).toEqual(['test']);
    expect(result.omitted.find((o) => o.id === 'install')?.reason).toMatch(/already installed/);
  });
});

describe('optional tools are never assumed', () => {
  const dev = (...packages: string[]) => ({ 'require-dev': Object.fromEntries(packages.map((p) => [p, '*'])) });

  it('a composer test script wins over PHPUnit', async () => {
    const d = await detect({ 'composer.json': { scripts: { test: 'phpunit' }, ...dev('phpunit/phpunit') }, 'phpunit.xml': '' });
    const test = cap(d.capabilities['test']);
    expect([test.command, ...test.args]).toEqual(['composer', 'run-script', 'test', '--no-interaction']);
    expect(test.source).toBe('script');
  });

  it('PHPUnit needs its config AND to be declared or installed; it runs without a result cache', async () => {
    const d = await detect({ 'composer.json': dev('phpunit/phpunit'), 'phpunit.xml.dist': '' });
    const test = cap(d.capabilities['test']);
    expect(test.command).toBe(join(d.root, 'vendor', 'bin', binName('phpunit')));
    expect(test.args).toEqual(['--do-not-cache-result']);
    expect(test.source).toBe('inferred');

    expect(reason((await detect({ 'composer.json': {}, 'phpunit.xml': '' })).capabilities['test'])).toMatch(/neither in composer\.json nor in vendor\/bin/);
    expect(reason((await detect({ 'composer.json': dev('phpunit/phpunit') })).capabilities['test'])).toMatch(/No composer "test" script, and no PHPUnit configuration/);
  });

  it('PHPStan and the formatters follow the same rule', async () => {
    const d = await detect({
      'composer.json': dev('phpstan/phpstan', 'friendsofphp/php-cs-fixer'),
      'phpstan.neon': '',
      '.php-cs-fixer.dist.php': '',
    });
    expect(cap(d.capabilities['analyse']).args).toEqual(['analyse', '--no-progress', '--no-interaction']);
    expect(cap(d.capabilities['format']).args).toEqual(['fix', '--dry-run', '--diff', '--using-cache=no', '--no-interaction']);

    const none = await detect({ 'composer.json': {}, 'phpstan.neon': '', '.php-cs-fixer.php': '' });
    expect(none.capabilities['analyse']?.state).toBe('unavailable');
    expect(none.capabilities['format']?.state).toBe('unavailable');
  });

  it('PHP_CodeSniffer is the fallback formatter and never fixes', async () => {
    const d = await detect({ 'composer.json': dev('squizlabs/php_codesniffer'), 'phpcs.xml': '' });
    const format = cap(d.capabilities['format']);
    expect(format.command).toBe(join(d.root, 'vendor', 'bin', binName('phpcs')));
    expect(format.args).toEqual(['--no-colors']);
    expect(format.command).not.toMatch(/phpcbf/);
  });

  it('no formatter step can modify files', async () => {
    const d = await detect({
      'composer.json': dev('friendsofphp/php-cs-fixer', 'squizlabs/php_codesniffer'),
      '.php-cs-fixer.php': '',
      'phpcs.xml': '',
    });
    const args = cap(d.capabilities['format']).args;
    expect(args).toContain('--dry-run');
    expect(args).not.toContain('--fix');
  });

  it('a declared tool whose binary is missing from an installed vendor/ is unavailable (installed with --no-dev?)', async () => {
    const dir = await makeTree({ 'composer.json': dev('phpunit/phpunit'), 'phpunit.xml': '', 'vendor/autoload.php': '' });
    const d = (await phpAdapter.detect(dir)) as PhpDetection;
    expect(reason(d.capabilities['test'])).toMatch(/does not exist although vendor\/ is installed/);
    await vendorBin(dir, 'phpunit', '');
    expect(((await phpAdapter.detect(dir)) as PhpDetection).capabilities['test']?.state).toBe('available');
  });

  it('a tool that is installed but not declared still counts as present', async () => {
    const dir = await makeTree({ 'composer.json': {}, 'phpstan.neon': '', 'vendor/autoload.php': '' });
    await vendorBin(dir, 'phpstan', '');
    expect(((await phpAdapter.detect(dir)) as PhpDetection).capabilities['analyse']?.state).toBe('available');
  });

  it('PHP and Composer are required tools; require.php sets a minimum version', async () => {
    const d = await detect({ 'composer.json': { require: { php: '^8.1' }, scripts: { test: 'x' } } });
    const requires = cap(d.capabilities['test']).requires;
    expect(requires).toContainEqual({ kind: 'tool', name: 'php' });
    expect(requires).toContainEqual({ kind: 'tool', name: 'composer' });
    expect(requires).toContainEqual({ kind: 'version', tool: 'php', atLeast: '8.1', source: 'composer.json require.php' });
  });

  it.each([
    ['>=7.4', '7.4'],
    ['~8.0.0', '8.0.0'],
    ['^8.2', '8.2'],
  ])('require.php %s -> at least %s', async (constraint, atLeast) => {
    const d = await detect({ 'composer.json': { require: { php: constraint }, scripts: { test: 'x' } } });
    expect(cap(d.capabilities['test']).requires).toContainEqual(expect.objectContaining({ kind: 'version', atLeast }));
  });

  it('alternatives in require.php are not guessed at: no check, and a note', async () => {
    const d = await detect({ 'composer.json': { require: { php: '^7.4 || ^8.0' }, scripts: { test: 'x' } } });
    expect(cap(d.capabilities['test']).requires.some((r) => r.kind === 'version')).toBe(false);
    expect(d.warnings?.[0]).toMatch(/no single lower bound/);
  });
});

describe('PHP through the pipeline with fake tools (mocked toolchain)', () => {
  const PHP = `
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('PHP 8.2.3 (cli) (built: fake)'); process.exit(0); }
`;
  const COMPOSER = `
const a = process.argv.slice(2);
const fs = require('fs');
if (a[0] === '--version') { console.log('Composer version 2.7.1 2024-02-09'); process.exit(0); }
if (process.env.COMPOSER_PROCESS_TIMEOUT !== '0') { console.error('composer timeout not disabled'); process.exit(9); }
if (a[0] === 'run-script' && a[1] === 'test' && fs.existsSync('.failing-test')) { console.log('FAILURES!'); process.exit(2); }
console.log('composer ' + a.join(' ') + ' ok');
`;
  const config = 'version: 1\nproject:\n  type: php\npipeline: [install, test, analyse, format]\n';
  const files = {
    '.local-ci.yml': config,
    'composer.json': { scripts: { test: 'phpunit' }, 'require-dev': { 'phpstan/phpstan': '*', 'friendsofphp/php-cs-fixer': '*' } },
    'composer.lock': '{}',
    'phpstan.neon': '',
    '.php-cs-fixer.php': '',
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const lastReport = async (cwd: string) => {
    const base = join(cwd, '.local-ci', 'reports');
    const [runId] = await newestRunIds(base);
    return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; exitCode?: number; stdout: string; error?: string }>;
    };
  };
  const statuses = (r: Awaited<ReturnType<typeof lastReport>>): Array<[string, string]> => r.steps.map((s) => [s.id, s.status]);

  async function installedProject(cwd: string, extra: Record<string, string | object> = {}): Promise<void> {
    await writeTree(cwd, { ...files, 'vendor/autoload.php': '', ...extra });
    await vendorBin(cwd, 'phpstan', "console.log('phpstan ' + process.argv.slice(2).join(' ') + ' ok')");
    await vendorBin(cwd, 'php-cs-fixer', "if (require('fs').existsSync('.unformatted')) { console.log('Found 1 of 3 files that can be fixed'); process.exit(8); } console.log('fixer ok')");
  }

  it('installs, tests (via the composer script), analyses and checks formatting', async () => {
    const shims = await installShims({ php: PHP, composer: COMPOSER });
    await withTempProject(async (cwd) => {
      await installedProject(cwd);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
        const report = await lastReport(cwd);
        expect(statuses(report).every(([, s]) => s === 'PASS')).toBe(true);
        expect(report.steps.find((s) => s.id === 'install')!.stdout).toContain('composer install --no-interaction --no-progress ok');
        expect(report.steps.find((s) => s.id === 'analyse')!.stdout).toContain('phpstan analyse --no-progress --no-interaction ok');
      });
    });
  }, 120_000);

  it('failing tests and a formatting difference fail only their own steps, with the tool exit codes', async () => {
    const shims = await installShims({ php: PHP, composer: COMPOSER });
    await withTempProject(async (cwd) => {
      await installedProject(cwd, { '.failing-test': '', '.unformatted': '' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['install', 'PASS'], ['test', 'FAIL'], ['analyse', 'PASS'], ['format', 'FAIL']]);
        expect(report.steps[1]).toMatchObject({ exitCode: 2 });
        expect(report.steps[3]).toMatchObject({ exitCode: 8 });
      });
    });
  }, 120_000);

  it('without php nothing runs; without composer only the composer-backed steps are blocked', async () => {
    await withTempProject(async (cwd) => {
      await installedProject(cwd);
      await withPath([], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect((await lastReport(cwd)).steps.every((s) => s.status === 'BLOCKED')).toBe(true);
      }, { replace: true });

      const onlyPhp = await installShims({ php: PHP });
      await withPath([onlyPhp], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect(statuses(await lastReport(cwd))).toEqual([['install', 'BLOCKED'], ['test', 'BLOCKED'], ['analyse', 'PASS'], ['format', 'PASS']]);
      }, { replace: true });
    });
  }, 120_000);

  it('an old PHP is blocked against composer.json require.php', async () => {
    const shims = await installShims({ php: PHP, composer: COMPOSER });
    await withTempProject(async (cwd) => {
      await installedProject(cwd, { 'composer.json': { ...files['composer.json'], require: { php: '>=8.4' } } });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect((await lastReport(cwd)).steps[0]!.error).toMatch(/composer\.json require\.php requires php >= 8\.4, but 8\.2\.3 is installed/);
      });
    });
  }, 120_000);

  it('vendor/ missing: blocked without an earlier install, only a warning with one', async () => {
    const shims = await installShims({ php: PHP, composer: COMPOSER });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { ...files, '.local-ci.yml': 'version: 1\nproject:\n  type: php\npipeline: [test]\n' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect(statuses(await lastReport(cwd))).toEqual([['test', 'BLOCKED']]);
        expect((await lastReport(cwd)).steps[0]!.error).toMatch(/vendor\/ \(composer install\) is missing/);

        await writeTree(cwd, { '.local-ci.yml': 'version: 1\nproject:\n  type: php\npipeline: [install, test]\n' });
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
      });
    });
  }, 120_000);

  it('`script:` in a PHP project runs a composer script, and a missing one is UNSUPPORTED', async () => {
    const shims = await installShims({ php: PHP, composer: COMPOSER });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: php\npipeline: [lint, ghost]\nsteps:\n  lint:\n    script: cs:check\n  ghost:\n    script: nope\n',
        'composer.json': { scripts: { 'cs:check': 'phpcs' } },
      });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['lint', 'PASS'], ['ghost', 'UNSUPPORTED']]);
        expect(report.steps[0]!.stdout).toContain('composer run-script cs:check --no-interaction ok');
        expect(report.steps[1]!.error).toMatch(/no script named "nope"/);
      });
    });
  }, 120_000);

  it('`script:` in an ecosystem without scripts says to use run:', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: rust\npipeline: [lint]\nsteps:\n  lint:\n    script: whatever\n',
        'Cargo.toml': '[package]\nname = "x"\n',
      });
      expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
      const report = await lastReport(cwd);
      expect(report.steps[0]).toMatchObject({ status: 'UNSUPPORTED' });
      expect(report.steps[0]!.error).toMatch(/Use run: \[command, \.\.\.args\]/);
    });
  }, 120_000);
});
