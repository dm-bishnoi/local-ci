import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunId } from '../../src/reporters/paths.js';
import { newestRunIds } from './reports.js';

describe('newestRunIds', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'local-ci-runids-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Creates a run directory whose modification time is exactly `seconds` after an arbitrary origin. */
  const makeRun = async (id: string, seconds: number): Promise<void> => {
    await mkdir(join(base, id));
    const when = new Date(1_700_000_000_000 + seconds * 1000);
    await utimes(join(base, id), when, when);
  };

  it('picks the run that was written last when two runs share a second and the older id sorts higher', async () => {
    // Same HHMMSS, so the order of the ids is decided by the random suffix alone.
    await makeRun('20261014-103234-ffffffff', 1); // older run, larger suffix
    await makeRun('20261014-103234-00000000', 2); // newer run, smaller suffix

    // The bug being guarded against: sorting by name picks the older run here.
    expect((await readdir(base)).sort().reverse()[0]).toBe('20261014-103234-ffffffff');
    expect(await newestRunIds(base)).toEqual(['20261014-103234-00000000', '20261014-103234-ffffffff']);
  });

  it('gives the same answer whichever suffix is larger', async () => {
    await makeRun('20261014-103234-00000000', 1);
    await makeRun('20261014-103234-ffffffff', 2);
    expect((await newestRunIds(base))[0]).toBe('20261014-103234-ffffffff');
  });

  it('orders ids produced by createRunId within one second by when they were written', async () => {
    const now = new Date(2026, 9, 14, 10, 32, 34, 100);
    for (let i = 0; i < 20; i++) {
      const first = createRunId(now);
      const second = createRunId(new Date(now.getTime() + 400));
      await makeRun(first, 2 * i);
      await makeRun(second, 2 * i + 1);
      expect((await newestRunIds(base))[0]).toBe(second);
      await rm(join(base, first), { recursive: true });
      await rm(join(base, second), { recursive: true });
    }
  });

  it('orders runs from different seconds the same way a name sort does', async () => {
    await makeRun('20261014-103233-aaaaaaaa', 1);
    await makeRun('20261014-103234-bbbbbbbb', 2);
    await makeRun('20261014-103235-cccccccc', 3);
    expect(await newestRunIds(base)).toEqual(['20261014-103235-cccccccc', '20261014-103234-bbbbbbbb', '20261014-103233-aaaaaaaa']);
  });

  it('returns an empty list for an empty directory', async () => {
    expect(await newestRunIds(base)).toEqual([]);
  });
});
