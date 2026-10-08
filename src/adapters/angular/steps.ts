import { createProcessStep } from '../../core/process-step.js';
import type { ProcessExecutor } from '../../core/process-runner.js';
import type { PipelineStep, StepRegistry, StepResult } from '../../core/step-runner.js';
import { STEP_NAMES, resolveStep, supportedStepIds, type ResolvedCommand } from './commands.js';
import type { AngularDetection } from './detect.js';

/**
 * Builds the Angular {@link PipelineStep} implementations and registers them
 * with a {@link StepRegistry}.
 *
 * The core engine never learns that these steps exist: it only receives
 * PipelineStep objects. A future React, Vue or Node adapter follows the exact
 * same shape.
 */

export interface AngularAdapterOptions {
  /** Substitutes process execution. Used by tests; defaults to the real runner. */
  exec?: ProcessExecutor;
}

/** Step ids the adapter owns. Anything else stays UNSUPPORTED by the core. */
export const ANGULAR_STEP_IDS: readonly string[] = supportedStepIds();

function unsupportedStep(id: string, reason: string): PipelineStep {
  return {
    id,
    name: STEP_NAMES[id] ?? id,
    async run(): Promise<StepResult> {
      return {
        id,
        name: STEP_NAMES[id] ?? id,
        status: 'UNSUPPORTED',
        durationMs: 0,
        error: reason,
      };
    },
  };
}

/**
 * Turns a resolved command into a runnable step, and an unresolved one into an
 * honest UNSUPPORTED step that explains itself.
 */
export function createAngularStep(id: string, resolved: ResolvedCommand, options: AngularAdapterOptions = {}): PipelineStep {
  const name = STEP_NAMES[id] ?? id;

  if (resolved.status === 'unsupported') return unsupportedStep(id, resolved.reason);

  return createProcessStep({
    id,
    name,
    command: resolved.command,
    args: resolved.args,
    exec: options.exec,
  });
}

/** Resolves every Angular step id against a detected project. */
export function createAngularSteps(
  detection: AngularDetection,
  options: AngularAdapterOptions = {},
): Map<string, PipelineStep> {
  const steps = new Map<string, PipelineStep>();

  for (const id of supportedStepIds()) {
    const resolved = resolveStep(id, detection);
    if (resolved) steps.set(id, createAngularStep(id, resolved, options));
  }

  return steps;
}

/**
 * Registers the Angular steps the configured pipeline actually asks for.
 * Steps outside the Angular vocabulary are deliberately left unregistered so the
 * core reports them as UNSUPPORTED.
 */
export function registerAngularSteps(
  registry: StepRegistry,
  detection: AngularDetection,
  pipelineIds: readonly string[],
  options: AngularAdapterOptions = {},
): void {
  const built = createAngularSteps(detection, options);
  for (const id of pipelineIds) {
    const step = built.get(id);
    if (step) registry.register(step);
  }
}

/** Clear diagnostic shown when the config asks for Angular but none was found. */
export function describeMissingAngular(detection: AngularDetection): string {
  return (
    detection.reason ??
    'Angular was not detected in this project, but .local-ci.yml declares project.type: angular.'
  );
}