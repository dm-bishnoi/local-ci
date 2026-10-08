import type { PipelineContext } from './context.js';
import { runStep, StepRegistry, type StepResult } from './step-runner.js';

export interface PipelineRunResult {
  runId: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  steps: StepResult[];
}

function unsupportedStep(id: string): StepResult {
  return {
    id,
    name: id,
    status: 'UNSUPPORTED',
    durationMs: 0,
    error: `No local implementation is registered for pipeline step "${id}".`,
  };
}

export class PipelineRunner {
  constructor(private readonly registry: StepRegistry) {}

  async run(context: PipelineContext): Promise<PipelineRunResult> {
    const started = performance.now();
    const steps: StepResult[] = [];
    let failed = false;

    for (const id of context.config.pipeline) {
      if (failed && context.config.settings.failFast) {
        steps.push({ id, name: id, status: 'SKIPPED', durationMs: 0, error: 'Skipped because failFast is enabled.' });
        continue;
      }

      const step = this.registry.get(id);
      const result = step ? await runStep(step, context) : unsupportedStep(id);
      steps.push(result);
      if (result.status === 'FAIL' || result.status === 'UNSUPPORTED') {
        failed = true;
      }
    }

    return {
      runId: context.runId,
      status: failed ? 'FAIL' : 'PASS',
      durationMs: Math.round(performance.now() - started),
      steps,
    };
  }
}
