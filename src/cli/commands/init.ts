import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveStep } from '../../adapters/angular/commands.js';
import { detectAngularProject } from '../../adapters/angular/detect.js';
import { CONFIG_FILE } from '../../config/loader.js';
import { resolveProjectDir } from '../../config/projects.js';
import { localCiConfigSchema, projectPathSchema } from '../../config/schema.js';
import { DEFAULT_SCAN_DEPTH, MAX_SCAN_DEPTH, discoverProjects, type DiscoveryResult } from '../../ecosystems/discovery.js';
import { ADAPTERS, adapterFor, knownProjectTypes } from '../../ecosystems/registry.js';
import type { Detection, EcosystemAdapter } from '../../ecosystems/types.js';
import { probeExecutable, probeTool } from '../../env/tools.js';
import { REPORT_ROOT_GITIGNORE, ensureReportRootIgnored } from '../../reporters/artifact.js';

/** The default Angular pipeline, in the order the steps run. */
const DEFAULT_PIPELINE = ['install', 'typecheck', 'test', 'coverage', 'lint', 'build', 'security'] as const;

interface OmittedStep {
  id: string;
  reason: string;
}

function renderConfig(pipeline: readonly string[], omitted: readonly OmittedStep[]): string {
  const lines = ['version: 1', '', 'project:', '  type: angular', '', 'pipeline:', ...pipeline.map((id) => `  - ${id}`)];
  if (omitted.length > 0) {
    lines.push('  # Not added: this project cannot run these yet. Fix the cause, then uncomment.');
    for (const { id, reason } of omitted) lines.push(`  # - ${id}  # ${reason}`);
  }
  lines.push('', 'settings:', '  failFast: false', '  timeoutMs: 300000', '');
  return lines.join('\n');
}

/**
 * The configuration for this project. In a detected Angular project only the
 * default steps the adapter can actually run are listed, so the first `run`
 * does not fail on steps the project was never set up for; the rest are left
 * as comments with the reason. Anywhere else the full default is written, as
 * before.
 */
async function configFor(cwd: string): Promise<{ text: string; omitted: OmittedStep[] }> {
  const detection = await detectAngularProject(cwd);
  if (!detection.detected) return { text: renderConfig(DEFAULT_PIPELINE, []), omitted: [] };

  const pipeline: string[] = [];
  const omitted: OmittedStep[] = [];
  for (const id of DEFAULT_PIPELINE) {
    const resolved = resolveStep(id, detection);
    if (resolved?.status !== 'resolved') {
      omitted.push({ id, reason: resolved?.reason ?? 'Not supported by the Angular adapter.' });
    } else if (id === 'install' && detection.lockfile === null) {
      // Preflight blocks install without a lockfile, so listing it would fail.
      omitted.push({ id, reason: 'No lockfile found, and install is blocked without one. Commit a lockfile first.' });
    } else {
      pipeline.push(id);
    }
  }

  // A pipeline needs at least one step; fall back to the full default.
  if (pipeline.length === 0) return { text: renderConfig(DEFAULT_PIPELINE, []), omitted: [] };
  return { text: renderConfig(pipeline, omitted), omitted };
}

export interface InitOptions {
  /** Replace an existing configuration. */
  force?: boolean;
  /** Write this project type instead of detecting it. */
  type?: string;
  /** Project directory, relative to the repository root. */
  path?: string;
  /** Write every discovered project as a `projects:` list. */
  all?: boolean;
  scanDepth?: number;
  ignore?: readonly string[];
  /** Print the configuration instead of writing it. */
  dryRun?: boolean;
}

interface GeneratedProject {
  name: string;
  type: string;
  path: string;
  pipeline: string[];
  omitted: OmittedStep[];
}

interface InitPlan {
  text: string;
  omitted: OmittedStep[];
  notes: string[];
}

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

const quote = (value: string): string => JSON.stringify(value);
const comment = (text: string): string => `# ${text.replace(/\r?\n/g, ' ')}`;

function renderOmitted(omitted: readonly OmittedStep[], indent: string): string[] {
  if (omitted.length === 0) return [];
  return [
    `${indent}# Not added (see the reason after each step). Fix the cause, then add it.`,
    ...omitted.map(({ id, reason }) => `${indent}# - ${id}  # ${reason.replace(/\r?\n/g, ' ')}`),
  ];
}

function renderSettings(): string[] {
  return ['', 'settings:', '  failFast: false', '  timeoutMs: 300000', ''];
}

function renderSingle(project: GeneratedProject, header: readonly string[]): string {
  const lines = [...header.map(comment), 'version: 1', '', 'project:', `  type: ${quote(project.type)}`];
  if (project.path !== '.') lines.push(`  path: ${quote(project.path)}`);
  lines.push('', 'pipeline:', ...project.pipeline.map((id) => `  - ${id}`), ...renderOmitted(project.omitted, '  '), ...renderSettings());
  return lines.join('\n');
}

function renderMulti(projects: readonly GeneratedProject[], header: readonly string[]): string {
  const lines = [...header.map(comment), 'version: 1', '', 'projects:'];
  for (const project of projects) {
    lines.push(`  - name: ${quote(project.name)}`, `    type: ${quote(project.type)}`, `    path: ${quote(project.path)}`);
    lines.push('    pipeline:', ...project.pipeline.map((id) => `      - ${id}`), ...renderOmitted(project.omitted, '      '), '');
  }
  lines.push(...renderSettings().slice(1));
  return lines.join('\n');
}

/**
 * Leaves out steps whose tools are not on this machine ("do not generate
 * commands for tools that are absent"). A probe that could not run keeps the
 * step: an unverified tool is not a missing one. Node projects are exempt,
 * because their package manager is the project's own choice and a machine
 * without it should be told so by preflight, not get an empty pipeline.
 */
async function withoutMissingTools(
  adapter: EcosystemAdapter,
  detection: Detection,
  chosen: { pipeline: string[]; omitted: OmittedStep[] },
): Promise<{ pipeline: string[]; omitted: OmittedStep[] }> {
  if (adapter.id === 'node') return chosen;

  const cache = new Map<string, Promise<{ outcome: string; detail: string }>>();
  const probe = (name: string, args: readonly string[] | undefined, locateOnly: boolean | undefined, env: Record<string, string> | undefined) => {
    const key = `${name}|${(args ?? []).join(' ')}|${locateOnly ? 'l' : 'r'}`;
    if (!cache.has(key)) cache.set(
        key,
        locateOnly ? probeExecutable(name) : probeTool(name, args ?? ['--version'], { ...(env ? { env } : {}), requireZeroExit: args !== undefined }),
      );
    return cache.get(key)!;
  };

  const pipeline: string[] = [];
  const omitted = [...chosen.omitted];
  for (const id of chosen.pipeline) {
    const capability = detection.capabilities[id];
    let missing: string | null = null;
    if (capability?.state === 'available') {
      for (const requirement of capability.requires) {
        if (requirement.kind !== 'tool') continue;
        const result = await probe(requirement.name, requirement.probeArgs, requirement.locateOnly, requirement.env);
        if (result.outcome === 'missing') {
          missing = `${requirement.display ?? requirement.name} was not found on this machine. Install it, then add "${id}".`;
          break;
        }
      }
    }
    if (missing === null) pipeline.push(id);
    else omitted.push({ id, reason: missing });
  }
  return { pipeline, omitted };
}

async function generate(
  name: string,
  type: string,
  path: string,
  adapter: EcosystemAdapter,
  detection: Detection,
): Promise<GeneratedProject> {
  const { pipeline, omitted } = await withoutMissingTools(adapter, detection, adapter.defaultPipeline(detection));
  if (pipeline.length === 0) {
    throw new InitError(
      `No runnable checks were found for "${path === '.' ? type : path}" (${type}). Nothing was written.\n` +
        `${omitted.map((step) => `  - ${step.id}: ${step.reason}`).join('\n')}\n` +
        'Add the missing scripts, tools or configuration, or define the checks yourself under steps (script: or run:).',
    );
  }
  return { name, type, path, pipeline, omitted };
}

/** A human-readable account of what discovery saw, so nothing is silently dropped. */
function discoveryNotes(discovery: DiscoveryResult): string[] {
  const notes: string[] = [];
  for (const member of discovery.covered) {
    notes.push(`Covered by "${member.coveredBy}" (${member.source}), not listed separately: ${member.path}`);
  }
  for (const candidate of discovery.candidates) {
    notes.push(`Possible ${candidate.ecosystem} project at "${candidate.path}" (${candidate.reason}); not added because the evidence is weak.`);
  }
  for (const path of discovery.skipped.depthLimited) {
    notes.push(`Not scanned below "${path}" (scan depth limit). Raise it with --scan-depth.`);
  }
  for (const path of discovery.skipped.symlinks) notes.push(`Symbolic link not followed: ${path}`);
  notes.push(...discovery.warnings);
  return notes;
}

function describeProjects(discovery: DiscoveryResult): string {
  return discovery.projects
    .map((project) => {
      const nested = project.nestedIn ? ` (inside "${project.nestedIn}", not declared as a member)` : '';
      return `  - ${project.name}: ${project.type} at "${project.path}"${nested}\n      local-ci-runner init --path ${quote(project.path)} --type ${project.type}`;
    })
    .join('\n');
}

async function detectAt(dir: string, type: string | undefined): Promise<{ adapter: EcosystemAdapter; detection: Detection }> {
  if (type !== undefined) {
    const adapter = adapterFor(type);
    if (!adapter) throw new InitError(`Unknown project type "${type}". Known types: ${knownProjectTypes().join(', ')}.`);
    const detection = await adapter.detect(dir);
    if (!detection.detected) {
      throw new InitError(`No ${type} project was detected at "${dir}": ${detection.reason ?? 'no evidence found'}`);
    }
    return { adapter, detection };
  }

  const hits: Array<{ adapter: EcosystemAdapter; detection: Detection }> = [];
  for (const adapter of ADAPTERS) {
    const detection = await adapter.detect(dir);
    if (detection.detected && detection.confidence === 'strong') hits.push({ adapter, detection });
  }
  if (hits.length === 0) throw new InitError(`No supported project was detected at "${dir}".`);
  if (hits.length > 1) {
    throw new InitError(
      `More than one ecosystem was detected at "${dir}": ${hits.map((hit) => hit.adapter.id).join(', ')}. ` +
        'Choose one with --type, or write every project with --all.',
    );
  }
  return hits[0]!;
}

async function buildPlan(cwd: string, options: InitOptions): Promise<InitPlan> {
  const scanDepth = options.scanDepth ?? DEFAULT_SCAN_DEPTH;
  if (!Number.isInteger(scanDepth) || scanDepth < 0 || scanDepth > MAX_SCAN_DEPTH) {
    throw new InitError(`--scan-depth must be a whole number from 0 to ${MAX_SCAN_DEPTH}.`);
  }
  if (options.type !== undefined && adapterFor(options.type) === undefined) {
    throw new InitError(`Unknown project type "${options.type}". Known types: ${knownProjectTypes().join(', ')}.`);
  }
  if (options.all && (options.type !== undefined || options.path !== undefined)) {
    throw new InitError('--all cannot be combined with --type or --path.');
  }

  let projectPath = '.';
  if (options.path !== undefined) {
    const checked = projectPathSchema.safeParse(options.path);
    if (!checked.success) throw new InitError(`--path ${quote(options.path)}: ${checked.error.issues[0]?.message ?? 'invalid'}.`);
    projectPath = options.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  }

  const discovery = await discoverProjects(cwd, {
    scanDepth,
    ...(options.ignore !== undefined ? { ignore: options.ignore } : {}),
  });
  const notes = discoveryNotes(discovery);

  // Explicit selection: --type and/or --path.
  if (options.type !== undefined || options.path !== undefined) {
    const resolved = await resolveProjectDir(cwd, projectPath);
    if (!resolved.ok) throw new InitError(resolved.reason);
    const { adapter, detection } = await detectAt(resolved.dir, options.type);

    // An Angular project at the root keeps the original, byte-identical output.
    if (projectPath === '.' && (options.type === undefined || options.type.toLowerCase() === 'angular')) {
      if ((await detectAngularProject(cwd)).detected) {
        const legacy = await configFor(cwd);
        return { text: legacy.text, omitted: legacy.omitted, notes };
      }
    }

    const type = options.type?.toLowerCase() ?? adapter.suggestType?.(detection) ?? adapter.id;
    const generated = await generate('project', type, projectPath, adapter, detection);
    return { text: renderSingle(generated, notes), omitted: generated.omitted, notes };
  }

  if (options.all) {
    if (discovery.projects.length === 0) throw new InitError('No supported projects were found to write. Nothing was written.');
    const generated: GeneratedProject[] = [];
    for (const project of discovery.projects) {
      const adapter = ADAPTERS.find((candidate) => candidate.id === project.ecosystem)!;
      generated.push(await generate(project.name, project.type, project.path, adapter, project.detection));
    }
    // Qualified by project, so the same step left out of two projects is not listed twice.
    const omitted = generated.flatMap((entry) => entry.omitted.map((step) => ({ ...step, id: `${entry.name}.${step.id}` })));
    return { text: renderMulti(generated, notes), omitted, notes };
  }

  // Nothing found: the original behaviour, a complete default configuration.
  if (discovery.projects.length === 0) {
    const legacy = await configFor(cwd);
    return {
      text: legacy.text,
      omitted: legacy.omitted,
      notes: [
        'No supported project was detected, so the default configuration was written. Choose a type with --type, or edit the file.',
        ...notes,
      ],
    };
  }

  if (discovery.projects.length > 1) {
    throw new InitError(
      'More than one project was found. Nothing was written. Choose one, or write them all with "local-ci-runner init --all":\n' +
        describeProjects(discovery),
    );
  }

  const only = discovery.projects[0]!;
  if (only.path === '.' && (await detectAngularProject(cwd)).detected) {
    const legacy = await configFor(cwd);
    return { text: legacy.text, omitted: legacy.omitted, notes };
  }
  const adapter = ADAPTERS.find((candidate) => candidate.id === only.ecosystem)!;
  const generated = await generate(only.name, only.type, only.path, adapter, only.detection);
  return { text: renderSingle(generated, notes), omitted: generated.omitted, notes };
}

export async function initCommand(cwd: string, forceOrOptions: boolean | InitOptions = false): Promise<void> {
  const options: InitOptions = typeof forceOrOptions === 'boolean' ? { force: forceOrOptions } : forceOrOptions;
  const path = join(cwd, CONFIG_FILE);

  const existing = await access(path).then(
    () => true,
    () => false,
  );
  if (existing && !options.force && !options.dryRun) {
    throw new Error(
      `${CONFIG_FILE} already exists. Use --force to replace it, or --dry-run to preview a new one without writing.`,
    );
  }

  const { text, omitted, notes } = await buildPlan(cwd, options);

  // Never write a file the loader would reject.
  const check = localCiConfigSchema.safeParse(parseYaml(text));
  if (!check.success) {
    throw new InitError(
      'Internal error: the generated configuration is invalid and was not written: ' +
        check.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  if (options.dryRun) {
    console.log(text);
    if (existing) console.log(`(${CONFIG_FILE} already exists and was not modified.)`);
    for (const note of notes) console.log(`Note: ${note}`);
    return;
  }

  await writeFile(path, text, 'utf8');
  console.log(`Created ${CONFIG_FILE}`);
  for (const note of notes) console.log(`Note: ${note}`);
  if (omitted.length > 0) {
    console.log(
      `Left out of the pipeline because this project cannot run them yet: ${omitted.map((step) => step.id).join(', ')}. ` +
        `The reasons are in ${CONFIG_FILE}.`,
    );
  }

  // Reports are written under .local-ci/ and can contain captured output.
  // The directory ignores itself; the project's own .gitignore is never edited.
  if (await ensureReportRootIgnored(cwd)) {
    console.log(`Created ${REPORT_ROOT_GITIGNORE} so run reports stay out of version control.`);
  }
}
