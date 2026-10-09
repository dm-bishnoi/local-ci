/**
 * Precise orphan check: the grandchild records its own PID, so we can ask
 * whether *that specific process* survived the tree kill.
 *
 * Run directly:  node demo/phase4.5-orphan-probe.mjs
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DIST = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')).href;
const { runProcess } = await import(`${DIST}/core/process-runner.js`);
const { processIsAlive } = await import(`${DIST}/core/process-tree.js`);

const cwd = await mkdtemp(join(tmpdir(), 'local-ci-orphan-'));
const pidFile = join(cwd, 'grandchild.pid');

// The grandchild writes its PID immediately, then sleeps for two minutes.
await writeFile(
  join(cwd, 'package.json'),
  JSON.stringify({
    name: 'orphan-app',
    private: true,
    scripts: {
      slow: "node -e \"require('fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(()=>{}, 120000)\"",
    },
  }),
);

const started = Date.now();
const result = await runProcess('npm', ['run', 'slow'], { cwd, timeoutMs: 4_000 });
const elapsed = Date.now() - started;

console.log(`elapsedMs   : ${elapsed}`);
console.log(`timedOut    : ${result.timedOut}`);
console.log(`signal      : ${result.signal}`);

let grandchildPid = null;
try {
  grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
} catch {
  console.log('grandchild  : never recorded its pid');
}

if (grandchildPid === null) {
  console.log('\nORPHAN PROBE: inconclusive');
} else {
  // Allow a moment for termination to propagate.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const alive = processIsAlive(grandchildPid);
  console.log(`grandchildPid: ${grandchildPid}`);
  console.log(`still alive  : ${alive}`);
  console.log(`\n${alive ? 'ORPHAN SURVIVED (tree kill incomplete)' : 'ORPHAN REAPED (tree kill complete)'}`);
}

await rm(cwd, { recursive: true, force: true });