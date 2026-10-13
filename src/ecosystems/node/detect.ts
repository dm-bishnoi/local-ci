import { join, relative, resolve } from 'node:path';
import { findWorkspaceRoot } from '../../adapters/angular/detect.js';
import { asStringRecord, listDir, pathExists, readJson, readText } from '../fs.js';
import type { Detection } from '../types.js';

export type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Fixed order: a directory with several lockfiles always resolves the same way. */
const LOCKFILES: ReadonlyArray<{ file: string; manager: NodeManager }> = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
];

export type Framework = 'angular' | 'react' | 'vue';

const FRAMEWORK_PACKAGES: Record<Framework, readonly string[]> = {
  angular: ['@angular/core', '@angular/cli', '@angular/build', '@angular-devkit/build-angular'],
  react: ['react', 'react-dom'],
  vue: ['vue', 'nuxt'],
};

export interface NodeDetection extends Detection {
  ecosystem: 'node';
  packageJson: string | null;
  packageJsonProblem?: string;
  packageManager: NodeManager;
  /** Lockfile that decided the manager, relative to `root`. */
  lockfile: string | null;
  packageManagerIsDefault: boolean;
  /** Every lockfile found in the project directory. */
  lockfilesFound: string[];
  yarnBerry: boolean;
  frameworks: Framework[];
  typescript: boolean;
  angularConfig: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** File names in the project directory, for configuration-evidence checks. */
  files: ReadonlySet<string>;
  /** Parsed package.json, for `eslintConfig` / `prettier` / `jest` keys. */
  manifest: Record<string, unknown>;
  tsconfig: { exists: boolean; solutionStyle: boolean };
  declaredPackageManager: NodeManager | null;
  /** node_modules is present and non-empty in the project or its workspace root. */
  dependenciesOnDisk: boolean;
}

async function nodeModulesPresent(dir: string): Promise<boolean> {
  if ((await listDir(join(dir, 'node_modules'))).length > 0) return true;
  const workspaceRoot = await findWorkspaceRoot(dir);
  return workspaceRoot !== null && (await listDir(join(workspaceRoot, 'node_modules'))).length > 0;
}

export function parseDeclaredManager(field: unknown): NodeManager | null {
  if (typeof field !== 'string') return null;
  const name = field.split('@')[0]?.trim().toLowerCase();
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null;
}

async function lockfileIn(dir: string): Promise<{ file: string; manager: NodeManager } | null> {
  for (const entry of LOCKFILES) {
    if (await pathExists(join(dir, entry.file))) return entry;
  }
  return null;
}

async function tsconfigState(dir: string): Promise<{ exists: boolean; solutionStyle: boolean }> {
  const raw = await readText(join(dir, 'tsconfig.json'));
  if (raw === null) return { exists: false, solutionStyle: false };
  // tsconfig allows comments and trailing commas, so a strict parse can fail on
  // a valid file. Detect the solution-style shape textually instead.
  const hasReferences = /"references"\s*:\s*\[/.test(raw);
  const emptyFiles = /"files"\s*:\s*\[\s*\]/.test(raw);
  return { exists: true, solutionStyle: hasReferences && emptyFiles };
}

/** Detects a Node.js project (JavaScript, TypeScript, Angular, React, Vue) in `dir`. */
export async function detectNode(dir: string): Promise<NodeDetection> {
  const root = resolve(dir);
  const packageJsonPath = join(root, 'package.json');
  const parsed = await readJson(packageJsonPath);

  let manifest: Record<string, unknown> | null = null;
  let problem: string | undefined;
  if ('error' in parsed) {
    if (parsed.error !== 'missing') problem = `package.json is not valid JSON: ${parsed.error}`;
  } else if (typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
    manifest = parsed.value as Record<string, unknown>;
  } else {
    problem = 'package.json does not contain a JSON object.';
  }

  const dependencies = asStringRecord(manifest?.['dependencies']);
  const devDependencies = asStringRecord(manifest?.['devDependencies']);
  const all = { ...dependencies, ...devDependencies };
  const files = new Set(await listDir(root));

  const frameworks = (Object.keys(FRAMEWORK_PACKAGES) as Framework[]).filter(
    (framework) =>
      FRAMEWORK_PACKAGES[framework].some((name) => name in all) || (framework === 'angular' && files.has('angular.json')),
  );
  const tsconfig = await tsconfigState(root);
  const typescript = 'typescript' in all || tsconfig.exists;

  // Package manager: local lockfile, then the enclosing workspace root's.
  let manager: NodeManager = 'npm';
  let lockfile: string | null = null;
  let isDefault = true;
  const local = await lockfileIn(root);
  if (local) {
    manager = local.manager;
    lockfile = local.file;
    isDefault = false;
  } else {
    const workspaceRoot = await findWorkspaceRoot(root);
    const inherited = workspaceRoot ? await lockfileIn(workspaceRoot) : null;
    if (workspaceRoot && inherited) {
      manager = inherited.manager;
      lockfile = relative(root, join(workspaceRoot, inherited.file));
      isDefault = false;
    }
  }

  const lockfilesFound: string[] = [];
  for (const entry of LOCKFILES) if (files.has(entry.file)) lockfilesFound.push(entry.file);

  const yarnRc = await readText(join(root, '.yarnrc.yml'));
  const declaredPackageManager = parseDeclaredManager(manifest?.['packageManager']);
  const declaredYarnMajor = /^yarn@(\d+)/.exec(String(manifest?.['packageManager'] ?? ''))?.[1];
  const yarnBerry = manager === 'yarn' && (yarnRc !== null || (declaredYarnMajor !== undefined && Number(declaredYarnMajor) >= 2));

  const evidence: string[] = [];
  if (manifest) evidence.push('package.json');
  if (lockfile) evidence.push(lockfile);
  if (files.has('angular.json')) evidence.push('angular.json');
  if (tsconfig.exists) evidence.push('tsconfig.json');
  for (const framework of frameworks) evidence.push(`framework: ${framework}`);

  const detected = manifest !== null;
  return {
    ecosystem: 'node',
    root,
    detected,
    confidence: 'strong',
    evidence,
    ...(detected
      ? {}
      : { reason: problem ?? `No package.json found in ${root}.` }),
    capabilities: {},
    packageJson: manifest ? packageJsonPath : null,
    ...(problem ? { packageJsonProblem: problem } : {}),
    packageManager: manager,
    lockfile,
    packageManagerIsDefault: isDefault,
    lockfilesFound,
    yarnBerry,
    frameworks,
    typescript,
    angularConfig: files.has('angular.json') ? join(root, 'angular.json') : null,
    scripts: asStringRecord(manifest?.['scripts']),
    dependencies,
    devDependencies,
    files,
    manifest: manifest ?? {},
    tsconfig,
    declaredPackageManager,
    dependenciesOnDisk: manifest !== null && (await nodeModulesPresent(root)),
  };
}

