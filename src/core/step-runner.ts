import type { PipelineContext } from './context.js';

export type StepStatus = 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'SKIPPED';

export interface StepResult {
  id: string;
  name: string;
  status: StepStatus;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface PipelineStep {
  id: string;
  name: string;
  run(context: PipelineContext): Promise<StepResult>;
}

export class StepRegistry {
  private readonly steps = new Map<string, PipelineStep>();

  register(step: PipelineStep): this {
    if (this.steps.has(step.id)) {
      throw new Error(`Pipeline step already registered: ${step.id}`);
    }
    this.steps.set(step.id, step);
    return this;
  }

  get(id: string): PipelineStep | undefined {
    return this.steps.get(id);
  }
}

export async function runStep(step: PipelineStep, context: PipelineContext): Promise<StepResult> {
  const started = performance.now();
  try {
    const result = await step.run(context);
    return { ...result, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      id: step.id,
      name: step.name,
      status: 'FAIL',
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
