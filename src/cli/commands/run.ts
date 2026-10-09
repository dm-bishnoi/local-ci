import { CONFIG_FILE } from '../../config/loader.js';
import {
  describeMissingAngular,
  registerAngularSteps,
  type AngularDetection,
} from '../../adapters/angular/index.js';
import { createRunCancellation } from '../../core/cancellation.js';
import { PipelineRunner, type PipelineRunResult } from '../../core/pipeline-runner.js';
import { StepRegistry } from '../../core/step-runner.js';
import { collectProjectFacts, type ProjectFacts } from '../../diagnostics/facts.js';
import { runPreflightChecks } from '../../diagnostics/preflight.js';
import {
  buildDiagnosticReport,
  blockingDiagnostics,
  type Diagnostic,
  type DiagnosticReport,
} from '../../diagnostics/types.js';
import { detectBrowsers, type BrowserSearchResult } from '../../env/browser.js';
import { buildFingerprint, type EnvironmentFingerprint } from '../../env/fingerprint.js';
import { probeTool } from '../../env/tools.js';
import { describeReportErrors, writeRunReports } from '../../reporters/artifact.js';
import { printConsoleReport, createProgressReporter } from '../../reporters/console.js';
import { readRunCoverage } from '../../reporters/coverage.js';
import { buildRunMetadata, readProjectName } from '../../reporters/metadata.js';
import { createRunId } from '../../reporters/paths.js';
import { buildRunReport, exitCodeForStatus } from '../../reporters/report-model.js';

/**
 * Builds the step registry for the configured project type.
 *
 * Detection happens here, in the CLI, so the core stays framework-agnostic. A
 * project type this build does not support leaves the registry empty and the
 * core reports every step as UNSUPPORTED, which is honest rather than a crash.
 */
function buildRegistry(
  facts: ProjectFacts,
  projectType: string,
  pipeline: readonly string[],
): { registry: StepRegistry; angular: AngularDetection | null } {
  const registry = new StepRegistry();

  if (projectType.toLowerCase() !== 'angular') return { registry, angular: null };

  const detection = facts.angular;
  if (detection === null || !detection.detected) return { registry, angular: detection };

  registerAngularSteps(registry, detection, pipeline);
  return { registry, angular: detection };
}

/**
 * Result used when preflight blocks execution outright, or when the
 * configuration promises Angular but the project is not one.
 *
 * Reported through the normal pipeline result so artifacts are still written,
 * the fingerprint and preflight still land in the report, and the exit code
 * follows the usual rules. A blocked run is a reported run, not a silent one.
 */
function blockedRunResult(
  runId: string,
  steps: Array<{ id: string; name: string; error: string }>,
): PipelineRunResult {
  const now = new Date().toISOString();
  return {
    runId,
    status: 'FAIL',
    durationMs: 0,
    startedAt: now,
    endedAt: now,
    cancelled: false,
    steps: steps.map((step) => ({
      id: step.id,
      name: step.name,
      status: 'BLOCKED' as const,
      durationMs: 0,
      error: step.error,
    })),
  };
}

/** Human-readable reason for a set of blocking diagnostics. */
function describeBlockers(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => (diagnostic.recommendation ? `${diagnostic.detail} ${diagnostic.recommendation}` : diagnostic.detail))
    .join(' ');
}

/**
 * Collects the environment fingerprint for the report.
 *
 * Best-effort by design: a tool that cannot be probed yields `null`/unknown in
 * the fingerprint rather than failing the run. The fingerprint informs the
 * report; it never gates it, and it never contains a secret.
 */
async function collectFingerprint(
  cwd: string,
  facts: ProjectFacts,
  projectName: string,
  projectType: string,
  browserOverride?: BrowserSearchResult,
): Promise<EnvironmentFingerprint> {
  const detection = facts.angular;
  const managerName = detection?.packageManager ?? null;
  const [managerProbe, gitProbe, browserSearch] = await Promise.all([
    managerName ? probeTool(managerName) : Promise.resolve(null),
    probeTool('git'),
    Promise.resolve(browserOverride ?? (await detectBrowsers())),
  ]);

  return buildFingerprint({
    cwd,
    projectName,
    projectType,
    detection,
    packageManagerVersion:
      managerProbe && managerProbe.outcome === 'ok' ? (managerProbe.version ?? null) : null,
    gitVersion: gitProbe.outcome === 'ok' ? (gitProbe.version ?? null) : null,
    browsers: browserSearch.browsers.map((browser) => ({ name: browser.name, version: browser.version })),
  });
}

/**
 * Turns a finished run into artifacts and prints the console report.
 *
 * Shared by the normal path and the blocked path so that both produce exactly
 * the same artifact set and the same console shape.
 *
 * Returns the process exit code. The pipeline result is authoritative:
 * reporting can only ever *add* a non-zero code, never turn a failure into a
 * pass.
 */
async function reportRun(
  cwd: string,
  result: PipelineRunResult,
  metadata: { projectName: string; projectType: string; framework: string | null; packageManager: string | null },
  gate: { environment: EnvironmentFingerprint; preflight: DiagnosticReport },
): Promise<number> {
  const coverage = await readRunCoverage(cwd, result.steps).catch(() => ({ percent: null, source: null }));

  const built = buildRunReport({
    result,
    metadata: buildRunMetadata(metadata),
    coveragePercent: coverage.percent,
    coverageSource: coverage.source,
    environment: gate.environment,
    preflight: gate.preflight,
  });

  printConsoleReport(built.report);

  // Persist artifacts even for a failed, blocked, timed-out or cancelled run:
  // the evidence is most valuable exactly when something went wrong.
  const artifacts = await writeRunReports(cwd, built);

  console.log(`Report directory: ${artifacts.paths.directory}`);
  console.log(`Logs:            ${artifacts.paths.logsDirectory}`);
  console.log(`JSON:            ${artifacts.paths.reportJson}`);
  console.log(`Summary:         ${artifacts.paths.summaryJson}`);
  console.log(`HTML:            ${artifacts.paths.reportHtml}`);

  const pipelineExitCode = exitCodeForStatus(result.status);

  if (artifacts.errors.length > 0) {
    // The original result still governs the outcome; the reporting failure is
    // reported in its own right rather than being folded into the pipeline.
    console.error(`\n${describeReportErrors(artifacts.errors)}`);
    return 1;
  }

  return pipelineExitCode;
}

export interface RunCommandOptions {
  /** Browser search override, used by tests to make browser checks deterministic. */
  browsers?: BrowserSearchResult;
  /** Skip probes that execute external tools. Used by tests. */
  skipToolProbes?: boolean;
  /** Environment to read required variable names from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(cwd: string, options: RunCommandOptions = {}): Promise<number> {
  const runId = createRunId();

  // Facts are collected once and shared by preflight and the fingerprint, so
  // the gate and the report describe the same machine at the same moment.
  const facts = await collectProjectFacts(cwd);
  const preflightDiagnostics = await runPreflightChecks(cwd, {
    facts,
    ...(options.browsers !== undefined ? { browsers: options.browsers } : {}),
    ...(options.skipToolProbes !== undefined ? { skipToolProbes: options.skipToolProbes } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const preflight = buildDiagnosticReport('preflight', preflightDiagnostics);

  const projectName = await readProjectName(cwd);
  const config = facts.config.config;
  const projectType = config?.project.type ?? 'unknown';
  const metadata = {
    projectName,
    projectType,
    framework: facts.angular?.framework ?? null,
    packageManager: facts.angular?.packageManager ?? null,
  };

  const environment = await collectFingerprint(cwd, facts, projectName, projectType, options.browsers);
  const gate = { environment, preflight };

  // Preflight could not produce a usable configuration: nothing can run, and
  // pretending otherwise would execute steps against an unknown plan.
  if (config === null) {
    const blockers = blockingDiagnostics(preflightDiagnostics);
    const result = blockedRunResult(runId, [
      {
        id: 'preflight',
        name: 'Preflight',
        error:
          blockers.length > 0
            ? describeBlockers(blockers)
            : `No usable ${CONFIG_FILE} was found. Run "local-ci-runner init" to create one.`,
      },
    ]);
    return reportRun(cwd, result, metadata, gate);
  }

  const { registry, angular } = buildRegistry(facts, config.project.type, config.pipeline);

  // Configuration promises Angular but the project is not one: blocked, with
  // the same artifact set as any other run.
  if (angular !== null && !angular.detected) {
    const result = blockedRunResult(runId, [
      { id: 'detection', name: 'Project detection', error: describeMissingAngular(angular) },
    ]);
    return reportRun(cwd, result, metadata, gate);
  }

  // Steps that must not execute, each carrying the reason it is blocked.
  //
  // A blocking diagnostic with no step scope (missing Node requirement, absent
  // package manager, unset required variable) blocks the whole pipeline; a
  // scoped one (no browser) blocks only the steps it names. Warnings never
  // block — they inform the report and nothing more.
  const blockedSteps = new Map<string, string>();
  for (const stepId of config.pipeline) {
    const scoped = blockingDiagnostics(preflightDiagnostics, stepId);
    if (scoped.length > 0) blockedSteps.set(stepId, describeBlockers(scoped));
  }

  const progress = createProgressReporter();
  const runner = new PipelineRunner(registry, {
    onStepStart: (step) => progress.onStepStart(step),
    onStepEnd: (result) => progress.onStepEnd(result),
    blockedSteps,
  });

  // One cancellation object per invocation, always disposed, so repeated
  // commands never accumulate SIGINT/SIGTERM listeners.
  const cancellation = createRunCancellation((reason) => {
    console.error(`\nlocal-ci-runner: ${reason} Cancelling run...`);
  });

  let result: PipelineRunResult;
  try {
    result = await runner.run({ cwd, config, runId, signal: cancellation.signal });
  } finally {
    progress.stop();
    cancellation.dispose();
  }

  const exitCode = await reportRun(cwd, result, metadata, gate);

  if (angular?.detected) {
    const lockNote =
      angular.lockfile === null ? ' (no lockfile found; defaulted to npm)' : ` (${angular.lockfile})`;
    console.log(`\nDetected: Angular, ${angular.packageManager}${lockNote}`);
  }

  return exitCode;
}
