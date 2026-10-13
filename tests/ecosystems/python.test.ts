import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { loadConfig } from '../../src/config/loader.js';
import { discoverProjects } from '../../src/ecosystems/discovery.js';
import { pythonAdapter, type PythonDetection } from '../../src/ecosystems/python/index.js';
import type { AvailableCapability, Capability } from '../../src/ecosystems/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, makeTree, writeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

const windows = process.platform === 'win32';
const PYPROJECT = '[project]\nname = "x"\nversion = "0.1"\n';

/** A fake `python`/`python3`, so detection picks a deterministic interpreter. */
const PY_SHIM = `
const a = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
const here = __dirname;
const has = (n) => fs.existsSync(path.join(here, n));
if (a[0] === '--version') { console.log('Python 3.12.4'); process.exit(0); }
if (a[0] === '-m') {
  const mod = a[1];
  if (a[2] === '--version') {
    if (has('no-' + mod)) { console.error('/usr/bin/python: No module named ' + mod); process.exit(1); }
    console.log(mod + ' 1.2.3'); process.exit(0);
  }
  if (process.env.PYTHONDONTWRITEBYTECODE !== '1') { console.error('bytecode writing not disabled'); process.exit(9); }
  if (mod === 'ruff' && a[2] === 'format' && fs.existsSync('.unformatted')) { console.log('Would reformat: app.py'); process.exit(1); }
  if (mod === 'pytest' && fs.existsSync('.failing-test')) { console.log('1 failed'); process.exit(1); }
  console.log(mod + ' ' + a.slice(2).join(' ') + ' ok'); process.exit(0);
}
process.exit(0);
`;
const pythonName = windows ? 'python' : 'python3';

const detectWith = async (files: Record<string, string | object>, shims?: string): Promise<PythonDetection> => {
  const dir = await makeTree(files);
  return shims ? withPath([shims], async () => (await pythonAdapter.detect(dir)) as PythonDetection) : ((await pythonAdapter.detect(dir)) as PythonDetection);
};
const args = (c: Capability | undefined): string[] => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return c.args;
};

describe('Python detection: strong, weak and negative evidence', () => {
  it.each([
    ['pyproject [project]', { 'pyproject.toml': PYPROJECT }],
    ['pyproject [tool.poetry]', { 'pyproject.toml': '[tool.poetry]\nname = "x"\n' }],
    ['pyproject [build-system]', { 'pyproject.toml': '[build-system]\nrequires = ["setuptools"]\n' }],
    ['setup.py', { 'setup.py': 'from setuptools import setup\nsetup()\n' }],
    ['requirements.txt', { 'requirements.txt': 'requests\n' }],
    ['requirements-dev.txt', { 'requirements-dev.txt': 'pytest\n' }],
    ['setup.cfg [metadata]', { 'setup.cfg': '[metadata]\nname = x\n' }],
    ['setup.cfg [options]', { 'setup.cfg': '[options]\npackages = find:\n' }],
  ])('%s is strong evidence', async (_name, files) => {
    const d = await detectWith(files);
    expect(d).toMatchObject({ detected: true, confidence: 'strong' });
  });

  it.each([
    ['pyproject with only tool tables', { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' }],
    ['setup.cfg without metadata', { 'setup.cfg': '[flake8]\nmax-line-length = 100\n' }],
    ['tox.ini alone', { 'tox.ini': '[tox]\nenvlist = py312\n' }],
    ['pytest.ini alone', { 'pytest.ini': '[pytest]\naddopts = -q\n' }],
  ])('%s is only weak evidence (a candidate, never auto-selected)', async (_name, files) => {
    const d = await detectWith(files);
    expect(d).toMatchObject({ detected: true, confidence: 'weak' });
    const found = await discoverProjects(await makeTree(files));
    expect(found.projects).toEqual([]);
    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]).toMatchObject({ ecosystem: 'python', path: '.' });
  });

  it('is not detected from unrelated files, and says why', async () => {
    const d = await detectWith({ 'README.md': 'x', 'main.py': 'print(1)', 'package.json': '{}', 'go.mod': 'module m' });
    expect(d).toMatchObject({ detected: false, reason: expect.stringMatching(/No Python project files/) });
    expect(d.capabilities).toEqual({});
  });
});

describe('a manifest is not proof that the optional tools are used', () => {
  const only = async (id: string, files: Record<string, string | object>): Promise<Capability | undefined> =>
    (await detectWith({ 'pyproject.toml': PYPROJECT, ...files })).capabilities[id];

  it('with no tool evidence there is no test, lint, format or typecheck step', async () => {
    const d = await detectWith({ 'pyproject.toml': PYPROJECT, 'main.py': 'x' });
    for (const id of ['test', 'lint', 'format', 'typecheck']) {
      expect(d.capabilities[id], id).toMatchObject({ state: 'unavailable' });
    }
  });

  it.each([
    ['pytest.ini', { 'pytest.ini': '[pytest]\n' }],
    ['pyproject [tool.pytest.ini_options]', { 'pyproject.toml': PYPROJECT + '[tool.pytest.ini_options]\naddopts = "-q"\n' }],
    ['setup.cfg [tool:pytest]', { 'setup.cfg': '[tool:pytest]\naddopts = -q\n' }],
    ['tox.ini [pytest]', { 'tox.ini': '[pytest]\naddopts = -q\n' }],
    ['conftest.py', { 'conftest.py': '' }],
    ['declared in pyproject', { 'pyproject.toml': PYPROJECT + 'dependencies = ["pytest>=7"]\n' }],
    ['declared in requirements', { 'requirements.txt': 'requests\npytest==8.0\n' }],
    ['declared with extras', { 'requirements.txt': 'pytest[testing]>=7\n' }],
  ])('pytest is configured by %s', async (_name, files) => {
    expect((await only('test', files))?.state).toBe('available');
  });

  it.each([
    ['pytest-cov alone', 'pytest-cov==4.0\n'],
    ['pytest-asyncio alone', 'pytest-asyncio\n'],
    ['a full-line comment', '# we should use pytest someday\nrequests\n'],
    ['a trailing comment', 'requests  # pytest is not needed yet\n'],
  ])('does not mistake %s for a pytest dependency', async (_name, requirements) => {
    expect(await only('test', { 'requirements.txt': requirements })).toMatchObject({ state: 'unavailable' });
  });

  it.each([
    ['ruff.toml', { 'ruff.toml': 'line-length = 100\n' }],
    ['.ruff.toml', { '.ruff.toml': '' }],
    ['[tool.ruff]', { 'pyproject.toml': PYPROJECT + '[tool.ruff]\nline-length = 100\n' }],
    ['a ruff dependency', { 'requirements-dev.txt': 'ruff>=0.4\n' }],
  ])('Ruff (lint and format) is configured by %s', async (_name, files) => {
    expect((await only('lint', files))?.state).toBe('available');
    expect((await only('format', files))?.state).toBe('available');
  });

  it('mypy needs configuration, and a single package or a files setting to know what to check', async () => {
    expect((await only('typecheck', { 'mypy.ini': '[mypy]\n' }))?.state).toBe('unavailable');
    expect(args(await only('typecheck', { 'mypy.ini': '[mypy]\nfiles = app\n' }))).toEqual(['-m', 'mypy']);
    expect(args(await only('typecheck', { 'mypy.ini': '[mypy]\n', 'app/__init__.py': '' }))).toEqual(['-m', 'mypy', 'app']);
    expect(args(await only('typecheck', { 'mypy.ini': '[mypy]\n', 'src/lib/__init__.py': '' }))).toEqual(['-m', 'mypy', 'src/lib']);
    const ambiguous = await only('typecheck', { 'mypy.ini': '[mypy]\n', 'a/__init__.py': '', 'b/__init__.py': '' });
    expect(ambiguous).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/no single package/) });
    // tests/ and docs/ are not the package under check
    expect(args(await only('typecheck', { 'mypy.ini': '[mypy]\n', 'app/__init__.py': '', 'tests/__init__.py': '' }))).toEqual(['-m', 'mypy', 'app']);
  });
});

describe('Python commands and interpreter', () => {
  it('runs tools as modules of the chosen interpreter and never writes bytecode', async () => {
    const shims = await installShims({ [pythonName]: PY_SHIM });
    const d = await detectWith({ 'pyproject.toml': PYPROJECT, 'pytest.ini': '', 'ruff.toml': '' }, shims);
    expect(d.interpreter).toMatchObject({ source: 'path', display: pythonName, command: pythonName });
    const test = d.capabilities['test'] as AvailableCapability;
    expect([test.command, ...test.args]).toEqual([pythonName, '-m', 'pytest']);
    expect(args(d.capabilities['lint'])).toEqual(['-m', 'ruff', 'check', '.']);
    expect(args(d.capabilities['format'])).toEqual(['-m', 'ruff', 'format', '--check', '.']);
    expect(test.env).toMatchObject({ PYTHONDONTWRITEBYTECODE: '1' });
  });

  it('prefers the project virtual environment, by absolute path', async () => {
    const rel = windows ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    const d = await detectWith({ 'pyproject.toml': PYPROJECT, 'pytest.ini': '', [rel]: '' });
    expect(d.venv).toBe('.venv');
    expect(d.interpreter).toMatchObject({ source: 'venv', display: '.venv' });
    expect(d.interpreter.command.replace(/\\/g, '/')).toMatch(/\/\.venv\/(Scripts\/python\.exe|bin\/python)$/);
    expect((d.capabilities['test'] as AvailableCapability).command).toBe(d.interpreter.command);
  });

  it('every tool check also requires the interpreter itself and the module to be importable', async () => {
    const d = await detectWith({ 'pyproject.toml': PYPROJECT, 'pytest.ini': '' });
    const requires = (d.capabilities['test'] as AvailableCapability).requires;
    expect(requires).toContainEqual(expect.objectContaining({ kind: 'tool', probeArgs: ['--version'] }));
    expect(requires).toContainEqual(expect.objectContaining({ kind: 'tool', probeArgs: ['-m', 'pytest', '--version'], display: expect.stringMatching(/^pytest \(.* -m pytest\)$/) }));
  });

  it('requires-python with a lower bound becomes a version requirement; other forms only warn', async () => {
    const bounded = await detectWith({ 'pyproject.toml': PYPROJECT + 'requires-python = ">=3.9,<4"\n', 'pytest.ini': '' });
    expect((bounded.capabilities['test'] as AvailableCapability).requires).toContainEqual(
      expect.objectContaining({ kind: 'version', atLeast: '3.9', source: 'requires-python' }),
    );
    const odd = await detectWith({ 'pyproject.toml': PYPROJECT + 'requires-python = "~=3.9"\n', 'pytest.ini': '' });
    expect(odd.warnings?.[0]).toMatch(/requires-python "~=3\.9".*not verified/);
  });

  describe('install is only ever explicit and never goes into a global interpreter', () => {
    it('is unavailable with no environment to install into', async () => {
      const d = await detectWith({ 'requirements.txt': 'requests\n' });
      expect(d.capabilities['install']).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/Installing into a global interpreter is never done automatically/) });
    });

    it('uses the existing venv with requirements.txt', async () => {
      const rel = windows ? 'venv/Scripts/python.exe' : 'venv/bin/python';
      const d = await detectWith({ 'requirements.txt': 'requests\n', [rel]: '' });
      expect(args(d.capabilities['install'])).toEqual(['-m', 'pip', 'install', '-r', 'requirements.txt']);
    });

    it('uv.lock needs uv on PATH; poetry.lock needs poetry on PATH', async () => {
      const uv = await installShims({ uv: 'process.exit(0)' });
      const withUv = await detectWith({ 'pyproject.toml': PYPROJECT, 'uv.lock': '' }, uv);
      expect(args(withUv.capabilities['install'])).toEqual(['sync', '--locked']);

      const poetry = await installShims({ poetry: 'process.exit(0)' });
      const withPoetry = await detectWith({ 'pyproject.toml': PYPROJECT, 'poetry.lock': '' }, poetry);
      expect(args(withPoetry.capabilities['install'])).toEqual(['install', '--no-interaction', '--sync']);

      // uv.lock without uv on PATH offers nothing (PATH is replaced so a real uv cannot interfere).
      const neither = await withPath([], () => detectWith({ 'pyproject.toml': PYPROJECT, 'uv.lock': '' }), { replace: true });
      expect(neither.capabilities['install']).toMatchObject({ state: 'unavailable' });
    });

    it('init never generates an install step', async () => {
      const shims = await installShims({ [pythonName]: PY_SHIM });
      const d = await detectWith({ 'pyproject.toml': PYPROJECT, 'pytest.ini': '', 'requirements.txt': 'pytest\n' }, shims);
      const result = pythonAdapter.defaultPipeline(d);
      expect(result.pipeline).not.toContain('install');
      expect(result.omitted.find((o) => o.id === 'install')?.reason).toMatch(/never installed unless you ask|never done automatically/);
    });
  });
});

describe('Python through the pipeline with fake tools (mocked toolchain)', () => {
  const config = 'version: 1\nproject:\n  type: python\npipeline: [test, lint, format, typecheck]\n';
  const project = {
    '.local-ci.yml': config,
    'pyproject.toml': PYPROJECT + '[tool.ruff]\n[tool.mypy]\nfiles = ["app"]\n',
    'pytest.ini': '',
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const lastReport = async (cwd: string) => {
    const base = join(cwd, '.local-ci', 'reports');
    const [runId] = (await readdir(base)).sort().reverse();
    return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; exitCode?: number; stdout: string; error?: string }>;
    };
  };
  const statuses = (r: Awaited<ReturnType<typeof lastReport>>): Array<[string, string]> => r.steps.map((s) => [s.id, s.status]);

  it('passes, then fails the right step when a check fails', async () => {
    const shims = await installShims({ [pythonName]: PY_SHIM });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, project);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
        expect(statuses(await lastReport(cwd)).every(([, s]) => s === 'PASS')).toBe(true);

        await writeTree(cwd, { '.failing-test': '', '.unformatted': '' });
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect(statuses(await lastReport(cwd))).toEqual([['test', 'FAIL'], ['lint', 'PASS'], ['format', 'FAIL'], ['typecheck', 'PASS']]);
      });
    });
  }, 120_000);

  it('an uninstalled tool blocks only its own step and is never reported as run', async () => {
    const shims = await installShims({ [pythonName]: PY_SHIM });
    await writeTree(shims, { 'no-mypy': '', 'no-ruff': '' });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, project);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['test', 'PASS'], ['lint', 'BLOCKED'], ['format', 'BLOCKED'], ['typecheck', 'BLOCKED']]);
        expect(report.steps[1]!.error).toMatch(/needs ruff \(.* -m ruff\), but it is not available/);
        expect(report.steps[1]!.stdout).toBe('');
      });
    });
  }, 120_000);

  it('without any interpreter every step is blocked', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, project);
      await withPath([], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect((await lastReport(cwd)).steps.every((s) => s.status === 'BLOCKED')).toBe(true);
      }, { replace: true });
    });
  }, 120_000);

  it('init writes only what the interpreter can actually run', async () => {
    const shims = await installShims({ [pythonName]: PY_SHIM });
    await writeTree(shims, { 'no-mypy': '' });
    const dir = await makeTree({ 'pyproject.toml': PYPROJECT + '[tool.ruff]\n[tool.mypy]\nfiles = ["app"]\n', 'pytest.ini': '' });
    await withPath([shims], () => initCommand(dir));
    const config2 = await loadConfig(dir);
    expect(config2.project.type).toBe('python');
    expect(config2.pipeline).toEqual(['test', 'lint', 'format']);
    const text = await readFile(join(dir, '.local-ci.yml'), 'utf8');
    expect(text).toMatch(/# - typecheck {2}# mypy \(.* -m mypy\) was not found on this machine/);
    expect(text).toMatch(/# - install {2}#/);
  }, 60_000);
});

const execFileAsync = promisify(execFile);
const realPython = await execFileAsync(windows ? 'python' : 'python3', ['--version'], { shell: windows }).then(
  () => true,
  () => false,
);

describe.skipIf(!realPython)('with the real Python on this machine (real toolchain)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a project that declares pytest but has no pytest installed is BLOCKED, not failed or passed', async () => {
    // Skipped if this interpreter happens to have pytest: then the premise does not hold.
    const hasPytest = await execFileAsync(windows ? 'python' : 'python3', ['-m', 'pytest', '--version'], { shell: windows }).then(
      () => true,
      () => false,
    );
    if (hasPytest) return;

    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': 'version: 1\nproject:\n  type: python\npipeline: [test]\n',
        'pyproject.toml': PYPROJECT,
        'conftest.py': '',
      });
      expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
      const base = join(cwd, '.local-ci', 'reports');
      const [runId] = (await readdir(base)).sort().reverse();
      const report = JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as { steps: Array<{ status: string; error?: string }> };
      expect(report.steps[0]!.status).toBe('BLOCKED');
      expect(report.steps[0]!.error).toMatch(/needs pytest/);
    });
  }, 120_000);

  it('detects the real interpreter and a real venv layout', async () => {
    const dir = await makeTree({ 'pyproject.toml': PYPROJECT, 'pytest.ini': '' });
    const d = (await pythonAdapter.detect(dir)) as PythonDetection;
    expect(d.interpreter.source).toBe('path');
    expect(d.interpreter.command).toMatch(/^(python3?|py)$/);
  });
});
