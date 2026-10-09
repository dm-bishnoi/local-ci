/**
 * E2E cancellation check against the BUILT output (dist/), not src/.
 *
 * Driving this through dist proves the shipped artifact behaves correctly, not
 * just the TypeScript sources.
 *
 * Cancellation is triggered programmatically rather than with an OS signal:
 * Windows delivers console control events to a whole process group, so sending
 * a real SIGINT from a script would also signal the harness. Everything else is
 * the real thing — the real Angular adapter, the real registry, the real
 * PipelineRunner, real child processes, and the real reporters.
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// Resolved relative to this file so the script works from any checkout.
const DIST = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')).href;

const { createRunCancellation } = await import(`${DIST}/core/cancellation.js`);
const { PipelineRunner } = await import(`${DIST}/core/pipeline-runner.js`);
const { StepRegistry } = await import(`${DIST}/core/step-runner.js`);
const { detectAngularProject, registerAngularSteps } = await import(`${DIST}/adapters/angular/index.js`);
const { buildRunReport } = await import(`${DIST}/reporters/report-model.js`);
const { writeRunReports } = await import(`${DIST}/reporters/artifact.js`);
const { formatConsoleReport } = await import(`${DIST}/reporters/console.js`);

const cwd = join(tmpdir(), `local-ci-p4-cancel-${process.pid}`);
await mkdir(cwd, { recursive: true });

await writeFile(
  join(cwd, 'package.json'),
  JSON.stringify({
    name: 'cancel-app',
    private: true,
    scripts: {
      typecheck: 'node -e "console.log(\'typecheck running\'); setTimeout(()=>{}, 60000)"',
      test: 'node -e "console.log(\'tests running\'); setTimeout(()=>{}, 60000)"',
      lint: 'node -e "console.log(\'lint clean\')"',
    },
    dependencies: { '@angular/core': '^19.0.0' },
  }),
);
await writeFile(
  join(cwd, 'angular.json'),
  JSON.stringify({ version: 1, projects: { 'cancel-app': { projectType: 'application', root: '' } } }),
);
await writeFile(join(cwd, 'package-lock.json'), '{"name":"cancel-app","lockfileVersion":3,"packages":{}}');

const config = {
  version: 1,
  project: { type: 'angular' },
  pipeline: ['typecheck', 'test', 'lint'],
  settings: { failFast: false, timeoutMs: 120000 },
};

const detection = await detectAngularProject(cwd);
const registry = new StepRegistry();
registerAngularSteps(registry, detection, config.pipeline);

const cancellation = createRunCancellation(() => {});
const runId = '20261008-000000-cancel01';

const running = new PipelineRunner(registry).run({ cwd, config, runId, signal: cancellation.signal });

// Let the first step actually start, then interrupt the run.
await new Promise((r) => setTimeout(r, 4000));
cancellation.cancel('E2E simulated interrupt.');
cancellation.dispose();

const result = await running;

const built = buildRunReport({
  result,
  metadata: { projectName: 'cancel-app', projectType: 'angular', framework: 'angular', packageManager: 'npm' },
});

console.log(formatConsoleReport(built.report));

const artifacts = await writeRunReports(cwd, built);
console.log('\nartifact errors:', artifacts.errors);

const files = await readdir(artifacts.paths.directory);
const logs = await readdir(artifacts.paths.logsDirectory);
console.log('artifacts:', files.sort().join(', '));
console.log('logs:', logs.sort().join(', '));

const json = JSON.parse(await readFile(artifacts.paths.reportJson, 'utf8'));
console.log('\nVERDICT');
console.log('  overall status      :', json.status, '(want CANCELLED)');
console.log('  exit code           :', json.exitCode, '(want 1)');
console.log('  typecheck cancelled :', json.steps.find((s) => s.id === 'typecheck')?.status);
console.log('  test skipped        :', json.steps.find((s) => s.id === 'test')?.status);
console.log('  lint skipped        :', json.steps.find((s) => s.id === 'lint')?.status);
console.log('  report.json written :', files.includes('report.json'));
console.log('  summary.json written:', files.includes('summary.json'));
console.log('  report.html written :', files.includes('report.html'));
console.log('  no fake test.log    :', !logs.includes('test.log'), !logs.includes('lint.log'));
console.log('  typecheck.log exists:', logs.includes('typecheck.log'));
process.exitCode = 0;