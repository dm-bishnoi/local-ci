import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { BATCH_UNSAFE_ARGUMENT } from '../../src/core/run-step.js';
import { discoverProjects } from '../../src/ecosystems/discovery.js';
import { javaAdapter, parseGradleIncludes, parseMavenModules, type JavaDetection } from '../../src/ecosystems/java/index.js';
import type { AvailableCapability, Capability } from '../../src/ecosystems/types.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';
import { installShims, withPath } from '../helpers/shims.js';
import { cleanupTrees, makeTree, writeTree } from '../helpers/tree.js';

// Detection tests scan real directories and look tools up on PATH. They take well under
// a second alone, but a loaded machine running the whole suite has been measured at 5 s+
// for them (the default limit). This is headroom, not a sign of slow code.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanupTrees);

const windows = process.platform === 'win32';
const POM = '<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>';
const detect = async (files: Record<string, string | object>, options = {}): Promise<JavaDetection> =>
  (await javaAdapter.detect(await makeTree(files), options)) as JavaDetection;
const cap = (c: Capability | undefined): AvailableCapability => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return c;
};
const argv = (c: Capability | undefined): string[] => [cap(c).command, ...cap(c).args];

const MAVEN_WRAPPER_FILES = {
  [windows ? 'mvnw.cmd' : 'mvnw']: windows ? '@echo off\r\n' : '#!/bin/sh\n',
  '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=https://example.invalid/maven.zip\n',
};
const GRADLE_WRAPPER_FILES = {
  [windows ? 'gradlew.bat' : 'gradlew']: windows ? '@echo off\r\n' : '#!/bin/sh\n',
  'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https://example.invalid/gradle.zip\n',
};
async function makeExecutable(dir: string, name: string): Promise<void> {
  if (!windows) await chmod(join(dir, name), 0o755);
}

describe('Java detection', () => {
  it('detects Maven, and Gradle in each of its spellings', async () => {
    expect(await detect({ 'pom.xml': POM })).toMatchObject({ detected: true, buildTool: 'maven' });
    for (const file of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
      expect(await detect({ [file]: '' }), file).toMatchObject({ detected: true, buildTool: 'gradle' });
    }
  });

  it('is not detected without build files, and says why', async () => {
    const d = await detect({ 'src/Main.java': 'class Main {}', 'package.json': '{}' });
    expect(d).toMatchObject({ detected: false, reason: expect.stringMatching(/No pom\.xml, build\.gradle/) });
    expect(d.capabilities).toEqual({});
  });

  it('Maven and Gradle together are ambiguous: blocked with the reason, never a guess', async () => {
    const d = await detect({ 'pom.xml': POM, 'build.gradle': '' });
    expect(d.detected).toBe(true);
    expect(d.problem).toMatch(/both Maven \(pom\.xml\) and Gradle \(build\.gradle\)/);
    expect(d.capabilities).toEqual({});
  });
});

describe('Java commands', () => {
  it('Maven: batch mode, quiet transfer progress, and package without tests for build', async () => {
    const d = await detect({ 'pom.xml': POM });
    const flags = ['-B', '-Dorg.slf4j.simpleLogger.log.org.apache.maven.cli.transfer.Slf4jMavenTransferListener=warn'];
    expect(argv(d.capabilities['compile'])).toEqual(['mvn', ...flags, 'compile']);
    expect(argv(d.capabilities['test'])).toEqual(['mvn', ...flags, 'test']);
    expect(argv(d.capabilities['verify'])).toEqual(['mvn', ...flags, 'verify']);
    expect(argv(d.capabilities['build'])).toEqual(['mvn', ...flags, 'package', '-DskipTests']);
  });

  it('Gradle: plain console, no daemon left behind, check for verify', async () => {
    const d = await detect({ 'build.gradle': '' });
    const flags = ['--console=plain', '--no-daemon'];
    expect(argv(d.capabilities['compile'])).toEqual(['gradle', ...flags, 'classes']);
    expect(argv(d.capabilities['test'])).toEqual(['gradle', ...flags, 'test']);
    expect(argv(d.capabilities['verify'])).toEqual(['gradle', ...flags, 'check']);
    expect(argv(d.capabilities['build'])).toEqual(['gradle', ...flags, 'assemble']);
  });

  it('settings.offline maps to -o for Maven and --offline for Gradle', async () => {
    expect(argv((await detect({ 'pom.xml': POM }, { offline: true })).capabilities['test'])).toContain('-o');
    expect(argv((await detect({ 'build.gradle': '' }, { offline: true })).capabilities['test'])).toContain('--offline');
    expect(argv((await detect({ 'pom.xml': POM })).capabilities['test'])).not.toContain('-o');
  });

  it('needs a JDK, and the build tool only when there is no wrapper', async () => {
    const d = await detect({ 'pom.xml': POM });
    expect(cap(d.capabilities['test']).requires).toEqual([
      { kind: 'tool', name: 'java', probeArgs: ['-version'], display: 'a JDK (java)' },
      { kind: 'tool', name: 'mvn' },
    ]);
  });

  it.each([
    ['maven.compiler.release 17', '<properties><maven.compiler.release>17</maven.compiler.release></properties>', '17'],
    ['java.version 21', '<properties><java.version>21</java.version></properties>', '21'],
    ['java.version 1.8 (java -version is not comparable)', '<properties><java.version>1.8</java.version></properties>', null],
  ])('a declared %s sets the minimum JDK only where it is checkable', async (_name, properties, atLeast) => {
    const d = await detect({ 'pom.xml': `<project>${properties}</project>` });
    const versions = cap(d.capabilities['test']).requires.filter((r) => r.kind === 'version');
    expect(versions.map((r) => r.kind === 'version' && r.atLeast)).toEqual(atLeast ? [atLeast] : []);
  });

  it('every command for a Windows batch wrapper passes the batch-file argument gate', async () => {
    for (const files of [{ 'pom.xml': POM }, { 'build.gradle': '' }]) {
      for (const options of [{}, { offline: true }]) {
        const d = await detect(files, options);
        for (const capability of Object.values(d.capabilities)) {
          for (const arg of cap(capability).args) expect(BATCH_UNSAFE_ARGUMENT.test(arg), arg).toBe(false);
        }
      }
    }
  });

  it('init generates compile, test and verify, and explains why build is left out', async () => {
    const d = await detect({ 'pom.xml': POM });
    const result = javaAdapter.defaultPipeline(d);
    expect(result.pipeline).toEqual(['compile', 'test', 'verify']);
    expect(result.omitted).toEqual([{ id: 'build', reason: expect.stringMatching(/part of "verify"/) }]);
  });
});

describe('Java wrappers', () => {
  it('Maven wrapper is preferred, by absolute path, and then only the JDK is required', async () => {
    const dir = await makeTree({ 'pom.xml': POM, ...MAVEN_WRAPPER_FILES });
    await makeExecutable(dir, windows ? 'mvnw.cmd' : 'mvnw');
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.wrapper).toBe(join(dir, windows ? 'mvnw.cmd' : 'mvnw'));
    expect(cap(d.capabilities['test']).command).toBe(d.wrapper);
    expect(cap(d.capabilities['test']).requires).toEqual([{ kind: 'tool', name: 'java', probeArgs: ['-version'], display: 'a JDK (java)' }]);
    expect(d.evidence).toContain('mvnw wrapper');
    expect(d.warnings?.[0]).toMatch(/wrapper downloads its pinned distribution/);
  });

  it('Gradle wrapper (gradlew / gradlew.bat) likewise', async () => {
    const dir = await makeTree({ 'build.gradle': '', ...GRADLE_WRAPPER_FILES });
    await makeExecutable(dir, windows ? 'gradlew.bat' : 'gradlew');
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.wrapper).toBe(join(dir, windows ? 'gradlew.bat' : 'gradlew'));
    expect(cap(d.capabilities['verify']).args).toEqual(['--console=plain', '--no-daemon', 'check']);
  });

  it('the offline note appears when offline is requested with a wrapper', async () => {
    const dir = await makeTree({ 'pom.xml': POM, ...MAVEN_WRAPPER_FILES });
    await makeExecutable(dir, windows ? 'mvnw.cmd' : 'mvnw');
    const d = (await javaAdapter.detect(dir, { offline: true })) as JavaDetection;
    expect(d.warnings?.[0]).toMatch(/offline mode is requested/);
  });

  it('a wrapper without its properties file blocks the project and says how to restore it', async () => {
    const dir = await makeTree({ 'pom.xml': POM, [windows ? 'mvnw.cmd' : 'mvnw']: '' });
    await makeExecutable(dir, windows ? 'mvnw.cmd' : 'mvnw');
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.problem).toMatch(/maven-wrapper\.properties is missing.*mvn wrapper:wrapper/);
    expect(d.capabilities).toEqual({});
  });

  it.skipIf(windows)('a wrapper that is not executable blocks the project with the chmod fix', async () => {
    const dir = await makeTree({ 'pom.xml': POM, ...MAVEN_WRAPPER_FILES });
    await chmod(join(dir, 'mvnw'), 0o644);
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.problem).toMatch(/mvnw is not executable.*chmod \+x mvnw/);
  });

  it('the other platform\'s wrapper alone does not count: the system tool is used, with a note', async () => {
    const other = windows ? 'mvnw' : 'mvnw.cmd';
    const dir = await makeTree({ 'pom.xml': POM, [other]: '', '.mvn/wrapper/maven-wrapper.properties': '' });
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.wrapper).toBeNull();
    expect(cap(d.capabilities['test']).command).toBe('mvn');
    expect(d.warnings?.[0]).toMatch(new RegExp(`${other.replace('.', '\\.')} exists but this platform needs`));
  });

  it.skipIf(!windows)('on Windows a wrapper under a path with cmd metacharacters is blocked, not started', async () => {
    const parent = await makeTree({});
    const dir = join(parent, 'a&b');
    await mkdir(dir, { recursive: true });
    await writeTree(dir, { 'pom.xml': POM, ...MAVEN_WRAPPER_FILES });
    const d = (await javaAdapter.detect(dir)) as JavaDetection;
    expect(d.problem).toMatch(/cmd\.exe interprets/);
  });
});

describe('Java modules', () => {
  it('parses Maven modules (ignoring comments) and Gradle includes in every spelling', () => {
    expect(parseMavenModules('<project><modules><module>core</module><!-- <module>old</module> --><module> api </module></modules></project>')).toEqual([
      'core',
      'api',
    ]);
    expect(parseGradleIncludes("include 'app', ':libs:util'\ninclude(\"web\")\n// include 'ignored'\ninclude \":svc:a\", \":svc:b\"\n")).toEqual([
      'app',
      'libs/util',
      'web',
      'svc/a',
      'svc/b',
    ]);
  });

  it('declared modules are covered by the root during discovery (Maven and Gradle, including buildSrc)', async () => {
    const maven = await makeTree({
      'pom.xml': '<project><modules><module>core</module><module>api</module></modules></project>',
      'core/pom.xml': POM,
      'api/pom.xml': POM,
      'extra/pom.xml': POM,
    });
    const m = await discoverProjects(maven);
    expect(m.projects.map((p) => p.path)).toEqual(['.', 'extra']);
    expect(m.projects.find((p) => p.path === 'extra')?.nestedIn).toBe('.');
    expect(m.covered.map((c) => c.path)).toEqual(['api', 'core']);

    const gradle = await makeTree({
      'settings.gradle': "include 'app'\n",
      'build.gradle': '',
      'app/build.gradle': '',
      'buildSrc/build.gradle': '',
    });
    const g = await discoverProjects(gradle);
    expect(g.projects.map((p) => [p.path, p.type])).toEqual([['.', 'gradle']]);
    expect(g.covered.map((c) => c.path)).toEqual(['app', 'buildSrc']);
  });

  it('warns about a Gradle toolchain that may download a JDK', async () => {
    const d = await detect({ 'build.gradle': 'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }' });
    expect(d.warnings?.[0]).toMatch(/may download a matching JDK/);
  });
});

describe('Java through the pipeline with fake tools (mocked toolchain)', () => {
  const JAVA = `
console.error('openjdk version "17.0.12" 2024-07-16');
process.exit(0);
`;
  const BUILD_TOOL = (name: string): string => `
const a = process.argv.slice(2);
const fs = require('fs');
if (a[0] === '--version') { console.log('${name} 9.9.9'); process.exit(0); }
const goal = a[a.length - 1];
if (goal === 'test' && fs.existsSync('.failing-test')) { console.log('Tests run: 1, Failures: 1'); process.exit(1); }
console.log('${name} ' + a.join(' ') + ' ok');
`;
  const config = 'version: 1\nproject:\n  type: maven\npipeline: [compile, test, verify]\n';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const lastReport = async (cwd: string) => {
    const base = join(cwd, '.local-ci', 'reports');
    const [runId] = (await readdir(base)).sort().reverse();
    return JSON.parse(await readFile(join(base, runId ?? '', 'report.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; exitCode?: number; stdout: string; error?: string }>;
    };
  };
  const statuses = (r: Awaited<ReturnType<typeof lastReport>>): Array<[string, string]> => r.steps.map((s) => [s.id, s.status]);

  it('runs through the system mvn, and a failing test fails only its step', async () => {
    const shims = await installShims({ java: JAVA, mvn: BUILD_TOOL('mvn') });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'pom.xml': POM });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
        await writeTree(cwd, { '.failing-test': '' });
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['compile', 'PASS'], ['test', 'FAIL'], ['verify', 'PASS']]);
        expect(report.steps[1]).toMatchObject({ exitCode: 1 });
      });
    });
  }, 120_000);

  it('prefers the project wrapper over a system mvn (which is not even installed here)', async () => {
    const shims = await installShims({ java: JAVA });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': config,
        'pom.xml': POM,
        '.mvn/wrapper/maven-wrapper.properties': '',
        'wrapper-impl.js': "console.log('wrapper ran: ' + process.argv.slice(2).join(' '))",
        [windows ? 'mvnw.cmd' : 'mvnw']: windows ? '@echo off\r\nnode "%~dp0wrapper-impl.js" %*\r\n' : '#!/bin/sh\nexec node "${0%/*}/wrapper-impl.js" "$@"\n',
      });
      await makeExecutable(cwd, windows ? 'mvnw.cmd' : 'mvnw');
      await withPath(
        [shims],
        async () => {
          expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
          const report = await lastReport(cwd);
          expect(report.steps[1]!.stdout).toMatch(/wrapper ran: -B .*test/);
        },
        { replace: true },
      );
    });
  }, 120_000);

  it('without a JDK every step is blocked (and says a JDK is what is missing)', async () => {
    const shims = await installShims({ mvn: BUILD_TOOL('mvn') });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'pom.xml': POM });
      await withPath(
        [shims],
        async () => {
          expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
          const report = await lastReport(cwd);
          expect(report.steps.every((s) => s.status === 'BLOCKED')).toBe(true);
          expect(report.steps[0]!.error).toMatch(/needs a JDK \(java\)/);
        },
        { replace: true },
      );
    });
  }, 120_000);

  it('without mvn and without a wrapper every step is blocked', async () => {
    const shims = await installShims({ java: JAVA });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'pom.xml': POM });
      await withPath(
        [shims],
        async () => {
          expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
          expect((await lastReport(cwd)).steps[0]!.error).toMatch(/needs mvn, but mvn was not found on PATH/);
        },
        { replace: true },
      );
    });
  }, 120_000);

  it('blocks when the JDK is older than the declared release', async () => {
    const shims = await installShims({ java: JAVA, mvn: BUILD_TOOL('mvn') });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'pom.xml': '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        expect((await lastReport(cwd)).steps[0]!.error).toMatch(/pom\.xml maven\.compiler\.release requires java >= 21, but 17\.0\.12 is installed/);
      });
    });
  }, 120_000);

  it('an ambiguous build (pom.xml and build.gradle) blocks every step with the reason', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'pom.xml': POM, 'build.gradle': '' });
      expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
      const report = await lastReport(cwd);
      expect(report.steps.every((s) => s.status === 'BLOCKED')).toBe(true);
      expect(report.steps[0]!.error).toMatch(/both Maven .* and Gradle/);
    });
  }, 120_000);
});

