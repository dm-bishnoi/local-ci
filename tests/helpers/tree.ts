import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Writes `{ 'relative/path': content }` under `dir`. Objects are written as JSON. */
export async function writeTree(dir: string, files: Record<string, string | object>): Promise<string> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  return dir;
}

const created: string[] = [];

/** Creates a temp project directory populated with `files`. Call {@link cleanupTrees} in afterEach/afterAll. */
export async function makeTree(files: Record<string, string | object> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-tree-'));
  created.push(dir);
  return writeTree(dir, files);
}

export async function cleanupTrees(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
