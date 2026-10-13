import type { EcosystemAdapter } from '../types.js';
import { NODE_STEP_IDS, NODE_STEP_NAMES, resolveNodeCapabilities } from './commands.js';
import { detectNode, type NodeDetection } from './detect.js';

export * from './commands.js';
export * from './detect.js';

export const nodeAdapter: EcosystemAdapter = {
  id: 'node',
  profiles: ['node', 'javascript', 'typescript', 'angular', 'react', 'vue'],
  async detect(dir: string): Promise<NodeDetection> {
    const detection = await detectNode(dir);
    detection.capabilities = detection.detected ? resolveNodeCapabilities(detection) : {};
    return detection;
  },
  stepIds: () => NODE_STEP_IDS,
  stepName: (id) => (Object.hasOwn(NODE_STEP_NAMES, id) ? NODE_STEP_NAMES[id]! : id),
};
