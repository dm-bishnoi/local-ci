import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readText } from '../fs.js';
import type { Detection, EcosystemAdapter, WorkspaceMembers } from '../types.js';
import { NODE_STEP_IDS, NODE_STEP_NAMES, resolveNodeCapabilities } from './commands.js';
import { detectNode, type NodeDetection } from './detect.js';

export * from './commands.js';
export * from './detect.js';

/** Steps `init` considers, in the order they should run. `security` is handled separately. */
const INIT_ORDER = ['install', 'typecheck', 'test', 'coverage', 'lint', 'format', 'build'] as const;

function suggestType(d: NodeDetection): string {
  if (d.frameworks.includes('angular')) return 'angular';
  if (d.frameworks.includes('vue')) return 'vue';
  if (d.frameworks.includes('react')) return 'react';
  return d.typescript ? 'typescript' : 'node';
}

async function workspaceMembers(dir: string): Promise<WorkspaceMembers | null> {
  const pnpm = await readText(join(dir, 'pnpm-workspace.yaml'));
  if (pnpm !== null) {
    try {
      const packages = (parseYaml(pnpm) as { packages?: unknown } | null)?.packages;
      if (Array.isArray(packages)) {
        return { patterns: packages.filter((p): p is string => typeof p === 'string'), source: 'pnpm-workspace.yaml' };
      }
    } catch {
      /* an unreadable workspace file declares nothing we can trust */
    }
  }

  const manifestText = await readText(join(dir, 'package.json'));
  if (manifestText === null) return null;
  try {
    const workspaces = (JSON.parse(manifestText) as { workspaces?: unknown }).workspaces;
    const patterns = Array.isArray(workspaces)
      ? workspaces
      : typeof workspaces === 'object' && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)
        ? (workspaces as { packages: unknown[] }).packages
        : null;
    if (patterns) return { patterns: patterns.filter((p): p is string => typeof p === 'string'), source: 'package.json workspaces' };
  } catch {
    /* handled by detection */
  }
  return null;
}

/**
 * The minimal pipeline `init` writes.
 *
 * Only steps that can run for this project are listed, and nothing contacts the
 * network unless it is needed: `install` is generated only when a lockfile
 * exists (so nothing is created or rewritten) and dependencies are not already
 * on disk; `security` (an audit, which queries the registry) is never generated.
 */
function defaultPipeline(detection: Detection): { pipeline: string[]; omitted: Array<{ id: string; reason: string }> } {
  const d = detection as NodeDetection;
  const pipeline: string[] = [];
  const omitted: Array<{ id: string; reason: string }> = [];
  const declaresDependencies = Object.keys(d.dependencies).length + Object.keys(d.devDependencies).length > 0;

  for (const id of INIT_ORDER) {
    const capability = d.capabilities[id];
    if (!capability) continue;
    if (capability.state === 'unavailable') {
      omitted.push({ id, reason: capability.reason });
      continue;
    }

    if (id === 'install') {
      if (d.lockfile === null) {
        omitted.push({ id, reason: 'No lockfile found, and installing without one would create it. Commit a lockfile first.' });
      } else if (d.dependenciesOnDisk) {
        omitted.push({ id, reason: 'Dependencies are already installed. Add "install" to reinstall from the lockfile (this uses the network).' });
      } else {
        pipeline.push(id);
      }
      continue;
    }

    const needsDependencies = capability.requires.some((requirement) => requirement.kind === 'dependencies');
    if (needsDependencies && declaresDependencies && !d.dependenciesOnDisk && !pipeline.includes('install')) {
      omitted.push({ id, reason: 'Needs dependencies installed (node_modules is missing) and no install step was generated.' });
      continue;
    }
    pipeline.push(id);
  }

  omitted.push({ id: 'security', reason: 'An audit contacts the package registry. Add "security" if you want it.' });
  return { pipeline, omitted };
}

export const nodeAdapter: EcosystemAdapter = {
  id: 'node',
  profiles: ['node', 'javascript', 'typescript', 'angular', 'react', 'vue'],
  async detect(dir: string): Promise<NodeDetection> {
    const detection = await detectNode(dir);
    detection.capabilities = detection.detected ? resolveNodeCapabilities(detection) : {};
    return detection;
  },
  stepIds: () => NODE_STEP_IDS,
  stepName: (id) => (Object.hasOwn(NODE_STEP_NAMES, id) ? NODE_STEP_NAMES[id]! : id),
  suggestType: (detection) => suggestType(detection as NodeDetection),
  workspaceMembers,
  defaultPipeline,
};
