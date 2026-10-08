import { loadConfig } from '../../config/loader.js';

export async function validateCommand(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  console.log(`Valid ${config.project.type} configuration: ${config.pipeline.length} pipeline step(s).`);
}
