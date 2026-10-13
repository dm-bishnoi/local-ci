/**
 * Ecosystem identity and project capabilities.
 *
 * Identity answers "what kind of project is this" (node, dotnet, ...). A
 * capability answers "can this project run check X, and how". They are kept
 * apart on purpose: detecting React must never remove a TypeScript check, and a
 * manifest proves the ecosystem, not that its optional tools are configured.
 */

export type EcosystemId = 'node' | 'dotnet' | 'python' | 'java' | 'php' | 'go' | 'rust';

/** Values accepted for `project.type`. The first five are profiles of `node`. */
export type ProjectType = EcosystemId | 'javascript' | 'typescript' | 'angular' | 'react' | 'vue';

/** Where an available command came from. Shown in diagnostics and reports. */
export type CapabilitySource =
  /** An explicit project script (package.json, composer.json). Always wins. */
  | 'script'
  /** A tool inferred from declared dependencies plus its configuration. */
  | 'inferred'
  /** A framework-specific fallback such as `ng build`. */
  | 'framework'
  /** A fixed command of the ecosystem itself (`go test ./...`). */
  | 'builtin';

export type Requirement =
  | {
      kind: 'tool';
      name: string;
      /** Arguments that print the version when `--version` does not (`go version`). */
      probeArgs?: string[];
      /** The tool has no version output (gofmt): only check that it is on PATH. */
      locateOnly?: boolean;
      /** What to call it in messages when the executable alone is not the point ("pytest (python -m pytest)"). */
      display?: string;
      /** Constant environment for the probe, e.g. RUSTUP_AUTO_INSTALL=0. */
      env?: Record<string, string>;
    }
  /** The installed `tool` must be at least `atLeast`, as required by `source` (e.g. go.mod). */
  | { kind: 'version'; tool: string; atLeast: string; source: string; probeArgs?: string[] }
  | { kind: 'dependencies'; detail: string }
  | { kind: 'lockfile'; file: string };

export interface AvailableCapability {
  state: 'available';
  command: string;
  args: string[];
  description: string;
  source: CapabilitySource;
  /**
   * Names a verdict check applied to a process that exited 0 (see
   * ecosystems/evaluators.ts). Data, not a function, so capabilities stay serializable.
   */
  evaluate?: 'gofmt-list';
  /** Constant environment added for this command, e.g. GOTOOLCHAIN=local. Never from configuration. */
  env?: Record<string, string>;
  /** The evidence that justified the command, e.g. "eslint in devDependencies + eslint.config.js". */
  evidence?: string;
  requires: Requirement[];
}

export interface UnavailableCapability {
  state: 'unavailable';
  reason: string;
}

export type Capability = AvailableCapability | UnavailableCapability;

export interface DetectOptions {
  /** `settings.offline`: adapters add their tool's offline flag where it has one. */
  offline?: boolean;
}

export interface Detection {
  ecosystem: EcosystemId;
  /** Absolute project directory. */
  root: string;
  detected: boolean;
  confidence: 'strong' | 'weak';
  evidence: string[];
  /** Always present when `detected` is false. */
  reason?: string;
  capabilities: Record<string, Capability>;
  /**
   * Detected, but not runnable until the user resolves something (two solutions
   * in one directory, a wrapper that is not executable). Every step of the
   * project is reported BLOCKED with this text.
   */
  problem?: string;
  /** Facts that do not block anything but the user should know (a missing lock file, a conflicting package manager). */
  warnings?: string[];
  /** Dependencies (node_modules, NuGet assets, vendor/) are present on disk. */
  dependenciesOnDisk?: boolean;
  /** The project declares dependencies at all; when false, missing ones are not a problem. */
  declaresDependencies?: boolean;
  /** What dependencies are called in messages ("node_modules"). */
  dependenciesLabel?: string;
  /** Step ids that populate dependencies. Defaults to `install`. */
  installStepIds?: readonly string[];
}

/** Members a project declares for itself (npm workspaces, go.work, Cargo workspace, ...). */
export interface WorkspaceMembers {
  /** Directory patterns relative to the project, exactly as declared. */
  patterns: string[];
  /** File that declared them, for messages. */
  source: string;
}

export interface DefaultPipeline {
  pipeline: string[];
  /** Steps left out, each with the reason; written into the generated file as comments. */
  omitted: Array<{ id: string; reason: string }>;
}

export interface EcosystemAdapter {
  id: EcosystemId;
  /** Config-facing type names handled by this adapter (lower case). */
  profiles: readonly string[];
  /** Read-only. Never installs, mutates or probes the network. */
  detect(dir: string, options?: DetectOptions): Promise<Detection>;
  /** What `steps.<id>.script` means for this ecosystem, if anything (composer scripts for PHP). */
  resolveScript?(script: string, detection: Detection): Capability;
  stepIds(): readonly string[];
  stepName(id: string): string;
  /** The `project.type` to write for a detection; defaults to the ecosystem id. */
  suggestType?(detection: Detection): string;
  /** Declared workspace members, so they are covered by the root project instead of listed again. */
  workspaceMembers?(dir: string): Promise<WorkspaceMembers | null>;
  /** The minimal pipeline `init` generates: only steps that can run for this project. */
  defaultPipeline(detection: Detection): DefaultPipeline;
}
