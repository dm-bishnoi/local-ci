/**
 * Real-toolchain verification. See helpers.ts for how skipping and required
 * mode work. Every fixture is offline: no dependency is downloaded.
 *
 * Which of these have actually been executed is recorded in the delivery
 * report; a suite that was skipped on the machine that built a release is not
 * evidence for that release.
 */

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';
import { writeTree } from '../helpers/tree.js';
import { describeReal, lastReport, statuses, toolWorks, withHermeticNpm } from './helpers.js';

const execFileAsync = promisify(execFile);
const windows = process.platform === 'win32';
const pythonCommand = windows ? 'python' : 'python3';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const run = (cwd: string) => runCommand(cwd, { browsers: NO_BROWSERS });
const node = (code: string): string => `node -e "${code}"`;

// --- Node package managers ---------------------------------------------------

const hasNpm = await toolWorks('npm');
describeReal('npm', hasNpm, () => {
  it('npm ci (offline, empty lockfile), a script build and a failing script', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [install, build, test]\n',
        'package.json': { name: 'x', version: '1.0.0', scripts: { build: node("console.log('built')"), test: node('process.exit(3)') } },
        'package-lock.json': { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } },
      });
      expect(await withHermeticNpm(() => run(cwd))).toBe(1);
      const report = await lastReport(cwd);
      expect(statuses(report)).toEqual([['install', 'PASS'], ['build', 'PASS'], ['test', 'FAIL']]);
      expect(report.steps[2]).toMatchObject({ exitCode: 3 });
      expect(report.steps[0]!.command).toBe('npm ci');
    });
  }, 180_000);
});

const hasPnpm = await toolWorks('pnpm');
describeReal('pnpm', hasPnpm, () => {
  it('runs scripts through pnpm and reports its own command', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [build]\n',
        'package.json': { name: 'x', version: '1.0.0', scripts: { build: node("console.log('pnpm built')") } },
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      });
      expect(await run(cwd)).toBe(0);
      const report = await lastReport(cwd);
      expect(report.steps[0]).toMatchObject({ status: 'PASS', command: 'pnpm run build' });
      expect(report.steps[0]!.stdout).toContain('pnpm built');
    });
  }, 180_000);
});

const hasBun = await toolWorks('bun');
describeReal('bun', hasBun, () => {
  it('runs scripts through bun', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [build]\n',
        'package.json': { name: 'x', version: '1.0.0', scripts: { build: node("console.log('bun built')") } },
        'bun.lock': '{}',
      });
      expect(await run(cwd)).toBe(0);
      expect((await lastReport(cwd)).steps[0]).toMatchObject({ status: 'PASS', command: 'bun run build' });
    });
  }, 180_000);
});

const hasYarn = await toolWorks('yarn');
describeReal('yarn', hasYarn, () => {
  it('runs scripts through yarn', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: node\npipeline: [build]\n',
        'package.json': { name: 'x', version: '1.0.0', scripts: { build: node("console.log('yarn built')") } },
        'yarn.lock': '# yarn lockfile v1\n',
      });
      expect(await run(cwd)).toBe(0);
      expect((await lastReport(cwd)).steps[0]).toMatchObject({ status: 'PASS', command: 'yarn run build' });
    });
  }, 180_000);
});

// --- Python -------------------------------------------------------------------

const hasPython = await toolWorks(pythonCommand);
const hasPytest = hasPython && (await toolWorks(pythonCommand, ['-m', 'pytest', '--version']));
const hasRuff = hasPython && (await toolWorks(pythonCommand, ['-m', 'ruff', '--version']));
describeReal('python', hasPython, () => {
  it('prefers a real virtual environment, and a tool missing from it is BLOCKED, not failed', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: python\npipeline: [test]\n',
        'pyproject.toml': '[project]\nname = "x"\nversion = "0.1"\n',
        'conftest.py': '',
      });
      await execFileAsync(pythonCommand, ['-m', 'venv', '.venv'], { cwd, timeout: 120_000, shell: windows });
      expect(await run(cwd)).toBe(1);
      const report = await lastReport(cwd);
      expect(report.steps[0]).toMatchObject({ id: 'test', status: 'BLOCKED' });
      expect(report.steps[0]!.error).toMatch(/pytest/);
      expect(report.steps[0]!.stdout).toBe('');
    });
  }, 240_000);

  it.skipIf(!hasPytest)('real pytest: a passing and a failing test', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: python\npipeline: [test]\n',
        'pyproject.toml': '[project]\nname = "x"\nversion = "0.1"\n',
        'pytest.ini': '[pytest]\n',
        'test_ok.py': 'def test_ok():\n    assert True\n',
      });
      expect(await run(cwd)).toBe(0);
      await writeTree(cwd, { 'test_bad.py': 'def test_bad():\n    assert False\n' });
      expect(await run(cwd)).toBe(1);
      expect(statuses(await lastReport(cwd))).toEqual([['test', 'FAIL']]);
    });
  }, 240_000);

  it.skipIf(!hasRuff)('real ruff: format --check fails on unformatted code and never rewrites it', async () => {
    await withTempProject(async (cwd) => {
      const ugly = 'x   =   1\n';
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: python\npipeline: [lint, format]\n',
        'pyproject.toml': '[project]\nname = "x"\nversion = "0.1"\n[tool.ruff]\n',
        'app.py': ugly,
      });
      expect(await run(cwd)).toBe(1);
      expect(statuses(await lastReport(cwd))).toEqual([['lint', 'PASS'], ['format', 'FAIL']]);
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(cwd, 'app.py'), 'utf8')).toBe(ugly);
    });
  }, 240_000);
});

// --- Go -------------------------------------------------------------------------

// gofmt ships in the same distribution and has no version flag (`gofmt -h` exits 2), so `go version` is the check.
const hasGo = await toolWorks('go', ['version']);
describeReal('go', hasGo, () => {
  const MAIN = 'package main\n\nfunc main() {}\n';
  const TEST = 'package main\n\nimport "testing"\n\nfunc TestOk(t *testing.T) {}\n';

  it('format, vet, test and build pass on a clean module', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: go\npipeline: [format, vet, test, build]\n',
        'go.mod': 'module example.com/x\n\ngo 1.18\n',
        'main.go': MAIN,
        'main_test.go': TEST,
      });
      expect(await run(cwd)).toBe(0);
      expect(statuses(await lastReport(cwd)).every(([, s]) => s === 'PASS')).toBe(true);
    });
  }, 240_000);

  it('gofmt -l lists an unformatted file with exit 0, and that is a FAIL; the file is not rewritten', async () => {
    await withTempProject(async (cwd) => {
      const ugly = 'package main\nfunc   main( ) {  }\n';
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: go\npipeline: [format]\n',
        'go.mod': 'module example.com/x\n\ngo 1.18\n',
        'main.go': ugly,
      });
      expect(await run(cwd)).toBe(1);
      const step = (await lastReport(cwd)).steps[0]!;
      expect(step).toMatchObject({ status: 'FAIL', exitCode: 0 });
      expect(step.stdout).toContain('main.go');
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(cwd, 'main.go'), 'utf8')).toBe(ugly);
    });
  }, 240_000);
});

// --- Rust -----------------------------------------------------------------------

const hasCargo = await toolWorks('cargo');
const hasFmt = hasCargo && (await toolWorks('cargo', ['fmt', '--version']));
describeReal('cargo', hasCargo, () => {
  it('check, test and build pass on a dependency-free crate, offline and --locked', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: rust\npipeline: [check, test, build]\nsettings:\n  offline: true\n',
        'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
        'Cargo.lock': '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "x"\nversion = "0.1.0"\n',
        'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(1, 2), 3); }\n}\n',
      });
      expect(await run(cwd)).toBe(0);
      expect(statuses(await lastReport(cwd)).every(([, s]) => s === 'PASS')).toBe(true);
      await rm(join(cwd, 'target'), { recursive: true, force: true });
    });
  }, 480_000);

  it.skipIf(!hasFmt)('cargo fmt --check fails on unformatted code and does not rewrite it', async () => {
    await withTempProject(async (cwd) => {
      const ugly = 'pub fn  add(a:i32,b:i32)->i32{a+b}\n';
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: rust\npipeline: [format]\n',
        'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': ugly,
      });
      expect(await run(cwd)).toBe(1);
      expect((await lastReport(cwd)).steps[0]).toMatchObject({ status: 'FAIL' });
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(cwd, 'src', 'lib.rs'), 'utf8')).toBe(ugly);
    });
  }, 240_000);
});

// --- .NET ------------------------------------------------------------------------

const hasDotnet = await toolWorks('dotnet');
const dotnetOnPath = await toolWorks('dotnet', ['--info']).then(() => true, () => false);
describeReal('dotnet', hasDotnet, () => {
  it('restore and build a dependency-free console project', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: dotnet\npipeline: [restore, build]\n',
        'App.csproj':
          '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n',
        'Program.cs': 'System.Console.WriteLine("hi");\n',
      });
      expect(await run(cwd)).toBe(0);
      expect(statuses(await lastReport(cwd))).toEqual([['restore', 'PASS'], ['build', 'PASS']]);
    });
  }, 480_000);
});

// A dotnet that is on PATH but does not work (as on the machine this feature was built on)
// must read as unavailable. This one needs no working SDK, so it is not a describeReal case.
it.skipIf(hasDotnet || !dotnetOnPath)('a dotnet that exists but cannot run is BLOCKED, never run and never passed', async () => {
  await withTempProject(async (cwd) => {
    await writeTree(cwd, {
      '.local-ci.yml': 'version: 1\nproject:\n  type: dotnet\npipeline: [restore]\n',
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    expect(await run(cwd)).toBe(1);
    expect((await lastReport(cwd)).steps[0]).toMatchObject({ status: 'BLOCKED', stdout: '' });
  });
}, 120_000);

// --- Java ------------------------------------------------------------------------

const hasJava = await toolWorks('java', ['-version']);
const hasMvn = hasJava && (await toolWorks('mvn', ['--version']));
const hasGradle = hasJava && (await toolWorks('gradle', ['--version']));
describeReal('java (JDK)', hasJava, () => {
  it.skipIf(hasMvn)('a Maven project without mvn or a wrapper is BLOCKED naming mvn, while the JDK probe passes', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: maven\npipeline: [compile]\n',
        'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>',
      });
      expect(await run(cwd)).toBe(1);
      const step = (await lastReport(cwd)).steps[0]!;
      expect(step.status).toBe('BLOCKED');
      expect(step.error).toMatch(/needs mvn/);
    });
  }, 120_000);

  it.skipIf(hasGradle)('a Gradle project without gradle or a wrapper is BLOCKED naming gradle', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: gradle\npipeline: [compile]\n',
        'build.gradle': '',
      });
      expect(await run(cwd)).toBe(1);
      expect((await lastReport(cwd)).steps[0]!.error).toMatch(/needs gradle/);
    });
  }, 120_000);
});

describeReal('maven', hasMvn, () => {
  it('is recognised by preflight (no build is run: that needs the network)', async () => {
    const { runPreflightChecks } = await import('../../src/diagnostics/preflight.js');
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: maven\npipeline: [compile]\n',
        'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>',
      });
      const diagnostics = await runPreflightChecks(cwd, { browsers: NO_BROWSERS });
      expect(diagnostics.find((d) => d.id.endsWith('tool:mvn'))?.severity).toBe('PASS');
      expect(diagnostics.find((d) => d.id.includes('tool:java'))?.severity).toBe('PASS');
    });
  }, 120_000);
});

// --- PHP -------------------------------------------------------------------------

const hasPhp = (await toolWorks('php')) && (await toolWorks('composer'));
describeReal('php and composer', hasPhp, () => {
  it('composer install from an empty lock file, then a composer test script', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: php\npipeline: [install, test]\n',
        'composer.json': { name: 'x/y', scripts: { test: 'php -r "exit(0);"' } },
        'composer.lock': {
          _readme: ['generated'],
          'content-hash': 'd41d8cd98f00b204e9800998ecf8427e',
          packages: [],
          'packages-dev': [],
          aliases: [],
          'minimum-stability': 'stable',
          'stability-flags': [],
          'prefer-stable': false,
          'prefer-lowest': false,
          platform: [],
          'platform-dev': [],
          'plugin-api-version': '2.6.0',
        },
      });
      expect(await run(cwd)).toBe(0);
      expect(statuses(await lastReport(cwd))).toEqual([['install', 'PASS'], ['test', 'PASS']]);
    });
  }, 240_000);
});
