import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, posix, win32 } from 'node:path';

/**
 * Executable lookup that belongs to this program, not to the operating system.
 *
 * Resolving a command to an absolute path before spawning it means the working
 * directory can never shadow a PATH entry (Windows searches the current
 * directory first), and a relative PATH entry is never trusted.
 */

/** Extensions a Windows process can be started from without a shell. */
export const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const;
export const WINDOWS_BATCH_EXTENSIONS = ['.cmd', '.bat'] as const;

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  /** PATH value; defaults to the ambient environment's. */
  path?: string;
  /** PATHEXT value (Windows); defaults to the ambient environment's. */
  pathExt?: string;
}

export function isBatchFile(file: string): boolean {
  return (WINDOWS_BATCH_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase());
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function isExecutableFile(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!(await isFile(file))) return false;
  if (platform === 'win32') return true;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate file names for `name` on Windows: itself if it has a usable extension, else with each PATHEXT entry. */
export function windowsCandidates(name: string, pathExt: string | undefined): string[] {
  const allowed = new Set<string>(WINDOWS_EXECUTABLE_EXTENSIONS);
  if (allowed.has(extname(name).toLowerCase())) return [name];
  const configured = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => allowed.has(ext));
  return (configured.length > 0 ? configured : ['.exe', '.cmd']).map((ext) => `${name}${ext}`);
}

/**
 * Finds a bare executable name on PATH.
 *
 * Only absolute PATH entries are searched. Returns an absolute path, or `null`.
 */
export async function resolveOnPath(name: string, options: ResolveOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const pathModule = windows ? win32 : posix;
  const pathValue = options.path ?? process.env['PATH'] ?? process.env['Path'] ?? '';
  const candidates = windows ? windowsCandidates(name, options.pathExt ?? process.env['PATHEXT']) : [name];

  for (const raw of pathValue.split(windows ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !pathModule.isAbsolute(dir)) continue;
    for (const candidate of candidates) {
      const full = pathModule.join(dir, candidate);
      if (await isExecutableFile(full, platform)) return full;
    }
  }
  return null;
}
