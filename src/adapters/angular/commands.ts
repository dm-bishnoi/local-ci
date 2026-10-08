import type { AngularDetection, PackageManager } from './detect.js';
import { hasAngularCli } from './detect.js';

/**
 * Translates a logical pipeline step id into a concrete local command.
 *
 * Every mapping is either resolved to an executable + argument vector, or
 * reported as unsupported with a reason the user can act on. Nothing here ever
 * guesses that a capability exists, and nothing is ever reported as passing
 * without having run.
 */

export type ResolvedCommand =
  | { status: 'resolved'; command: string; args: string[]; description: string }
  | { status: 'unsupported'; reason: string };

/** Coverage providers that indicate `--coverage` is a real flag for this project. */
const COVERAGE_PROVIDERS = [
  'karma-coverage',
  'nyc',
  'jest',
  'c8',
  '@vitest/coverage-v8',
  '@vitest/coverage-istanbul',
  '@vitest/coverage-c8',
];

/** Logical step id -> display name used in reports. */
export const STEP_NAMES: Record<string, string> = {
  install: 'Dependencies',
  typecheck: 'TypeScript',
  test: 'Unit Tests',
  coverage: 'Coverage',
  lint: 'Lint',
  build: 'Production Build',
  security: 'Security',
};

/** Runs a package.json script: `npm run build`, `pnpm run build`, `yarn run build`. */
export function runScriptCommand(manager: PackageManager, script: string, extraArgs: readonly string[] = []): ResolvedCommand {
  const args = ['run', script, ...extraArgs];
  return { status: 'resolved', command: manager, args, description: `${manager} run ${script}` };
}

/**
 * Runs the local Angular CLI binary without any chance of fetching a package
 * from a registry. `npm` uses `npx --no-install`; the others already resolve
 * only from the project.
 */
export function localNgCommand(manager: PackageManager, args: readonly string[]): ResolvedCommand {
  switch (manager) {
    case 'npm':
      return {
        status: 'resolved',
        command: 'npx',
        args: ['--no-install', 'ng', ...args],
        description: 'npx --no-install ng',
      };
    case 'pnpm':
      return { status: 'resolved', command: 'pnpm', args: ['exec', 'ng', ...args], description: 'pnpm exec ng' };
    case 'yarn':
      return { status: 'resolved', command: 'yarn', args: ['exec', 'ng', ...args], description: 'yarn exec ng' };
  }
}

/**
 * Argument forwarding differs per package manager: npm needs `--` to pass flags
 * through to the underlying script, pnpm and yarn forward them directly.
 */
export function coverageFlagArgs(manager: PackageManager): string[] {
  return manager === 'npm' ? ['--', '--coverage'] : ['--coverage'];
}

function hasScript(detection: AngularDetection, name: string): boolean {
  return typeof detection.scripts[name] === 'string' && detection.scripts[name].trim() !== '';
}

function hasCoverageProvider(detection: AngularDetection): boolean {
  const all = { ...detection.dependencies, ...detection.devDependencies };
  return COVERAGE_PROVIDERS.some((provider) => provider in all);
}

function unsupported(reason: string): ResolvedCommand {
  return { status: 'unsupported', reason };
}

export function resolveInstall(detection: AngularDetection): ResolvedCommand {
  const manager = detection.packageManager ?? 'npm';
  const frozen = detection.lockfile !== null;

  switch (manager) {
    case 'npm':
      return {
        status: 'resolved',
        command: 'npm',
        // `npm ci` requires a lockfile and fails loudly without one.
        args: frozen ? ['ci'] : ['install'],
        description: frozen ? 'npm ci' : 'npm install (no lockfile found)',
      };
    case 'pnpm':
      return {
        status: 'resolved',
        command: 'pnpm',
        args: frozen ? ['install', '--frozen-lockfile'] : ['install'],
        description: frozen ? 'pnpm install --frozen-lockfile' : 'pnpm install',
      };
    case 'yarn':
      return {
        status: 'resolved',
        command: 'yarn',
        args: frozen ? ['install', '--frozen-lockfile'] : ['install'],
        description: frozen ? 'yarn install --frozen-lockfile' : 'yarn install',
      };
  }
}

export function resolveTypecheck(detection: AngularDetection): ResolvedCommand {
  if (hasScript(detection, 'typecheck')) return runScriptCommand(detection.packageManager ?? 'npm', 'typecheck');
  return unsupported(
    'No "typecheck" script in package.json. Angular type-checks as part of "ng build"; ' +
      'add a "typecheck" script if you want it as a separate step.',
  );
}

export function resolveTest(detection: AngularDetection): ResolvedCommand {
  if (hasScript(detection, 'test')) return runScriptCommand(detection.packageManager ?? 'npm', 'test');
  // Guessing a test builder here would risk launching a browser-driven runner
  // with unknown flags, so the adapter declines instead.
  return unsupported(
    'No "test" script in package.json. Add one (for example "test": "ng test") to run unit tests.',
  );
}

export function resolveCoverage(detection: AngularDetection): ResolvedCommand {
  const manager = detection.packageManager ?? 'npm';

  if (hasScript(detection, 'coverage')) return runScriptCommand(manager, 'coverage');

  if (hasScript(detection, 'test') && hasCoverageProvider(detection)) {
    return runScriptCommand(manager, 'test', coverageFlagArgs(manager));
  }

  return unsupported(
    'Coverage cannot be determined safely: no "coverage" script, and no known coverage provider ' +
      '(karma-coverage, nyc, jest, c8 or @vitest/coverage-*) was found in dependencies.',
  );
}

export function resolveLint(detection: AngularDetection): ResolvedCommand {
  if (hasScript(detection, 'lint')) return runScriptCommand(detection.packageManager ?? 'npm', 'lint');
  return unsupported(
    'No "lint" script in package.json. Add one (for example "lint": "ng lint") to lint this project.',
  );
}

export function resolveBuild(detection: AngularDetection): ResolvedCommand {
  const manager = detection.packageManager ?? 'npm';
  if (hasScript(detection, 'build')) return runScriptCommand(manager, 'build');
  // The Angular CLI is a safe local-only fallback when the workspace is real.
  if (detection.angularConfig !== null && hasAngularCli(detection)) {
    return localNgCommand(manager, ['build']);
  }
  return unsupported('No "build" script in package.json and the Angular CLI could not be resolved locally.');
}

export function resolveSecurity(detection: AngularDetection): ResolvedCommand {
  const manager = detection.packageManager;
  if (manager === null) {
    return unsupported('No package manager could be determined, so no dependency audit can run.');
  }

  switch (manager) {
    case 'npm':
      return {
        status: 'resolved',
        command: 'npm',
        args: ['audit', '--json'],
        description: 'npm audit --json',
      };
    case 'pnpm':
      return {
        status: 'resolved',
        command: 'pnpm',
        args: ['audit', '--json'],
        description: 'pnpm audit --json',
      };
    case 'yarn':
      // Yarn's audit support differs between v1 and Berry and cannot be
      // detected reliably without running it.
      return unsupported(
        'Dependency auditing is not supported for yarn: its audit command differs between yarn 1 and Yarn Berry.',
      );
  }
}

const RESOLVERS: Record<string, (detection: AngularDetection) => ResolvedCommand> = {
  install: resolveInstall,
  typecheck: resolveTypecheck,
  test: resolveTest,
  coverage: resolveCoverage,
  lint: resolveLint,
  build: resolveBuild,
  security: resolveSecurity,
};

/** Logical pipeline ids this adapter can address. */
export function supportedStepIds(): string[] {
  return Object.keys(RESOLVERS);
}

export function resolveStep(stepId: string, detection: AngularDetection): ResolvedCommand | undefined {
  const resolver = RESOLVERS[stepId];
  return resolver ? resolver(detection) : undefined;
}