import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listDir, pathExists, readText } from '../fs.js';
import { pipelineFromCapabilities } from '../pipeline.js';
import type { AvailableCapability, Capability, DefaultPipeline, DetectOptions, Detection, EcosystemAdapter, Requirement, WorkspaceMembers } from '../types.js';

/**
 * Maven and Gradle projects.
 *
 * The project's own wrapper (`mvnw`, `gradlew`) is preferred over a system
 * install, with the platform's wrapper on Windows (`.cmd` / `.bat`). A wrapper
 * that cannot run (not executable, properties file missing) blocks the project
 * with the exact fix instead of falling back silently to a different Maven or
 * Gradle version than the project pins.
 *
 * Checks: `compile`, `test`, `verify`, `build` (package without tests). A JDK is
 * always required; a `release` of 9 or higher declared in the build raises the
 * minimum JDK accordingly.
 */

export type JavaBuildTool = 'maven' | 'gradle';

export interface JavaDetection extends Detection {
  ecosystem: 'java';
  buildTool: JavaBuildTool | null;
  /** Absolute wrapper path, when the project's wrapper is used. */
  wrapper: string | null;
  modules: string[];
}

const STEP_IDS = ['compile', 'test', 'verify', 'build'] as const;
const INIT_ORDER = ['compile', 'test', 'verify'] as const;
const STEP_NAMES: Record<string, string> = {
  compile: 'Compile',
  test: 'Unit Tests',
  verify: 'Verify',
  build: 'Production Build',
};

/** cmd.exe metacharacters that would make a batch wrapper path unsafe to start (see core/run-step.ts). */
const BATCH_UNSAFE_PATH = /[%!^&|<>"\r\n]/;

/** `<module>x</module>` entries of a pom. */
export function parseMavenModules(pom: string): string[] {
  const body = /<modules>([\s\S]*?)<\/modules>/.exec(pom.replace(/<!--[\s\S]*?-->/g, ''))?.[1] ?? '';
  return [...body.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!);
}

/** Project paths from `include` statements in settings.gradle(.kts): `include 'a', ':b:c'` or `include("a")`. */
export function parseGradleIncludes(settings: string): string[] {
  const text = settings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const dirs: string[] = [];
  for (const statement of text.matchAll(/\binclude\s*\(?([^\n)]*)/g)) {
    for (const name of statement[1]!.matchAll(/["']([^"']+)["']/g)) {
      const dir = name[1]!.replace(/^:/, '').replace(/:/g, '/');
      if (dir !== '') dirs.push(dir);
    }
  }
  return dirs;
}

async function wrapperState(dir: string, tool: JavaBuildTool): Promise<{ path: string | null; problem: string | null; note: string | null }> {
  const windows = process.platform === 'win32';
  const name = tool === 'maven' ? (windows ? 'mvnw.cmd' : 'mvnw') : windows ? 'gradlew.bat' : 'gradlew';
  const other = tool === 'maven' ? (windows ? 'mvnw' : 'mvnw.cmd') : windows ? 'gradlew' : 'gradlew.bat';
  const properties =
    tool === 'maven' ? join('.mvn', 'wrapper', 'maven-wrapper.properties') : join('gradle', 'wrapper', 'gradle-wrapper.properties');
  const full = join(dir, name);

  if (!(await pathExists(full))) {
    return {
      path: null,
      problem: null,
      note: (await pathExists(join(dir, other)))
        ? `${other} exists but this platform needs ${name}; the system ${tool === 'maven' ? 'mvn' : 'gradle'} is used instead.`
        : null,
    };
  }

  if (!(await pathExists(join(dir, properties)))) {
    return { path: null, problem: `${name} is present but ${properties.replace(/\\/g, '/')} is missing, so the wrapper cannot run. Restore the wrapper files (for example "${tool === 'maven' ? 'mvn wrapper:wrapper' : 'gradle wrapper'}").`, note: null };
  }
  if (windows && BATCH_UNSAFE_PATH.test(full)) {
    return { path: null, problem: `${name} sits at a path containing characters cmd.exe interprets (% ! ^ & | < > "), which cannot be started safely. Move the project to a plainer path.`, note: null };
  }
  if (!windows) {
    const mode = (await stat(full)).mode;
    if ((mode & 0o111) === 0) {
      return { path: null, problem: `${name} is not executable. Run "chmod +x ${name}" (and commit the mode with "git update-index --chmod=+x ${name}").`, note: null };
    }
  }
  return { path: full, problem: null, note: null };
}

function requirementsFor(tool: JavaBuildTool, wrapper: string | null, jdkAtLeast: { version: string; source: string } | null): Requirement[] {
  const requires: Requirement[] = [{ kind: 'tool', name: 'java', probeArgs: ['-version'], display: 'a JDK (java)' }];
  if (jdkAtLeast) {
    requires.push({ kind: 'version', tool: 'java', atLeast: jdkAtLeast.version, source: jdkAtLeast.source, probeArgs: ['-version'] });
  }
  if (wrapper === null) requires.push({ kind: 'tool', name: tool === 'maven' ? 'mvn' : 'gradle' });
  return requires;
}

/** The minimum JDK implied by a declared `release`, for releases where `java -version` is comparable (9+). */
function declaredJdk(pom: string | null): { version: string; source: string } | null {
  if (pom === null) return null;
  const match = /<(maven\.compiler\.release|maven\.compiler\.source|java\.version)>\s*(\d+(?:\.\d+)?)\s*</.exec(pom);
  if (!match) return null;
  const value = match[2]!;
  const major = Number(value.startsWith('1.') ? value.slice(2) : value.split('.')[0]);
  return major >= 9 ? { version: String(major), source: `pom.xml ${match[1]}` } : null;
}

function resolveJava(stepId: string, tool: JavaBuildTool, wrapper: string | null, options: DetectOptions, jdk: ReturnType<typeof declaredJdk>, evidence: string): Capability {
  const command = wrapper ?? (tool === 'maven' ? 'mvn' : 'gradle');
  const common = tool === 'maven' ? ['-B', '-Dorg.slf4j.simpleLogger.log.org.apache.maven.cli.transfer.Slf4jMavenTransferListener=warn'] : ['--console=plain', '--no-daemon'];
  const offline = options.offline ? [tool === 'maven' ? '-o' : '--offline'] : [];
  const goals: Record<string, string[]> =
    tool === 'maven'
      ? { compile: ['compile'], test: ['test'], verify: ['verify'], build: ['package', '-DskipTests'] }
      : { compile: ['classes'], test: ['test'], verify: ['check'], build: ['assemble'] };
  const goal = goals[stepId];
  if (goal === undefined) return { state: 'unavailable', reason: `Unknown Java step "${stepId}".` };

  const capability: AvailableCapability = {
    state: 'available',
    source: 'builtin',
    command,
    args: [...common, ...offline, ...goal],
    description: `${wrapper ? (tool === 'maven' ? 'mvnw' : 'gradlew') : tool === 'maven' ? 'mvn' : 'gradle'} ${goal.join(' ')}`,
    evidence,
    requires: requirementsFor(tool, wrapper, jdk),
  };
  return capability;
}

async function detect(dir: string, options: DetectOptions = {}): Promise<JavaDetection> {
  const entries = new Set(await listDir(dir));
  const hasPom = entries.has('pom.xml');
  const gradleFiles = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].filter((name) => entries.has(name));
  const hasGradle = gradleFiles.length > 0;

  const base = {
    ecosystem: 'java' as const,
    root: dir,
    confidence: 'strong' as const,
    capabilities: {} as Record<string, Capability>,
    buildTool: null as JavaBuildTool | null,
    wrapper: null as string | null,
    modules: [] as string[],
  };

  if (!hasPom && !hasGradle) {
    return { ...base, detected: false, evidence: [], reason: `No pom.xml, build.gradle or settings.gradle found in ${dir}.` };
  }

  if (hasPom && hasGradle) {
    return {
      ...base,
      detected: true,
      evidence: ['pom.xml', ...gradleFiles],
      problem: `both Maven (pom.xml) and Gradle (${gradleFiles.join(', ')}) build files are present, so it is unclear which one is the build. Remove the unused one, or define the steps yourself with run:.`,
    };
  }

  const tool: JavaBuildTool = hasPom ? 'maven' : 'gradle';
  const evidence = hasPom ? ['pom.xml'] : [...gradleFiles];
  const pom = hasPom ? await readText(join(dir, 'pom.xml')) : null;
  const settings = (await readText(join(dir, 'settings.gradle'))) ?? (await readText(join(dir, 'settings.gradle.kts')));
  const buildScript = (await readText(join(dir, 'build.gradle'))) ?? (await readText(join(dir, 'build.gradle.kts')));

  const wrapper = await wrapperState(dir, tool);
  const detection: JavaDetection = { ...base, detected: true, evidence, buildTool: tool, wrapper: wrapper.path };
  if (wrapper.path) evidence.push(tool === 'maven' ? 'mvnw wrapper' : 'gradlew wrapper');

  detection.modules = tool === 'maven' ? (pom ? parseMavenModules(pom) : []) : settings ? parseGradleIncludes(settings) : [];

  const warnings: string[] = [];
  if (wrapper.note) warnings.push(wrapper.note);
  if (wrapper.path) {
    warnings.push(
      `The ${tool === 'maven' ? 'Maven' : 'Gradle'} wrapper downloads its pinned distribution on first use${options.offline ? ' (offline mode is requested, so that download will fail if it is not cached)' : ''}.`,
    );
  }
  if (tool === 'gradle' && buildScript && /JavaLanguageVersion\.of\(/.test(buildScript)) {
    warnings.push(
      'The build declares a Gradle Java toolchain; Gradle may download a matching JDK unless one is installed or --offline is used.',
    );
  }
  if (warnings.length > 0) detection.warnings = warnings;

  if (wrapper.problem) {
    detection.problem = wrapper.problem;
    return detection;
  }

  const jdk = tool === 'maven' ? declaredJdk(pom) : null;
  detection.capabilities = Object.fromEntries(
    STEP_IDS.map((id) => [id, resolveJava(id, tool, wrapper.path, options, jdk, evidence.join(', '))]),
  );
  return detection;
}

async function workspaceMembers(dir: string): Promise<WorkspaceMembers | null> {
  const pom = await readText(join(dir, 'pom.xml'));
  if (pom !== null) {
    const modules = parseMavenModules(pom);
    return modules.length > 0 ? { patterns: modules, source: 'pom.xml <modules>' } : null;
  }
  const settings = (await readText(join(dir, 'settings.gradle'))) ?? (await readText(join(dir, 'settings.gradle.kts')));
  if (settings === null) return null;
  const includes = parseGradleIncludes(settings);
  if (await pathExists(join(dir, 'buildSrc'))) includes.push('buildSrc');
  return includes.length > 0 ? { patterns: includes, source: 'settings.gradle' } : null;
}

function defaultPipeline(detection: Detection): DefaultPipeline {
  const result: DefaultPipeline = pipelineFromCapabilities(detection, INIT_ORDER);
  if (detection.capabilities['build']?.state === 'available') {
    result.omitted.push({ id: 'build', reason: 'Packaging is already part of "verify". Add "build" for a package-only step.', onlyIf: 'verify' });
  }
  return result;
}

export const javaAdapter: EcosystemAdapter = {
  id: 'java',
  profiles: ['java', 'maven', 'gradle'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: (detection) => (detection as JavaDetection).buildTool ?? 'java',
  workspaceMembers,
  defaultPipeline,
};
