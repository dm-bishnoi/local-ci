import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config/loader.js';
import {
  detectAngularProject,
  describeMissingAngular,
  registerAngularSteps,
  type AngularDetection,
} from '../../adapters/angular/index.js';
import { createRunCancellation } from '../../core/cancellation.js';
import { PipelineRunner, type PipelineRunResult } from '../../core/pipeline-runner.js';
import { StepRegistry } from '../../core/step-runner.js';
import { writeHtmlReport } from '../../reporters/html.js';
import { printConsoleReport } from '../../reporters/console.js';
import { writeJsonReport } from '../../reporters/json.js';
import { writeRunLogs } from '../../reporters/logs.js';

function createRunId(): string {
  return `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Builds the step registry for the configured project type.
 *
 * Detection happens here, in the CLI, so the core stays framework-agnostic. A
 * project type this build does not support leaves the registry empty and the
 * core reports every step as UNSUPPORTED, which is honest rather than a crash.
 */
async function buildRegistry(
  cwd: string,
  projectType: string,
  pipeline: readonly string[],
): Promise<{ registry: StepRegistry; angular: AngularDetection | null }> {
  const registry = new StepRegistry();

  if (projectType.toLowerCase() !== 'angular') return { registry, angular: null };

  const detection = await detectAngularProject(cwd);
  if (!detection.detected) return { registry, angular: detection };

  registerAngularSteps(registry, detection, pipeline);
  return { registry, angular: detection };
}

/**
 * Result used when the configuration promises Angular but the project is not
 * one. Reported through the normal pipeline result so artifacts are still
 * written and the exit code follows the usual rules.
 */
function detectionFailureResult(runId: string, message: string): PipelineRunResult {
  return {
    runId,
    status: 'FAIL',
    durationMs: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    cancelled: false,
    steps: [
      {
        id: 'detection',
        name: 'Project detection',
        status: 'FAIL',
        durationMs: 0,
        error: message,
      },
    ],
  };
}

export async function runCommand(cwd: string): Promise<number> {
  const config = await loadConfig(cwd);
  const runId = createRunId();

  const { registry, angular } = await buildRegistry(cwd, config.project.type, config.pipeline);

  if (angular !== null && !angular.detected) {
    const result = detectionFailureResult(runId, describeMissingAngular(angular));
    printConsoleReport(result);
    const logs = await writeRunLogs(cwd, result);
    const json = await writeJsonReport(cwd, result);
    const html = await writeHtmlReport(cwd, result);
    console.log(`\nLogs: ${logs}`);
    console.log(`JSON: ${json}`);
    console.log(`HTML: ${html}`);
    return 1;
  }

  const runner = new PipelineRunner(registry);

  // One cancellation object per invocation, always disposed, so repeated
  // commands never accumulate SIGINT/SIGTERM listeners.
  const cancellation = createRunCancellation((reason) => {
    console.error(`\nlocal-ci: ${reason} Cancelling run...`);
  });

  let result: PipelineRunResult;
  try {
    result = await runner.run({ cwd, config, runId, signal: cancellation.signal });
  } finally {
    cancellation.dispose();
  }

  printConsoleReport(result);

  // Persist artifacts even for a failed or cancelled run: the evidence is most
  // valuable exactly when something went wrong.
  const logs = await writeRunLogs(cwd, result);
  const json = await writeJsonReport(cwd, result);
  const html = await writeHtmlReport(cwd, result);

  console.log(`\nLogs: ${logs}`);
  console.log(`JSON: ${json}`);
  console.log(`HTML: ${html}`);

  if (angular?.detected) {
    const lockNote = angular.lockfile === null
      ? ' (no lockfile found; defaulted to npm)'
      : ` (${angular.lockfile})`;
    console.log(`\nDetected: Angular, ${angular.packageManager}${lockNote}`);
  }

  // 0 only when the pipeline genuinely succeeded.
  return result.status === 'PASS' ? 0 : 1;
}