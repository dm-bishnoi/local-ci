import type { LocalCiConfig } from '../config/schema.js';

export interface PipelineContext {
  cwd: string;
  config: LocalCiConfig;
  runId: string;
  /**
   * Aborted when the run is cancelled (Ctrl+C). Step runners pass a derived
   * signal to their steps, so a step-level timeout does not cancel the run.
   */
  signal?: AbortSignal;
}