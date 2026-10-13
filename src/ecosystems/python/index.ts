import { join } from 'node:path';
import { resolveOnPath } from '../../core/resolve-executable.js';
import { listDir, pathExists, readText } from '../fs.js';
import type { AvailableCapability, Capability, DefaultPipeline, Detection, EcosystemAdapter, Requirement } from '../types.js';

/**
 * Python projects: pytest, Ruff and mypy, run through the project's own
 * interpreter.
 *
 * A manifest proves "this is a Python project"; it does not prove pytest, Ruff
 * or mypy are in use or installed. Each check therefore needs *evidence* (a
 * configuration section, a config file or a declared dependency) before it
 * exists at all, and a probe at preflight (`python -m pytest --version`) before
 * it may run. Dependencies are never installed unless the pipeline lists an
 * `install` step, and that step refuses to touch a global interpreter.
 */

export interface PythonInterpreter {
  command: string;
  prefixArgs: string[];
  source: 'venv' | 'path';
  /** Name for messages: ".venv", "python3", "py -3". */
  display: string;
}

export interface PythonDetection extends Detection {
  ecosystem: 'python';
  interpreter: PythonInterpreter;
  venv: string | null;
  tooling: { pytest: string | null; ruff: string | null; mypy: string | null };
  requiresPython: string | null;
}

const STEP_IDS = ['install', 'test', 'lint', 'format', 'typecheck'] as const;
const INIT_ORDER = ['test', 'lint', 'format', 'typecheck'] as const;
const STEP_NAMES: Record<string, string> = {
  install: 'Dependencies',
  test: 'Unit Tests',
  lint: 'Lint',
  format: 'Format',
  typecheck: 'Type Check',
};

const PYTHON_ENV = { PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } as const;
const NOT_PACKAGES = new Set(['tests', 'test', 'docs', 'doc', 'venv', 'env', 'build', 'dist', 'node_modules', 'scripts', 'examples', 'example', 'benchmarks']);

function hasHeader(text: string | null, header: string): boolean {
  return text !== null && new RegExp(`^\\s*\\[${header.replace(/[.[\]]/g, '\\$&')}`, 'm').test(text);
}

function mentionsPackage(text: string | null, name: string): boolean {
  if (text === null) return false;
  return new RegExp(`(^|["'\\s,\\[])${name}(\\[[^\\]]*\\])?(?=$|[\\s"'<>=!~;,\\]])`, 'im').test(text);
}

async function findVenv(dir: string): Promise<string | null> {
  const windows = process.platform === 'win32';
  for (const name of ['.venv', 'venv']) {
    const python = windows ? join(dir, name, 'Scripts', 'python.exe') : join(dir, name, 'bin', 'python');
    if (await pathExists(python)) return name;
  }
  return null;
}

async function findInterpreter(dir: string, venv: string | null): Promise<PythonInterpreter> {
  const windows = process.platform === 'win32';
  if (venv !== null) {
    const command = windows ? join(dir, venv, 'Scripts', 'python.exe') : join(dir, venv, 'bin', 'python');
    return { command, prefixArgs: [], source: 'venv', display: venv };
  }
  const order = windows ? ['python', 'py'] : ['python3', 'python'];
  for (const name of order) {
    if ((await resolveOnPath(name)) !== null) {
      return name === 'py'
        ? { command: 'py', prefixArgs: ['-3'], source: 'path', display: 'py -3' }
        : { command: name, prefixArgs: [], source: 'path', display: name };
    }
  }
  // Nothing found: name the conventional interpreter so preflight reports it missing.
  const fallback = windows ? 'python' : 'python3';
  return { command: fallback, prefixArgs: [], source: 'path', display: fallback };
}

async function packageTarget(dir: string): Promise<string | null> {
  const candidates: string[] = [];
  const check = async (parent: string, relativePrefix: string): Promise<void> => {
    for (const name of (await listDir(parent)).sort()) {
      if (name.startsWith('.') || NOT_PACKAGES.has(name)) continue;
      if (await pathExists(join(parent, name, '__init__.py'))) candidates.push(`${relativePrefix}${name}`);
    }
  };
  await check(dir, '');
  if (await pathExists(join(dir, 'src'))) await check(join(dir, 'src'), 'src/');
  return candidates.length === 1 ? candidates[0]! : null;
}

function parseRequiresPython(pyproject: string | null): { atLeast: string | null; raw: string | null } {
  const raw = pyproject === null ? null : (/^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? null);
  if (raw === null) return { atLeast: null, raw };
  const lower = /(?:^|,)\s*>=\s*(\d+\.\d+(?:\.\d+)?)/.exec(raw.replace(/\s+/g, ''))?.[1] ?? null;
  return { atLeast: lower, raw };
}

function module(i: PythonInterpreter, name: string, display: string, version = '--version'): Requirement[] {
  return [
    { kind: 'tool', name: i.command, probeArgs: [...i.prefixArgs, '--version'], env: { ...PYTHON_ENV } },
    { kind: 'tool', name: i.command, probeArgs: [...i.prefixArgs, '-m', name, version], display, env: { ...PYTHON_ENV } },
  ];
}

async function detect(dir: string): Promise<PythonDetection> {
  const entries = new Set(await listDir(dir));
  const pyproject = await readText(join(dir, 'pyproject.toml'));
  const setupCfg = await readText(join(dir, 'setup.cfg'));
  const toxIni = await readText(join(dir, 'tox.ini'));
  const requirementsFiles = [...entries].filter((name) => /^requirements.*\.txt$/i.test(name)).sort();
  const requirementsText = (await Promise.all(requirementsFiles.map((name) => readText(join(dir, name))))).filter((t): t is string => t !== null).join('\n');
  // Comments are not declarations: "# we should use pytest" does not make pytest a dependency.
  const withoutComments = (text: string): string => text.replace(/(^|\s)#.*$/gm, '$1');
  const declared = withoutComments(`${pyproject ?? ''}\n${requirementsText}\n${setupCfg ?? ''}`);

  const strong: string[] = [];
  if (hasHeader(pyproject, 'project') || hasHeader(pyproject, 'tool.poetry') || hasHeader(pyproject, 'build-system')) strong.push('pyproject.toml');
  if (entries.has('setup.py')) strong.push('setup.py');
  strong.push(...requirementsFiles);
  if (hasHeader(setupCfg, 'metadata') || hasHeader(setupCfg, 'options')) strong.push('setup.cfg');

  const weak: string[] = [];
  if (pyproject !== null && !strong.includes('pyproject.toml')) weak.push('pyproject.toml (tool configuration only)');
  if (setupCfg !== null && !strong.includes('setup.cfg')) weak.push('setup.cfg (no [metadata] or [options])');
  if (toxIni !== null) weak.push('tox.ini');
  if (entries.has('pytest.ini')) weak.push('pytest.ini');

  const venv = await findVenv(dir);
  const interpreter = await findInterpreter(dir, venv);

  const base = {
    ecosystem: 'python' as const,
    root: dir,
    capabilities: {} as Record<string, Capability>,
    interpreter,
    venv,
    tooling: { pytest: null as string | null, ruff: null as string | null, mypy: null as string | null },
    requiresPython: null as string | null,
  };

  if (strong.length === 0 && weak.length === 0) {
    return {
      ...base,
      detected: false,
      confidence: 'strong',
      evidence: [],
      reason: `No Python project files (pyproject.toml, setup.py, setup.cfg, requirements*.txt) found in ${dir}.`,
    };
  }

  const confidence = strong.length > 0 ? 'strong' : 'weak';
  const evidence = strong.length > 0 ? strong : weak;
  const detection: PythonDetection = { ...base, detected: true, confidence, evidence: [...evidence] };
  if (venv) detection.evidence.push(`${venv}/`);

  // Tool evidence: configuration, a config file, or a declared dependency.
  const tooling = detection.tooling;
  tooling.pytest = entries.has('pytest.ini')
    ? 'pytest.ini'
    : hasHeader(pyproject, 'tool.pytest.ini_options')
      ? 'pyproject.toml [tool.pytest.ini_options]'
      : hasHeader(setupCfg, 'tool:pytest')
        ? 'setup.cfg [tool:pytest]'
        : hasHeader(toxIni, 'pytest')
          ? 'tox.ini [pytest]'
          : entries.has('conftest.py')
            ? 'conftest.py'
            : mentionsPackage(declared, 'pytest')
              ? 'declared dependency'
              : null;
  tooling.ruff = entries.has('ruff.toml')
    ? 'ruff.toml'
    : entries.has('.ruff.toml')
      ? '.ruff.toml'
      : hasHeader(pyproject, 'tool.ruff')
        ? 'pyproject.toml [tool.ruff]'
        : mentionsPackage(declared, 'ruff')
          ? 'declared dependency'
          : null;
  tooling.mypy = entries.has('mypy.ini')
    ? 'mypy.ini'
    : entries.has('.mypy.ini')
      ? '.mypy.ini'
      : hasHeader(pyproject, 'tool.mypy')
        ? 'pyproject.toml [tool.mypy]'
        : hasHeader(setupCfg, 'mypy')
          ? 'setup.cfg [mypy]'
          : mentionsPackage(declared, 'mypy')
            ? 'declared dependency'
            : null;

  const requires = parseRequiresPython(pyproject);
  detection.requiresPython = requires.raw;
  const warnings: string[] = [];
  if (requires.raw !== null && requires.atLeast === null) {
    warnings.push(`requires-python "${requires.raw}" has no ">=" lower bound this version can check, so the interpreter version is not verified.`);
  }
  if (weak.length > 0 && strong.length > 0) {
    // Weak signals next to strong ones are ordinary (tox.ini beside pyproject), not worth a note.
  }
  if (warnings.length > 0) detection.warnings = warnings;

  const withVersion = (requirements: Requirement[]): Requirement[] =>
    requires.atLeast
      ? [
          ...requirements,
          { kind: 'version', tool: interpreter.command, atLeast: requires.atLeast, source: 'requires-python', probeArgs: [...interpreter.prefixArgs, '--version'] },
        ]
      : requirements;

  const run = (args: string[], evidenceText: string, requires2: Requirement[]): AvailableCapability => ({
    state: 'available',
    source: 'inferred',
    command: interpreter.command,
    args: [...interpreter.prefixArgs, ...args],
    description: `${interpreter.display} ${args.join(' ')}`,
    env: { ...PYTHON_ENV },
    evidence: evidenceText,
    requires: withVersion(requires2),
  });

  const capabilities: Record<string, Capability> = {};

  capabilities['test'] = tooling.pytest
    ? run(['-m', 'pytest'], `pytest: ${tooling.pytest}`, module(interpreter, 'pytest', `pytest (${interpreter.display} -m pytest)`))
    : { state: 'unavailable', reason: 'pytest is not configured: no pytest.ini, [tool.pytest.ini_options], conftest.py or declared pytest dependency.' };

  capabilities['lint'] = tooling.ruff
    ? run(['-m', 'ruff', 'check', '.'], `ruff: ${tooling.ruff}`, module(interpreter, 'ruff', `ruff (${interpreter.display} -m ruff)`))
    : { state: 'unavailable', reason: 'Ruff is not configured: no ruff.toml, [tool.ruff] or declared ruff dependency.' };

  capabilities['format'] = tooling.ruff
    ? run(['-m', 'ruff', 'format', '--check', '.'], `ruff: ${tooling.ruff}`, module(interpreter, 'ruff', `ruff (${interpreter.display} -m ruff)`))
    : { state: 'unavailable', reason: 'Ruff is not configured: no ruff.toml, [tool.ruff] or declared ruff dependency.' };

  if (!tooling.mypy) {
    capabilities['typecheck'] = { state: 'unavailable', reason: 'mypy is not configured: no mypy.ini, [tool.mypy], [mypy] section or declared mypy dependency.' };
  } else {
    const configText = `${pyproject ?? ''}\n${setupCfg ?? ''}\n${(await readText(join(dir, 'mypy.ini'))) ?? ''}\n${(await readText(join(dir, '.mypy.ini'))) ?? ''}`;
    const hasFiles = /^\s*files\s*=/m.test(configText);
    const target = hasFiles ? null : await packageTarget(dir);
    capabilities['typecheck'] =
      hasFiles || target !== null
        ? run(['-m', 'mypy', ...(target ? [target] : [])], `mypy: ${tooling.mypy}${target ? `, target ${target}` : ', files from its configuration'}`, module(interpreter, 'mypy', `mypy (${interpreter.display} -m mypy)`))
        : {
            state: 'unavailable',
            reason:
              'mypy is configured, but there is no single package to check: set "files" in the mypy configuration, ' +
              'or define the command with run: [python, -m, mypy, <path>].',
          };
  }

  // `install` exists only for a project that already has an environment to install into.
  const hasRequirements = entries.has('requirements.txt');
  if (venv !== null && hasRequirements) {
    capabilities['install'] = {
      state: 'available',
      source: 'builtin',
      command: interpreter.command,
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      description: `${venv} pip install -r requirements.txt`,
      env: { ...PYTHON_ENV },
      evidence: `${venv}/ and requirements.txt`,
      requires: [{ kind: 'tool', name: interpreter.command, probeArgs: ['--version'], env: { ...PYTHON_ENV } }],
    };
  } else if (entries.has('uv.lock') && (await resolveOnPath('uv')) !== null) {
    capabilities['install'] = {
      state: 'available',
      source: 'builtin',
      command: 'uv',
      args: ['sync', '--locked'],
      description: 'uv sync --locked',
      evidence: 'uv.lock',
      requires: [{ kind: 'tool', name: 'uv' }],
    };
  } else if (entries.has('poetry.lock') && (await resolveOnPath('poetry')) !== null) {
    capabilities['install'] = {
      state: 'available',
      source: 'builtin',
      command: 'poetry',
      args: ['install', '--no-interaction', '--sync'],
      description: 'poetry install --no-interaction --sync',
      evidence: 'poetry.lock',
      requires: [{ kind: 'tool', name: 'poetry' }],
    };
  } else {
    capabilities['install'] = {
      state: 'unavailable',
      reason:
        'There is no virtual environment (.venv or venv) with a requirements.txt, uv.lock with uv, or poetry.lock with poetry to install from. ' +
        'Installing into a global interpreter is never done automatically.',
    };
  }

  detection.installStepIds = ['install'];
  detection.capabilities = capabilities;
  return detection;
}

function defaultPipeline(detection: Detection): DefaultPipeline {
  const pipeline: string[] = [];
  const omitted: Array<{ id: string; reason: string }> = [];
  const install = detection.capabilities['install'];
  omitted.push({
    id: 'install',
    reason:
      install?.state === 'available'
        ? 'Dependencies are never installed unless you ask. Add "install" to install into the existing environment.'
        : (install?.state === 'unavailable' ? install.reason : 'Dependencies are never installed unless you ask.'),
  });
  for (const id of INIT_ORDER) {
    const capability = detection.capabilities[id];
    if (capability === undefined) continue;
    if (capability.state === 'available') pipeline.push(id);
    else omitted.push({ id, reason: capability.reason });
  }
  return { pipeline, omitted };
}

export const pythonAdapter: EcosystemAdapter = {
  id: 'python',
  profiles: ['python', 'py'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: () => 'python',
  defaultPipeline,
};
