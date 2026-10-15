import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ADAPTERS } from './registry.js';
import type { Detection, EcosystemAdapter, EcosystemId } from './types.js';

/**
 * Project discovery for `init` and `doctor`. `run` never scans: what runs is
 * what the configuration says.
 *
 * Precedence, so nothing is silently merged or dropped:
 *   1. Workspace metadata a project declares for itself (npm/pnpm workspaces,
 *      and the equivalents other adapters add) says which directories are
 *      *covered* by that project. They are reported, not listed again.
 *   2. A bounded scan finds everything else. Symlinks and junctions are never
 *      followed (each is reported), the same directory is never listed twice,
 *      and whatever the depth limit or ignore list hid is reported too.
 *   3. A project of the same ecosystem inside another one that does not declare
 *      it is real, independent work: it is listed and marked `nestedIn`.
 */

export const DEFAULT_SCAN_DEPTH = 3;
export const MAX_SCAN_DEPTH = 8;

/** Directories that hold build output, dependencies or tooling state, never projects. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  'node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'target', 'vendor', 'dist', 'build', 'out',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.gradle', '.idea', '.vs', '.local-ci', 'coverage',
];

export interface DiscoveredProject {
  /** Unique, valid as `projects[].name`. */
  name: string;
  /** Path relative to the scan root, `.` for the root itself, with forward slashes. */
  path: string;
  /** Value to write for `type`. */
  type: string;
  ecosystem: EcosystemId;
  detection: Detection;
  /** Path of the project of the same ecosystem this one sits inside, when it is not a declared member. */
  nestedIn?: string;
}

export interface CoveredMember {
  path: string;
  coveredBy: string;
  source: string;
}

export interface DiscoveryCandidate {
  path: string;
  ecosystem: EcosystemId;
  reason: string;
}

export interface DiscoveryResult {
  projects: DiscoveredProject[];
  covered: CoveredMember[];
  /** Weak evidence only. Shown, never selected automatically. */
  candidates: DiscoveryCandidate[];
  warnings: string[];
  skipped: {
    symlinks: string[];
    ignoredDirectories: Record<string, number>;
    /** Directories at the depth limit that have sub-directories which were not scanned. */
    depthLimited: string[];
  };
}

export interface DiscoveryOptions {
  scanDepth?: number;
  /** Extra directory names to ignore, on top of {@link DEFAULT_IGNORED_DIRECTORIES}. */
  ignore?: readonly string[];
  adapters?: readonly EcosystemAdapter[];
}

const toPosix = (value: string): string => value.split(sep).join('/');

function relativePath(root: string, dir: string): string {
  const rel = toPosix(relative(root, dir));
  return rel === '' ? '.' : rel;
}

/** Characters this matcher does not implement; a pattern containing one is reported, never guessed at. */
const UNSUPPORTED_GLOB = /[{}[\]?!()]/;

interface ExpandResult {
  dirs: string[];
  unsupported: boolean;
}

/**
 * Expands a workspace member pattern: literal segments, `*`, and a trailing
 * `**`. Symlinks are never followed.
 */
async function expandPattern(base: string, pattern: string, ignored: ReadonlySet<string>, symlinks: string[]): Promise<ExpandResult> {
  const cleaned = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const segments = cleaned.split('/').filter((segment) => segment !== '' && segment !== '.');
  const inner = segments.slice(0, -1);
  if (UNSUPPORTED_GLOB.test(cleaned) || segments.includes('..') || inner.includes('**') || cleaned.startsWith('/')) {
    return { dirs: [], unsupported: true };
  }

  let current = [base];
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const next: string[] = [];
    for (const dir of current) {
      if (segment === '*' || segment === '**') {
        const recursive = segment === '**' && last;
        const stack = [dir];
        while (stack.length > 0) {
          const parent = stack.pop()!;
          let entries;
          try {
            entries = await readdir(parent, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(parent, entry.name);
            if (entry.isSymbolicLink()) {
              symlinks.push(full);
              continue;
            }
            if (!entry.isDirectory() || ignored.has(entry.name)) continue;
            next.push(full);
            if (recursive) stack.push(full);
          }
        }
      } else {
        const full = join(dir, segment);
        try {
          const info = await lstat(full);
          if (info.isSymbolicLink()) symlinks.push(full);
          else if (info.isDirectory()) next.push(full);
        } catch {
          /* a declared member that does not exist is simply not there */
        }
      }
    }
    current = next;
  }
  return { dirs: [...new Set(current)], unsupported: false };
}

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'project' : cleaned.slice(0, 64);
}

/** Unique, deterministic names: the directory name, then the full path, then a numeric suffix. */
function assignNames(root: string, projects: DiscoveredProject[]): void {
  const taken = new Set<string>();
  const rootName = sanitizeName(basename(resolve(root)));
  for (const project of projects) {
    const candidates = [
      project.path === '.' ? rootName : sanitizeName(basename(project.path)),
      sanitizeName(project.path === '.' ? rootName : project.path),
      `${sanitizeName(project.path === '.' ? rootName : project.path)}-${project.ecosystem}`,
    ];
    let name = candidates.find((candidate) => !taken.has(candidate));
    for (let n = 2; name === undefined; n++) {
      const numbered = `${candidates[2]}-${n}`;
      if (!taken.has(numbered)) name = numbered;
    }
    project.name = name;
    taken.add(name);
  }
}

export async function discoverProjects(root: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const adapters = options.adapters ?? ADAPTERS;
  const scanDepth = Math.min(Math.max(options.scanDepth ?? DEFAULT_SCAN_DEPTH, 0), MAX_SCAN_DEPTH);
  const ignored = new Set<string>([...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignore ?? [])]);
  const absoluteRoot = resolve(root);

  const result: DiscoveryResult = {
    projects: [],
    covered: [],
    candidates: [],
    warnings: [],
    skipped: { symlinks: [], ignoredDirectories: {}, depthLimited: [] },
  };

  const seenReal = new Set<string>();
  const found: DiscoveredProject[] = [];
  /** `realpath|ecosystem` -> declared members of a project, whether or not the walk reached them. */
  const coveredDirs = new Map<string, CoveredMember & { adapter: EcosystemAdapter; dir: string }>();
  const reached = new Set<string>();

  const detectHere = async (dir: string): Promise<void> => {
    const rel = relativePath(absoluteRoot, dir);
    for (const adapter of adapters) {
      const detection = await adapter.detect(dir);
      if (!detection.detected) continue;
      const real = `${await realpath(dir).catch(() => dir)}|${adapter.id}`;
      if (seenReal.has(real)) continue;
      seenReal.add(real);

      if (detection.confidence === 'weak') {
        result.candidates.push({ path: rel, ecosystem: adapter.id, reason: detection.evidence.join(', ') });
        continue;
      }

      const member = coveredDirs.get(real);
      if (member) {
        reached.add(real);
        result.covered.push({ path: member.path, coveredBy: member.coveredBy, source: member.source });
        continue;
      }

      found.push({
        name: '',
        path: rel,
        type: adapter.suggestType?.(detection) ?? adapter.id,
        ecosystem: adapter.id,
        detection,
      });

      // Declared members are covered by this project and must not be listed again.
      const declared = await adapter.workspaceMembers?.(dir);
      if (declared) {
        for (const pattern of declared.patterns) {
          const expanded = await expandPattern(dir, pattern, ignored, result.skipped.symlinks);
          if (expanded.unsupported) {
            result.warnings.push(
              `${declared.source} in "${rel}" declares the member pattern "${pattern}", which this version cannot expand ` +
                '(supported: literal paths, "*" and a trailing "**"). Members matching it are not covered automatically; list them under projects.',
            );
            continue;
          }
          for (const memberDir of expanded.dirs) {
            const memberReal = `${await realpath(memberDir).catch(() => memberDir)}|${adapter.id}`;
            coveredDirs.set(memberReal, {
              path: relativePath(absoluteRoot, memberDir),
              coveredBy: rel,
              source: declared.source,
              adapter,
              dir: memberDir,
            });
          }
        }
      }
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    await detectHere(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const children = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));

    const scannable: string[] = [];
    for (const child of children) {
      const full = join(dir, child.name);
      if (child.isSymbolicLink()) {
        result.skipped.symlinks.push(full);
        continue;
      }
      if (ignored.has(child.name)) {
        result.skipped.ignoredDirectories[child.name] = (result.skipped.ignoredDirectories[child.name] ?? 0) + 1;
        continue;
      }
      scannable.push(full);
    }

    if (depth >= scanDepth) {
      if (scannable.length > 0) result.skipped.depthLimited.push(relativePath(absoluteRoot, dir));
      return;
    }
    for (const full of scannable) await walk(full, depth + 1);
  };

  await walk(absoluteRoot, 0);

  // Members the walk did not reach (below the depth limit) still count as covered,
  // but only when they really are projects: a pattern such as "libs/**" also matches
  // plain directories.
  for (const [key, member] of coveredDirs) {
    if (reached.has(key)) continue;
    const detection = await member.adapter.detect(member.dir);
    if (detection.detected && detection.confidence === 'strong') {
      result.covered.push({ path: member.path, coveredBy: member.coveredBy, source: member.source });
    }
  }

  // Parents are walked before their children, so declared members were registered
  // before they were reached and never entered `found`.
  const projects = found;

  for (const project of projects) {
    for (const other of projects) {
      if (other === project || other.ecosystem !== project.ecosystem) continue;
      const inside = other.path === '.' ? project.path !== '.' : project.path.startsWith(`${other.path}/`);
      if (inside && (project.nestedIn === undefined || other.path.length > project.nestedIn.length)) project.nestedIn = other.path;
    }
  }

  // Deterministic order: path, then adapter order.
  const order = new Map(adapters.map((adapter, index) => [adapter.id, index]));
  projects.sort((a, b) => a.path.localeCompare(b.path) || (order.get(a.ecosystem) ?? 0) - (order.get(b.ecosystem) ?? 0));
  assignNames(absoluteRoot, projects);

  result.projects = projects;
  // A covered path can be seen once per ecosystem; keep each once.
  const uniqueCovered = new Map(result.covered.map((member) => [`${member.path}|${member.coveredBy}`, member]));
  result.covered = [...uniqueCovered.values()].sort((a, b) => a.path.localeCompare(b.path));
  result.skipped.symlinks = [...new Set(result.skipped.symlinks.map((full) => relativePath(absoluteRoot, full)))].sort();
  result.skipped.depthLimited.sort();
  return result;
}
