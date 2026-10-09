import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { localCiConfigSchema, type LocalCiConfig } from './schema.js';

export const CONFIG_FILE = '.local-ci.yml';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(cwd: string): Promise<LocalCiConfig> {
  const path = join(cwd, CONFIG_FILE);
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      throw new ConfigError(`Missing ${CONFIG_FILE}. Run "local-ci-runner init" first.`);
    }
    throw new ConfigError(`Unable to read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = localCiConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Invalid ${CONFIG_FILE}:\n${result.error.issues.map((issue) => `- ${issue.path.join('.') || '<root>'}: ${issue.message}`).join('\n')}`);
  }

  return result.data;
}
