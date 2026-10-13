import type { ProcessExecutor } from '../core/process-runner.js';
import { createProcessStep } from '../core/process-step.js';
import type { PipelineStep } from '../core/step-runner.js';
import type { Capability } from './types.js';

export interface CapabilityStepOptions {
  name?: string;
  cwd?: string;
  timeoutMs?: number;
  exec?: ProcessExecutor;
}

/**
 * Turns a capability into a runnable step. An available one is a plain process
 * step (all timeout/cancel/redaction behaviour is the engine's); an unavailable
 * one is an UNSUPPORTED step carrying its reason, never a silent pass.
 */
export function createCapabilityStep(id: string, capability: Capability, options: CapabilityStepOptions = {}): PipelineStep {
  const name = options.name ?? id;
  if (capability.state === 'unavailable') {
    return {
      id,
      name,
      async run() {
        return { id, name, status: 'UNSUPPORTED', durationMs: 0, error: capability.reason };
      },
    };
  }
  return createProcessStep({
    id,
    name,
    command: capability.command,
    args: capability.args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.exec !== undefined ? { exec: options.exec } : {}),
  });
}
