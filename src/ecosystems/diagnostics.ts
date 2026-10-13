import { isRunStep, requiredEnvironmentVariables, type LocalCiConfig, type RunStepDefinition } from '../config/schema.js';
import { prepareRunStep, type PrepareOptions } from '../core/run-step.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { satisfies } from '../env/semver.js';
import { probeExecutable, probeTool, type ProbeResult } from '../env/tools.js';
import { qualifiedPipeline, scriptCapabilityFor, type ProjectPlan } from './plan.js';
import { unrecognisedTypeWarning } from './registry.js';
import type { Capability } from './types.js';

/**
 * Preflight / doctor diagnostics for the adapter-driven path.
 *
 * Every diagnostic is scoped to the qualified step ids it affects, so a blocked
 * project never stops another project from running. The only unscoped blockers
 * are configuration-wide ones (a required environment variable that is unset).
 *
 * Severity mapping (unchanged from 0.2.x, and the only way a diagnostic turns
 * into a step status):
 *   PASS / WARNING / UNKNOWN -> the step runs and its own result decides
 *   BLOCKED / ERROR          -> the step is reported BLOCKED
 *   UNSUPPORTED              -> the step reports UNSUPPORTED when it is reached
 */

/**
 * BLOCKED diagnostic for a `run:` step that cannot be started safely (missing
 * or escaping executable, unsafe Windows batch arguments, bad cwd), or null.
 */
export async function runStepDiagnostic(input: {
  id: string;
  label: string;
  qid: string;
  stepId: string;
  definition: RunStepDefinition;
  projectDir: string;
  prepare?: PrepareOptions;
}): Promise<Diagnostic | null> {
  const prepared = await prepareRunStep(input.definition, input.projectDir, input.prepare);
  if (prepared.ok) return null;
  return {
    id: input.id,
    label: input.label,
    severity: 'BLOCKED',
    category: 'pipeline',
    detail: prepared.reason,
    recommendation: `Fix steps.${input.stepId}.run in .local-ci.yml. This step was not run.`,
    steps: [input.qid],
  };
}

export interface EcosystemDiagnosticOptions {
  skipToolProbes?: boolean;
  /** Substitutes the tool probe. Used by tests. */
  probe?: (name: string, args?: readonly string[], locateOnly?: boolean, env?: Record<string, string>) => Promise<ProbeResult>;
}

function label(plan: ProjectPlan): string {
  return plan.project.name ?? plan.project.type;
}

/** Single-project configurations keep the bare ids of 0.2.x; named projects are prefixed. */
function id(plan: ProjectPlan, suffix: string): string {
  return plan.project.name === null ? suffix : `project:${plan.project.name}:${suffix}`;
}

function availableOf(plan: ProjectPlan, stepId: string): Capability | undefined {
  return plan.detection?.capabilities[stepId];
}

interface NeededTool {
  name: string;
  display?: string;
  env?: Record<string, string>;
  probeArgs?: string[];
  locateOnly?: boolean;
  steps: string[];
  versions: Array<{ atLeast: string; source: string; steps: string[] }>;
}

/** Tools every available capability of the plan needs, with the qualified steps that need them. */
function toolsNeeded(plan: ProjectPlan): Map<string, NeededTool> {
  const needed = new Map<string, NeededTool>();
  const entry = (
    name: string,
    probeArgs: string[] | undefined,
    locateOnly: boolean | undefined,
    display?: string,
    env?: Record<string, string>,
  ): NeededTool => {
    const key = `${name}|${(probeArgs ?? []).join(' ')}|${locateOnly ? 'locate' : 'run'}`;
    let tool = needed.get(key);
    if (!tool) {
      tool = {
        name,
        ...(display ? { display } : {}),
        ...(env ? { env } : {}),
        ...(probeArgs ? { probeArgs } : {}),
        ...(locateOnly ? { locateOnly } : {}),
        steps: [],
        versions: [],
      };
      needed.set(key, tool);
    }
    return tool;
  };

  for (const [index, stepId] of plan.project.pipeline.entries()) {
    const qid = qualifiedPipeline(plan)[index]!;
    const definition = Object.hasOwn(plan.project.steps, stepId) ? plan.project.steps[stepId] : undefined;
    if (definition !== undefined && isRunStep(definition)) continue;
    let capability: Capability | undefined;
    if (definition !== undefined) {
      // package.json scripts only need the package manager; other ecosystems may map a script to a command.
      capability = scriptCapabilityFor(plan, definition.script) ?? undefined;
      if (capability === undefined) {
        const manager = plan.scriptHost?.packageManager;
        if (manager) entry(manager, undefined, undefined).steps.push(qid);
        continue;
      }
    } else {
      capability = availableOf(plan, stepId);
    }
    if (capability?.state !== 'available') continue;
    for (const requirement of capability.requires) {
      if (requirement.kind === 'tool') {
        entry(requirement.name, requirement.probeArgs, requirement.locateOnly, requirement.display, requirement.env).steps.push(qid);
      } else if (requirement.kind === 'version') {
        const tool = entry(requirement.tool, requirement.probeArgs, undefined);
        const existing = tool.versions.find((v) => v.atLeast === requirement.atLeast && v.source === requirement.source);
        if (existing) existing.steps.push(qid);
        else tool.versions.push({ atLeast: requirement.atLeast, source: requirement.source, steps: [qid] });
      }
    }
  }
  return needed;
}

async function toolDiagnostics(plan: ProjectPlan, options: EcosystemDiagnosticOptions): Promise<Diagnostic[]> {
  if (options.skipToolProbes) return [];
  const probe =
    options.probe ??
    ((name: string, args?: readonly string[], locateOnly?: boolean, env?: Record<string, string>) =>
      locateOnly ? probeExecutable(name) : probeTool(name, args ?? ['--version'], env ? { env } : {}));
  const diagnostics: Diagnostic[] = [];

  for (const tool of toolsNeeded(plan).values()) {
    const result = await probe(tool.name, tool.probeArgs, tool.locateOnly, tool.env);
    const shown = tool.display ?? tool.name;
    const base = {
      id: id(plan, `tool:${tool.name}${tool.probeArgs ? `:${tool.probeArgs.join(' ')}` : ''}`),
      label: `${label(plan)}: ${shown}`, category: 'environment' as const, steps: tool.steps };
    if (result.outcome === 'ok') {
      const known = result.version !== undefined && result.version !== 'unknown';
      diagnostics.push({ ...base, severity: 'PASS', detail: known ? `${tool.name} ${result.version}` : `${tool.name} found on PATH` });
      for (const requirement of tool.versions) {
        const verdict = satisfies(result.version ?? '', `>=${requirement.atLeast}`);
        const versionBase = {
          id: id(plan, `version:${tool.name}`),
          label: `${label(plan)}: ${tool.name} version`,
          category: 'environment' as const,
          steps: requirement.steps,
        };
        if (verdict.verdict === 'satisfied') {
          diagnostics.push({ ...versionBase, severity: 'PASS', detail: `${tool.name} ${result.version} satisfies >=${requirement.atLeast} (${requirement.source}).` });
        } else if (verdict.verdict === 'violated') {
          diagnostics.push({
            ...versionBase,
            severity: 'BLOCKED',
            detail: `${requirement.source} requires ${tool.name} >= ${requirement.atLeast}, but ${result.version} is installed.`,
            recommendation: `Install ${tool.name} ${requirement.atLeast} or newer. Automatic toolchain downloads are disabled so the check never uses the network unasked.`,
          });
        } else {
          diagnostics.push({
            ...versionBase,
            severity: 'UNKNOWN',
            detail: `${requirement.source} requires ${tool.name} >= ${requirement.atLeast}; the installed version "${result.version ?? 'unknown'}" could not be compared.`,
            recommendation: 'Verify the version manually. local-ci-runner will not claim a compatibility it could not check.',
          });
        }
      }
    } else if (result.outcome === 'blocked') {
      // The check itself was not permitted. That is a fact about the check, not
      // about the tool, so it is UNKNOWN and the step is allowed to try.
      diagnostics.push({
        ...base,
        severity: 'UNKNOWN',
        detail: result.detail,
        recommendation: `${tool.name} could not be probed, so this check is unverified rather than passing.`,
      });
    } else {
      diagnostics.push({
        ...base,
        severity: 'BLOCKED',
        detail: tool.display
          ? `Project "${label(plan)}" needs ${shown}, but it is not available (${result.detail}).`
          : `Project "${label(plan)}" needs ${tool.name}, but ${tool.name} was not found on PATH.`,
        recommendation: `Install ${shown}. Only the steps of project "${label(plan)}" that need it are blocked.`,
      });
    }
  }
  return diagnostics;
}

function nodeRuntimeDiagnostics(plan: ProjectPlan): Diagnostic[] {
  const host = plan.scriptHost;
  if (host === null) return [];
  const engines = (host.manifest['engines'] as { node?: unknown } | undefined)?.node;
  if (typeof engines !== 'string') return [];

  const steps = qualifiedPipeline(plan);
  const verdict = satisfies(process.versions.node, engines);
  const base = { id: id(plan, 'node-version'), label: `${label(plan)}: Node version`, category: 'environment' as const, steps };
  if (verdict.verdict === 'satisfied') {
    return [{ ...base, severity: 'PASS', detail: `Node ${process.versions.node} satisfies ${engines}.` }];
  }
  if (verdict.verdict === 'violated') {
    return [
      {
        ...base,
        severity: 'BLOCKED',
        detail: `Node ${process.versions.node} does not satisfy ${engines} (engines.node of project "${label(plan)}").`,
        recommendation: `Switch to a Node version matching ${engines}.`,
      },
    ];
  }
  return [
    {
      ...base,
      severity: 'UNKNOWN',
      detail: `engines.node "${engines}" could not be evaluated: ${verdict.reason ?? 'unsupported syntax'}.`,
      recommendation: 'Verify the Node version manually. local-ci-runner will not claim a compatibility it could not check.',
    },
  ];
}

function declaresDependencies(plan: ProjectPlan): boolean {
  if (plan.detection?.declaresDependencies !== undefined) return plan.detection.declaresDependencies;
  const host = plan.scriptHost;
  return host !== null && Object.keys(host.dependencies).length + Object.keys(host.devDependencies).length > 0;
}

async function stepDiagnostics(plan: ProjectPlan): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const qids = qualifiedPipeline(plan);
  const pipeline = plan.project.pipeline;
  const host = plan.scriptHost;
  const dependenciesLabel = plan.detection?.dependenciesLabel ?? 'node_modules';

  /** True when an install-style step runs before `index` and can provide the dependencies. */
  const installBefore = (index: number): boolean =>
    pipeline.slice(0, index).some((stepId) => {
      if (!(plan.detection?.installStepIds ?? ['install']).includes(stepId)) return false;
      if (Object.hasOwn(plan.project.steps, stepId)) return true;
      return availableOf(plan, stepId)?.state === 'available';
    });

  for (const [index, stepId] of pipeline.entries()) {
    const qid = qids[index]!;
    const stepLabel = `${label(plan)}: ${stepId}`;
    const scripted = Object.hasOwn(plan.project.steps, stepId) ? plan.project.steps[stepId] : undefined;

    if (scripted !== undefined && isRunStep(scripted)) {
      const problem = plan.dir === null
        ? null
        : await runStepDiagnostic({
            id: id(plan, `step:${stepId}`),
            label: stepLabel,
            qid,
            stepId,
            definition: scripted,
            projectDir: plan.dir,
          });
      if (problem) diagnostics.push(problem);
      continue;
    }

    if (scripted !== undefined) {
      const mapped = scriptCapabilityFor(plan, scripted.script);
      if (mapped !== null) {
        // An ecosystem with its own notion of "script" (composer) or none at all.
        if (mapped.state === 'unavailable') {
          diagnostics.push({
            id: id(plan, `step:${stepId}`),
            label: stepLabel,
            severity: 'UNSUPPORTED',
            category: 'pipeline',
            detail: mapped.reason,
            recommendation: `Fix steps.${stepId} in .local-ci.yml. This step will report UNSUPPORTED.`,
            steps: [qid],
          });
        }
        continue;
      }
      const exists = host !== null && Object.hasOwn(host.scripts, scripted.script) && host.scripts[scripted.script]!.trim() !== '';
      if (!exists) {
        diagnostics.push({
          id: id(plan, `step:${stepId}`),
          label: stepLabel,
          severity: 'UNSUPPORTED',
          category: 'pipeline',
          detail: `package.json has no script named "${scripted.script}".`,
          recommendation: `Add a "${scripted.script}" script to package.json, or fix the name under steps.${stepId} in .local-ci.yml. This step will report UNSUPPORTED.`,
          steps: [qid],
        });
      }
      continue;
    }

    if (plan.adapter === undefined) {
      diagnostics.push({
        id: id(plan, `step:${stepId}`),
        label: stepLabel,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: `project type "${plan.project.type}" has no built-in steps, and "${stepId}" is not defined under steps.`,
        recommendation: 'This step will report UNSUPPORTED. Define it under steps, or use a recognised project type.',
        steps: [qid],
      });
      continue;
    }

    const capability = availableOf(plan, stepId);
    if (capability === undefined) {
      diagnostics.push({
        id: id(plan, `step:${stepId}`),
        label: stepLabel,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: `No implementation is registered for pipeline step "${stepId}" in project type "${plan.project.type}".`,
        recommendation: `Known steps are: ${plan.adapter.stepIds().join(', ')}. This step will report UNSUPPORTED.`,
        steps: [qid],
      });
      continue;
    }

    if (capability.state === 'unavailable') {
      diagnostics.push({
        id: id(plan, `step:${stepId}`),
        label: stepLabel,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: capability.reason,
        recommendation: 'This step will report UNSUPPORTED. Add the missing script, tool or configuration to enable it.',
        steps: [qid],
      });
      continue;
    }

    // Installing without a lockfile would create one (and may resolve newer
    // versions than CI). A local check must not quietly change the project.
    if (stepId === 'install' && plan.detection?.ecosystem === 'node' && host !== null && host.lockfile === null) {
      diagnostics.push({
        id: id(plan, 'lockfile'),
        label: `${label(plan)}: Lockfile`,
        severity: 'BLOCKED',
        category: 'project',
        detail:
          'No lockfile was found in this project or its workspace root. Installing without one would create a ' +
          'lockfile and could install different versions than CI.',
        recommendation:
          'Generate and commit a lockfile (for example run "npm install" once yourself), or remove "install" ' +
          'from this project\'s pipeline and install dependencies manually.',
        steps: [qid],
      });
      continue;
    }

    for (const requirement of capability.requires) {
      if (requirement.kind !== 'dependencies') continue;
      if (!declaresDependencies(plan) || plan.dependenciesOnDisk) continue;
      if (installBefore(index)) {
        diagnostics.push({
          id: id(plan, `deps:${stepId}`),
          label: stepLabel,
          severity: 'WARNING',
          category: 'project',
          detail: `${dependenciesLabel} is missing or empty; the install step runs first and will populate it (needed: ${requirement.detail}).`,
          steps: [qid],
        });
      } else {
        diagnostics.push({
          id: id(plan, `deps:${stepId}`),
          label: stepLabel,
          severity: 'BLOCKED',
          category: 'project',
          detail: `${dependenciesLabel} is missing or empty and this project's pipeline has no earlier install step (needed: ${requirement.detail}).`,
          recommendation: 'Install the dependencies yourself, or add an install step before this one.',
          steps: [qid],
        });
      }
    }
  }

  return diagnostics;
}

export async function ecosystemDiagnostics(
  plans: readonly ProjectPlan[],
  config: LocalCiConfig,
  env: NodeJS.ProcessEnv,
  options: EcosystemDiagnosticOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let unsupported = 0;

  for (const plan of plans) {
    const qids = qualifiedPipeline(plan);

    const warning = unrecognisedTypeWarning(plan.project.type);
    if (warning) {
      diagnostics.push({
        id: id(plan, 'type'),
        label: `${label(plan)}: project type`,
        severity: 'WARNING',
        category: 'configuration',
        detail: warning,
        steps: qids,
      });
    }

    if (plan.problem !== null) {
      diagnostics.push({
        id: id(plan, 'detect'),
        label: `${label(plan)}: project`,
        severity: 'BLOCKED',
        category: 'project',
        detail: plan.problem,
        recommendation: 'Set the project type and path in .local-ci.yml to match this project.',
        steps: qids,
      });
      continue;
    }

    if (plan.detection) {
      diagnostics.push({
        id: id(plan, 'detect'),
        label: `${label(plan)}: project`,
        severity: 'PASS',
        category: 'project',
        detail: `Detected ${plan.detection.ecosystem} project (${plan.detection.evidence.join(', ')}).`,
      });
      for (const [index, warning] of (plan.detection.warnings ?? []).entries()) {
        diagnostics.push({
          id: id(plan, `note:${index + 1}`),
          label: `${label(plan)}: note`,
          severity: 'WARNING',
          category: 'project',
          detail: warning,
        });
      }
    }

    diagnostics.push(...nodeRuntimeDiagnostics(plan));
    diagnostics.push(...(await toolDiagnostics(plan, options)));
    const steps = await stepDiagnostics(plan);
    unsupported += steps.filter((d) => d.severity === 'UNSUPPORTED').length;
    diagnostics.push(...steps);
  }

  const total = plans.reduce((sum, plan) => sum + plan.project.pipeline.length, 0);
  diagnostics.push(
    unsupported === 0
      ? {
          id: 'pipeline',
          label: 'Pipeline',
          severity: 'PASS',
          category: 'pipeline',
          detail: `All ${total} configured step(s) have an implementation for their project.`,
        }
      : {
          id: 'pipeline',
          label: 'Pipeline',
          severity: 'WARNING',
          category: 'pipeline',
          detail: `${unsupported} configured step(s) have no implementation and will report UNSUPPORTED, which fails the run.`,
          recommendation: 'Remove the unsupported steps, or accept that the run will report UNSUPPORTED and exit non-zero.',
        },
  );

  const required = requiredEnvironmentVariables(config);
  const missing = required.filter((name) => !(name in env) || env[name] === '');
  if (required.length === 0) {
    diagnostics.push({ id: 'env-vars', label: 'Environment variables', severity: 'PASS', category: 'requirements', detail: 'This configuration declares no required environment variables.' });
  } else if (missing.length === 0) {
    diagnostics.push({ id: 'env-vars', label: 'Environment variables', severity: 'PASS', category: 'requirements', detail: 'All required environment variables are present.' });
  } else {
    diagnostics.push({
      id: 'env-vars',
      label: 'Environment variables',
      severity: 'BLOCKED',
      category: 'requirements',
      detail: `Required environment variable(s) not set: ${missing.join(', ')}.`,
      recommendation: `Set ${missing.join(', ')} before running the pipeline. local-ci-runner reports presence only and never reads or prints their values.`,
    });
  }

  return diagnostics;
}
