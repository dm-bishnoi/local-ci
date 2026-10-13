import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStep } from '../../adapters/angular/commands.js';
import { detectAngularProject } from '../../adapters/angular/detect.js';
import { CONFIG_FILE } from '../../config/loader.js';
import { REPORT_ROOT_GITIGNORE, ensureReportRootIgnored } from '../../reporters/artifact.js';

/** The default Angular pipeline, in the order the steps run. */
const DEFAULT_PIPELINE = ['install', 'typecheck', 'test', 'coverage', 'lint', 'build', 'security'] as const;

interface OmittedStep {
  id: string;
  reason: string;
}

function renderConfig(pipeline: readonly string[], omitted: readonly OmittedStep[]): string {
  const lines = ['version: 1', '', 'project:', '  type: angular', '', 'pipeline:', ...pipeline.map((id) => `  - ${id}`)];
  if (omitted.length > 0) {
    lines.push('  # Not added: this project cannot run these yet. Fix the cause, then uncomment.');
    for (const { id, reason } of omitted) lines.push(`  # - ${id}  # ${reason}`);
  }
  lines.push('', 'settings:', '  failFast: false', '  timeoutMs: 300000', '');
  return lines.join('\n');
}

/**
 * The configuration for this project. In a detected Angular project only the
 * default steps the adapter can actually run are listed, so the first `run`
 * does not fail on steps the project was never set up for; the rest are left
 * as comments with the reason. Anywhere else the full default is written, as
 * before.
 */
async function configFor(cwd: string): Promise<{ text: string; omitted: OmittedStep[] }> {
  const detection = await detectAngularProject(cwd);
  if (!detection.detected) return { text: renderConfig(DEFAULT_PIPELINE, []), omitted: [] };

  const pipeline: string[] = [];
  const omitted: OmittedStep[] = [];
  for (const id of DEFAULT_PIPELINE) {
    const resolved = resolveStep(id, detection);
    if (resolved?.status !== 'resolved') {
      omitted.push({ id, reason: resolved?.reason ?? 'Not supported by the Angular adapter.' });
    } else if (id === 'install' && detection.lockfile === null) {
      // Preflight blocks install without a lockfile, so listing it would fail.
      omitted.push({ id, reason: 'No lockfile found, and install is blocked without one. Commit a lockfile first.' });
    } else {
      pipeline.push(id);
    }
  }

  // A pipeline needs at least one step; fall back to the full default.
  if (pipeline.length === 0) return { text: renderConfig(DEFAULT_PIPELINE, []), omitted: [] };
  return { text: renderConfig(pipeline, omitted), omitted };
}

export async function initCommand(cwd: string, force = false): Promise<void> {
  const path = join(cwd, CONFIG_FILE);
  try {
    await access(path);
    if (!force) throw new Error(`${CONFIG_FILE} already exists. Use --force to replace it.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) throw error;
  }
  const { text, omitted } = await configFor(cwd);
  await writeFile(path, text, 'utf8');
  console.log(`Created ${CONFIG_FILE}`);
  if (omitted.length > 0) {
    console.log(
      `Left out of the pipeline because this project cannot run them yet: ${omitted.map((step) => step.id).join(', ')}. ` +
        `The reasons are in ${CONFIG_FILE}.`,
    );
  }

  // Reports are written under .local-ci/ and can contain captured output.
  // The directory ignores itself; the project's own .gitignore is never edited.
  if (await ensureReportRootIgnored(cwd)) {
    console.log(`Created ${REPORT_ROOT_GITIGNORE} so run reports stay out of version control.`);
  }
}
