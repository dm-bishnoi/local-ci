import { describe, expect, it } from 'vitest';
import { PipelineRunner } from '../../src/core/pipeline-runner.js';
import { StepRegistry, type PipelineStep } from '../../src/core/step-runner.js';
import type { PipelineContext } from '../../src/core/context.js';

const context: PipelineContext = {
  cwd: process.cwd(),
  runId: 'test-run',
  config: {
    version: 1,
    project: { type: 'test' },
    pipeline: ['ok', 'missing'],
    settings: { failFast: false },
  },
};

const okStep: PipelineStep = {
  id: 'ok',
  name: 'OK',
  async run() { return { id: 'ok', name: 'OK', status: 'PASS', durationMs: 0 }; },
};

describe('PipelineRunner', () => {
  it('never treats an unregistered step as PASS', async () => {
    const registry = new StepRegistry().register(okStep);
    const result = await new PipelineRunner(registry).run(context);
    expect(result.status).toBe('FAIL');
    expect(result.steps.map((step) => step.status)).toEqual(['PASS', 'UNSUPPORTED']);
  });

  it('honors failFast', async () => {
    const failStep: PipelineStep = {
      id: 'fail', name: 'Fail', async run() { return { id: 'fail', name: 'Fail', status: 'FAIL', durationMs: 0 }; },
    };
    const registry = new StepRegistry().register(failStep);
    const failFastContext = { ...context, config: { ...context.config, pipeline: ['fail', 'later'], settings: { failFast: true } } };
    const result = await new PipelineRunner(registry).run(failFastContext);
    expect(result.steps.map((step) => step.status)).toEqual(['FAIL', 'SKIPPED']);
  });
});
