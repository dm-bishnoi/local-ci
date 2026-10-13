import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeTree } from './tree.js';

/**
 * Fake command-line tools for integration tests.
 *
 * Each shim is a tiny Node program behind a platform wrapper (`name.cmd` on
 * Windows, an executable `name` elsewhere), so the real runner resolves and
 * spawns it exactly like a real tool. They let the whole pipeline be exercised
 * without go, cargo, dotnet or php installed. They are mocks, and tests that
 * use them must be reported as such.
 */
export async function installShims(shims: Record<string, string>): Promise<string> {
  const dir = await makeTree({});
  const windows = process.platform === 'win32';

  for (const [name, code] of Object.entries(shims)) {
    await writeFile(join(dir, `${name}.js`), code, 'utf8');
    if (windows) {
      await writeFile(join(dir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`, 'utf8');
    } else {
      const file = join(dir, name);
      await writeFile(file, `#!/bin/sh\nexec node "$(dirname "$0")/${name}.js" "$@"\n`, 'utf8');
      await chmod(file, 0o755);
    }
  }
  return dir;
}

/** Runs `body` with `directories` prepended to PATH (or replacing it), restoring it afterwards. */
export async function withPath<T>(directories: string[], body: () => Promise<T>, options: { replace?: boolean } = {}): Promise<T> {
  const key = process.platform === 'win32' ? (Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path') : 'PATH';
  const previous = process.env[key];
  const separator = process.platform === 'win32' ? ';' : ':';
  const nodeDir = dirname(process.execPath);
  process.env[key] = options.replace
    ? [...directories, nodeDir].join(separator)
    : [...directories, previous ?? ''].join(separator);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
