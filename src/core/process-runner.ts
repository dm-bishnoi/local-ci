import { execa, type ResultPromise } from 'execa';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Normalizes execa output (string | Uint8Array | string[] | undefined)
 * to plain text for reports without leaking raw binary shapes.
 */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  if (Array.isArray(value)) return value.map((entry) => toText(entry)).join('\n');
  if (value == null) return '';
  return String(value);
}

/**
 * Executes a fixed executable + argument vector. The core never evaluates a
 * shell string, which avoids accidental shell interpretation by default.
 */
export async function runProcess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number } ,
): Promise<ProcessResult> {
  const child: ResultPromise = execa(executable, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    reject: false,
    shell: false,
    extendEnv: true,
  });
  const result = await child;
  return {
    exitCode: result.exitCode ?? (result.failed ? 1 : 0),
    stdout: toText(result.stdout),
    stderr: toText(result.stderr),
  };
}
