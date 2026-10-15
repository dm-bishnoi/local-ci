import { join } from 'node:path';
import { listDir, pathExists, readJson } from '../fs.js';
import { pipelineFromCapabilities } from '../pipeline.js';
import type { AvailableCapability, Capability, DefaultPipeline, Detection, EcosystemAdapter, Requirement } from '../types.js';

/**
 * Composer-based PHP projects.
 *
 * Checks: `install` (from composer.lock only), `test` (a composer `test` script,
 * else PHPUnit with a config file), `analyse` (PHPStan with a config file) and
 * `format` (PHP-CS-Fixer in `--dry-run` or PHP_CodeSniffer, neither of which
 * rewrites files). Optional tools are never assumed: each needs its
 * configuration file *and* to be declared in composer.json or already present
 * in vendor/bin.
 */

export interface PhpDetection extends Detection {
  ecosystem: 'php';
  lockfile: boolean;
  scripts: Record<string, string>;
  binDir: string;
  /** Lower bound of composer.json `require.php`, when it has a single one. */
  phpAtLeast: string | null;
  /** Tools (by binary name) found in vendor/bin. */
  installedBinaries: string[];
}

const STEP_IDS = ['install', 'test', 'analyse', 'format'] as const;
const INIT_ORDER = ['install', 'test', 'analyse', 'format'] as const;
const STEP_NAMES: Record<string, string> = {
  install: 'Dependencies',
  test: 'Unit Tests',
  analyse: 'Static Analysis',
  format: 'Format',
};

/** Composer kills scripts after 300 s by default; local-ci's own timeout must be the only one. */
const COMPOSER_ENV = { COMPOSER_PROCESS_TIMEOUT: '0', COMPOSER_NO_INTERACTION: '1', COMPOSER_DISABLE_XDEBUG_WARN: '1' } as const;
const BATCH_UNSAFE_PATH = /[%!^&|<>"\r\n]/;

const tool = (name: string): Requirement => ({ kind: 'tool', name });

function lowerBound(constraint: string): string | null {
  const clauses = constraint.split('||');
  if (clauses.length !== 1) return null;
  return /^\s*(?:>=|\^|~)?\s*(\d+\.\d+(?:\.\d+)?)/.exec(clauses[0]!)?.[1] ?? null;
}

function exists(files: ReadonlySet<string>, ...names: string[]): string | undefined {
  return names.find((name) => files.has(name));
}

async function detect(dir: string): Promise<PhpDetection> {
  const base = {
    ecosystem: 'php' as const,
    root: dir,
    confidence: 'strong' as const,
    capabilities: {} as Record<string, Capability>,
    lockfile: false,
    scripts: {} as Record<string, string>,
    binDir: 'vendor/bin',
    phpAtLeast: null as string | null,
    installedBinaries: [] as string[],
  };

  const parsed = await readJson(join(dir, 'composer.json'));
  if ('error' in parsed) {
    return {
      ...base,
      detected: false,
      evidence: [],
      reason: parsed.error === 'missing' ? `No composer.json found in ${dir}.` : `composer.json is not valid JSON: ${parsed.error}`,
    };
  }
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ...base, detected: false, evidence: ['composer.json'], reason: 'composer.json does not contain a JSON object.' };
  }

  const manifest = parsed.value as {
    require?: Record<string, unknown>;
    'require-dev'?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
    config?: { 'bin-dir'?: unknown };
  };
  const files = new Set(await listDir(dir));
  const lockfile = files.has('composer.lock');
  const declared = new Set([...Object.keys(manifest.require ?? {}), ...Object.keys(manifest['require-dev'] ?? {})]);
  const packages = [...declared].filter((name) => name !== 'php' && !name.startsWith('ext-') && !name.startsWith('lib-'));
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
    if (typeof value === 'string' || Array.isArray(value)) scripts[name] = Array.isArray(value) ? value.join(' && ') : value;
  }
  const configuredBin = manifest.config?.['bin-dir'];
  const binDir = typeof configuredBin === 'string' && /^[A-Za-z0-9_./-]+$/.test(configuredBin) && !configuredBin.split('/').includes('..') ? configuredBin.replace(/\/+$/, '') : 'vendor/bin';

  const windows = process.platform === 'win32';
  const binaries = ['phpunit', 'phpstan', 'php-cs-fixer', 'phpcs'];
  const installedBinaries: string[] = [];
  for (const name of binaries) {
    if (await pathExists(join(dir, binDir, windows ? `${name}.bat` : name))) installedBinaries.push(name);
  }

  const detection: PhpDetection = {
    ...base,
    detected: true,
    evidence: ['composer.json', ...(lockfile ? ['composer.lock'] : [])],
    lockfile,
    scripts,
    binDir,
    installedBinaries,
  };
  detection.declaresDependencies = packages.length > 0;
  detection.dependenciesOnDisk = await pathExists(join(dir, 'vendor', 'autoload.php'));
  detection.dependenciesLabel = 'vendor/ (composer install)';
  detection.installStepIds = ['install'];

  if (windows && BATCH_UNSAFE_PATH.test(dir)) {
    detection.problem = 'The project path contains characters cmd.exe interprets (% ! ^ & | < > "), so the vendor/bin batch shims cannot be started safely. Move the project to a plainer path.';
    return detection;
  }

  const phpVersion = typeof manifest.require?.['php'] === 'string' ? (manifest.require['php'] as string) : null;
  const atLeast = phpVersion ? lowerBound(phpVersion) : null;
  detection.phpAtLeast = atLeast;
  const warnings: string[] = [];
  if (phpVersion && atLeast === null) warnings.push(`composer.json requires php "${phpVersion}", which has no single lower bound this version can check, so the PHP version is not verified.`);
  if (warnings.length > 0) detection.warnings = warnings;

  const php = (extra: Requirement[]): Requirement[] => [
    tool('php'),
    ...(atLeast ? ([{ kind: 'version', tool: 'php', atLeast, source: 'composer.json require.php' }] as Requirement[]) : []),
    ...extra,
  ];
  const needsVendor = (what: string): Requirement[] => (detection.declaresDependencies ? [{ kind: 'dependencies', detail: what }] : []);
  const binPath = (name: string): string => join(dir, binDir, windows ? `${name}.bat` : name);
  const has = (name: string): boolean => declared.has(name) || installedBinaries.includes(name.split('/').pop()!);

  const run = (command: string, args: string[], source: AvailableCapability['source'], evidence: string, requires: Requirement[], env?: Record<string, string>): AvailableCapability => ({
    state: 'available',
    source,
    command,
    args,
    description: command === 'composer' ? `composer ${args.slice(0, 2).join(' ')}` : `${binDir}/${command.split(/[\\/]/).pop()!.replace(/\.bat$/, '')}`,
    evidence,
    requires,
    ...(env ? { env } : {}),
  });

  /** A tool that is declared and whose vendor/ is installed, but whose binary is absent (installed with --no-dev), cannot run. */
  const guarded = (capability: AvailableCapability, bin: string): Capability =>
    detection.dependenciesOnDisk && !installedBinaries.includes(bin)
      ? {
          state: 'unavailable',
          reason: `${bin} is declared in composer.json, but ${binDir}/${bin} does not exist although vendor/ is installed (installed with --no-dev?). Run "composer install" with dev dependencies.`,
        }
      : capability;

  const capabilities: Record<string, Capability> = {};

  capabilities['install'] = lockfile
    ? run('composer', ['install', '--no-interaction', '--no-progress'], 'builtin', 'composer.lock', php([tool('composer'), { kind: 'lockfile', file: 'composer.lock' }]), { ...COMPOSER_ENV })
    : {
        state: 'unavailable',
        reason: 'No composer.lock was found, and "composer install" without one would create it and resolve versions CI may not use. Commit a composer.lock first.',
      };

  const phpunitConfig = exists(files, 'phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml');
  if (scripts['test'] !== undefined) {
    capabilities['test'] = run('composer', ['run-script', 'test', '--no-interaction'], 'script', 'composer.json script "test"', php([tool('composer'), ...needsVendor('vendor/ dependencies')]), { ...COMPOSER_ENV });
  } else if (phpunitConfig && has('phpunit/phpunit')) {
    capabilities['test'] = guarded(
      run(binPath('phpunit'), ['--do-not-cache-result'], 'inferred', `${phpunitConfig} + phpunit/phpunit`, php(needsVendor(`${binDir}/phpunit`))),
      'phpunit',
    );
  } else {
    capabilities['test'] = {
      state: 'unavailable',
      reason: phpunitConfig
        ? 'phpunit.xml exists, but phpunit/phpunit is neither in composer.json nor in vendor/bin, so PHPUnit is not assumed to be installed.'
        : 'No composer "test" script, and no PHPUnit configuration (phpunit.xml or phpunit.xml.dist) was found.',
    };
  }

  const phpstanConfig = exists(files, 'phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon');
  capabilities['analyse'] =
    phpstanConfig && has('phpstan/phpstan')
      ? guarded(
          run(binPath('phpstan'), ['analyse', '--no-progress', '--no-interaction'], 'inferred', `${phpstanConfig} + phpstan/phpstan`, php(needsVendor(`${binDir}/phpstan`))),
          'phpstan',
        )
      : {
          state: 'unavailable',
          reason: phpstanConfig
            ? 'A PHPStan configuration exists, but phpstan/phpstan is neither in composer.json nor in vendor/bin.'
            : 'No PHPStan configuration (phpstan.neon or phpstan.neon.dist) was found.',
        };

  const csFixerConfig = exists(files, '.php-cs-fixer.php', '.php-cs-fixer.dist.php');
  const phpcsConfig = exists(files, 'phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml', '.phpcs.xml.dist');
  if (csFixerConfig && has('friendsofphp/php-cs-fixer')) {
    // --dry-run never rewrites; --using-cache=no keeps it from leaving a cache file in the project.
    capabilities['format'] = guarded(
      run(binPath('php-cs-fixer'), ['fix', '--dry-run', '--diff', '--using-cache=no', '--no-interaction'], 'inferred', `${csFixerConfig} + friendsofphp/php-cs-fixer`, php(needsVendor(`${binDir}/php-cs-fixer`))),
      'php-cs-fixer',
    );
  } else if (phpcsConfig && has('squizlabs/php_codesniffer')) {
    capabilities['format'] = guarded(
      run(binPath('phpcs'), ['--no-colors'], 'inferred', `${phpcsConfig} + squizlabs/php_codesniffer`, php(needsVendor(`${binDir}/phpcs`))),
      'phpcs',
    );
  } else {
    capabilities['format'] = {
      state: 'unavailable',
      reason:
        csFixerConfig || phpcsConfig
          ? 'A formatter configuration exists, but its tool (friendsofphp/php-cs-fixer or squizlabs/php_codesniffer) is neither in composer.json nor in vendor/bin.'
          : 'No PHP-CS-Fixer (.php-cs-fixer.php) or PHP_CodeSniffer (phpcs.xml) configuration was found.',
    };
  }

  detection.capabilities = capabilities;
  return detection;
}

/** `steps.<id>.script` in a PHP project is a composer script. */
function resolveScript(script: string, detection: Detection): Capability {
  const d = detection as PhpDetection;
  if (!Object.hasOwn(d.scripts, script)) {
    return { state: 'unavailable', reason: `composer.json has no script named "${script}".` };
  }
  return {
    state: 'available',
    source: 'script',
    command: 'composer',
    args: ['run-script', script, '--no-interaction'],
    description: `composer run-script ${script}`,
    env: { ...COMPOSER_ENV },
    evidence: `composer.json script "${script}"`,
    requires: [
      tool('php'),
      ...(d.phpAtLeast ? ([{ kind: 'version', tool: 'php', atLeast: d.phpAtLeast, source: 'composer.json require.php' }] as Requirement[]) : []),
      tool('composer'),
      ...(d.declaresDependencies ? ([{ kind: 'dependencies', detail: 'vendor/ dependencies' }] as Requirement[]) : []),
    ],
  };
}

function defaultPipeline(detection: Detection): DefaultPipeline {
  const d = detection as PhpDetection;
  const result = pipelineFromCapabilities(detection, INIT_ORDER);
  // Install only what is missing, from the lock file: nothing is reinstalled over a working vendor/.
  if (result.pipeline.includes('install') && d.dependenciesOnDisk) {
    result.pipeline = result.pipeline.filter((id) => id !== 'install');
    result.omitted.push({ id: 'install', reason: 'vendor/ is already installed. Add "install" to reinstall from composer.lock (this uses the network).' });
  }
  return result;
}

export const phpAdapter: EcosystemAdapter = {
  id: 'php',
  profiles: ['php', 'composer'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: () => 'php',
  resolveScript,
  defaultPipeline,
};
