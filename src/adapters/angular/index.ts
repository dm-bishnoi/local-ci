/**
 * Angular adapter.
 *
 * The only Angular-aware code in the project. The core engine imports nothing
 * from here; it only receives `PipelineStep` objects.
 */
export {
  ANGULAR_CONFIG_FILE,
  PACKAGE_JSON_FILE,
  detectAngularProject,
  detectPackageManager,
  hasAngularCli,
  type AngularDetection,
  type PackageJson,
  type PackageManager,
} from './detect.js';

export {
  STEP_NAMES,
  coverageFlagArgs,
  localNgCommand,
  resolveBuild,
  resolveCoverage,
  resolveInstall,
  resolveLint,
  resolveSecurity,
  resolveStep,
  resolveTest,
  resolveTypecheck,
  runScriptCommand,
  supportedStepIds,
  type ResolvedCommand,
} from './commands.js';

export {
  ANGULAR_STEP_IDS,
  createAngularStep,
  createAngularSteps,
  describeMissingAngular,
  registerAngularSteps,
  type AngularAdapterOptions,
} from './steps.js';