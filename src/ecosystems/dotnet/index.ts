import { dirname, extname, join, posix } from 'node:path';
import { listDir, pathExists, readJson, readText } from '../fs.js';
import { pipelineFromCapabilities } from '../pipeline.js';
import type { AvailableCapability, Capability, DefaultPipeline, Detection, EcosystemAdapter, Requirement, WorkspaceMembers } from '../types.js';

/**
 * .NET: `.sln`, `.slnx`, and SDK-style `.csproj`/`.fsproj`/`.vbproj` projects.
 *
 * Checks: `restore`, `build`, `test` (only when a test project exists) and
 * `format` (`dotnet format --verify-no-changes`, which never rewrites files).
 * The telemetry banner and first-run experience are switched off, and the target
 * is always passed explicitly (as `./name`, so a file name can never be read as
 * an option), which also avoids the CLI's "more than one project or solution
 * file" error.
 */

export interface DotnetDetection extends Detection {
  ecosystem: 'dotnet';
  solutions: string[];
  projects: string[];
  /** The solution or project every command is pointed at, relative to the project directory. */
  target: string | null;
  /** Project files (relative) that reference the test SDK. */
  testProjects: string[];
  editorConfig: boolean;
  globalJson: { version: string | null; rollForward: string | null } | null;
}

const STEP_IDS = ['restore', 'build', 'test', 'format'] as const;
const INIT_ORDER = ['restore', 'build', 'test', 'format'] as const;
const STEP_NAMES: Record<string, string> = {
  restore: 'Restore',
  build: 'Production Build',
  test: 'Unit Tests',
  format: 'Format',
};

const PROJECT_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj'];
const SOLUTION_EXTENSIONS = ['.sln', '.slnx'];
const DOTNET_ENV = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } as const;

/** Project paths referenced by a `.sln` (classic) or `.slnx` (XML) file. */
export function parseSolutionProjects(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/g)) paths.push(match[1]!);
  for (const match of text.matchAll(/<Project\s+[^>]*Path="([^"]+)"/g)) paths.push(match[1]!);
  return paths
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => PROJECT_EXTENSIONS.includes(extname(p).toLowerCase()));
}

/** Resolves a solution-relative project path to one inside the project directory, or null. */
function insideProject(relativePath: string): string | null {
  const normalized = posix.normalize(relativePath);
  return normalized.startsWith('..') || posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) ? null : normalized;
}

function isSdkStyle(projectText: string): boolean {
  return /<Project\b[^>]*\sSdk\s*=/.test(projectText) || /<Sdk\s+Name\s*=/.test(projectText);
}

function isTestProject(projectText: string): boolean {
  return /Microsoft\.NET\.Test\.Sdk/.test(projectText) || /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(projectText);
}

const dotnetTool = (): Requirement => ({ kind: 'tool', name: 'dotnet', env: { ...DOTNET_ENV } });

function resolveDotnet(stepId: string, d: DotnetDetection, lockedRestore: boolean): Capability {
  const target = `./${d.target}`;
  const needsRestore: Requirement = { kind: 'dependencies', detail: 'restored NuGet packages (run the restore step first)' };
  const make = (args: string[], requires: Requirement[]): AvailableCapability => ({
    state: 'available',
    source: 'builtin',
    command: 'dotnet',
    args,
    description: `dotnet ${args[0]}`,
    env: { ...DOTNET_ENV },
    evidence: d.evidence.join(', '),
    requires,
  });

  switch (stepId) {
    case 'restore':
      return make(['restore', target, ...(lockedRestore ? ['--locked-mode'] : [])], [dotnetTool()]);
    case 'build':
      return make(['build', target, '--no-restore', '-c', 'Release'], [dotnetTool(), needsRestore]);
    case 'test':
      if (d.testProjects.length === 0) {
        return {
          state: 'unavailable',
          reason: 'No test project was found (none references Microsoft.NET.Test.Sdk or sets IsTestProject), so there is nothing to run with "dotnet test".',
        };
      }
      // No --no-build: the build is incremental, so this stays correct when `test` is run on its own.
      return make(['test', target, '--no-restore', '-c', 'Release'], [dotnetTool(), needsRestore]);
    case 'format':
      return make(
        ['format', target, '--verify-no-changes', '--no-restore'],
        [
          dotnetTool(),
          { kind: 'version', tool: 'dotnet', atLeast: '6.0.0', source: '"dotnet format" (built into the SDK from 6.0)' },
          needsRestore,
        ],
      );
    default:
      return { state: 'unavailable', reason: `Unknown .NET step "${stepId}".` };
  }
}

async function detect(dir: string): Promise<DotnetDetection> {
  const entries = await listDir(dir);
  const solutions = entries.filter((name) => SOLUTION_EXTENSIONS.includes(extname(name).toLowerCase())).sort();
  const projects = entries.filter((name) => PROJECT_EXTENSIONS.includes(extname(name).toLowerCase())).sort();

  const base = {
    ecosystem: 'dotnet' as const,
    root: dir,
    confidence: 'strong' as const,
    capabilities: {} as Record<string, Capability>,
    solutions,
    projects,
    target: null as string | null,
    testProjects: [] as string[],
    editorConfig: entries.includes('.editorconfig'),
    globalJson: null as DotnetDetection['globalJson'],
  };

  if (solutions.length === 0 && projects.length === 0) {
    return { ...base, detected: false, evidence: [], reason: `No .sln, .slnx, .csproj, .fsproj or .vbproj file found in ${dir}.` };
  }

  const evidence = [...solutions, ...projects];
  const globalJson = await readJson(join(dir, 'global.json'));
  let pinned: DotnetDetection['globalJson'] = null;
  if (!('error' in globalJson) && typeof globalJson.value === 'object' && globalJson.value !== null) {
    const sdk = (globalJson.value as { sdk?: { version?: unknown; rollForward?: unknown } }).sdk;
    pinned = {
      version: typeof sdk?.version === 'string' ? sdk.version : null,
      rollForward: typeof sdk?.rollForward === 'string' ? sdk.rollForward : null,
    };
    evidence.push('global.json');
  }

  const detection: DotnetDetection = { ...base, detected: true, evidence, globalJson: pinned };
  detection.dependenciesLabel = 'NuGet packages (obj/project.assets.json)';
  detection.declaresDependencies = true;
  detection.installStepIds = ['restore'];

  // Which projects belong to the target decides the test-project and restore checks.
  let projectFiles: string[] = [];
  if (solutions.length === 1) {
    detection.target = solutions[0]!;
    const text = (await readText(join(dir, solutions[0]!))) ?? '';
    projectFiles = parseSolutionProjects(text).map(insideProject).filter((p): p is string => p !== null);
  } else if (solutions.length === 0 && projects.length === 1) {
    detection.target = projects[0]!;
    projectFiles = [projects[0]!];
  } else {
    const candidates = solutions.length > 1 ? solutions : projects;
    detection.problem =
      `${solutions.length > 1 ? 'more than one solution' : 'more than one project file and no solution'} in this directory (${candidates.join(', ')}), ` +
      'so the .NET CLI cannot tell which to build. Point the project at one (project.path), or define the steps yourself with run:.';
  }

  const testProjects: string[] = [];
  const assets: boolean[] = [];
  let lockFiles = false;
  let nonSdk: string | null = null;
  for (const file of projectFiles) {
    const text = await readText(join(dir, file));
    if (text === null) continue;
    if (!isSdkStyle(text) && nonSdk === null) nonSdk = file;
    if (isTestProject(text)) testProjects.push(file);
    assets.push(await pathExists(join(dir, dirname(file), 'obj', 'project.assets.json')));
    if (await pathExists(join(dir, dirname(file), 'packages.lock.json'))) lockFiles = true;
  }
  detection.testProjects = testProjects;
  detection.dependenciesOnDisk = assets.length > 0 && assets.every(Boolean);

  const warnings: string[] = [];
  if (pinned?.version) {
    warnings.push(
      `global.json pins SDK ${pinned.version}${pinned.rollForward ? ` (rollForward: ${pinned.rollForward})` : ''}; ` +
        `the check requires at least that version, and dotnet itself reports an exact mismatch when it runs.`,
    );
  }
  if (warnings.length > 0) detection.warnings = warnings;

  const unsupportedReason =
    nonSdk !== null
      ? `${nonSdk} is not an SDK-style project (no Sdk attribute), which the dotnet CLI cannot reliably build. Use run: with msbuild, or migrate the project to SDK style.`
      : null;
  if (detection.target !== null) {
    detection.capabilities = Object.fromEntries(
      STEP_IDS.map((id) => {
        const capability: Capability = unsupportedReason
          ? { state: 'unavailable', reason: unsupportedReason }
          : resolveDotnet(id, detection, lockFiles);
        if (capability.state === 'available' && pinned?.version) {
          capability.requires.push({ kind: 'version', tool: 'dotnet', atLeast: pinned.version, source: 'global.json' });
        }
        return [id, capability];
      }),
    );
  }
  return detection;
}

async function workspaceMembers(dir: string): Promise<WorkspaceMembers | null> {
  const entries = await listDir(dir);
  const solutions = entries.filter((name) => SOLUTION_EXTENSIONS.includes(extname(name).toLowerCase()));
  if (solutions.length !== 1) return null;
  const text = (await readText(join(dir, solutions[0]!))) ?? '';
  const dirs = parseSolutionProjects(text)
    .map(insideProject)
    .filter((p): p is string => p !== null)
    .map((p) => posix.dirname(p))
    .filter((p) => p !== '.');
  return { patterns: [...new Set(dirs)], source: solutions[0]! };
}

function defaultPipeline(detection: Detection): DefaultPipeline {
  const result = pipelineFromCapabilities(detection, INIT_ORDER);
  const d = detection as DotnetDetection;
  if (result.pipeline.includes('format') && !d.editorConfig) {
    result.pipeline = result.pipeline.filter((id) => id !== 'format');
    result.omitted.push({
      id: 'format',
      reason: 'No .editorconfig was found, so "dotnet format" would judge the code against defaults nobody chose. Add an .editorconfig, then add "format".',
    });
  }
  return result;
}

export const dotnetAdapter: EcosystemAdapter = {
  id: 'dotnet',
  profiles: ['dotnet', 'csharp', 'c#', 'fsharp'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: () => 'dotnet',
  workspaceMembers,
  defaultPipeline,
};
