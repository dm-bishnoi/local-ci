import { loadConfig } from '../../config/loader.js';
import { effectiveTimeoutMs } from '../../config/schema.js';
import { formatTimeout } from '../../core/step-runner.js';

export async function validateCommand(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  console.log(`Valid ${config.project.type} configuration: ${config.pipeline.length} pipeline step(s).`);
  const source = config.settings.timeoutMs === undefined ? 'default' : 'configured';
  console.log(`Step timeout: ${formatTimeout(effectiveTimeoutMs(config))} (${source}).`);
}
