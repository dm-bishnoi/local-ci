/**
 * Verifies that a timed-out package-manager step does not leave grandchildren
 * running, and that the CLI does not linger waiting for them.
 *
 * This is the Phase 4 finding, reproduced: `npm run <script>` spawns a `node`
 * grandchild that holds the inherited stdio handles open, so killing only the
 * direct child left the command alive long after the step was declared over
 * (observed: a 3s timeout that took 62s to return).
 *
 * Run directly:  node demo/phase4.5-process-tree.mjs
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DIST = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')).href;
const { runProcess } = await import(`${DIST}/core/process-runner.js`);
const { processIsAlive } = await import(`${DIST}/core/process-tree.js`);

const cwd = await mkdtemp(join(tmpdir(), 'local-ci-tree-'));

// The grandchild records its own pid so the orphan check can ask about *that*
// process. Counting node processes globally is too noisy to be evidence.
await writeFile(
  join(cwd, 'package.json'),
  JSON.stringify({
    name: 'tree-app',
    private: true,
    scripts: {
      slow: "node -e \"require('fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(()=>{}, 120000)\"",
    },
  }),
);

console.log(`platform : ${process.platform}`);
console.log(`home     : ${homedir()}\n`);

// `npm run slow` spawns npm -> cmd -> node. Timing out must reach the grandchild.
const started = Date.now();
const result = await runProcess('npm', ['run', 'slow'], { cwd, timeoutMs: 4_000 });
const elapsed = Date.now() - started;

console.log('--- result ---');
console.log('timedOut  :', result.timedOut);
console.log('cancelled :', result.cancelled);
console.log('exitCode  :', result.exitCode);
console.log('signal    :', result.signal);
console.log('failed    :', result.failed);
console.log('error     :', result.error);
console.log('elapsedMs :', elapsed, '(timeout was 4000)');

let grandchildPid = null;
try {
  grandchildPid = Number((await readFile(join(cwd, 'grandchild.pid'), 'utf8')).trim());
} catch {
  /* the grandchild never got far enough to record itself */
}

// Allow a moment for termination to propagate before asking.
await new Promise((resolve) => setTimeout(resolve, 2_500));
const orphanAlive = grandchildPid === null ? null : processIsAlive(grandchildPid);

const checks = [
  ['returned promptly (no 60s stall)', elapsed < 20_000, `${elapsed}ms`],
  ['reported as timed out', result.timedOut === true, String(result.timedOut)],
  ['no invented exit code', result.exitCode === null, String(result.exitCode)],
  ['error explains the timeout', /timed out/i.test(result.error ?? ''), result.error],
  ['marked as failed', result.failed === true, String(result.failed)],
  ['grandchild observed', grandchildPid !== null, String(grandchildPid)],
  // alive === false is the outcome we want: the tree kill reached the grandchild.
  ['no orphaned node grandchild', orphanAlive === false, orphanAlive === null ? 'not observed' : `pid ${grandchildPid} alive=${orphanAlive}`],
];

console.log('\n--- verdict ---');
let ok = true;
for (const [label, passed, detail] of checks) {
  ok = ok && passed;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label} (${detail})`);
}

await rm(cwd, { recursive: true, force: true });
console.log(`\n${ok ? 'PROCESS TREE VERIFIED' : 'PROCESS TREE FAILED'}`);
process.exit(ok ? 0 : 1);