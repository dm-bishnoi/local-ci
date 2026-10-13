import { nodeAdapter } from './node/index.js';
import type { EcosystemAdapter } from './types.js';

/**
 * Registered adapters in a fixed order. Order is the tie-break whenever more
 * than one adapter claims a directory, so detection is deterministic.
 */
export const ADAPTERS: readonly EcosystemAdapter[] = [nodeAdapter];

/** Resolves a config `project.type` (case-insensitive) to its adapter, or undefined if unrecognised. */
export function adapterFor(type: string): EcosystemAdapter | undefined {
  const key = type.trim().toLowerCase();
  return ADAPTERS.find((adapter) => adapter.profiles.includes(key));
}

export function knownProjectTypes(): string[] {
  return ADAPTERS.flatMap((adapter) => [...adapter.profiles]).sort();
}
