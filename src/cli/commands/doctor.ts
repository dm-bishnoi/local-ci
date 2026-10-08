import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_FILE, loadConfig } from '../../config/loader.js';

const execFileAsync = promisify(execFile);

async function executable(name: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [name]);
    return true;
  } catch {
    return false;
  }
}

export async function doctorCommand(cwd: string): Promise<number> {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(['Node.js', Number(process.versions.node.split('.')[0]) >= 20, process.version]);
  checks.push(['npm', await executable('npm'), 'required for Phase 1 package workflow']);
  checks.push(['Git', await executable('git'), 'recommended for project workflows']);
  checks.push(['local config', await access(join(cwd, CONFIG_FILE)).then(() => true).catch(() => false), CONFIG_FILE]);

  let configValid = false;
  try { await loadConfig(cwd); configValid = true; } catch { /* reported below */ }
  checks.push(['configuration', configValid, configValid ? 'valid' : `invalid or missing ${CONFIG_FILE}`]);

  console.log('\nLOCAL CI DOCTOR\n');
  for (const [name, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}
