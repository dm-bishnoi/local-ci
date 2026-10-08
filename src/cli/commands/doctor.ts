import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_FILE, loadConfig } from '../../config/loader.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

type CheckOutcome = 'ok' | 'missing' | 'blocked' | 'invalid';

interface Probe {
  outcome: CheckOutcome;
  detail: string;
}

const ICONS: Record<CheckOutcome, string> = {
  ok: '✓',
  missing: '✗',
  blocked: '!',
  invalid: '✗',
};

/**
 * Distinguishes "tool is not installed" from "we were not allowed to look".
 *
 * Phase 1 collapsed every probe failure to `false`, so a sandbox or permission
 * block was reported as a missing tool. That is a false negative that must
 * never be presented as a definitive answer, and it must never be reported as
 * a pass either.
 */
async function probeExecutable(name: string): Promise<Probe> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(locator, [name], { timeout: PROBE_TIMEOUT_MS });
    return { outcome: 'ok', detail: name };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // A string code is a spawn-level failure (ENOENT, EPERM, EACCES...), not an
    // exit status. EPERM/EACCES specifically means the check itself was blocked.
    if (typeof code === 'string') {
      const blocked = code === 'EPERM' || code === 'EACCES';
      return {
        outcome: 'blocked',
        detail: blocked
          ? `${name} could not be checked: process execution was blocked (${code})`
          : `${name} could not be checked: ${code}`,
      };
    }

    const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
    if (stdout) return { outcome: 'ok', detail: name };

    return { outcome: 'missing', detail: `${name} was not found on PATH` };
  }
}

export async function doctorCommand(cwd: string): Promise<number> {
  const checks: Array<[string, CheckOutcome, string]> = [];
  checks.push([
    'Node.js',
    Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'invalid',
    process.version,
  ]);

  for (const tool of ['npm', 'git']) {
    const probe = await probeExecutable(tool);
    checks.push([tool, probe.outcome, probe.detail]);
  }

  const hasConfig = await access(join(cwd, CONFIG_FILE)).then(() => true).catch(() => false);
  checks.push([CONFIG_FILE, hasConfig ? 'ok' : 'missing', hasConfig ? CONFIG_FILE : `${CONFIG_FILE} not found`]);

  let configValid = false;
  try { await loadConfig(cwd); configValid = true; } catch { /* reported below */ }
  checks.push([
    'configuration',
    configValid ? 'ok' : 'invalid',
    configValid ? 'valid' : `invalid or missing ${CONFIG_FILE}`,
  ]);

  console.log('\nLOCAL CI DOCTOR\n');
  for (const [name, outcome, detail] of checks) console.log(`${ICONS[outcome]} ${name}: ${detail}`);

  // Blocked probes are not passes and are not clean results either.
  return checks.every(([, outcome]) => outcome === 'ok') ? 0 : 1;
}