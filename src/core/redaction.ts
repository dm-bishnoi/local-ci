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
  'CONNECTIONSTRING',
  'CONNECTION_STRING',
  'WEBHOOK',
] as const;

/**
 * Short words that are only sensitive as a whole name segment. Substring
 * matching would mask `PATH` (for `PAT`) or `KEYBOARD` (for `KEY`); segment
 * matching catches `GH_PAT`, `AZURE_DEVOPS_EXT_PAT`, `STRIPE_KEY`, `DB_PWD`.
 */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set(['PAT', 'KEY', 'PWD', 'PASS', 'DSN']);

const SENSITIVE_FLAG = /^--?[a-z0-9-]*(token|secret|password|passwd|passphrase|credential|auth|api[-_]?key|[-_]?key)([=-]|$)/i;

/** True when a name (env var or CLI flag) looks like it carries a credential. */
export function isSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  // PWD and OLDPWD are shell navigation variables, not credentials. Keep PWD
  // as a sensitive segment for names such as DB_PWD.
  if (upper === 'PWD' || upper === 'OLDPWD') return false;
  if (SENSITIVE_WORDS.some((word) => upper.includes(word))) return true;
  const segments = upper.split(/[^A-Z0-9]+/);
  if (segments.length === 1 && NON_SECRET_SHELL_SEGMENTS.has(upper)) return false;
  return segments.some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/**
 * Credentials recognisable by their *format*, independent of any known value.
 *
 * Value-based masking only covers secrets this process can see in its own
 * environment. A tool printing a token it read from `.npmrc`, a keychain or a
 * config file gives nothing to match against. Each pattern here targets a
 * documented token format or an unambiguous `name=value` credential syntax, so
 * ordinary build output is not masked by accident.
 */
const TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; keep: (...groups: string[]) => string }> = [
  // HTTP authorization headers, e.g. `Authorization: Bearer abc`, `authorization=Basic xyz`.
  {
    pattern: /\b(authorization\s*[:=]\s*)((?:bearer|basic|token)\s+)?[^\s"',;]+/gi,
    keep: (prefix = '', scheme = '') => `${prefix}${scheme}`,
  },
  // A bare bearer credential, e.g. in a curl trace.
  { pattern: /\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, keep: (prefix = '') => prefix },
  // JSON Web Tokens: three base64url segments, the first two always `eyJ`.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, keep: () => '' },
  // GitHub tokens (classic, OAuth, user/server, refresh, fine-grained).
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, keep: () => '' },
  // npm automation/publish tokens.
  { pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, keep: () => '' },
  // `.npmrc` credentials: `//registry/:_authToken=...`, `_auth=...`, `_password=...`.
  { pattern: /(_authToken|_auth|_password)(\s*=\s*)[^\s"']+/g, keep: (name = '', eq = '') => `${name}${eq}` },
  // Slack tokens and AWS access key ids.
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, keep: () => '' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: () => '' },
  // Key/value connection strings: `Password=...;`, `pwd=...`, `AccountKey=...`, `SharedAccessKey=...`.
  {
    pattern: /\b(password|pwd|accountkey|sharedaccesskey|sharedaccesssignature)(\s*=\s*)[^;\s"']+/gi,
    keep: (name = '', eq = '') => `${name}${eq}`,
  },
];

/**
 * Masks credentials recognisable by format, keeping the label in front of the
 * value (`Authorization: Bearer ***`) so a reader still knows what was there.
 */
export function maskTokenPatterns(text: string): string {
  let output = text;
  for (const { pattern, keep } of TOKEN_PATTERNS) {
    output = output.replace(pattern, (_match, ...groups: unknown[]) => {
      const captured = groups.slice(0, -2).map((group) => (typeof group === 'string' ? group : ''));
      return `${keep(...captured)}${REDACTED}`;
    });
  }
  return output;
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