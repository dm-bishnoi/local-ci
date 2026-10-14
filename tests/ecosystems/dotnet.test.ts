import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../src/cli/commands/run.js';
import { discoverProjects } from '../../src/ecosystems/discovery.js';
import { dotnetAdapter, parseSolutionProjects, type DotnetDetection } from '../../src/ecosystems/dotnet/index.js';
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

const SDK_APP = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n';
const TEST_APP =
  '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup>\n</Project>\n';
const sln = (...projects: string[]): string =>
  'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
  projects.map((p, i) => `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "P${i}", "${p}", "{0000000${i}-0000-0000-0000-000000000000}"\nEndProject\n`).join('');

const detect = async (files: Record<string, string | object>): Promise<DotnetDetection> =>
  (await dotnetAdapter.detect(await makeTree(files))) as DotnetDetection;
const argv = (c: Capability | undefined): string[] => {
  if (c?.state !== 'available') throw new Error(`expected available: ${JSON.stringify(c)}`);
  return [c.command, ...c.args];
};

describe('.NET detection', () => {
  it('detects a solution with SDK-style projects and finds the test project', async () => {
    const d = await detect({
      'App.sln': sln('src\\App\\App.csproj', 'tests\\App.Tests\\App.Tests.csproj'),
      'src/App/App.csproj': SDK_APP,
      'tests/App.Tests/App.Tests.csproj': TEST_APP,
    });
    expect(d).toMatchObject({ detected: true, target: 'App.sln', solutions: ['App.sln'] });
    expect(d.testProjects).toEqual(['tests/App.Tests/App.Tests.csproj']);
    expect(d.problem).toBeUndefined();
  });

  it('detects .slnx (XML) solutions', async () => {
    const d = await detect({
      'App.slnx': '<Solution>\n  <Project Path="src/App/App.csproj" />\n  <Project Path="tests/T/T.csproj" />\n</Solution>\n',
      'src/App/App.csproj': SDK_APP,
      'tests/T/T.csproj': TEST_APP,
    });
    expect(d).toMatchObject({ target: 'App.slnx' });
    expect(d.testProjects).toEqual(['tests/T/T.csproj']);
  });

  it('detects a lone project without a solution', async () => {
    const d = await detect({ 'App.csproj': SDK_APP });
    expect(d).toMatchObject({ detected: true, target: 'App.csproj', solutions: [], testProjects: [] });
  });

  it('F# and VB projects count too', async () => {
    expect((await detect({ 'A.fsproj': SDK_APP })).detected).toBe(true);
    expect((await detect({ 'A.vbproj': SDK_APP })).detected).toBe(true);
  });

  it('a solution next to one project builds the solution', async () => {
    const d = await detect({ 'App.sln': sln('App.csproj'), 'App.csproj': SDK_APP });
    expect(d.target).toBe('App.sln');
  });

  it('is not detected from build-config files alone, and says why', async () => {
    const d = await detect({ 'global.json': '{"sdk":{"version":"8.0.100"}}', 'Directory.Build.props': '<Project/>' });
    expect(d).toMatchObject({ detected: false, reason: expect.stringMatching(/No \.sln, \.slnx, \.csproj/) });
    expect(d.capabilities).toEqual({});
  });

  it('does not mistake other ecosystems for .NET', async () => {
    expect((await detect({ 'package.json': '{}', 'go.mod': 'module m', 'Cargo.toml': '[package]' })).detected).toBe(false);
  });

  it.each([
    ['two solutions', { 'A.sln': sln(), 'B.sln': sln() }, /more than one solution.*A\.sln, B\.sln/],
    ['an .sln and an .slnx', { 'A.sln': sln(), 'A.slnx': '<Solution/>' }, /more than one solution/],
    ['two projects and no solution', { 'A.csproj': SDK_APP, 'B.csproj': SDK_APP }, /more than one project file and no solution/],
  ])('%s is ambiguous: a detection problem that blocks the project, not a guess', async (_name, files, message) => {
    const d = await detect(files);
    expect(d.detected).toBe(true);
    expect(d.problem).toMatch(message);
    expect(d.capabilities).toEqual({});
  });

  it('a legacy (non-SDK) project is reported unavailable instead of being built blindly', async () => {
    const d = await detect({ 'Old.csproj': '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"></Project>' });
    for (const id of ['restore', 'build', 'test', 'format']) {
      expect(d.capabilities[id]).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/not an SDK-style project/) });
    }
  });

  it('ignores project paths that escape the directory and ones that do not exist', async () => {
    const d = await detect({ 'App.sln': sln('..\\outside\\X.csproj', 'missing\\Y.csproj') });
    expect(d.testProjects).toEqual([]);
    expect(parseSolutionProjects(sln('a\\b.csproj', 'Folder'))).toEqual(['a/b.csproj']);
  });
});

describe('.NET commands', () => {
  const files = {
    'App.sln': sln('src/App/App.csproj', 'tests/T/T.csproj'),
    'src/App/App.csproj': SDK_APP,
    'tests/T/T.csproj': TEST_APP,
  };

  it('restore, build, test and format use the explicit target and never rewrite files', async () => {
    const d = await detect(files);
    expect(argv(d.capabilities['restore'])).toEqual(['dotnet', 'restore', './App.sln']);
    expect(argv(d.capabilities['build'])).toEqual(['dotnet', 'build', './App.sln', '--no-restore', '-c', 'Release']);
    expect(argv(d.capabilities['test'])).toEqual(['dotnet', 'test', './App.sln', '--no-restore', '-c', 'Release']);
    expect(argv(d.capabilities['format'])).toEqual(['dotnet', 'format', './App.sln', '--verify-no-changes', '--no-restore']);
  });

  it('a file name that looks like an option cannot be read as one', async () => {
    const d = await detect({ '-evil.csproj': SDK_APP });
    expect(argv(d.capabilities['build'])[2]).toBe('./-evil.csproj');
  });

  it('a project with no test project has no test step (unavailable, not silently passing)', async () => {
    const d = await detect({ 'App.csproj': SDK_APP });
    expect(d.capabilities['test']).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/No test project was found/) });
  });

  it('IsTestProject marks a test project too', async () => {
    const d = await detect({ 'T.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>' });
    expect(d.testProjects).toEqual(['T.csproj']);
    expect(d.capabilities['test']?.state).toBe('available');
  });

  it('uses --locked-mode when a packages.lock.json exists', async () => {
    const d = await detect({ 'App.csproj': SDK_APP, 'packages.lock.json': '{}' });
    expect(argv(d.capabilities['restore'])).toEqual(['dotnet', 'restore', './App.csproj', '--locked-mode']);
  });

  it('turns off telemetry and first-run output', async () => {
    const d = await detect(files);
    expect((d.capabilities['build'] as AvailableCapability).env).toEqual({
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    });
  });

  it('format needs SDK 6 or newer, build/test/format need restored packages, restore does not', async () => {
    const d = await detect(files);
    const requires = (id: string): AvailableCapability['requires'] => (d.capabilities[id] as AvailableCapability).requires;
    expect(requires('format').some((r) => r.kind === 'version' && r.atLeast === '6.0.0')).toBe(true);
    for (const id of ['build', 'test', 'format']) expect(requires(id).some((r) => r.kind === 'dependencies'), id).toBe(true);
    expect(requires('restore').some((r) => r.kind === 'dependencies')).toBe(false);
  });

  it('global.json adds a minimum SDK requirement and a note', async () => {
    const d = await detect({ 'App.csproj': SDK_APP, 'global.json': '{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}' });
    expect(d.globalJson).toEqual({ version: '8.0.100', rollForward: 'latestFeature' });
    expect((d.capabilities['build'] as AvailableCapability).requires).toContainEqual({
      kind: 'version',
      tool: 'dotnet',
      atLeast: '8.0.100',
      source: 'global.json',
    });
    expect(d.warnings?.[0]).toMatch(/global\.json pins SDK 8\.0\.100 \(rollForward: latestFeature\)/);
  });

  it('knows whether packages are restored', async () => {
    expect((await detect({ 'App.csproj': SDK_APP })).dependenciesOnDisk).toBe(false);
    expect((await detect({ 'App.csproj': SDK_APP, 'obj/project.assets.json': '{}' })).dependenciesOnDisk).toBe(true);
    const partial = await detect({
      'App.sln': sln('a/A.csproj', 'b/B.csproj'),
      'a/A.csproj': SDK_APP,
      'b/B.csproj': SDK_APP,
      'a/obj/project.assets.json': '{}',
    });
    expect(partial.dependenciesOnDisk).toBe(false);
  });

  it('init leaves format out unless an .editorconfig says how the code should look', async () => {
    const without = await detect(files);
    expect(dotnetAdapter.defaultPipeline(without).pipeline).toEqual(['restore', 'build', 'test']);
    expect(dotnetAdapter.defaultPipeline(without).omitted[0]).toMatchObject({ id: 'format', reason: expect.stringMatching(/\.editorconfig/) });
    const withEditorConfig = await detect({ ...files, '.editorconfig': 'root = true' });
    expect(dotnetAdapter.defaultPipeline(withEditorConfig).pipeline).toEqual(['restore', 'build', 'test', 'format']);
  });

  it('projects inside a single solution are covered by it during discovery', async () => {
    const dir = await makeTree(files);
    const result = await discoverProjects(dir);
    expect(result.projects.map((p) => [p.path, p.type])).toEqual([['.', 'dotnet']]);
    expect(result.covered.map((c) => c.path)).toEqual(['src/App', 'tests/T']);
  });
});

describe('.NET through the pipeline with fake tools (mocked toolchain)', () => {
  const DOTNET = `
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('8.0.100'); process.exit(0); }
if (process.env.DOTNET_CLI_TELEMETRY_OPTOUT !== '1') { console.error('telemetry not disabled'); process.exit(9); }
if (a[0] === 'format' && require('fs').existsSync('.misformatted')) { console.log('Formatted code differs in Program.cs'); process.exit(2); }
console.log('dotnet ' + a.join(' ') + ' ok');
`;
  const BROKEN_DOTNET = `
console.error('The command could not be loaded, possibly because:');
console.error('  * You intended to execute a .NET application:');
console.error('      The application \\'--version\\' does not exist.');
process.exit(145);
`;
  const config = 'version: 1\nproject:\n  type: dotnet\npipeline: [restore, build, test, format]\n';
  const project = {
    '.local-ci.yml': config,
    'App.sln': sln('src/App.csproj', 'tests/T.csproj'),
    'src/App.csproj': SDK_APP,
    'tests/T.csproj': TEST_APP,
  };

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

  it('restores, builds, tests and verifies formatting', async () => {
    const shims = await installShims({ dotnet: DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, project);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(0);
        const report = await lastReport(cwd);
        expect(statuses(report).every(([, s]) => s === 'PASS')).toBe(true);
        expect(report.steps.find((s) => s.id === 'build')!.stdout).toContain('dotnet build ./App.sln --no-restore -c Release ok');
      });
    });
  }, 120_000);

  it('a formatting difference fails only the format step, with the tool exit code', async () => {
    const shims = await installShims({ dotnet: DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { ...project, '.misformatted': '' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['restore', 'PASS'], ['build', 'PASS'], ['test', 'PASS'], ['format', 'FAIL']]);
        expect(report.steps[3]).toMatchObject({ exitCode: 2 });
      });
    });
  }, 120_000);

  it('a broken dotnet ("The command could not be loaded") is treated as missing, never as present', async () => {
    const shims = await installShims({ dotnet: BROKEN_DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, project);
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(report.steps.every((s) => s.status === 'BLOCKED')).toBe(true);
        // It is on PATH but unusable, and the message says exactly that, quoting dotnet itself.
        expect(report.steps[0]!.error).toMatch(/needs dotnet, but it is not available \(dotnet was found, but "dotnet --version" did not report a version: The command could not be loaded/);
      });
    });
  }, 120_000);

  it('without a restore step, build is blocked until packages exist; with one it is only a warning', async () => {
    const shims = await installShims({ dotnet: DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { ...project, '.local-ci.yml': 'version: 1\nproject:\n  type: dotnet\npipeline: [build]\n' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(statuses(report)).toEqual([['build', 'BLOCKED']]);
        expect(report.steps[0]!.error).toMatch(/NuGet packages \(obj\/project\.assets\.json\) is missing.*no earlier install step/);
      });
    });
  }, 120_000);

  it('blocks when the SDK is older than global.json requires', async () => {
    const shims = await installShims({ dotnet: DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { ...project, 'global.json': '{"sdk":{"version":"9.0.100"}}' });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(report.steps[0]!.status).toBe('BLOCKED');
        expect(report.steps[0]!.error).toMatch(/global\.json requires dotnet >= 9\.0\.100, but 8\.0\.100 is installed/);
      });
    });
  }, 120_000);

  it('an ambiguous directory blocks every step with the reason', async () => {
    const shims = await installShims({ dotnet: DOTNET });
    await withTempProject(async (cwd) => {
      await writeTree(cwd, { '.local-ci.yml': config, 'A.sln': sln(), 'B.sln': sln() });
      await withPath([shims], async () => {
        expect(await runCommand(cwd, { browsers: NO_BROWSERS })).toBe(1);
        const report = await lastReport(cwd);
        expect(report.steps.every((s) => s.status === 'BLOCKED')).toBe(true);
        expect(report.steps[0]!.error).toMatch(/more than one solution/);
      });
    });
  }, 120_000);
});
