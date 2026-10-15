import { chmod, mkdir, readFile, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunStepDefinition } from '../../src/config/schema.js';
import type { PipelineContext } from '../../src/core/context.js';
import { processIsAlive } from '../../src/core/process-tree.js';
import { BATCH_UNSAFE_ARGUMENT, createRunStep, prepareRunStep } from '../../src/core/run-step.js';
import { resolveOnPath, windowsCandidates } from '../../src/core/resolve-executable.js';
import { runStep } from '../../src/core/step-runner.js';
import { cleanupTrees, makeTree } from '../helpers/tree.js';

afterEach(cleanupTrees);

const windows = process.platform === 'win32';
const NODE_DIR = dirname(process.execPath);
/** PATH that contains only the directory of the running Node, so `node` always resolves. */
const prepare = { path: NODE_DIR };

const def = (run: string[], extra: Partial<RunStepDefinition> = {}): RunStepDefinition => ({ run, ...extra });

function context(cwd: string, timeoutMs?: number, signal?: AbortSignal): PipelineContext {
  return {
    cwd,
    runId: '20260101-000000-feedf00d',
    config: { version: 1, project: { type: 'test' }, pipeline: ['s'], settings: { failFast: false, ...(timeoutMs ? { timeoutMs } : {}) } },
    ...(signal ? { signal } : {}),
  };
}

describe('executable resolution', () => {
  it('finds a bare name on an absolute PATH entry', async () => {
    const found = await resolveOnPath('node', { path: NODE_DIR });
    expect(found).not.toBeNull();
    expect(found!.toLowerCase()).toContain('node');
  });

  it('ignores relative and empty PATH entries, so the current directory is never searched', async () => {
    const dir = await makeTree({ [windows ? 'tool.cmd' : 'tool']: '' });
    if (!windows) await chmod(join(dir, 'tool'), 0o755);
    const separator = windows ? ';' : ':';
    const relativeOnly = `${separator}.${separator}relative/dir`;
    const before = process.cwd();
    try {
      process.chdir(dir); // the tool now sits in the current directory
    } catch {
      return; // worker threads cannot chdir; nothing to assert
    }
    try {
      expect(await resolveOnPath('tool', { path: relativeOnly })).toBeNull();
      // Control: the same directory as an absolute PATH entry is found.
      expect(await resolveOnPath('tool', { path: dir })).not.toBeNull();
    } finally {
      process.chdir(before);
    }
  });

  it('returns null for a missing executable', async () => {
    expect(await resolveOnPath('definitely-not-installed-xyz', { path: NODE_DIR })).toBeNull();
  });

  it('on Windows tries PATHEXT but only for extensions that can run without a shell', () => {
    expect(windowsCandidates('npm', '.COM;.EXE;.BAT;.CMD;.JS;.VBS')).toEqual(['npm.com', 'npm.exe', 'npm.bat', 'npm.cmd']);
    expect(windowsCandidates('tool.cmd', '.EXE')).toEqual(['tool.cmd']);
    expect(windowsCandidates('tool.js', '.JS;.EXE')).toEqual(['tool.js.exe']);
  });
});

describe('prepareRunStep: containment and rejection', () => {
  it('rejects a missing bare executable with an actionable message', async () => {
    const dir = await makeTree({});
    const result = await prepareRunStep(def(['definitely-not-installed-xyz']), dir, prepare);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/not found on PATH/) });
  });

  it('resolves a bare name to an absolute path', async () => {
    const dir = await makeTree({});
    const result = await prepareRunStep(def(['node', '--version']), dir, prepare);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executable).toMatch(/node/i);
      expect(result.args).toEqual(['--version']);
    }
  });

  it('rejects a project-relative executable that does not exist', async () => {
    const dir = await makeTree({});
    const result = await prepareRunStep(def(['./tools/missing']), dir, prepare);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist inside the project/) });
  });

  it('rejects a cwd that is missing, a file, or outside the project', async () => {
    const dir = await makeTree({ 'file.txt': 'x' });
    for (const cwd of ['nope', 'file.txt']) {
      expect(await prepareRunStep(def(['node'], { cwd }), dir, prepare)).toMatchObject({ ok: false, reason: expect.stringMatching(/^cwd:/) });
    }
  });

  it('accepts an existing cwd inside the project', async () => {
    const dir = await makeTree({ 'sub/x.txt': 'x' });
    const result = await prepareRunStep(def(['node'], { cwd: 'sub' }), dir, prepare);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cwd.replace(/\\/g, '/')).toMatch(/\/sub$/);
  });

  it('rejects a symlinked/junctioned directory that leads outside the project', async () => {
    const outside = await makeTree({ [windows ? 'evil.cmd' : 'evil']: '', 'x.txt': 'x' });
    const project = await makeTree({});
    await mkdir(join(project, 'tools'), { recursive: true });
    const link = join(project, 'tools', 'out');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      return; // links cannot be created in this environment
    }
    try {
      const exe = await prepareRunStep(def(['tools/out/' + (windows ? 'evil.cmd' : 'evil')]), project, prepare);
      expect(exe).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the project/) });
      const cwd = await prepareRunStep(def(['node'], { cwd: 'tools/out' }), project, prepare);
      expect(cwd).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the repository/) });
    } finally {
      await rmdir(link).catch(() => unlink(link).catch(() => undefined));
    }
  });

  it('blocks PowerShell scripts everywhere and tells the user how to run them', async () => {
    const dir = await makeTree({ 'tools/x.ps1': '' });
    const result = await prepareRunStep(def(['tools/x.ps1']), dir, { ...prepare, platform: windows ? 'win32' : 'linux' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/pwsh, -File/) });
  });

  it.skipIf(windows)('blocks a non-executable file on POSIX', async () => {
    const dir = await makeTree({ 'tools/run.sh': '#!/bin/sh\nexit 0\n' });
    await chmod(join(dir, 'tools/run.sh'), 0o644);
    expect(await prepareRunStep(def(['tools/run.sh']), dir, prepare)).toMatchObject({ ok: false, reason: expect.stringMatching(/not executable/) });
    await chmod(join(dir, 'tools/run.sh'), 0o755);
    expect((await prepareRunStep(def(['tools/run.sh']), dir, prepare)).ok).toBe(true);
  });

  it('on Windows, a .sh file cannot be started directly and the message names the interpreter', async () => {
    const dir = await makeTree({ 'tools/run.sh': '' });
    const result = await prepareRunStep(def(['tools/run.sh']), dir, { ...prepare, platform: 'win32' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be started directly on Windows.*bash/) });
  });
});

describe('Windows batch files are a security gate (platform-independent rules)', () => {
  const unsafe = ['%PATH%', '!x', '^x', 'a&b', 'a|b', 'a<b', 'a>b', 'say "hi"', '(x)', 'line\nbreak', 'cr\rhere', '100%'];
  const safe = ['hello world', 'a=b', 'x,y', 'p;q', 'ünïcode', '--flag=value', '-v', 'path\\with\\back', 'C:\\Program Files\\x', "it's", '', '@at', '#hash', '$dollar', '*', '?', '~tilde'];

  it('BATCH_UNSAFE_ARGUMENT matches exactly the metacharacter set', () => {
    for (const arg of unsafe) expect(BATCH_UNSAFE_ARGUMENT.test(arg), JSON.stringify(arg)).toBe(true);
    for (const arg of safe) expect(BATCH_UNSAFE_ARGUMENT.test(arg), JSON.stringify(arg)).toBe(false);
  });

  for (const arg of unsafe) {
    it(`rejects ${JSON.stringify(arg)} for a .cmd target before anything runs`, async () => {
      const dir = await makeTree({ 'tools/t.cmd': '@echo off\r\n' });
      const result = await prepareRunStep(def(['tools/t.cmd', arg]), dir, { ...prepare, platform: 'win32' });
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/cmd\.exe interprets/) });
    });
  }

  it('applies to .bat as well, and allows safe arguments', async () => {
    const dir = await makeTree({ 'tools/t.bat': '@echo off\r\n' });
    const ok = await prepareRunStep(def(['tools/t.bat', ...safe]), dir, { ...prepare, platform: 'win32' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.batch).toBe(true);
    expect((await prepareRunStep(def(['tools/t.bat', '&calc']), dir, { ...prepare, platform: 'win32' })).ok).toBe(false);
  });

  it('does not apply to a .exe target, which receives arguments literally', async () => {
    const dir = await makeTree({ 'tools/t.exe': '' });
    const result = await prepareRunStep(def(['tools/t.exe', '&calc', '%PATH%']), dir, { ...prepare, platform: 'win32' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.batch).toBe(false);
  });

  it('rejects a batch file whose own path contains cmd metacharacters', async () => {
    const dir = await makeTree({ 'a&b/t.cmd': '' });
    const result = await prepareRunStep(def(['a&b/t.cmd']), dir, { ...prepare, platform: 'win32' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/path contains characters/) });
  });
});

describe('createRunStep: real execution', () => {
  it('passes, reports the command as written (not the absolute path) and captures output', async () => {
    const dir = await makeTree({});
    const step = createRunStep({ id: 's', name: 'S', definition: def(['node', '-e', "console.log('hello from run')"]), projectDir: dir, prepare });
    const result = await runStep(step, context(dir));
    expect(result.status).toBe('PASS');
    expect(result.stdout).toContain('hello from run');
    expect(result.command?.startsWith('node ')).toBe(true);
    expect(result.command).not.toContain(NODE_DIR);
  }, 30_000);

  it('fails with the exit code on a nonzero exit', async () => {
    const dir = await makeTree({});
    const step = createRunStep({ id: 's', definition: def(['node', '-e', 'process.exit(7)']), projectDir: dir, prepare });
    const result = await runStep(step, context(dir));
    expect(result).toMatchObject({ status: 'FAIL', exitCode: 7 });
  }, 30_000);

  it('runs in the configured cwd', async () => {
    const dir = await makeTree({ 'sub/marker.txt': 'x' });
    const step = createRunStep({
      id: 's',
      definition: def(['node', '-e', "console.log(require('fs').existsSync('marker.txt'))"], { cwd: 'sub' }),
      projectDir: dir,
      prepare,
    });
    expect((await runStep(step, context(dir))).stdout).toContain('true');
  }, 30_000);

  it('reports BLOCKED, never PASS, when the executable cannot be resolved', async () => {
    const dir = await makeTree({});
    const step = createRunStep({ id: 's', definition: def(['definitely-not-installed-xyz']), projectDir: dir, prepare });
    const result = await runStep(step, context(dir));
    expect(result.status).toBe('BLOCKED');
    expect(result.error).toMatch(/not found on PATH/);
  }, 30_000);

  it('passes arguments literally: no expansion, no splitting, no shell interpretation', async () => {
    const dir = await makeTree({});
    const hostile = ['$HOME', '%PATH%', '`id`', '$(id)', 'a;b', 'a && b', '*', 'with space', '"quoted"', '~'];
    const step = createRunStep({
      id: 's',
      definition: def(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...hostile]),
      projectDir: dir,
      prepare,
    });
    const result = await runStep(step, context(dir));
    expect(result.status).toBe('PASS');
    expect(JSON.parse(result.stdout.trim())).toEqual(hostile);
  }, 30_000);

  it('times out, reports TIMEOUT, and kills the whole process tree', async () => {
    const dir = await makeTree({});
    const pidFile = join(dir, 'grandchild.pid');
    const code =
      "const {spawn}=require('child_process');" +
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));` +
      'setTimeout(()=>{},60000)';
    const step = createRunStep({ id: 's', definition: def(['node', '-e', code], { timeoutMs: 4000 }), projectDir: dir, prepare });
    const result = await runStep(step, context(dir, 60_000));

    expect(result).toMatchObject({ status: 'FAIL', timedOut: true });
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(processIsAlive(pid)).toBe(false);
  }, 60_000);

  it('cancellation stops the step and reports CANCELLED', async () => {
    const dir = await makeTree({});
    const controller = new AbortController();
    const step = createRunStep({ id: 's', definition: def(['node', '-e', 'setTimeout(()=>{},60000)']), projectDir: dir, prepare });
    const pending = runStep(step, context(dir, 60_000, controller.signal));
    setTimeout(() => controller.abort(), 1500);
    const result = await pending;
    expect(result.status).toBe('CANCELLED');
  }, 60_000);

  it('masks environment secrets in captured output and credential-looking arguments in the command label', async () => {
    const dir = await makeTree({});
    process.env['MY_API_TOKEN'] = 'super-secret-value-12345';
    try {
      const step = createRunStep({
        id: 's',
        definition: def(['node', '-e', "console.log('token is ' + process.env.MY_API_TOKEN)", '--password=hunter2-secret']),
        projectDir: dir,
        prepare,
      });
      const result = await runStep(step, context(dir));
      expect(result.stdout).not.toContain('super-secret-value-12345');
      expect(result.command).not.toContain('hunter2-secret');
    } finally {
      delete process.env['MY_API_TOKEN'];
    }
  }, 30_000);
});

describe.skipIf(!windows)('Windows batch files: real cmd.exe behaviour', () => {
  const DUMP = "require('fs').writeFileSync(require('path').join(__dirname,'out.json'),JSON.stringify(process.argv.slice(2)))";

  async function batchProject(): Promise<string> {
    return makeTree({
      'tools/dump.js': DUMP,
      'tools/dump.cmd': '@echo off\r\nnode "%~dp0dump.js" %*\r\n',
      'tools/canary.cmd': '@echo off\r\nnode "%~dp0dump.js" %*\r\n',
    });
  }

  const BENIGN = [
    ['hello world'],
    ['a=b'],
    ['x,y'],
    ['p;q'],
    ['ünïcode'],
    ['--flag=value', '-v'],
    ['C:\\Program Files\\x'],
    ["it's"],
    ['$dollar', '#hash', '@at', '~tilde'],
  ];

  for (const args of BENIGN) {
    it(`delivers ${JSON.stringify(args)} to a .cmd literally`, async () => {
      const dir = await batchProject();
      const step = createRunStep({ id: 's', definition: def(['tools/dump.cmd', ...args]), projectDir: dir, prepare });
      const result = await runStep(step, context(dir));
      expect(result.status, result.error).toBe('PASS');
      expect(JSON.parse(await readFile(join(dir, 'tools', 'out.json'), 'utf8'))).toEqual(args);
    }, 30_000);
  }

  const INJECTIONS = ['&echo PWNED>canary.txt', '| echo PWNED>canary.txt', '"&echo PWNED>canary.txt', '%COMSPEC%', '^&echo', '!PATH!', 'x"&calc'];
  for (const arg of INJECTIONS) {
    it(`never runs ${JSON.stringify(arg)}: blocked before spawn, no side effect`, async () => {
      const dir = await batchProject();
      const step = createRunStep({ id: 's', definition: def(['tools/dump.cmd', arg]), projectDir: dir, prepare });
      const result = await runStep(step, context(dir));
      expect(result.status).toBe('BLOCKED');
      await expect(readFile(join(dir, 'canary.txt'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(dir, 'tools', 'canary.txt'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(dir, 'tools', 'out.json'), 'utf8')).rejects.toThrow();
    }, 30_000);
  }

  it('delivers metacharacters literally to a .exe target (no gate needed)', async () => {
    const dir = await makeTree({});
    const hostile = ['&echo PWNED>canary.txt', '| x', '%PATH%', '!PATH!', '^', '"q"', '(x)'];
    const step = createRunStep({
      id: 's',
      definition: def(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...hostile]),
      projectDir: dir,
      prepare,
    });
    const result = await runStep(step, context(dir));
    expect(result.status, result.error).toBe('PASS');
    expect(JSON.parse(result.stdout.trim())).toEqual(hostile);
    await expect(readFile(join(dir, 'canary.txt'), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('runs a batch file from a directory with spaces and parentheses', async () => {
    const dir = await makeTree({
      'my tools (x86)/dump.js': DUMP,
      'my tools (x86)/dump.cmd': '@echo off\r\nnode "%~dp0dump.js" %*\r\n',
    });
    const step = createRunStep({ id: 's', definition: def(['my tools (x86)/dump.cmd', 'ok']), projectDir: dir, prepare });
    const result = await runStep(step, context(dir));
    expect(result.status, result.error).toBe('PASS');
    expect(JSON.parse(await readFile(join(dir, 'my tools (x86)', 'out.json'), 'utf8'))).toEqual(['ok']);
  }, 30_000);

  it('resolves npm (a .cmd shim) from PATH and runs it', async () => {
    const dir = await makeTree({});
    const step = createRunStep({ id: 's', definition: def(['npm', '--version']), projectDir: dir });
    const result = await runStep(step, context(dir));
    expect(result.status, result.error).toBe('PASS');
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);
});

