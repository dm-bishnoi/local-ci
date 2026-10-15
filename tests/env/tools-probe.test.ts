import { afterEach, describe, expect, it } from 'vitest';
import { probeTool } from '../../src/env/tools.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees } from '../helpers/tree.js';

afterEach(cleanupTrees);

describe('probeTool: missing, broken and present are different answers', () => {
  it('an executable that does not exist is missing (not "unverified"), on every platform', async () => {
    const result = await probeTool('definitely-not-installed-xyz');
    expect(result.outcome).toBe('missing');
    expect(result.detail).toMatch(/not found on PATH/);
  });

  it('reads a version printed to stderr on success (java -version)', async () => {
    const shims = await installShims({ fakejava: "console.error('openjdk version \"17.0.12\" 2024-07-16'); process.exit(0)" });
    await withPath([shims], async () => {
      expect(await probeTool('fakejava', ['-version'])).toMatchObject({ outcome: 'ok', version: '17.0.12' });
    });
  });

  it('a full path (which may contain spaces) is run directly, never through a shell', async () => {
    const result = await probeTool(process.execPath, ['--version']);
    expect(result).toMatchObject({ outcome: 'ok' });
    expect(result.version).toMatch(/^\d+\.\d+/);
  });

  describe('requireZeroExit: a failed module or subcommand probe is never mined for a version', () => {
    // The real failure this guards against: `python -m pytest --version` prints
    // "<install path>\\python.exe: No module named pytest" and the install path
    // (Python3.14-64) contains something that looks like a version.
    const shims = () =>
      installShims({
        fakepy: "console.error('C:\\\\Python3.14-64\\\\python.exe: No module named pytest'); process.exit(1)",
      });

    it('without it the legacy tolerance reads that error text as a version', async () => {
      await withPath([await shims()], async () => {
        expect(await probeTool('fakepy', ['-m', 'pytest', '--version'])).toMatchObject({ outcome: 'ok', version: '3.14-64' });
      });
    });

    it('with it the same failure is reported as missing, with the tool message', async () => {
      await withPath([await shims()], async () => {
        const result = await probeTool('fakepy', ['-m', 'pytest', '--version'], { requireZeroExit: true });
        expect(result.outcome).toBe('missing');
        expect(result.detail).toMatch(/No module named pytest/);
        expect(result.version).toBeUndefined();
      });
    });

    it('a probe that exits 0 still passes', async () => {
      const ok = await installShims({ fakepy: "console.log('pytest 8.2.0'); process.exit(0)" });
      await withPath([ok], async () => {
        expect(await probeTool('fakepy', ['-m', 'pytest', '--version'], { requireZeroExit: true })).toMatchObject({
          outcome: 'ok',
          version: '8.2.0',
        });
      });
    });
  });

  it('a probe that is too slow is "could not be checked", never "missing" and never "present"', async () => {
    const shims = await installShims({ slowtool: "setTimeout(() => { console.log('1.0.0'); }, 20000)" });
    await withPath([shims], async () => {
      const result = await probeTool('slowtool', ['--version'], { timeoutMs: 600 });
      expect(result.outcome).toBe('blocked');
      expect(result.detail).toMatch(/did not answer within 1s, so it could not be checked/);
      expect(result.version).toBeUndefined();

      // The same slow answer is accepted when the limit allows it.
      const patient = await installShims({ slowtool: "setTimeout(() => { console.log('2.0.0'); }, 300)" });
      await withPath([patient], async () => {
        expect(await probeTool('slowtool', ['--version'], { timeoutMs: 15000 })).toMatchObject({ outcome: 'ok', version: '2.0.0' });
      });
    });
  }, 60_000);

  it('passes constant environment to the probe', async () => {
    const shims = await installShims({ envtool: "console.log(process.env.PROBE_FLAG === 'on' ? '1.0.0' : 'wrong')" });
    await withPath([shims], async () => {
      expect(await probeTool('envtool', ['--version'], { env: { PROBE_FLAG: 'on' } })).toMatchObject({ outcome: 'ok', version: '1.0.0' });
    });
  });
});
