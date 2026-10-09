/**
 * `local-ci preflight` — "can this configured pipeline reasonably run here?"
 *
 * Preflight is narrower than doctor on purpose. Doctor audits the machine and
 * the project; preflight answers the one question that decides whether `run`
 * should proceed, and it is the only thing allowed to block execution.
 *
 * The distinction that carries the product principle:
 *
 * - `WARNING`  → the pipeline can still run. Never blocks.
 * - `BLOCKED`  → a known requirement prevents execution. `run` must not start
 *                the affected steps.
 * - `UNSUPPORTED` → local-ci cannot do this capability, on any machine. Also
 *                non-zero for the run, but a different fact from BLOCKED.
 */

import { requiredEnvironmentVariables } from '../config/schema.js';
import { resolveStep, supportedStepIds } from '../adapters/angular/commands.js';
import { detectBrowsers, requiresBrowser, type BrowserSearchResult } from '../env/browser.js';
import { probeTool } from '../env/tools.js';
import { collectProjectFacts, type ProjectFacts } from './facts.js';
import type { Diagnostic } from './types.js';
import type { AngularDetection } from '../adapters/angular/detect.js';

export interface PreflightOptions {
  /** Skip probes that execute external tools. Used by tests. */
  skipToolProbes?: boolean;
  env?: NodeJS.ProcessEnv;
  facts?: ProjectFacts;
  /** Browser search result override, so "no browser" is testable deterministically. */
  browsers?: BrowserSearchResult;
}

const EMPTY_DETECTION: AngularDetection = {
  detected: false,
  framework: null,
  angularConfig: null,
  packageJson: null,
  packageManager: null,
  lockfile: null,
  packageManagerIsDefault: true,
  scripts: {},
  dependencies: {},
  devDependencies: {},
};

function detectionFor(facts: ProjectFacts): AngularDetection {
  return facts.angular ?? EMPTY_DETECTION;
}

/**
 * The package manager must actually be usable before any step is dispatched.
 *
 * A missing manager is `BLOCKED` rather than `FAIL`: nothing ran, and nothing
 * will run until it is installed. Failing at step time would blur the
 * difference between "your project is broken" and "your machine is not ready".
 */
async function packageManagerDiagnostic(facts: ProjectFacts, skipToolProbes: boolean): Promise<Diagnostic[]> {
  const detection = detectionFor(facts);
  const name = detection.packageManager;
  if (!name) return [];

  if (skipToolProbes) {
    // Test mode: the probe is deliberately absent rather than reported. An
    // absent check makes no claim; an UNKNOWN check would drag an otherwise
    // healthy preflight down to WARNING for a condition the test removed.
    return [];
  }

  const probe = await probeTool(name, ['--version']);
  if (probe.outcome === 'ok') {
    return [
      {
        id: `package-manager:${name}`,
        label: name,
        severity: 'PASS',
        category: 'environment',
        detail: `${name} ${probe.version ?? '(version unknown)'}`,
      },
    ];
  }

  if (probe.outcome === 'blocked') {
    return [
      {
        id: `package-manager:${name}`,
        label: name,
        severity: 'UNKNOWN',
        category: 'environment',
        detail: probe.detail,
        recommendation: `${name} could not be probed, so this check is unverified rather than passing.`,
      },
    ];
  }

  return [
    {
      id: `package-manager:${name}`,
      label: name,
      severity: 'BLOCKED',
      category: 'environment',
      detail: `This project resolves to ${name}, but ${name} was not found on PATH.`,
      recommendation: `Install ${name}, or remove ${detection.lockfile ?? 'the lockfile'} so a different manager can be detected.`,
    },
  ];
}

function nodeDiagnostic(facts: ProjectFacts): Diagnostic[] {
  const { node } = facts;
  if (!node.result) return [];

  const declared = node.source === 'engines' ? node.enginesRange : node.nvmrc;
  const base = {
    id: 'node-version',
    label: 'Node version',
    category: 'environment' as const,
  };

  if (node.result.verdict === 'satisfied') {
    return [{ ...base, severity: 'PASS', detail: `Node ${process.versions.node} satisfies ${declared}.` }];
  }
  if (node.result.verdict === 'violated') {
    return [
      {
        ...base,
        severity: 'BLOCKED',
        detail: `Node ${process.versions.node} does not satisfy ${declared}.`,
        recommendation: `Switch to a Node version matching ${declared} before running the pipeline.`,
      },
    ];
  }
  return [
    {
      ...base,
      severity: 'UNKNOWN',
      detail: `Node ${process.versions.node} is running, but ${declared} could not be evaluated: ${node.result.reason ?? 'unsupported syntax'}.`,
      recommendation: 'Verify the Node version manually. local-ci will not claim a compatibility it could not check.',
    },
  ];
}

async function browserDiagnostics(facts: ProjectFacts, override?: BrowserSearchResult): Promise<Diagnostic[]> {
  const { browsers } = override ?? await detectBrowsers();
  if (browsers.length > 0) {
    return [
      {
        id: 'browser',
        label: 'Browser',
        severity: 'PASS',
        category: 'environment',
        detail: `Detected ${browsers.map((b) => b.name).join(', ')}.`,
      },
    ];
  }

  const dependencies = { ...facts.dependencies, ...facts.devDependencies };
  const runsBrowserTests = facts.config.config?.pipeline.includes('test') ?? false;

  if (requiresBrowser(dependencies)) {
    // A known browser-driven runner without a browser genuinely cannot run.
    // Scoped to the test steps so `build` is still allowed to proceed.
    return [
      {
        id: 'browser',
        label: 'Browser',
        severity: 'BLOCKED',
        category: 'environment',
        detail: 'A browser-driven test runner is declared, but no Chrome or Chromium installation was found.',
        recommendation:
          'Install Chrome or Chromium. Karma, Protractor and Cypress launch a real browser, so these tests cannot run without one.',
        steps: ['test', 'coverage', 'e2e'],
      },
    ];
  }

  if (runsBrowserTests) {
    return [
      {
        id: 'browser',
        label: 'Browser',
        severity: 'WARNING',
        category: 'environment',
        detail: 'No Chrome or Chromium installation was found.',
        recommendation:
          'No browser-driven test runner was detected, so this is not expected to block the run. Install Chrome or Chromium if your tests need a real browser.',
      },
    ];
  }

  return [
    {
      id: 'browser',
      label: 'Browser',
      severity: 'PASS',
      category: 'environment',
      detail: 'No browser is required by this pipeline.',
    },
  ];
}

function projectDiagnostics(facts: ProjectFacts): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  diagnostics.push(
    facts.packageJsonExists
      ? facts.packageJsonValid
        ? { id: 'package-json', label: 'package.json', severity: 'PASS', category: 'project', detail: 'Found.' }
        : {
            id: 'package-json',
            label: 'package.json',
            severity: 'BLOCKED',
            category: 'project',
            detail: `package.json is not valid JSON: ${facts.packageJsonProblem}`,
            recommendation: 'Fix package.json before running the pipeline.',
          }
      : {
          id: 'package-json',
          label: 'package.json',
          severity: 'BLOCKED',
          category: 'project',
          detail: 'No package.json was found.',
          recommendation: 'Run local-ci from a project root.',
        },
  );

  const config = facts.config.config;
  if (!config) {
    diagnostics.push(
      facts.config.exists
        ? {
            id: 'config',
            label: '.local-ci.yml',
            severity: 'BLOCKED',
            category: 'configuration',
            detail: facts.config.problem ?? 'The configuration could not be used.',
            recommendation: 'Fix .local-ci.yml, or run "local-ci init --force" to start fresh.',
          }
        : {
            id: 'config',
            label: '.local-ci.yml',
            severity: 'BLOCKED',
            category: 'configuration',
            detail: 'No .local-ci.yml was found.',
            recommendation: 'Run "local-ci init" to create one.',
          },
    );
    return diagnostics;
  }

  diagnostics.push({
    id: 'config',
    label: '.local-ci.yml',
    severity: 'PASS',
    category: 'configuration',
    detail: `Valid configuration with ${config.pipeline.length} pipeline step(s).`,
  });

  if (config.project.type.toLowerCase() === 'angular') {
    const detection = detectionFor(facts);
    diagnostics.push(
      detection.detected
        ? { id: 'angular', label: 'angular.json', severity: 'PASS', category: 'project', detail: 'Angular project detected.' }
        : {
            id: 'angular',
            label: 'angular.json',
            severity: 'BLOCKED',
            category: 'project',
            detail: detection.reason ?? 'Angular was not detected.',
            recommendation: 'Set project.type to match this project, or add an Angular dependency.',
          },
    );
  }

  // Dependencies: an empty node_modules is only a warning when the pipeline can
  // populate it. Otherwise the run would fail on a missing module for a reason
  // that has nothing to do with the project's health.
  const hasInstallStep = config.pipeline.includes('install');
  if (hasInstallStep) {
    diagnostics.push(
      facts.dependenciesOnDisk.installed
        ? { id: 'dependencies', label: 'Dependencies', severity: 'PASS', category: 'project', detail: 'node_modules is present and non-empty.' }
        : {
            id: 'dependencies',
            label: 'Dependencies',
            severity: 'WARNING',
            category: 'project',
            detail: 'node_modules is missing or empty; the install step will populate it.',
            recommendation: 'No action needed if the install step can reach the package registry.',
          },
    );
  } else {
    diagnostics.push(
      facts.dependenciesOnDisk.installed
        ? { id: 'dependencies', label: 'Dependencies', severity: 'PASS', category: 'project', detail: 'node_modules is present and non-empty.' }
        : {
            id: 'dependencies',
            label: 'Dependencies',
            severity: 'BLOCKED',
            category: 'project',
            detail: 'node_modules is missing or empty and this pipeline has no install step.',
            recommendation: 'Run your package manager install, or add an "install" step to the pipeline.',
          },
    );
  }

  return diagnostics;
}

function pipelineDiagnostics(facts: ProjectFacts): Diagnostic[] {
  const config = facts.config.config;
  if (!config) return [];

  const diagnostics: Diagnostic[] = [];
  const detection = detectionFor(facts);
  const known = new Set(supportedStepIds());

  for (const stepId of config.pipeline) {
    const label = `step ${stepId}`;

    if (!known.has(stepId)) {
      diagnostics.push({
        id: `step:${stepId}`,
        label,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: `No implementation is registered for pipeline step "${stepId}".`,
        recommendation: `Known Angular steps are: ${[...known].join(', ')}. This step will report UNSUPPORTED.`,
        steps: [stepId],
      });
      continue;
    }

    const resolved = resolveStep(stepId, detection);
    if (resolved?.status === 'unsupported') {
      diagnostics.push({
        id: `step:${stepId}`,
        label,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: resolved.reason,
        recommendation: 'This step will report UNSUPPORTED. Add the missing script or dependency to enable it.',
        steps: [stepId],
      });
    }
  }

  const unsupportedCount = diagnostics.length;
  diagnostics.push(
    unsupportedCount === 0
      ? {
          id: 'pipeline',
          label: 'Pipeline',
          severity: 'PASS',
          category: 'pipeline',
          detail: `All ${config.pipeline.length} configured step(s) have an implementation for this project.`,
        }
      : {
          id: 'pipeline',
          label: 'Pipeline',
          severity: 'WARNING',
          category: 'pipeline',
          detail: `${unsupportedCount} configured step(s) have no implementation and will report UNSUPPORTED, which fails the run.`,
          recommendation: 'Remove the unsupported steps, or accept that the run will report UNSUPPORTED and exit non-zero.',
        },
  );

  return diagnostics;
}

/**
 * Required environment variables.
 *
 * Presence only — never a value. A missing required variable blocks the run,
 * because the step that needs it cannot do its job and would otherwise fail in
 * a way that looks like a project problem.
 */
function environmentVariableDiagnostics(facts: ProjectFacts, env: NodeJS.ProcessEnv): Diagnostic[] {
  const config = facts.config.config;
  if (!config) return [];

  const required = requiredEnvironmentVariables(config);
  if (required.length === 0) {
    return [
      {
        id: 'env-vars',
        label: 'Environment variables',
        severity: 'PASS',
        category: 'requirements',
        detail: 'This configuration declares no required environment variables.',
      },
    ];
  }

  const missing = required.filter((name) => !(name in env) || env[name] === '');
  const present = required.filter((name) => !missing.includes(name));

  const diagnostics: Diagnostic[] = [];
  if (present.length > 0) {
    diagnostics.push({
      id: 'env-vars:present',
      label: 'Environment variables',
      severity: 'PASS',
      category: 'requirements',
      detail: `${present.length} required variable(s) are present: ${present.join(', ')}.`,
    });
  }

  diagnostics.push(
    missing.length === 0
      ? {
          id: 'env-vars',
          label: 'Environment variables',
          severity: 'PASS',
          category: 'requirements',
          detail: 'All required environment variables are present.',
        }
      : {
          id: 'env-vars',
          label: 'Environment variables',
          severity: 'BLOCKED',
          category: 'requirements',
          detail: `Required environment variable(s) not set: ${missing.join(', ')}.`,
          recommendation:
            `Set ${missing.join(', ')} before running the pipeline. ` +
            'local-ci reports presence only and never reads or prints their values.',
        },
  );

  return diagnostics;
}

/** Runs every preflight check. Never executes a pipeline step. */
export async function runPreflightChecks(cwd: string, options: PreflightOptions = {}): Promise<Diagnostic[]> {
  const facts = options.facts ?? (await collectProjectFacts(cwd));
  const env = options.env ?? process.env;

  return [
    ...nodeDiagnostic(facts),
    ...(await packageManagerDiagnostic(facts, options.skipToolProbes ?? false)),
    ...(await browserDiagnostics(facts, options.browsers)),
    ...projectDiagnostics(facts),
    ...pipelineDiagnostics(facts),
    ...environmentVariableDiagnostics(facts, env),
  ];
}