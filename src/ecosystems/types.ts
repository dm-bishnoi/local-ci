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
  | { kind: 'tool'; name: string }
  | { kind: 'dependencies'; detail: string }
  | { kind: 'lockfile'; file: string };

export interface AvailableCapability {
  state: 'available';
  command: string;
  args: string[];
  description: string;
  source: CapabilitySource;
  /** The evidence that justified the command, e.g. "eslint in devDependencies + eslint.config.js". */
  evidence?: string;
  requires: Requirement[];
}

export interface UnavailableCapability {
  state: 'unavailable';
  reason: string;
}

export type Capability = AvailableCapability | UnavailableCapability;

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
}

export interface EcosystemAdapter {
  id: EcosystemId;
  /** Config-facing type names handled by this adapter (lower case). */
  profiles: readonly string[];
  /** Read-only. Never installs, mutates or probes the network. */
  detect(dir: string): Promise<Detection>;
  stepIds(): readonly string[];
  stepName(id: string): string;
}
