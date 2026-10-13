import { goAdapter } from './go/index.js';
import { nodeAdapter } from './node/index.js';
import type { EcosystemAdapter } from './types.js';

/**
 * Registered adapters in a fixed order. Order is the tie-break whenever more
 * than one adapter claims a directory, so detection is deterministic.
 */
export const ADAPTERS: readonly EcosystemAdapter[] = [nodeAdapter, goAdapter];

/** Resolves a config `project.type` (case-insensitive) to its adapter, or undefined if unrecognised. */
export function adapterFor(type: string): EcosystemAdapter | undefined {
  const key = type.trim().toLowerCase();
  return ADAPTERS.find((adapter) => adapter.profiles.includes(key));
}

export function knownProjectTypes(): string[] {
  return ADAPTERS.flatMap((adapter) => [...adapter.profiles]).sort();
}

/**
 * Warning for a `project.type` no adapter handles. Such a configuration keeps
 * working exactly as in 0.2.x (only `steps:` entries run, every other step is
 * UNSUPPORTED); this just says so instead of leaving the user to find out.
 */
export function unrecognisedTypeWarning(type: string): string | null {
  if (type === 'multi' || adapterFor(type)) return null;
  return (
    `project.type "${type}" is not a recognised ecosystem, so only "steps:" entries will run and every other ` +
    `step reports UNSUPPORTED. Known types: ${knownProjectTypes().join(', ')}.`
  );
}
