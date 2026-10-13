import { join } from 'node:path';
import { pathExists, readText } from '../fs.js';
import { pipelineFromCapabilities } from '../pipeline.js';
import type { AvailableCapability, Capability, DetectOptions, Detection, EcosystemAdapter, Requirement, WorkspaceMembers } from '../types.js';

/**
 * Cargo projects (`Cargo.toml`, `Cargo.lock`).
 *
 * Checks: `check`, `test`, `build` (release), `format` (`cargo fmt --check`,
 * which never rewrites files) and `lint` (clippy, warnings are errors).
 * `--locked` is added whenever a Cargo.lock exists so the lock file is never
 * rewritten; `--offline` follows `settings.offline`. rustup is told not to
 * install toolchains (RUSTUP_AUTO_INSTALL=0), so nothing is downloaded unasked.
 */

export interface RustDetection extends Detection {
  ecosystem: 'rust';
  workspace: boolean;
  package: boolean;
  lockfile: boolean;
  members: string[];
  toolchainFile: string | null;
}

const STEP_IDS = ['check', 'test', 'build', 'format', 'lint'] as const;
const INIT_ORDER = ['format', 'lint', 'check', 'test', 'build'] as const;
const STEP_NAMES: Record<string, string> = {
  check: 'Check',
  test: 'Unit Tests',
  build: 'Production Build',
  format: 'Format',
  lint: 'Lint',
};

const RUST_ENV = { RUSTUP_AUTO_INSTALL: '0' } as const;

function sectionBody(toml: string, header: string): string | null {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function stringList(body: string, key: string): string[] {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(body);
  if (!match) return [];
  return [...match[1]!.replace(/#.*$/gm, '').matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

const cargo = (probeArgs?: string[], display?: string): Requirement => ({
  kind: 'tool',
  name: 'cargo',
  env: { ...RUST_ENV },
  ...(probeArgs ? { probeArgs } : {}),
  ...(display ? { display } : {}),
});

function resolveRust(stepId: string, d: RustDetection, options: DetectOptions): Capability {
  const workspace = d.workspace ? ['--workspace'] : [];
  const locked = d.lockfile ? ['--locked'] : [];
  const offline = options.offline ? ['--offline'] : [];
  const base = { state: 'available', source: 'builtin', env: { ...RUST_ENV }, evidence: d.evidence.join(', ') } as const;

  const make = (args: string[], requires: Requirement[]): AvailableCapability => ({
    ...base,
    command: 'cargo',
    args,
    description: `cargo ${args[0]}`,
    requires,
  });

  switch (stepId) {
    case 'check':
      return make(['check', '--all-targets', ...workspace, ...locked, ...offline], [cargo()]);
    case 'test':
      return make(['test', ...workspace, ...locked, ...offline], [cargo()]);
    case 'build':
      return make(['build', '--release', ...workspace, ...locked, ...offline], [cargo()]);
    case 'format':
      // `--check` makes rustfmt report differences and exit non-zero; it never writes.
      return make(['fmt', '--all', '--', '--check'], [cargo(['fmt', '--version'], 'rustfmt (cargo fmt)')]);
    case 'lint':
      return make(
        ['clippy', '--all-targets', ...workspace, ...locked, ...offline, '--', '-D', 'warnings'],
        [cargo(['clippy', '--version'], 'clippy (cargo clippy)')],
      );
    default:
      return { state: 'unavailable', reason: `Unknown Rust step "${stepId}".` };
  }
}

async function detect(dir: string, options: DetectOptions = {}): Promise<RustDetection> {
  const manifest = await readText(join(dir, 'Cargo.toml'));
  const empty = {
    ecosystem: 'rust' as const,
    root: dir,
    confidence: 'strong' as const,
    capabilities: {} as Record<string, Capability>,
    workspace: false,
    package: false,
    lockfile: false,
    members: [] as string[],
    toolchainFile: null as string | null,
  };

  if (manifest === null) return { ...empty, detected: false, evidence: [], reason: `No Cargo.toml found in ${dir}.` };

  const workspaceBody = sectionBody(manifest, 'workspace');
  const hasPackage = sectionBody(manifest, 'package') !== null;
  if (workspaceBody === null && !hasPackage) {
    return {
      ...empty,
      detected: false,
      evidence: ['Cargo.toml'],
      reason: 'Cargo.toml declares neither [package] nor [workspace].',
    };
  }

  const lockfile = await pathExists(join(dir, 'Cargo.lock'));
  const toolchainFile = (await pathExists(join(dir, 'rust-toolchain.toml')))
    ? 'rust-toolchain.toml'
    : (await pathExists(join(dir, 'rust-toolchain')))
      ? 'rust-toolchain'
      : null;

  const evidence = ['Cargo.toml'];
  if (lockfile) evidence.push('Cargo.lock');
  if (toolchainFile) evidence.push(toolchainFile);

  const detection: RustDetection = {
    ...empty,
    detected: true,
    evidence,
    workspace: workspaceBody !== null,
    package: hasPackage,
    lockfile,
    members: workspaceBody ? stringList(workspaceBody, 'members') : [],
    toolchainFile,
  };
  if (!lockfile) {
    detection.warnings = ['No Cargo.lock was found, so --locked is not used and cargo will create one in the project. Commit a Cargo.lock for reproducible runs.'];
  }
  detection.capabilities = Object.fromEntries(STEP_IDS.map((id) => [id, resolveRust(id, detection, options)]));
  return detection;
}

async function workspaceMembers(dir: string): Promise<WorkspaceMembers | null> {
  const manifest = await readText(join(dir, 'Cargo.toml'));
  if (manifest === null) return null;
  const body = sectionBody(manifest, 'workspace');
  if (body === null) return null;
  return { patterns: stringList(body, 'members'), source: 'Cargo.toml [workspace]' };
}

export const rustAdapter: EcosystemAdapter = {
  id: 'rust',
  profiles: ['rust', 'cargo'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: () => 'rust',
  workspaceMembers,
  defaultPipeline: (detection) => pipelineFromCapabilities(detection, INIT_ORDER),
};
