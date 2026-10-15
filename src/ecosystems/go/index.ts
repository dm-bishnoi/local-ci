import { join } from 'node:path';
import { readText } from '../fs.js';
import type { AvailableCapability, Capability, Detection, EcosystemAdapter, Requirement, WorkspaceMembers } from '../types.js';

/**
 * Go modules (`go.mod`) and workspaces (`go.work`).
 *
 * Checks: `format` (gofmt -l, judged by its output, never -w), `vet`, `test`,
 * `build`. Nothing here modifies go.mod/go.sum (`-mod=readonly` is Go's default
 * and is not overridden), formats files in place, or downloads a toolchain
 * (GOTOOLCHAIN=local).
 */

export interface GoDetection extends Detection {
  ecosystem: 'go';
  workspace: boolean;
  /** Module directories relative to the project, `.` for a single module. */
  modules: string[];
  /** Minimum Go version from the `go` directive, when declared. */
  goVersion: string | null;
  toolchain: string | null;
}

const STEP_IDS = ['format', 'vet', 'test', 'build'] as const;
const STEP_NAMES: Record<string, string> = {
  format: 'Format',
  vet: 'Vet',
  test: 'Unit Tests',
  build: 'Production Build',
};

/** Directories from go.work come from a file in the repository, so they are validated like any untrusted value. */
function safeModuleDirectory(dir: string): string | null {
  const cleaned = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(cleaned)) return null;
  return cleaned;
}

/** Extracts the directories of the `use` directives of a go.work file. */
export function parseGoWorkUse(text: string): string[] {
  const dirs: string[] = [];
  const unquote = (value: string): string => value.trim().replace(/^["`](.*)["`]$/, '$1');
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '').trim());

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const single = /^use\s+(?!\()(.+)$/.exec(line);
    if (single) {
      dirs.push(unquote(single[1]!));
      continue;
    }
    if (/^use\s*\($/.test(line)) {
      for (index++; index < lines.length && lines[index] !== ')'; index++) {
        if (lines[index] !== '') dirs.push(unquote(lines[index]!));
      }
    }
  }
  return dirs;
}

export function parseGoMod(text: string): { goVersion: string | null; toolchain: string | null } {
  const go = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text);
  const toolchain = /^toolchain\s+go(\S+)\s*$/m.exec(text);
  return { goVersion: go?.[1] ?? null, toolchain: toolchain?.[1] ?? null };
}

const GO_ENV = { GOTOOLCHAIN: 'local' } as const;

function goRequirements(d: GoDetection): Requirement[] {
  const requires: Requirement[] = [{ kind: 'tool', name: 'go', probeArgs: ['version'] }];
  if (d.goVersion) requires.push({ kind: 'version', tool: 'go', atLeast: d.goVersion, source: d.workspace ? 'go.work' : 'go.mod', probeArgs: ['version'] });
  return requires;
}

function packagePatterns(d: GoDetection): string[] {
  return d.modules.map((dir) => (dir === '.' ? './...' : `./${dir}/...`));
}

function resolveGo(stepId: string, d: GoDetection): Capability {
  const common = { state: 'available', source: 'builtin', env: { ...GO_ENV } } as const;

  switch (stepId) {
    case 'format': {
      const targets = d.modules.map((dir) => (dir === '.' ? '.' : `./${dir}`));
      const capability: AvailableCapability = {
        ...common,
        command: 'gofmt',
        args: ['-l', ...targets],
        description: 'gofmt -l',
        evaluate: 'gofmt-list',
        evidence: d.evidence.join(', '),
        requires: [{ kind: 'tool', name: 'gofmt', locateOnly: true }],
      };
      return capability;
    }
    case 'vet':
      return { ...common, command: 'go', args: ['vet', ...packagePatterns(d)], description: 'go vet', evidence: d.evidence.join(', '), requires: goRequirements(d) };
    case 'test':
      return { ...common, command: 'go', args: ['test', ...packagePatterns(d)], description: 'go test', evidence: d.evidence.join(', '), requires: goRequirements(d) };
    case 'build':
      return { ...common, command: 'go', args: ['build', ...packagePatterns(d)], description: 'go build', evidence: d.evidence.join(', '), requires: goRequirements(d) };
    default:
      return { state: 'unavailable', reason: `Unknown Go step "${stepId}".` };
  }
}

async function detect(dir: string): Promise<GoDetection> {
  const goWork = await readText(join(dir, 'go.work'));
  const goMod = await readText(join(dir, 'go.mod'));
  const evidence: string[] = [];
  const base = {
    ecosystem: 'go' as const,
    root: dir,
    confidence: 'strong' as const,
    capabilities: {} as Record<string, Capability>,
    workspace: false,
    modules: [] as string[],
    goVersion: null as string | null,
    toolchain: null as string | null,
  };

  if (goWork === null && goMod === null) {
    return { ...base, detected: false, evidence, reason: `No go.work or go.mod found in ${dir}.` };
  }

  if (goWork !== null) {
    evidence.push('go.work');
    const uses = parseGoWorkUse(goWork);
    const unsafe = uses.filter((use) => safeModuleDirectory(use) === null);
    const modules = uses.map(safeModuleDirectory).filter((use): use is string => use !== null);
    const version = parseGoMod(goWork);
    const detection: GoDetection = {
      ...base,
      detected: true,
      evidence,
      workspace: true,
      modules,
      goVersion: version.goVersion,
      toolchain: version.toolchain,
    };
    const blockedReason =
      unsafe.length > 0
        ? `go.work uses directories outside the project or with unsafe names (${unsafe.join(', ')}), so no Go step is generated for them. Run those checks from their own project.`
        : modules.length === 0
          ? 'go.work declares no modules (no "use" directive), so there is nothing to check.'
          : null;
    detection.capabilities = Object.fromEntries(
      STEP_IDS.map((id) => [id, blockedReason ? ({ state: 'unavailable', reason: blockedReason } as Capability) : resolveGo(id, detection)]),
    );
    return detection;
  }

  evidence.push('go.mod');
  const version = parseGoMod(goMod!);
  const detection: GoDetection = { ...base, detected: true, evidence, modules: ['.'], ...version };
  detection.capabilities = Object.fromEntries(STEP_IDS.map((id) => [id, resolveGo(id, detection)]));
  return detection;
}

async function workspaceMembers(dir: string): Promise<WorkspaceMembers | null> {
  const goWork = await readText(join(dir, 'go.work'));
  if (goWork === null) return null;
  return { patterns: parseGoWorkUse(goWork).filter((use) => safeModuleDirectory(use) !== null && safeModuleDirectory(use) !== '.'), source: 'go.work' };
}

export const goAdapter: EcosystemAdapter = {
  id: 'go',
  profiles: ['go', 'golang'],
  detect,
  stepIds: () => STEP_IDS,
  stepName: (id) => (Object.hasOwn(STEP_NAMES, id) ? STEP_NAMES[id]! : id),
  suggestType: () => 'go',
  workspaceMembers,
  defaultPipeline(detection) {
    const pipeline: string[] = [];
    const omitted: Array<{ id: string; reason: string }> = [];
    for (const id of STEP_IDS) {
      const capability = detection.capabilities[id];
      if (capability?.state === 'available') pipeline.push(id);
      else if (capability) omitted.push({ id, reason: capability.reason });
    }
    return { pipeline, omitted };
  },
};
