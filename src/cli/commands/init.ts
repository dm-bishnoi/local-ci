import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE } from '../../config/loader.js';
import { REPORT_ROOT_GITIGNORE, ensureReportRootIgnored } from '../../reporters/artifact.js';

const TEMPLATE = `version: 1\n\nproject:\n  type: angular\n\npipeline:\n  - install\n  - typecheck\n  - test\n  - coverage\n  - lint\n  - build\n  - security\n\nsettings:\n  failFast: false\n  timeoutMs: 300000\n`;

export async function initCommand(cwd: string, force = false): Promise<void> {
  const path = join(cwd, CONFIG_FILE);
  try {
    await access(path);
    if (!force) throw new Error(`${CONFIG_FILE} already exists. Use --force to replace it.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) throw error;
  }
  await writeFile(path, TEMPLATE, 'utf8');
  console.log(`Created ${CONFIG_FILE}`);

  // Reports are written under .local-ci/ and can contain captured output.
  // The directory ignores itself; the project's own .gitignore is never edited.
  if (await ensureReportRootIgnored(cwd)) {
    console.log(`Created ${REPORT_ROOT_GITIGNORE} so run reports stay out of version control.`);
  }
}
