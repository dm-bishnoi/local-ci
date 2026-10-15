import { access, readFile, readdir } from 'node:fs/promises';

/** Removes a leading UTF-8 byte order mark (common in files written on Windows). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return stripBom(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export type JsonRead = { value: unknown } | { error: string };

/** `error: 'missing'` means the file does not exist; anything else is a parse problem. */
export async function readJson(path: string): Promise<JsonRead> {
  const raw = await readText(path);
  if (raw === null) return { error: 'missing' };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** Names of the entries directly inside `dir`; empty when it cannot be read. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
