/**
 * Phase 2 verification harness.
 *
 * Exercises the execution engine end to end against deterministic commands
 * (the current Node binary), covering every behaviour Phase 2 claims:
 * PASS, FAIL, failFast=false, failFast=true, UNSUPPORTED, timeout and
 * cancellation. Each scenario writes real reports and logs, then asserts the
 * resulting statuses and exit codes.
 *
 * Run after `npm run build`:  node demo/phase2-demo.mjs
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunCancellation } from '../dist/core/cancellation.js';
import { PipelineRunner } from '../dist/core/pipeline-runner.js';
import { StepRegistry } from '../dist/core/step-runner.js';
import { createProcessStep } from '../dist/core/process-step.js';
import { printConsoleReport } from '../dist/reporters/console.js';
import { writeJsonReport } from '../dist/reporters/json.js';
import { writeHtmlReport } from '../dist/reporters/html.js';
import { writeRunLogs } from '../dist/reporters/logs.js';

const NODE = process.execPath;
const cwd = await mkdtemp(join(tmpdir(), 'local-ci-phase2-'));

let failures = 0;

const ok = (id, name, extra = []) =>
  createProcessStep({
    id,
    name,
    command: NODE,
    args: ['-e', `console.log("${name} ran"); process.exit(0);`],
    ...extra,
  });

const fail = (id, name) =>
  createProcessStep({
    id,
    name,
    command: NODE,
    args: ['-e', `console.error("${name} exploded"); process.exit(2);`],
  });

const slow = (id, name, ms = 30_000) =>
  createProcessStep({ id, name, command: NODE, args: ['-e', `setTimeout(() => {}, ${ms});`] });

function check(label, actual, expected) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (!good) failures += 1;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${good ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

/** Exit code per the Phase 2 model: 0 only for a successful pipeline. */
const exitCodeFor = (status) => (status === 'PASS' ? 0 : 1);

async function scenario(title, { pipeline, failFast = false, timeoutMs, signal }) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

  const registry = new StepRegistry().register(ok('first', 'First')).register(fail('second', 'Second')).register(ok('third', 'Third')).register(slow('slow', 'Slow'));

  const runId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now()}`;
  const runner = new PipelineRunner(registry, {
    onStepEnd: (step) => console.log(`   -> ${step.name}: ${step.status}`),
  });

  const result = await runner.run({
    cwd,
    runId,
    signal,
    config: {
      version: 1,
      project: { type: 'demo' },
      pipeline,
      settings: { failFast, timeoutMs },
    },
  });

  printConsoleReport(result);

  const logs = await writeRunLogs(cwd, result);
  await writeJsonReport(cwd, result);
  await writeHtmlReport(cwd, result);

  const written = (await readdir(logs)).sort();
  console.log(`   log files: ${written.join(', ')}`);

  return { result, exitCode: exitCodeFor(result.status), written };
}

// 1. All steps pass ----------------------------------------------------------
{
  const { result, exitCode } = await scenario('1. PASS - every step succeeds', {
    pipeline: ['first', 'third'],
  });
  check('step statuses', result.steps.map((s) => s.status), ['PASS', 'PASS']);
  check('pipeline status', result.status, 'PASS');
  check('exit code', exitCode, 0);
}

// 2. FAIL with failFast=false ------------------------------------------------
{
  const { result, exitCode } = await scenario('2. FAIL - failFast=false keeps going after a failure', {
    pipeline: ['first', 'second', 'third'],
    failFast: false,
  });
  check('step statuses', result.steps.map((s) => s.status), ['PASS', 'FAIL', 'PASS']);
  check('pipeline status', result.status, 'FAIL');
  check('exit code', exitCode, 1);
  check('failing exit code captured', result.steps[1].exitCode, 2);
}

// 3. FAIL with failFast=true -------------------------------------------------
{
  const { result, exitCode } = await scenario('3. FAIL - failFast=true skips the rest', {
    pipeline: ['first', 'second', 'third'],
    failFast: true,
  });
  check('step statuses', result.steps.map((s) => s.status), ['PASS', 'FAIL', 'SKIPPED']);
  check('pipeline status', result.status, 'FAIL');
  check('exit code', exitCode, 1);
}

// 4. UNSUPPORTED -------------------------------------------------------------
{
  const { result, exitCode } = await scenario('4. UNSUPPORTED - unregistered step fails the run', {
    pipeline: ['first', 'no-such-step'],
  });
  check('step statuses', result.steps.map((s) => s.status), ['PASS', 'UNSUPPORTED']);
  check('pipeline status', result.status, 'FAIL');
  check('exit code', exitCode, 1);
}

// 5. Timeout -----------------------------------------------------------------
{
  const { result, exitCode, written } = await scenario('5. TIMEOUT - a slow step is terminated', {
    pipeline: ['slow', 'first'],
    timeoutMs: 800,
  });
  check('step statuses', result.steps.map((s) => s.status), ['FAIL', 'PASS']);
  check('timedOut flag', result.steps[0].timedOut, true);
  check('error message', result.steps[0].error, 'Step timed out after 800ms');
  check('pipeline status', result.status, 'FAIL');
  check('exit code', exitCode, 1);
  check('timeout log written', written.includes('slow.log'), true);

  const log = await readFile(join(cwd, '.local-ci', 'reports', result.runId, 'logs', 'slow.log'), 'utf8');
  check('log records timeout', log.includes('timedOut: true'), true);
}

// 6. Cancellation (Ctrl+C through the real signal handler) --------------------
{
  const cancellation = createRunCancellation((reason) => console.log(`\n   [signal] ${reason}`));
  setTimeout(() => process.emit('SIGINT'), 700);

  const { result, exitCode, written } = await scenario('6. CANCELLED - Ctrl+C aborts the run', {
    pipeline: ['slow', 'first', 'third'],
    signal: cancellation.signal,
  });
  cancellation.dispose();

  check('step statuses', result.steps.map((s) => s.status), ['CANCELLED', 'SKIPPED', 'SKIPPED']);
  check('cancelled flag', result.cancelled, true);
  check('pipeline status', result.status, 'CANCELLED');
  check('exit code', exitCode, 1);
  check('cancellation log written', written.includes('slow.log'), true);

  const log = await readFile(join(cwd, '.local-ci', 'reports', result.runId, 'logs', 'slow.log'), 'utf8');
  check('log records cancellation', log.includes('cancelled: true'), true);
}

// 7. Secret redaction in a real run -------------------------------------------
{
  console.log(`\n${'='.repeat(72)}\n7. SECURITY - credentials are masked in output and logs\n${'='.repeat(72)}`);
  const secret = 'ghp_demo_secret_value_should_not_leak';
  const leaky = createProcessStep({
    id: 'leaky',
    name: 'Leaky',
    // "--" stops Node from parsing the trailing flags as its own options.
    command: NODE,
    args: ['-e', `console.log(process.env.DEMO_TOKEN);`, '--', '--token', secret],
    env: { ...process.env, DEMO_TOKEN: secret },
  });

  const runId = `security-${Date.now()}`;
  const result = await new PipelineRunner(new StepRegistry().register(leaky)).run({
    cwd,
    runId,
    config: { version: 1, project: { type: 'demo' }, pipeline: ['leaky'], settings: { failFast: false } },
  });

  const logs = await writeRunLogs(cwd, result);
  const log = await readFile(join(logs, 'leaky.log'), 'utf8');
  const json = JSON.stringify(result);

  check('secret absent from step stdout', result.steps[0].stdout.includes(secret), false);
  check('secret absent from log file', log.includes(secret), false);
  check('secret absent from report JSON', json.includes(secret), false);
  check('secret absent from reported command', String(result.steps[0].command).includes(secret), false);
  check('masking marker present', result.steps[0].stdout.includes('***'), true);
}

console.log(`\n${'='.repeat(72)}`);
console.log(failures === 0 ? 'ALL DEMO SCENARIOS PASSED' : `${failures} DEMO CHECK(S) FAILED`);
console.log(`Artifacts: ${join(cwd, '.local-ci', 'reports')}`);
process.exit(failures === 0 ? 0 : 1);