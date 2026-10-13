import { loadConfig } from '../../config/loader.js';
import { normalizeProjects } from '../../config/projects.js';
import { effectiveTimeoutMs } from '../../config/schema.js';
import { formatTimeout } from '../../core/step-runner.js';
import { unrecognisedTypeWarning } from '../../ecosystems/registry.js';

export async function validateCommand(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const projects = normalizeProjects(config);
  if (config.projects === undefined) {
    console.log(`Valid ${config.project.type} configuration: ${config.pipeline.length} pipeline step(s).`);
  } else {
    console.log(
      `Valid multi-project configuration: ${projects.length} project(s), ${config.pipeline.length} pipeline step(s) in total.`,
    );
    for (const project of projects) {
      console.log(`  ${project.name}: ${project.type} at ${project.path} (${project.pipeline.length} step(s))`);
    }
  }
  for (const project of projects) {
    const warning = unrecognisedTypeWarning(project.type);
    if (warning) console.warn(`Warning: ${project.name ? `[${project.name}] ` : ''}${warning}`);
  }
  const source = config.settings.timeoutMs === undefined ? 'default' : 'configured';
  console.log(`Step timeout: ${formatTimeout(effectiveTimeoutMs(config))} (${source}).`);
}
