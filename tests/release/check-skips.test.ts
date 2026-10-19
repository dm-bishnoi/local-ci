import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'check-skips.mjs');

async function check(tests: Array<{ fullName: string; status: string }>) {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-skips-'));
  try {
    const report = join(dir, 'report.json');
    await writeFile(report, JSON.stringify({ testResults: [{ name: 'tests/real/x.test.ts', assertionResults: tests }] }), 'utf8');
    return spawnSync(process.execPath, [script, report], { encoding: 'utf8' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('scripts/check-skips.mjs', () => {
  it('passes when nothing is skipped', async () => {
    expect((await check([{ fullName: 'real go > builds', status: 'passed' }])).status).toBe(0);
  });

  it('accepts the three "tool is absent" skips and lists them', async () => {
    const result = await check([
      { fullName: 'a dotnet that exists but cannot run is BLOCKED, never run and never passed', status: 'skipped' },
      { fullName: 'real java (JDK) > a Maven project without mvn or a wrapper is BLOCKED naming mvn', status: 'skipped' },
      { fullName: 'real java (JDK) > a Gradle project without gradle or a wrapper is BLOCKED naming gradle', status: 'skipped' },
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Expected skips');
  });

  it('fails, naming the test, on any other skip', async () => {
    const result = await check([{ fullName: 'real gradle build > compile, test, verify and build all pass', status: 'skipped' }]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNEXPECTED SKIP** real gradle build');
  });
});
