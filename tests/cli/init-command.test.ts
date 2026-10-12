/**
 * `init` creates the configuration and protects the reports directory, without
 * editing any file the project already owns.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { CONFIG_FILE, loadConfig } from '../../src/config/loader.js';
import { REPORT_ROOT_GITIGNORE } from '../../src/reporters/artifact.js';
import { withTempProject } from '../helpers/reports.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('init', () => {
  it('writes a valid configuration and a self-ignoring reports directory', async () => {
    await withTempProject(async (cwd) => {
      await initCommand(cwd);

      const config = await loadConfig(cwd);
      expect(config.pipeline.length).toBeGreaterThan(0);
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toMatch(/^\*$/m);
    });
  });

  it('leaves the project .gitignore untouched', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, '.gitignore'), 'dist/\r\n', 'utf8');
      await initCommand(cwd);
      expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('dist/\r\n');
    });
  });

  it('keeps an existing .local-ci/.gitignore', async () => {
    await withTempProject(async (cwd) => {
      await initCommand(cwd);
      await writeFile(join(cwd, REPORT_ROOT_GITIGNORE), 'custom\n', 'utf8');
      await initCommand(cwd, true);
      expect(await readFile(join(cwd, REPORT_ROOT_GITIGNORE), 'utf8')).toBe('custom\n');
    });
  });

  it('refuses to replace a configuration without --force and writes nothing', async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, CONFIG_FILE), 'version: 1\n', 'utf8');

      await expect(initCommand(cwd)).rejects.toThrow(/already exists/);
      expect(await readFile(join(cwd, CONFIG_FILE), 'utf8')).toBe('version: 1\n');
      expect(await exists(join(cwd, REPORT_ROOT_GITIGNORE))).toBe(false);
    });
  });
});
