import { join } from 'node:path';
import { findWorkspaceRoot } from '../adapters/angular/detect.js';
import { normalizeProjects, qualifyStepId, resolveProjectDir, type ConfiguredProject } from '../config/projects.js';
import { isRunStep, type LocalCiConfig } from '../config/schema.js';
import type { ProcessExecutor } from '../core/process-runner.js';
import { createRunStep } from '../core/run-step.js';
import { createMissingScriptStep, createScriptStep } from '../core/script-step.js';
import { StepRegistry } from '../core/step-runner.js';
import { listDir } from './fs.js';
import { detectNode, type NodeDetection } from './node/detect.js';
import { adapterFor } from './registry.js';
import { createCapabilityStep } from './steps.js';
import type { Detection, EcosystemAdapter } from './types.js';

/**
 * One configured project, resolved against the file system.
 *
 * Planning is read-only. It answers "where is this project, which adapter owns
 * it, and what can it run" so that preflight, doctor and run all start from the
 * same facts.
 */
export interface ProjectPlan {
  project: ConfiguredProject;
  /** Absolute directory, or `null` when the configured path could not be used. */
  dir: string | null;
  /** `undefined` for a `project.type` no adapter handles (legacy "generic" mode). */
  adapter: EcosystemAdapter | undefined;
  detection: Detection | null;
  /** Node view used for `script:` steps; the detection itself for Node projects. */
  scriptHost: NodeDetection | null;
  /** Why every step of this project is blocked, when it cannot run at all. */
  problem: string | null;
  /** node_modules present (in the project or its workspace root). Node projects only. */
  dependenciesOnDisk: boolean;
}

/**
 * True when the configuration is executed through the ecosystem adapters.
 *
 * A plain `project: { type: angular }` keeps the original, proven code path so
 * existing configurations behave exactly as before; so does an unrecognised
 * type. Everything new (the `projects:` form, `project.path`, and the other
 * recognised types) goes through the adapters.
 */
export function usesEcosystemPath(config: LocalCiConfig): boolean {
  if (config.projects !== undefined) return true;
  if (config.project.path !== undefined) return true;
  const type = config.project.type.toLowerCase();
  return type !== 'angular' && adapterFor(type) !== undefined;
}

export function qualifiedPipeline(plan: ProjectPlan): string[] {
  return plan.project.pipeline.map((id) => qualifyStepId(plan.project.name, id));
}

/** Display name for a step: unqualified for a single project, `<project>: <name>` otherwise. */
export function stepDisplayName(plan: ProjectPlan, id: string): string {
  const base = plan.adapter ? plan.adapter.stepName(id) : id;
  return plan.project.name === null ? base : `${plan.project.name}: ${base}`;
}

async function nodeModulesPresent(dir: string): Promise<boolean> {
  const own = await listDir(join(dir, 'node_modules'));
  if (own.length > 0) return true;
  const workspaceRoot = await findWorkspaceRoot(dir);
  return workspaceRoot !== null && (await listDir(join(workspaceRoot, 'node_modules'))).length > 0;
}

export async function planProjects(root: string, config: LocalCiConfig): Promise<ProjectPlan[]> {
  const plans: ProjectPlan[] = [];

  for (const project of normalizeProjects(config)) {
    const adapter = adapterFor(project.type);
    const resolved = await resolveProjectDir(root, project.path);
    const label = project.name ?? project.type;

    if (!resolved.ok) {
      plans.push({ project, dir: null, adapter, detection: null, scriptHost: null, problem: resolved.reason, dependenciesOnDisk: false });
      continue;
    }

    const detection = adapter ? await adapter.detect(resolved.dir) : null;
    if (detection && !detection.detected) {
      plans.push({
        project,
        dir: resolved.dir,
        adapter,
        detection,
        scriptHost: null,
        problem: `Project "${label}" is configured as type "${project.type}" but was not detected at "${project.path}": ${detection.reason ?? 'no evidence found'}`,
        dependenciesOnDisk: false,
      });
      continue;
    }

    const scriptHost = detection?.ecosystem === 'node' ? (detection as NodeDetection) : await detectNode(resolved.dir);
    plans.push({
      project,
      dir: resolved.dir,
      adapter,
      detection,
      scriptHost: scriptHost.detected ? scriptHost : null,
      problem: null,
      dependenciesOnDisk: scriptHost.detected ? await nodeModulesPresent(resolved.dir) : false,
    });
  }
  return plans;
}

export interface BuiltRegistry {
  registry: StepRegistry;
  /** Qualified step id -> project name, for attributing results. */
  stepProject: Map<string, string>;
}

function hasScript(host: NodeDetection | null, script: string): boolean {
  if (host === null) return false;
  return Object.hasOwn(host.scripts, script) && host.scripts[script]!.trim() !== '';
}

/**
 * Registers a step for every pipeline id the adapters can implement.
 *
 * Ids that no adapter implements stay unregistered, so the engine reports them
 * as UNSUPPORTED. Blocked projects register nothing: their steps are reported
 * BLOCKED from the preflight verdict and never run.
 */
export function buildProjectRegistry(
  plans: readonly ProjectPlan[],
  options: { exec?: ProcessExecutor } = {},
): BuiltRegistry {
  const registry = new StepRegistry();
  const stepProject = new Map<string, string>();

  for (const plan of plans) {
    const { project } = plan;
    for (const id of project.pipeline) {
      const qid = qualifyStepId(project.name, id);
      if (project.name !== null) stepProject.set(qid, project.name);
      const name = stepDisplayName(plan, id);
      if (plan.problem !== null || plan.dir === null) {
        // Registered only so the BLOCKED row carries a readable name. Preflight
        // blocks the step before it is dispatched; if that ever failed, this
        // stub still reports BLOCKED rather than running anything.
        const reason = plan.problem ?? 'The project directory could not be resolved.';
        registry.register({
          id: qid,
          name,
          async run() {
            return { id: qid, name, status: 'BLOCKED', durationMs: 0, error: reason };
          },
        });
        continue;
      }

      const scripted = Object.hasOwn(project.steps, id) ? project.steps[id] : undefined;

      if (scripted !== undefined && isRunStep(scripted)) {
        registry.register(
          createRunStep({
            id: qid,
            name,
            definition: scripted,
            projectDir: plan.dir,
            ...(options.exec !== undefined ? { exec: options.exec } : {}),
          }),
        );
        continue;
      }

      if (scripted !== undefined) {
        const host = plan.scriptHost;
        registry.register(
          host !== null && hasScript(host, scripted.script)
            ? createScriptStep({
                id: qid,
                name,
                packageManager: host.packageManager,
                script: scripted.script,
                cwd: plan.dir,
                ...(scripted.timeoutMs !== undefined ? { timeoutMs: scripted.timeoutMs } : {}),
                ...(options.exec !== undefined ? { exec: options.exec } : {}),
              })
            : createMissingScriptStep(qid, name, scripted.script),
        );
        continue;
      }

      const capability = plan.detection?.capabilities[id];
      if (capability === undefined) continue;
      registry.register(
        createCapabilityStep(qid, capability, {
          name,
          cwd: plan.dir,
          ...(options.exec !== undefined ? { exec: options.exec } : {}),
        }),
      );
    }
  }
  return { registry, stepProject };
}
