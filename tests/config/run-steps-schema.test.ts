import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRunStep, localCiConfigSchema } from '../../src/config/schema.js';

function parse(steps: unknown) {
  return localCiConfigSchema.safeParse({ version: 1, project: { type: 'node' }, pipeline: ['check'], steps: { check: steps } });
}

describe('steps.<id>.run', () => {
  it('accepts a bare executable with arguments, an optional cwd and a timeout', () => {
    const result = parse({ run: ['node', '-e', "console.log('hi')", '--flag=value'], cwd: 'tools', timeoutMs: 5000 });
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data.steps!['check']!;
      expect(isRunStep(step)).toBe(true);
      if (isRunStep(step)) expect(step.run[0]).toBe('node');
    }
  });

  it('accepts project-relative executable paths, with either slash', () => {
    for (const exe of ['./tools/check', 'tools/check.cmd', 'tools\\check.bat', 'scripts/lint.sh']) {
      expect(parse({ run: [exe] }).success, exe).toBe(true);
    }
  });

  it('script steps keep working and are told apart from run steps', () => {
    const result = parse({ script: 'lint' });
    expect(result.success).toBe(true);
    if (result.success) expect(isRunStep(result.data.steps!['check']!)).toBe(false);
  });

  const rejected: Array<[string, unknown]> = [
    ['an empty argv', { run: [] }],
    ['an empty executable', { run: [''] }],
    ['an absolute posix path', { run: ['/usr/bin/env'] }],
    ['a drive-letter path', { run: ['C:\\Windows\\system32\\cmd.exe'] }],
    ['a UNC path', { run: ['\\\\server\\share\\x.exe'] }],
    ['a parent segment', { run: ['../outside/tool'] }],
    ['a nested parent segment', { run: ['tools/../../tool'] }],
    ['a backslash parent segment', { run: ['tools\\..\\..\\tool'] }],
    ['a shell command string with spaces', { run: ['npm run build'] }],
    ['a shell operator in the executable', { run: ['a;b'] }],
    ['a leading dash executable', { run: ['-rf'] }],
    ['a newline in the executable', { run: ['tool\nrm'] }],
    ['NUL in an argument', { run: ['node', 'a\u0000b'] }],
    ['an over-long argument', { run: ['node', 'x'.repeat(5000)] }],
    ['too many arguments', { run: ['node', ...Array.from({ length: 70 }, () => 'a')] }],
    ['a non-string argument', { run: ['node', 5] }],
    ['an escaping cwd', { run: ['node'], cwd: '../x' }],
    ['an absolute cwd', { run: ['node'], cwd: '/tmp' }],
    ['both script and run', { script: 'lint', run: ['node'] }],
    ['an env key (environment cannot be set from configuration)', { run: ['node'], env: { A: 'b' } }],
    ['a shell key', { run: ['node'], shell: true }],
    ['a command string key', { command: 'npm test' }],
    ['a zero timeout', { run: ['node'], timeoutMs: 0 }],
  ];
  for (const [name, steps] of rejected) {
    it(`rejects ${name}`, () => {
      expect(parse(steps).success).toBe(false);
    });
  }

  it('gives an actionable message for a command string', () => {
    const result = parse({ run: ['npm run build'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toMatch(/bare executable name/);
  });

  it('works inside a projects entry and is qualified', () => {
    const result = localCiConfigSchema.safeParse({
      version: 1,
      projects: [{ name: 'a', type: 'node', pipeline: ['check'], steps: { check: { run: ['node', '-v'] } } }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.keys(result.data.steps ?? {})).toEqual(['a.check']);
  });
});

describe('no shell for user-provided commands', () => {
  async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sources(full)));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('`shell: true` appears only in the tool probe, which only ever receives constant names and arguments', async () => {
    const offenders: string[] = [];
    for (const file of await sources(join(process.cwd(), 'src'))) {
      const text = await readFile(file, 'utf8');
      // Comments may mention it; code may not.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/shell\s*:\s*true/.test(code)) offenders.push(file.replace(process.cwd(), '').replace(/\\/g, '/'));
    }
    expect(offenders).toEqual(['/src/env/tools.ts']);
  });

  it('the process runner never enables a shell', async () => {
    const text = await readFile(join(process.cwd(), 'src', 'core', 'process-runner.ts'), 'utf8');
    expect(text).toMatch(/shell:\s*false/);
    expect(text).not.toMatch(/shell:\s*true/);
  });
});
