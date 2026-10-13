import { CONFIG_FILE } from '../../config/loader.js';
import { withEffectiveDefaults, type LocalCiConfig } from '../../config/schema.js';
import {
  describeMissingAngular,
  registerAngularSteps,
  STEP_NAMES,
  type AngularDetection,
} from '../../adapters/angular/index.js';
import { createRunCancellation } from '../../core/cancellation.js';
import type { ProcessExecutor } from '../../core/process-runner.js';
import { qualifiedPipeline, buildProjectRegistry } from '../../ecosystems/plan.js';
import { PipelineRunner, type PipelineRunResult } from '../../core/pipeline-runner.js';
import { createMissingScriptStep, createScriptStep } from '../../core/script-step.js';
import { StepRegistry } from '../../core/step-runner.js';
import { collectProjectFacts, type ProjectFacts } from '../../diagnostics/facts.js';
import { hasProjectScript, runPreflightChecks } from '../../diagnostics/preflight.js';
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
  config: LocalCiConfig,
): { registry: StepRegistry; angular: AngularDetection | null } {
  const registry = new StepRegistry();
  const scripted = config.steps ?? {};
  const isAngular = config.project.type.toLowerCase() === 'angular';
  const detection = facts.angular;

  if (isAngular && (detection === null || !detection.detected)) return { registry, angular: detection };

  // A `steps` entry replaces the built-in implementation of the same id, so the
  // adapter is only asked for the ids the configuration did not script.
  if (isAngular && detection !== null) {
    registerAngularSteps(
      registry,
      detection,
      config.pipeline.filter((id) => !Object.hasOwn(scripted, id)),
    );
  }

  registerScriptSteps(registry, facts, scripted);
  return { registry, angular: isAngular ? detection : null };
}

/** Registers the configuration's `steps` entries, for any project type. */
function registerScriptSteps(
  registry: StepRegistry,
  facts: ProjectFacts,
  scripted: NonNullable<LocalCiConfig['steps']>,
): void {
  const packageManager = facts.angular?.packageManager ?? 'npm';

  for (const [id, definition] of Object.entries(scripted)) {
    // Own properties only: an id such as "constructor" must not pick up Object members.
    const name = (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id] : undefined) ?? id;
    registry.register(
      facts.angular !== null && hasProjectScript(facts.angular, definition.script)
        ? createScriptStep({
            id,
            name,
            packageManager,
            script: definition.script,
            ...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
          })
        : createMissingScriptStep(id, name, definition.script),
    );
  }
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
  projects?: ReadonlyArray<{ name: string; type: string; path: string }>,
): Promise<number> {
  const coverage = await readRunCoverage(cwd, result.steps).catch(() => ({ percent: null, source: null }));

  const built = buildRunReport({
    result,
    metadata: buildRunMetadata(metadata),
    coveragePercent: coverage.percent,
    coverageSource: coverage.source,
    environment: gate.environment,
    preflight: gate.preflight,
    ...(projects && projects.length > 0 ? { projects } : {}),
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
  /** Run only these projects of a `projects:` configuration. */
  projects?: readonly string[];
  /** Substitutes process execution for adapter steps. Used by tests. */
  exec?: ProcessExecutor;
}

interface PlannedRun {
  cwd: string;
  runId: string;
  config: LocalCiConfig;
  facts: ProjectFacts;
  plans: NonNullable<ProjectFacts['plans']>;
  preflightDiagnostics: readonly Diagnostic[];
  projectName: string;
  gate: { environment: EnvironmentFingerprint; preflight: DiagnosticReport };
  options: RunCommandOptions;
}

/**
 * Runs a configuration through the ecosystem adapters.
 *
 * Every step id is project-qualified, blocked projects are reported BLOCKED
 * without touching the other projects, and each result carries the project it
 * belongs to so reports can roll them up.
 */
async function runPlannedProjects(input: PlannedRun): Promise<number> {
  const { cwd, runId, config, plans, preflightDiagnostics, gate, options } = input;
  const { registry, stepProject } = buildProjectRegistry(plans, options.exec ? { exec: options.exec } : {});
  const pipeline = plans.flatMap((plan) => qualifiedPipeline(plan));

  const blockedSteps = new Map<string, string>();
  for (const stepId of pipeline) {
    const scoped = blockingDiagnostics(preflightDiagnostics, stepId);
    if (scoped.length > 0) blockedSteps.set(stepId, describeBlockers(scoped));
  }

  const single = plans.length === 1 && plans[0]!.project.name === null ? plans[0]! : null;
  const node = single?.scriptHost ?? null;
  const metadata = {
    projectName: input.projectName,
    projectType: config.project.type,
    framework: node?.frameworks[0] ?? null,
    packageManager: node?.packageManager ?? null,
  };
  const projects = plans
    .filter((plan) => plan.project.name !== null)
    .map((plan) => ({ name: plan.project.name!, type: plan.project.type, path: plan.project.path }));

  const progress = createProgressReporter();
  const runner = new PipelineRunner(registry, {
    onStepStart: (step) => progress.onStepStart(step),
    onStepEnd: (result) => progress.onStepEnd(result),
    blockedSteps,
  });
  const cancellation = createRunCancellation((reason) => {
    console.error(`
local-ci-runner: ${reason} Cancelling run...`);
  });

  let result: PipelineRunResult;
  try {
    result = await runner.run({
      cwd,
      config: { ...withEffectiveDefaults(config), pipeline },
      runId,
      signal: cancellation.signal,
    });
  } finally {
    progress.stop();
    cancellation.dispose();
  }

  const attributed: PipelineRunResult = {
    ...result,
    steps: result.steps.map((step) => {
      const project = stepProject.get(step.id);
      return project === undefined ? step : { ...step, project };
    }),
  };
  return reportRun(cwd, attributed, metadata, gate, projects);
}

export async function runCommand(cwd: string, options: RunCommandOptions = {}): Promise<number> {
  const runId = createRunId();

  // Facts are collected once and shared by preflight and the fingerprint, so
  // the gate and the report describe the same machine at the same moment.
  const facts = await collectProjectFacts(cwd);

  // `--project` narrows a `projects:` configuration. Anything unknown is an
  // error, not a silently empty run.
  if (options.projects !== undefined && options.projects.length > 0) {
    if (facts.plans === null) {
      console.error('local-ci-runner: --project can only be used with a "projects:" configuration.');
      return 1;
    }
    const known = facts.plans.map((plan) => plan.project.name ?? plan.project.type);
    const unknown = options.projects.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      console.error(`local-ci-runner: unknown project ${unknown.map((n) => `"${n}"`).join(', ')}. Known projects: ${known.join(', ')}.`);
      return 1;
    }
    facts.plans = facts.plans.filter((plan) => options.projects!.includes(plan.project.name ?? plan.project.type));
  }

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

  if (facts.plans !== null) {
    return runPlannedProjects({ cwd, runId, config, facts, plans: facts.plans, preflightDiagnostics, projectName, gate, options });
  }

  const { registry, angular } = buildRegistry(facts, config);

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
    // The documented default timeout is applied here, at the boundary where a
    // user's configuration becomes a run, so no step can run without a limit.
    result = await runner.run({ cwd, config: withEffectiveDefaults(config), runId, signal: cancellation.signal });
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
