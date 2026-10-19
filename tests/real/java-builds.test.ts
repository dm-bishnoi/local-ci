/**
 * Real Maven and Gradle builds. Nothing is faked: the project is compiled,
 * tested and packaged by the actual build tool, so these tests need network
 * access (the build tool downloads its plugins and JUnit from Maven Central).
 *
 * Without the tool they skip locally and fail under LOCAL_CI_REAL_TOOLCHAINS=required
 * (see helpers.ts). A probe that merely timed out counts as "maybe installed":
 * the test then runs and reports the real outcome.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { NO_BROWSERS } from '../helpers/fixtures.js';
import { withTempProject } from '../helpers/reports.js';
import { writeTree } from '../helpers/tree.js';
import { describeReal, lastReport, probeToolState, statuses, toolWorks } from './helpers.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const run = (cwd: string) => runCommand(cwd, { browsers: NO_BROWSERS });

const hasJava = await toolWorks('java', ['-version']);
const mvnMaybe = hasJava && (await probeToolState('mvn', ['--version'], 60_000)) !== 'failed';
const gradleMaybe = hasJava && (await probeToolState('gradle', ['--version'], 120_000)) !== 'failed';

const CALC = 'package example;\n\npublic class Calc {\n  public static int add(int a, int b) { return a + b; }\n}\n';
const GOOD_TEST =
  'package example;\n\nimport static org.junit.Assert.assertEquals;\n\nimport org.junit.Test;\n\n' +
  'public class CalcTest {\n  @Test\n  public void adds() { assertEquals(3, Calc.add(1, 2)); }\n}\n';
const BAD_TEST = GOOD_TEST.replace('assertEquals(3,', 'assertEquals(4,');

const POM =
  '<project xmlns="http://maven.apache.org/POM/4.0.0">\n' +
  '  <modelVersion>4.0.0</modelVersion>\n' +
  '  <groupId>example</groupId><artifactId>calc</artifactId><version>1.0</version><packaging>jar</packaging>\n' +
  '  <properties>\n' +
  '    <maven.compiler.release>17</maven.compiler.release>\n' +
  '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n' +
  '  </properties>\n' +
  '  <dependencies>\n' +
  '    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>\n' +
  '  </dependencies>\n' +
  '</project>\n';

const BUILD_GRADLE =
  "plugins { id 'java' }\n" +
  'repositories { mavenCentral() }\n' +
  "dependencies { testImplementation 'junit:junit:4.13.2' }\n" +
  'tasks.withType(JavaCompile) { options.release = 17 }\n';

const config = (type: string): string =>
  `version: 1\nproject:\n  type: ${type}\npipeline: [compile, test, verify, build]\nsettings:\n  failFast: false\n  timeoutMs: 900000\n`;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describeReal('maven build', mvnMaybe, () => {
  it('compile, test, verify and build all pass on a project with a passing JUnit test', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': config('maven'),
        'pom.xml': POM,
        'src/main/java/example/Calc.java': CALC,
        'src/test/java/example/CalcTest.java': GOOD_TEST,
      });
      expect(await run(cwd)).toBe(0);
      const report = await lastReport(cwd);
      expect(statuses(report)).toEqual([['compile', 'PASS'], ['test', 'PASS'], ['verify', 'PASS'], ['build', 'PASS']]);
      expect(await exists(join(cwd, 'target', 'calc-1.0.jar'))).toBe(true);
    });
  }, 900_000);

  it('a failing JUnit test fails test and verify with a non-zero exit code, and not compile or build', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': config('maven'),
        'pom.xml': POM,
        'src/main/java/example/Calc.java': CALC,
        'src/test/java/example/CalcTest.java': BAD_TEST,
      });
      expect(await run(cwd)).toBe(1);
      const report = await lastReport(cwd);
      expect(statuses(report)).toEqual([['compile', 'PASS'], ['test', 'FAIL'], ['verify', 'FAIL'], ['build', 'PASS']]);
      expect(report.steps[1]!.exitCode).not.toBe(0);
    });
  }, 900_000);

  it('code that does not compile fails compile', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': `version: 1\nproject:\n  type: maven\npipeline: [compile]\nsettings:\n  timeoutMs: 900000\n`,
        'pom.xml': POM,
        'src/main/java/example/Calc.java': 'package example;\npublic class Calc { int x = "not an int"; }\n',
      });
      expect(await run(cwd)).toBe(1);
      expect(statuses(await lastReport(cwd))).toEqual([['compile', 'FAIL']]);
    });
  }, 900_000);
});

describeReal('gradle build', gradleMaybe, () => {
  it('compile, test, verify and build all pass on a project with a passing JUnit test', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': config('gradle'),
        'build.gradle': BUILD_GRADLE,
        'settings.gradle': "rootProject.name = 'calc'\n",
        'src/main/java/example/Calc.java': CALC,
        'src/test/java/example/CalcTest.java': GOOD_TEST,
      });
      expect(await run(cwd)).toBe(0);
      const report = await lastReport(cwd);
      expect(statuses(report)).toEqual([['compile', 'PASS'], ['test', 'PASS'], ['verify', 'PASS'], ['build', 'PASS']]);
      expect(await exists(join(cwd, 'build', 'libs', 'calc.jar'))).toBe(true);
    });
  }, 900_000);

  it('a failing JUnit test fails test and verify with a non-zero exit code, and not compile or build', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': config('gradle'),
        'build.gradle': BUILD_GRADLE,
        'settings.gradle': "rootProject.name = 'calc'\n",
        'src/main/java/example/Calc.java': CALC,
        'src/test/java/example/CalcTest.java': BAD_TEST,
      });
      expect(await run(cwd)).toBe(1);
      const report = await lastReport(cwd);
      expect(statuses(report)).toEqual([['compile', 'PASS'], ['test', 'FAIL'], ['verify', 'FAIL'], ['build', 'PASS']]);
      expect(report.steps[1]!.exitCode).not.toBe(0);
    });
  }, 900_000);

  it('code that does not compile fails compile', async () => {
    await withTempProject(async (cwd) => {
      await writeTree(cwd, {
        '.local-ci.yml': `version: 1\nproject:\n  type: gradle\npipeline: [compile]\nsettings:\n  timeoutMs: 900000\n`,
        'build.gradle': BUILD_GRADLE,
        'settings.gradle': "rootProject.name = 'calc'\n",
        'src/main/java/example/Calc.java': 'package example;\npublic class Calc { int x = "not an int"; }\n',
      });
      expect(await run(cwd)).toBe(1);
      expect(statuses(await lastReport(cwd))).toEqual([['compile', 'FAIL']]);
    });
  }, 900_000);
});
