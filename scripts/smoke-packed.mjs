#!/usr/bin/env node
/**
 * Black-box smoke test of the PACKED package.
 *
 * Packs this repository (`npm pack`, which builds through `prepack`), installs
 * the tarball into an empty directory outside the repository, and drives the
 * installed CLI (`init`, `doctor`, `run`) against one small fixture per
 * language. Nothing is imported from `src/`, so this exercises exactly what
 * would be published.
 *
 * Each fixture needs its real toolchain. A fixture whose tool is missing is
 * SKIPPED and listed loudly; with LOCAL_CI_SMOKE=required a missing tool is a
 * failure instead, so CI cannot pass by not testing. Fixtures are offline
 * (nothing is downloaded by the fixtures themselves). Maven and Gradle are
 * covered by tests/real/java-builds.test.ts, which needs network access.
 *
 * Usage: node scripts/smoke-packed.mjs
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = process.env.LOCAL_CI_SMOKE === 'required';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const pythonCommand = windows ? 'python' : 'python3';

const failures = [];
const skipped = [];
const passed = [];

/** Runs a command line through the shell (so npm/.cmd shims work everywhere). */
function sh(commandLine, cwd, extraEnv = {}) {
  return spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 600_000, windowsHide: true });
}

function works(commandLine) {
  const result = sh(commandLine, tmpdir());
  return result.status === 0;
}

function must(result, what) {
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const work = mkdtempSync(join(tmpdir(), 'local-ci-smoke-'));
const toolDir = join(work, 'tool');
mkdirSync(toolDir, { recursive: true });

console.log('== Packing and installing the tarball');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const packed = must(sh(`npm pack --pack-destination "${work}" --silent`, repo), 'npm pack');
const tarball = join(work, packed.stdout.trim().split(/\r?\n/).pop());
if (!existsSync(tarball)) throw new Error(`npm pack reported ${tarball}, which does not exist`);
console.log(`   ${tarball} (${statSync(tarball).size} bytes)`);
must(sh(`npm install --prefix "${toolDir}" --no-audit --no-fund "${tarball}"`, work), 'npm install of the tarball');
const cli = join(toolDir, 'node_modules', '@dm-bishnoi', 'local-ci-runner', 'dist', 'cli', 'index.js');
if (!existsSync(cli)) throw new Error(`the installed package has no ${cli}`);

/** Runs the installed CLI. */
function localCi(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 600_000, windowsHide: true });
}

const version = localCi(['--version'], work);
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
  failures.push(`--version printed "${version.stdout.trim()}", expected package.json version ${pkg.version}`);
} else {
  passed.push('--version matches package.json');
}

function newestReport(cwd) {
  const base = join(cwd, '.local-ci', 'reports');
  const dirs = readdirSync(base).map((name) => ({ name, mtime: statSync(join(base, name)).mtimeMs }));
  dirs.sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(readFileSync(join(base, dirs[0].name, 'report.json'), 'utf8'));
}

const fixtures = [
  {
    name: 'node',
    tools: ['node --version'],
    files: {
      'package.json': JSON.stringify({
        name: 'smoke-node',
        version: '1.0.0',
        scripts: { build: 'node -e "console.log(1)"', test: 'node -e "process.exit(0)"' },
      }),
    },
    expectSteps: ['build', 'test'],
    // A second run with a broken test must fail, proving the exit code is not always 0.
    breakWith: { 'package.json': JSON.stringify({ name: 'smoke-node', version: '1.0.0', scripts: { build: 'node -e "console.log(1)"', test: 'node -e "process.exit(3)"' } }) },
  },
  {
    name: 'python',
    tools: [`${pythonCommand} --version`, `${pythonCommand} -m pytest --version`],
    files: { 'pyproject.toml': '[project]\nname = "x"\nversion = "0.1"\n', 'pytest.ini': '[pytest]\n', 'test_ok.py': 'def test_ok():\n    assert True\n' },
    expectSteps: ['test'],
    breakWith: { 'test_bad.py': 'def test_bad():\n    assert False\n' },
  },
  {
    name: 'go',
    tools: ['go version'],
    files: {
      'go.mod': 'module example.com/x\n\ngo 1.18\n',
      'main.go': 'package main\n\nfunc main() {}\n',
      'main_test.go': 'package main\n\nimport "testing"\n\nfunc TestOk(t *testing.T) {}\n',
    },
    expectSteps: ['format', 'vet', 'test', 'build'],
    breakWith: { 'main.go': 'package main\nfunc   main( ) {  }\n' },
  },
  {
    name: 'rust',
    tools: ['cargo --version'],
    files: {
      'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
      'Cargo.lock': '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "x"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
    },
    expectSteps: ['check', 'test', 'build'],
    breakWith: { 'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b + }\n' },
  },
  {
    name: 'dotnet',
    tools: ['dotnet --version'],
    files: {
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n',
      'Program.cs': 'System.Console.WriteLine("hi");\n',
    },
    expectSteps: ['restore', 'build'],
    breakWith: { 'Program.cs': 'System.Console.WriteLine("hi"\n' },
  },
  {
    name: 'php',
    tools: ['php --version', 'composer --version'],
    files: {
      'composer.json': JSON.stringify({ name: 'x/y', scripts: { test: 'php -r "exit(0);"' } }),
      'composer.lock': JSON.stringify({
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
      }),
    },
    expectSteps: ['install', 'test'],
    breakWith: { 'composer.json': JSON.stringify({ name: 'x/y', scripts: { test: 'php -r "exit(3);"' } }) },
  },
];

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

for (const fixture of fixtures) {
  const missing = fixture.tools.filter((tool) => !works(tool));
  if (missing.length > 0) {
    const reason = `${fixture.name}: tool not available (${missing.join(', ')})`;
    if (REQUIRED) failures.push(`${reason}, and LOCAL_CI_SMOKE=required`);
    else skipped.push(reason);
    continue;
  }

  console.log(`== ${fixture.name}`);
  const dir = join(work, `fixture-${fixture.name}`);
  mkdirSync(dir, { recursive: true });
  write(dir, fixture.files);
  const problems = [];

  const init = localCi(['init'], dir);
  if (init.status !== 0 || !existsSync(join(dir, '.local-ci.yml'))) problems.push(`init failed (exit ${init.status}): ${init.stderr}${init.stdout}`);

  const doctor = localCi(['doctor'], dir);
  if (doctor.status !== 0) problems.push(`doctor exited ${doctor.status}:\n${doctor.stdout}${doctor.stderr}`);

  const first = localCi(['run'], dir);
  if (first.status !== 0) {
    problems.push(`run exited ${first.status}:\n${first.stdout}${first.stderr}`);
  } else {
    const report = newestReport(dir);
    const byId = Object.fromEntries(report.steps.map((step) => [step.id, step.status]));
    for (const id of fixture.expectSteps) if (byId[id] !== 'PASS') problems.push(`step "${id}" was ${byId[id] ?? 'absent'}, expected PASS`);
    const notPassing = report.steps.filter((step) => step.status !== 'PASS');
    if (notPassing.length > 0) problems.push(`non-passing steps: ${notPassing.map((s) => `${s.id}=${s.status}`).join(', ')}`);
  }

  if (fixture.breakWith) {
    write(dir, fixture.breakWith);
    const broken = localCi(['run'], dir);
    if (broken.status !== 1) problems.push(`run after breaking the project exited ${broken.status}, expected 1`);
  }

  if (problems.length > 0) failures.push(`${fixture.name}:\n   ${problems.join('\n   ')}`);
  else passed.push(`${fixture.name}: init, doctor, run (${fixture.expectSteps.join(', ')}) and a failing run`);
}

rmSync(work, { recursive: true, force: true });

const lines = [
  '## Packed-tarball smoke test',
  '',
  `Platform: ${process.platform}, Node ${process.version}, mode: ${REQUIRED ? 'required' : 'skips allowed'}`,
  '',
  ...passed.map((entry) => `- PASS ${entry}`),
  ...skipped.map((entry) => `- **SKIPPED** ${entry}`),
  ...failures.map((entry) => `- **FAIL** ${entry}`),
];
console.log(`\n${lines.join('\n')}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
if (skipped.length > 0) console.log(`\n${skipped.length} fixture(s) SKIPPED: this run does not cover them.`);
process.exit(failures.length > 0 ? 1 : 0);
