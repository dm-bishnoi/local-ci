import type { LocalCiConfig } from '../config/schema.js';

export interface PipelineContext {
  cwd: string;
  config: LocalCiConfig;
  runId: string;
}
