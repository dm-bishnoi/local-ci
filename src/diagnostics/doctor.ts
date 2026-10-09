/**
 * `local-ci doctor` — a diagnostic of the machine and the project.
 *
 * Doctor is **diagnostic only**. It never executes the pipeline, never installs
 * anything and never modifies the project. Its entire value is that it can be
 * run safely on a machine that is not yet known to be healthy.
 *
 * Every check maps an observation to a severity:
 * - verified good        → `PASS`
 * - off but workable     → `WARNING`
 * - prevents execution   → `BLOCKED`
 * - cannot do at all     → `UNSUPPORTED`
 * - could not determine  → `UNKNOWN`, never `PASS`
 */

import { join } from 'node:path';
import { probeTool } from '../env/tools.js';
import { detectBrowsers, requiresBrowser, type BrowserSearchResult } from '../env/browser.js';
import { resolveStep, supportedStepIds } from '../adapters/angular/commands.js';
import { requiredEnvironmentVariables } from '../config/schema.js';
import { formatTimeout } from '../core/step-runner.js';
import { collectProjectFacts, type ProjectFacts } from './facts.js';
import type { Diagnostic } from './types.js';

export interface DoctorOptions {
  /** Skip probes that execute external tools. Used by tests. */
  skipToolProbes?: boolean;
  /** Environment to read variable *names* from. Values are never inspected. */
  env?: NodeJS.ProcessEnv;
  /** Project facts override, used by tests. */
  facts?: ProjectFacts;
  /**
   * Browser search result override.
   *
   * Browser detection is a filesystem probe of platform-specific install
   * locations; tests inject a result so "no browser found" is deterministic on
   * a machine that happens to have Chrome installed.
   */
  browsers?: BrowserSearchResult;
}

function environmentDiagnostics(probe: typeof probeTool): Promise<Diagnostic[]> {
  return Promise.all([
    probe('npm', ['--version']),
    probe('pnpm', ['--version']),
    probe('yarn', ['--version']),
    probe('git', ['--version']),
  ]).then(([npm, pnpm, yarn, git]) => {
    const diagnostics: Diagnostic[] = [];

    // The declared manager matters; the other two are informational.
    const managers = { npm, pnpm, yarn };
    for (const [name, result] of Object.entries(managers)) {
      if (result.outcome === 'ok') {
        diagnostics.push({
          id: `package-manager:${name}`,
          label: `${name}`,
          severity: 'PASS',
          category: 'environment',
          detail: `${name} ${result.version ?? '(version unknown)'}`,
        });
      } else if (result.outcome === 'blocked') {
        diagnostics.push({
          id: `package-manager:${name}`,
          label: `${name}`,
          severity: 'UNKNOWN',
          category: 'environment',
          detail: result.detail,
        });
      }
    }

    if (git.outcome === 'ok') {
      diagnostics.push({
        id: 'git',
        label: 'Git',
        severity: 'PASS',
        category: 'environment',
        detail: `git ${git.version ?? '(version unknown)'}`,
      });
    } else if (git.outcome === 'blocked') {
      diagnostics.push({
        id: 'git',
        label: 'Git',
        severity: 'UNKNOWN',
        category: 'environment',
        detail: git.detail,
        recommendation: 'Git is optional for local-ci-runner but common in CI. It was not checked here.',
      });
    } else {
      diagnostics.push({
        id: 'git',
        label: 'Git',
        severity: 'WARNING',
        category: 'environment',
        detail: git.detail,
        recommendation: 'Install Git if you want local runs to mirror a CI checkout.',
      });
    }

    return diagnostics;
  });
}

function runtimeDiagnostic(facts: ProjectFacts): Diagnostic {
  const { node } = facts;
  const label = 'Node version';

  if (!node.result) {
    return {
      id: 'node-version',
      label,
      severity: 'WARNING',
      category: 'environment',
      detail: `Node ${process.versions.node} is running, but this project declares no Node requirement to check against.`,
      recommendation: 'Declare engines.node in package.json or add an .nvmrc so the requirement can be verified.',
    };
  }

  const { result, source } = node;
  const declared = source === 'engines' ? node.enginesRange : node.nvmrc;

  if (result.verdict === 'satisfied') {
    return {
      id: 'node-version',
      label,
      severity: 'PASS',
      category: 'environment',
      detail: `Node ${process.versions.node} satisfies ${declared} (from ${source}).`,
    };
  }

  if (result.verdict === 'violated') {
    return {
      id: 'node-version',
      label,
      severity: 'BLOCKED',
      category: 'environment',
      detail: `Node ${process.versions.node} does not satisfy ${declared} (from ${source}).`,
      recommendation: `Switch to a Node version matching ${declared}, for example with "nvm use".`,
    };
  }

  // The requirement exists but could not be evaluated with confidence.
  return {
    id: 'node-version',
    label,
    severity: 'UNKNOWN',
    category: 'environment',
    detail: `Node ${process.versions.node} is running. ${declared} is declared but could not be evaluated: ${result.reason ?? 'unsupported range syntax'}.`,
    recommendation: `Verify manually that Node ${process.versions.node} satisfies ${declared}. local-ci-runner does not claim compatibility it could not check.`,
  };
}

async function browserDiagnostic(facts: ProjectFacts, override?: BrowserSearchResult): Promise<Diagnostic> {
  const label = 'Browser';
  const { browsers } = override ?? await detectBrowsers();
  const found = browsers.map((browser) => `${browser.name}${browser.version ? ` ${browser.version}` : ''}`).join(', ');

  const needed = requiresBrowser({ ...facts.dependencies, ...facts.devDependencies });
  const runsTests = facts.config.config?.pipeline.includes('test') || facts.config.config?.pipeline.includes('coverage');

  if (found !== '') {
    return {
      id: 'browser',
      label,
      severity: 'PASS',
      category: 'environment',
      detail: `Detected ${found} across ${browsers.length} install location(s).`,
    };
  }

  if (needed) {
    return {
      id: 'browser',
      label,
      severity: 'BLOCKED',
      category: 'environment',
      detail: 'This project declares a browser-driven test runner, but no Chrome or Chromium installation was found.',
      recommendation:
        'Install Chrome or Chromium. Karma, Protractor and Cypress all launch a real browser, so browser-driven tests cannot run without one.',
      steps: ['test', 'coverage', 'e2e'],
    };
  }

  if (runsTests) {
    return {
      id: 'browser',
      label,
      severity: 'WARNING',
      category: 'environment',
      detail: 'No Chrome or Chromium installation was found.',
      recommendation:
        'No known browser-driven test runner was detected, so this is unlikely to block the run. If your tests need a real browser, install Chrome or Chromium.',
      steps: ['test', 'coverage', 'e2e'],
    };
  }

  return {
    id: 'browser',
    label,
    severity: 'PASS',
    category: 'environment',
    detail: 'No Chrome or Chromium installation was found, and this project does not appear to require one.',
  };
}

function projectDiagnostics(facts: ProjectFacts): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  diagnostics.push(
    facts.packageJsonExists
      ? facts.packageJsonValid
        ? {
            id: 'package-json',
            label: 'package.json',
            severity: 'PASS',
            category: 'project',
            detail: `Found${facts.packageName ? ` (${facts.packageName})` : ''}.`,
          }
        : {
            id: 'package-json',
            label: 'package.json',
            severity: 'BLOCKED',
            category: 'project',
            detail: `package.json is not valid JSON: ${facts.packageJsonProblem}`,
            recommendation: 'Fix package.json, or delete it if this is not a JavaScript project.',
          }
      : {
          id: 'package-json',
          label: 'package.json',
          severity: 'BLOCKED',
          category: 'project',
          detail: 'No package.json was found in this directory.',
          recommendation: 'Run local-ci-runner from a project root, or run "local-ci-runner init" to create a .local-ci.yml.',
        },
  );

  diagnostics.push(
    facts.config.exists && facts.config.config
      ? {
          id: 'config',
          label: '.local-ci.yml',
          severity: 'PASS',
          category: 'configuration',
          detail: `Valid configuration with ${facts.config.config.pipeline.length} pipeline step(s).`,
        }
      : facts.config.exists
        ? {
            id: 'config',
            label: '.local-ci.yml',
            severity: 'BLOCKED',
            category: 'configuration',
            detail: facts.config.problem ?? 'The configuration could not be used.',
            recommendation: 'Fix the configuration, or run "local-ci-runner init --force" to start fresh.',
          }
        : {
            id: 'config',
            label: '.local-ci.yml',
            severity: 'BLOCKED',
            category: 'configuration',
            detail: 'No .local-ci.yml was found.',
            recommendation: 'Run "local-ci-runner init" to create one.',
          },
  );

  const framework = facts.angular?.framework ?? null;
  if (framework) {
    const declared = facts.angular?.dependencies['@angular/core'] ?? facts.angular?.devDependencies['@angular/core'];
    diagnostics.push({
      id: 'angular',
      label: 'Angular',
      severity: 'PASS',
      category: 'project',
      detail: declared
        ? `Angular detected (@angular/core ${declared}).`
        : 'Angular detected.',
    });
  } else {
    const declaredType = facts.config.config?.project.type;
    diagnostics.push({
      id: 'angular',
      label: 'Angular',
      severity: declaredType && declaredType.toLowerCase() === 'angular' ? 'BLOCKED' : 'WARNING',
      category: 'project',
      detail: `Angular was not detected. ${facts.angular?.reason ?? ''}`.trim(),
      recommendation:
        declaredType && declaredType.toLowerCase() === 'angular'
          ? 'Set project.type in .local-ci.yml to match this project, or add an Angular dependency.'
          : 'This project is not Angular. Other frameworks are not implemented yet.',
    });
  }

  diagnostics.push(
    facts.lockfile
      ? {
          id: 'lockfile',
          label: 'Lockfile',
          severity: 'PASS',
          category: 'project',
          detail: `${facts.lockfile} present; package manager resolved as ${facts.angular?.packageManager ?? 'npm'}.`,
        }
      : {
          id: 'lockfile',
          label: 'Lockfile',
          severity: 'WARNING',
          category: 'project',
          detail: 'No lockfile was found, so the package manager was defaulted to npm.',
          recommendation: 'Commit a lockfile so local runs install exactly what CI installs.',
        },
  );

  // A packageManager field and a lockfile that disagree is a real source of
  // "works locally, fails in CI" drift, so it is reported rather than smoothed over.
  if (facts.declaredPackageManager && facts.angular?.packageManager &&
      facts.declaredPackageManager !== facts.angular.packageManager) {
    diagnostics.push({
      id: 'package-manager-mismatch',
      label: 'Package manager',
      severity: 'WARNING',
      category: 'project',
      detail: `package.json declares ${facts.packageManagerField} but ${facts.lockfile} implies ${facts.angular.packageManager}.`,
      recommendation: 'Make packageManager and the lockfile agree, or local runs will not match CI.',
    });
  }

  diagnostics.push(
    facts.dependenciesOnDisk.installed
      ? {
          id: 'dependencies',
          label: 'Dependencies',
          severity: 'PASS',
          category: 'project',
          detail:
            facts.dependenciesOnDisk.packageCount === null
              ? 'node_modules is present.'
              : `node_modules contains ${facts.dependenciesOnDisk.packageCount} entries.`,
        }
      : {
          id: 'dependencies',
          label: 'Dependencies',
          severity: 'WARNING',
          category: 'project',
          detail: 'node_modules is missing or empty.',
          recommendation: facts.config.config?.pipeline.includes('install')
            ? 'The install step will populate it; no action needed.'
            : 'Add an "install" step to the pipeline, or run your package manager install.',
        },
  );

  return diagnostics;
}

function pipelineDiagnostics(facts: ProjectFacts): Diagnostic[] {
  const config = facts.config.config;
  if (!config) return [];

  const diagnostics: Diagnostic[] = [];
  const known = new Set(supportedStepIds());
  const configured = config.pipeline;

  for (const stepId of configured) {
    if (known.has(stepId)) continue;

    // An id outside the adapter vocabulary is UNSUPPORTED, not ERROR: it may
    // simply be a capability this build does not implement.
    const resolved = resolveStep(stepId, facts.angular ?? { detected: false, framework: null, angularConfig: null, packageJson: null, packageManager: null, lockfile: null, packageManagerIsDefault: true, scripts: {}, dependencies: {}, devDependencies: {} });
    if (resolved?.status === 'unsupported') {
      diagnostics.push({
        id: `step:${stepId}`,
        label: stepId,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: resolved.reason,
        recommendation: 'Remove this step from the pipeline, or add the capability that implements it.',
        steps: [stepId],
      });
      continue;
    }

    diagnostics.push({
      id: `step:${stepId}`,
      label: stepId,
      severity: 'UNSUPPORTED',
      category: 'pipeline',
      detail: `No implementation is registered for pipeline step "${stepId}".`,
      recommendation: `Known Angular steps are: ${[...known].join(', ')}.`,
      steps: [stepId],
    });
  }

  for (const stepId of configured) {
    if (!known.has(stepId)) continue;
    const resolved = resolveStep(stepId, facts.angular ?? { detected: false, framework: null, angularConfig: null, packageJson: null, packageManager: null, lockfile: null, packageManagerIsDefault: true, scripts: {}, dependencies: {}, devDependencies: {} });
    if (resolved?.status === 'unsupported') {
      diagnostics.push({
        id: `step:${stepId}`,
        label: stepId,
        severity: 'UNSUPPORTED',
        category: 'pipeline',
        detail: resolved.reason,
        recommendation: 'Add the missing script or dependency to enable this step.',
        steps: [stepId],
      });
    }
  }

  if (config.settings.timeoutMs !== undefined) {
    diagnostics.push({
      id: 'timeout',
      label: 'Timeout',
      severity: 'PASS',
      category: 'pipeline',
      detail: `Each step is limited to ${formatTimeout(config.settings.timeoutMs)}.`,
    });
  }

  diagnostics.push({
    id: 'fail-fast',
    label: 'failFast',
    severity: 'PASS',
    category: 'pipeline',
    detail: config.settings.failFast ? 'Enabled: the run stops at the first failing step.' : 'Disabled: every configured step runs.',
  });

  return diagnostics;
}

/**
 * Environment-variable requirements.
 *
 * Reports **presence only**. Values are never read, never compared and never
 * emitted — a diagnostic that could print a database URL is a diagnostic that
 * will eventually leak one.
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

  if (missing.length === 0) {
    return [
      {
        id: 'env-vars',
        label: 'Environment variables',
        severity: 'PASS',
        category: 'requirements',
        detail: `All ${required.length} required variable(s) are present.`,
      },
    ];
  }

  // A required variable named in .env.example is a strong hint that a setup
  // step was missed; anything else may simply be a CI-only secret.
  const hinted = missing.filter((name) => facts.envExampleNames.includes(name));
  const unhinted = missing.filter((name) => !facts.envExampleNames.includes(name));

  const diagnostics: Diagnostic[] = [
    {
      id: 'env-vars',
      label: 'Environment variables',
      severity: 'BLOCKED',
      category: 'requirements',
      detail: `${missing.length} required variable(s) are not set: ${missing.join(', ')}.`,
      recommendation:
        `Set ${missing.join(', ')} in your shell before running the pipeline. ` +
        'local-ci-runner reports presence only and never reads or prints their values.',
    },
  ];

  if (hinted.length > 0) {
    diagnostics.push({
      id: 'env-vars:example',
      label: 'Environment variables',
      severity: 'WARNING',
      category: 'requirements',
      detail: `${hinted.join(', ')} appear(s) in .env.example but ${hinted.length === 1 ? 'is' : 'are'} not set.`,
      recommendation: `Copy .env.example to .env and fill in ${hinted.join(', ')}. local-ci-runner does not load .env for you.`,
    });
  }

  if (unhinted.length > 0) {
    diagnostics.push({
      id: 'env-vars:unhinted',
      label: 'Environment variables',
      severity: 'WARNING',
      category: 'requirements',
      detail: `${unhinted.join(', ')} ${unhinted.length === 1 ? 'is' : 'are'} required but not listed in .env.example.`,
      recommendation: 'Confirm these are intended for local runs rather than CI-only secrets.',
    });
  }

  return diagnostics;
}

/** Runs every doctor check. Diagnostic only — never executes the pipeline. */
export async function runDoctorChecks(cwd: string, options: DoctorOptions = {}): Promise<Diagnostic[]> {
  const facts = options.facts ?? (await collectProjectFacts(cwd));
  const env = options.env ?? process.env;

  const noToolProbes = async (): Promise<Diagnostic[]> => [];
  const toolDiagnostics = options.skipToolProbes
    ? await noToolProbes()
    : await environmentDiagnostics((name, args) => probeTool(name, args));

  return [
    {
      id: 'os',
      label: 'Operating system',
      severity: 'PASS',
      category: 'environment',
      detail: `${process.platform} ${process.arch}`,
    },
    runtimeDiagnostic(facts),
    ...toolDiagnostics,
    await browserDiagnostic(facts, options.browsers),
    ...projectDiagnostics(facts),
    ...pipelineDiagnostics(facts),
    ...environmentVariableDiagnostics(facts, env),
  ];
}

/** Absolute path of a project file, for diagnostics that mention one. */
export function projectPath(cwd: string, name: string): string {
  return join(cwd, name);
}