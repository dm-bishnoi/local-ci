import { describe, expect, it } from 'vitest';
import { probeToolState, toolWorks } from './helpers.js';

// `node` is the one tool every environment running these tests is known to have.
describe('probeToolState', () => {
  it('is "works" for a command that exits 0', async () => {
    expect(await probeToolState('node', ['--version'])).toBe('works');
    expect(await toolWorks('node')).toBe(true);
  });

  it('is "failed" for a command that exits non-zero, and for one that does not exist', async () => {
    expect(await probeToolState('node', ['-e', 'process.exit(3)'])).toBe('failed');
    expect(await probeToolState('local-ci-no-such-tool-xyz')).toBe('failed');
  });

  it('is "timed-out", not "failed", for a command that is merely slow', async () => {
    expect(await probeToolState('node', ['-e', 'setTimeout(()=>{},10000)'], 300)).toBe('timed-out');
  });
});
