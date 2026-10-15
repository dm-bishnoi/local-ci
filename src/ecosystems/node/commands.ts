import type { AvailableCapability, Capability, Requirement } from '../types.js';
import type { NodeDetection, NodeManager } from './detect.js';

/**
 * Node capability resolution.
 *
 * Precedence for every step: an explicit package.json script, then (outside
 * Angular) a tool inferred from declared dependencies *and* its configuration,
 * then a framework fallback, then `unavailable` with a reason. Nothing is
 * inferred from a framework name alone.
 */

export const NODE_STEP_NAMES: Record<string, string> = {
  install: 'Dependencies',
  typecheck: 'TypeScript',
  test: 'Unit Tests',
  coverage: 'Coverage',
  lint: 'Lint',
  format: 'Format',
  build: 'Production Build',
  security: 'Security',
};

export const NODE_STEP_IDS: readonly string[] = ['install', 'typecheck', 'test', 'coverage', 'lint', 'format', 'build', 'security'];

const COVERAGE_PROVIDERS = [
  'karma-coverage',
  'nyc',
  'jest',
  'c8',
  '@vitest/coverage-v8',
  '@vitest/coverage-istanbul',
  '@vitest/coverage-c8',
];

const toolReq = (name: string): Requirement => ({ kind: 'tool', name });
const depsReq = (detail: string): Requirement => ({ kind: 'dependencies', detail });

function unavailable(reason: string): Capability {
  return { state: 'unavailable', reason };
}

function hasScript(d: NodeDetection, name: string): boolean {
  return Object.hasOwn(d.scripts, name) && d.scripts[name]!.trim() !== '';
}

function declared(d: NodeDetection, name: string): boolean {
  return name in d.dependencies || name in d.devDependencies;
}

function hasFileMatching(d: NodeDetection, pattern: RegExp): string | undefined {
  for (const name of d.files) if (pattern.test(name)) return name;
  return undefined;
}

function isAngular(d: NodeDetection): boolean {
  return d.frameworks.includes('angular');
}

/** `<manager> run <script> [extra]`. npm needs `--` to forward flags. */
export function scriptCapability(d: NodeDetection, script: string, extra: readonly string[] = []): AvailableCapability {
  const manager = d.packageManager;
  const forwarded = extra.length > 0 && manager === 'npm' ? ['--', ...extra] : [...extra];
  return {
    state: 'available',
    command: manager,
    args: ['run', script, ...forwarded],
    description: `${manager} run ${script}`,
    source: 'script',
    evidence: `package.json script "${script}"`,
    requires: [toolReq(manager), depsReq('project dependencies (node_modules)')],
  };
}

/** Runs a locally installed binary without any chance of fetching it from a registry. */
export function localBinCommand(
  manager: NodeManager,
  bin: string,
  args: readonly string[],
): { command: string; args: string[]; description: string } {
  switch (manager) {
    case 'npm':
      return { command: 'npx', args: ['--no-install', bin, ...args], description: `npx --no-install ${bin}` };
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...args], description: `pnpm exec ${bin}` };
    case 'yarn':
      return { command: 'yarn', args: ['exec', bin, ...args], description: `yarn exec ${bin}` };
    case 'bun':
      return { command: 'bun', args: ['x', '--no-install', bin, ...args], description: `bun x --no-install ${bin}` };
  }
}

function inferred(
  d: NodeDetection,
  bin: string,
  args: readonly string[],
  evidence: string,
  source: 'inferred' | 'framework' = 'inferred',
): AvailableCapability {
  const local = localBinCommand(d.packageManager, bin, args);
  return {
    state: 'available',
    ...local,
    source,
    evidence,
    requires: [toolReq(local.command), depsReq(`${bin} (node_modules/.bin)`)],
  };
}

export function resolveInstall(d: NodeDetection): Capability {
  const manager = d.packageManager;
  const frozen = d.lockfile !== null;
  const requires: Requirement[] = [toolReq(manager)];
  let args: string[];
  let description: string;

  switch (manager) {
    case 'npm':
      // `npm ci` requires a lockfile and fails loudly without one.
      args = frozen ? ['ci'] : ['install'];
      description = frozen ? 'npm ci' : 'npm install (no lockfile found)';
      break;
    case 'pnpm':
      args = frozen ? ['install', '--frozen-lockfile'] : ['install'];
      description = frozen ? 'pnpm install --frozen-lockfile' : 'pnpm install';
      break;
    case 'yarn':
      args = frozen ? ['install', d.yarnBerry ? '--immutable' : '--frozen-lockfile'] : ['install'];
      description = `yarn ${args.join(' ')}`;
      break;
    case 'bun':
      args = frozen ? ['install', '--frozen-lockfile'] : ['install'];
      description = `bun ${args.join(' ')}`;
      break;
  }
  if (d.lockfile) requires.push({ kind: 'lockfile', file: d.lockfile });
  return {
    state: 'available',
    command: manager,
    args,
    description,
    source: 'builtin',
    evidence: d.lockfile ? `lockfile ${d.lockfile}` : 'no lockfile',
    requires,
  };
}

export function resolveTypecheck(d: NodeDetection): Capability {
  if (hasScript(d, 'typecheck')) return scriptCapability(d, 'typecheck');
  if (isAngular(d)) {
    return unavailable(
      'No "typecheck" script in package.json. Angular type-checks as part of "ng build"; ' +
        'add a "typecheck" script if you want it as a separate step.',
    );
  }
  if (declared(d, 'vue-tsc') && d.tsconfig.exists) {
    return inferred(d, 'vue-tsc', ['--noEmit'], 'vue-tsc declared + tsconfig.json');
  }
  if (declared(d, 'typescript') && d.tsconfig.exists) {
    if (d.tsconfig.solutionStyle) {
      return unavailable(
        'tsconfig.json is solution-style (files: [] + references); a plain "tsc --noEmit" would check nothing. ' +
          'Add a "typecheck" script (for example "tsc -b").',
      );
    }
    return inferred(d, 'tsc', ['--noEmit', '-p', 'tsconfig.json'], 'typescript declared + tsconfig.json');
  }
  return unavailable(
    'No "typecheck" script in package.json, and no inferable type checker (needs "typescript" or "vue-tsc" declared and a tsconfig.json).',
  );
}

export function resolveTest(d: NodeDetection): Capability {
  if (hasScript(d, 'test')) return scriptCapability(d, 'test');
  if (isAngular(d)) {
    return unavailable('No "test" script in package.json. Add one (for example "test": "ng test") to run unit tests.');
  }
  const vitest = declared(d, 'vitest');
  const jest = declared(d, 'jest');
  if (vitest && jest) {
    return unavailable('No "test" script, and both vitest and jest are declared, so the test runner is ambiguous. Add a "test" script.');
  }
  if (vitest) {
    const config = hasFileMatching(d, /^vitest\.config\./) ?? hasFileMatching(d, /^vite\.config\./);
    if (config) return inferred(d, 'vitest', ['run'], `vitest declared + ${config}`);
  }
  if (jest) {
    const config = hasFileMatching(d, /^jest\.config\./) ?? ('jest' in d.manifest ? 'package.json "jest"' : undefined);
    if (config) return inferred(d, 'jest', ['--ci'], `jest declared + ${config}`);
  }
  return unavailable('No "test" script in package.json, and no test runner with a configuration (vitest or jest) was found.');
}

export function resolveCoverage(d: NodeDetection): Capability {
  if (hasScript(d, 'coverage')) return scriptCapability(d, 'coverage');
  const all = { ...d.dependencies, ...d.devDependencies };
  if (hasScript(d, 'test') && COVERAGE_PROVIDERS.some((provider) => provider in all)) {
    return scriptCapability(d, 'test', ['--coverage']);
  }
  return unavailable(
    'Coverage cannot be determined safely: no "coverage" script, and no known coverage provider ' +
      '(karma-coverage, nyc, jest, c8 or @vitest/coverage-*) was found in dependencies.',
  );
}

export function resolveLint(d: NodeDetection): Capability {
  if (hasScript(d, 'lint')) return scriptCapability(d, 'lint');
  if (isAngular(d)) {
    return unavailable('No "lint" script in package.json. Add one (for example "lint": "ng lint") to lint this project.');
  }
  if (declared(d, 'eslint')) {
    const config =
      hasFileMatching(d, /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/) ??
      hasFileMatching(d, /^\.eslintrc(\.|$)/) ??
      ('eslintConfig' in d.manifest ? 'package.json "eslintConfig"' : undefined);
    if (config) return inferred(d, 'eslint', ['.'], `eslint declared + ${config}`);
  }
  return unavailable('No "lint" script in package.json, and no ESLint with a configuration was found.');
}

export function resolveFormat(d: NodeDetection): Capability {
  if (hasScript(d, 'format:check')) return scriptCapability(d, 'format:check');
  if (hasScript(d, 'format')) {
    return unavailable(
      'package.json has a "format" script, but it may rewrite files, so it is not run as a check. ' +
        'Add a non-mutating "format:check" script.',
    );
  }
  if (isAngular(d)) return unavailable('No "format:check" script in package.json.');
  if (declared(d, 'prettier')) {
    const config =
      hasFileMatching(d, /^\.prettierrc(\.|$)/) ??
      hasFileMatching(d, /^prettier\.config\./) ??
      ('prettier' in d.manifest ? 'package.json "prettier"' : undefined);
    if (config) return inferred(d, 'prettier', ['--check', '.'], `prettier declared + ${config}`);
  }
  return unavailable('No "format:check" script in package.json, and no Prettier with a configuration was found.');
}

export function resolveBuild(d: NodeDetection): Capability {
  if (hasScript(d, 'build')) return scriptCapability(d, 'build');
  if (d.angularConfig !== null && declared(d, '@angular/cli')) {
    return inferred(d, 'ng', ['build'], 'angular.json + @angular/cli declared', 'framework');
  }
  return unavailable(
    isAngular(d)
      ? 'No "build" script in package.json and the Angular CLI could not be resolved locally.'
      : 'No "build" script in package.json.',
  );
}

export function resolveSecurity(d: NodeDetection): Capability {
  switch (d.packageManager) {
    case 'npm':
    case 'pnpm':
      return {
        state: 'available',
        command: d.packageManager,
        args: ['audit', '--json'],
        description: `${d.packageManager} audit --json`,
        source: 'builtin',
        requires: [toolReq(d.packageManager)],
      };
    case 'yarn':
      return unavailable('Dependency auditing is not supported for yarn: its audit command differs between yarn 1 and Yarn Berry.');
    case 'bun':
      return unavailable('Dependency auditing is not supported for bun.');
  }
}

const RESOLVERS: Record<string, (d: NodeDetection) => Capability> = {
  install: resolveInstall,
  typecheck: resolveTypecheck,
  test: resolveTest,
  coverage: resolveCoverage,
  lint: resolveLint,
  format: resolveFormat,
  build: resolveBuild,
  security: resolveSecurity,
};

export function resolveNodeStep(stepId: string, d: NodeDetection): Capability | undefined {
  return Object.hasOwn(RESOLVERS, stepId) ? RESOLVERS[stepId]!(d) : undefined;
}

export function resolveNodeCapabilities(d: NodeDetection): Record<string, Capability> {
  const result: Record<string, Capability> = {};
  for (const id of NODE_STEP_IDS) result[id] = resolveNodeStep(id, d)!;
  return result;
}
