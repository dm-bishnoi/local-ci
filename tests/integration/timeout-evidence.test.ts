/**
 * F-2 / F-8 regression, end to end with real child processes.
 *
 * A timed-out step must keep the command it ran and the output it printed
 * before the timeout — in the step result, in report.json and in its log — and
 * the next step must not start until the timed-out process tree is gone.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipelineContext } from '../../src/core/context.js';
import { PipelineRunner } from '../../src/core/pipeline-runner.js';
import { createProcessStep } from '../../src/core/process-step.js';
import { processIsAlive } from '../../src/core/process-tree.js';
import { StepRegistry, runStep } from '../../src/core/step-runner.js';
import { writeRunReports } from '../../src/reporters/artifact.js';
import { buildRunMetadata } from '../../src/reporters/metadata.js';
import { buildRunReport } from '../../src/reporters/report-model.js';

const HANGS_AFTER_PRINTING =
  "console.log('MARKER-STDOUT'); console.error('MARKER-STDERR'); setTimeout(() => {}, 60000)";

function context(cwd: string, pipeline: string[], timeoutMs: number): PipelineContext {
  return {
    cwd,
    runId: '20260101-000000-feedf00d',
    config: { version: 1, project: { type: 'test' }, pipeline, settings: { failFast: false, timeoutMs } },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('timed-out process steps keep their evidence', () => {
  it('reports command and pre-timeout output on the step result', async () => {
    const step = createProcessStep({ id: 'hang', name: 'Hang', command: process.execPath, args: ['-e', HANGS_AFTER_PRINTING] });
    const result = await runStep(step, context(process.cwd(), ['hang'], 1_500));

    expect(result.status).toBe('FAIL');
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe('Step timed out after 1500ms');
    expect(result.command).toContain('-e');
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('MARKER-STDOUT');
    expect(result.stderr).toContain('MARKER-STDERR');
  }, 30_000);

  it('writes that evidence to report.json and the step log', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'local-ci-timeout-'));
    dirs.push(cwd);

    const registry = new StepRegistry().register(
      createProcessStep({ id: 'hang', name: 'Hang', command: process.execPath, args: ['-e', HANGS_AFTER_PRINTING] }),
    );
    const run = await new PipelineRunner(registry).run(context(cwd, ['hang'], 1_500));
    const built = buildRunReport({
      result: run,
      metadata: buildRunMetadata({ projectName: 'fx', projectType: 'test', framework: null, packageManager: null }),
      coveragePercent: null,
      coverageSource: null,
    });
    const artifacts = await writeRunReports(cwd, built);
    expect(artifacts.errors).toEqual([]);

    const json = JSON.parse(await readFile(artifacts.paths.reportJson, 'utf8')) as {
      steps: Array<{ id: string; outcome: string; command?: string; stdout: string; stderr: string }>;
    };
    const step = json.steps.find((entry) => entry.id === 'hang');
    expect(step?.outcome).toBe('TIMEOUT');
    expect(step?.command).toBeTruthy();
    expect(step?.stdout).toContain('MARKER-STDOUT');
    expect(step?.stderr).toContain('MARKER-STDERR');

    const log = await readFile(join(artifacts.paths.logsDirectory, 'hang.log'), 'utf8');
    expect(log).toContain('timedOut: true');
    expect(log).toContain('command:');
    expect(log).toContain('MARKER-STDOUT');

    const html = await readFile(artifacts.paths.reportHtml, 'utf8');
    expect(html).toContain('MARKER-STDOUT');
  }, 30_000);

  it('does not start the next step until the timed-out process is gone', async () => {
    let hungPid: number | undefined;
    let aliveWhenNextStarted: boolean | undefined;

    const hang = createProcessStep({
      id: 'hang',
      name: 'Hang',
      command: process.execPath,
      args: ['-e', "console.log('PID=' + process.pid); setTimeout(() => {}, 60000)"],
    });
    const next = {
      id: 'next',
      name: 'Next',
      async run() {
        aliveWhenNextStarted = hungPid !== undefined && processIsAlive(hungPid);
        return { id: 'next', name: 'Next', status: 'PASS' as const, durationMs: 0 };
      },
    };
    const registry = new StepRegistry().register(hang).register(next);

    const run = await new PipelineRunner(registry, {
      onStepEnd: (result) => {
        const match = /PID=(\d+)/.exec(result.stdout ?? '');
        if (result.id === 'hang' && match) hungPid = Number(match[1]);
      },
    }).run(context(process.cwd(), ['hang', 'next'], 1_500));

    expect(run.steps.map((step) => step.id)).toEqual(['hang', 'next']);
    expect(hungPid, 'the timed-out step must report its output, including its pid').toBeDefined();
    expect(aliveWhenNextStarted).toBe(false);
  }, 30_000);
});
