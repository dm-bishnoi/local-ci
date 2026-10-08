/**
 * Redaction helpers for captured process output and command metadata.
 *
 * Local CI captures stdout/stderr verbatim from child processes. Those streams
 * can legitimately contain credentials (a failing auth probe printing a header,
 * a tool echoing the token it was handed). Phase 2 masks those values in memory
 * before they reach a report or a log file.
 *
 * Security rules for this module:
 * - Secret values are read only to *mask* them. They are never stored on any
 *   result object, never serialized, and never written to disk.
 * - Environment *values* are never copied into reports. Only masked output is.
 */

export const REDACTED = '***';

/** Minimum secret length worth masking; shorter values cause mass false positives. */
const MIN_SECRET_LENGTH = 4;

/**
 * Substrings that mark an environment variable name or CLI flag as sensitive.
 * Matching is intentionally broad: over-masking is safe, under-masking is not.
 */
const SENSITIVE_WORDS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'AUTH',
  'APIKEY',
  'API_KEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'SESSION',
  'COOKIE',
] as const;

const SENSITIVE_FLAG = /^--?[a-z0-9-]*(token|secret|password|passwd|passphrase|credential|auth|api[-_]?key|[-_]?key)([=-]|$)/i;

/** True when a name (env var or CLI flag) looks like it carries a credential. */
export function isSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_WORDS.some((word) => upper.includes(word));
}

/**
 * Collects the *values* of sensitive-looking environment variables so output can
 * be masked. Used in memory only.
 */
export function sensitiveEnvValues(env: NodeJS.ProcessEnv | undefined): string[] {
  if (!env) return [];
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && isSensitiveName(name)) {
      values.push(value);
    }
  }
  return values;
}

/** Replaces every occurrence of a known secret with {@link REDACTED}. */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

/**
 * Masks credentials passed as command-line arguments, both as
 * `--token value` and as `--token=value`, so command metadata can be logged.
 */
export function sanitizeArgs(args: readonly string[]): string[] {
  const sanitized: string[] = [];
  let maskNext = false;

  for (const arg of args) {
    if (maskNext) {
      sanitized.push(REDACTED);
      maskNext = false;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const flagPart = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);

    if (SENSITIVE_FLAG.test(flagPart)) {
      if (equalsIndex !== -1) {
        sanitized.push(`${flagPart}=${REDACTED}`);
      } else {
        sanitized.push(arg);
        maskNext = true;
      }
      continue;
    }

    sanitized.push(arg);
  }

  return sanitized;
}

/**
 * Renders a command line for reports. Arguments are sanitized, and the result is
 * truncated so a pathological argument list cannot bloat a report.
 */
export function describeCommand(command: string, args: readonly string[], limit = 2_000): string {
  const rendered = [command, ...sanitizeArgs(args)].join(' ').trim();
  return truncate(rendered, limit);
}

/** Truncates text, appending a marker that states how much was dropped. */
export function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n... [truncated ${dropped} character(s)]`;
}