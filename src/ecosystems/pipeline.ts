import type { Capability, DefaultPipeline, Detection } from './types.js';

/**
 * The default `init` pipeline for an adapter whose steps are all fixed
 * commands: every available step, in the given order. Unavailable ones are
 * listed with their reason instead of being generated.
 */
export function pipelineFromCapabilities(detection: Detection, order: readonly string[]): DefaultPipeline {
  const pipeline: string[] = [];
  const omitted: Array<{ id: string; reason: string }> = [];
  for (const id of order) {
    const capability: Capability | undefined = detection.capabilities[id];
    if (capability === undefined) continue;
    if (capability.state === 'available') pipeline.push(id);
    else omitted.push({ id, reason: capability.reason });
  }
  return { pipeline, omitted };
}
