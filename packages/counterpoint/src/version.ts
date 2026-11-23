import type { ReplicaId } from './id.ts';

/**
 * For each replica, how many of its counter values have been applied.
 * Because ops from one replica are applied strictly in counter order, this
 * number says exactly which of that replica's ops are present: all of those
 * with counter < n. Missing replicas count as 0.
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;

export function versionOf(vv: VersionVector, replica: ReplicaId): number {
  return Object.hasOwn(vv, replica) ? vv[replica]! : 0;
}

/** True if `a` has seen everything `b` has. */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  return Object.keys(b).every((r) => versionOf(a, r) >= versionOf(b, r));
}

export function sameVersion(a: VersionVector, b: VersionVector): boolean {
  return dominates(a, b) && dominates(b, a);
}

/** Pointwise maximum. */
export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  // Null prototype, so a replica named "__proto__" is just a key.
  const out: Record<ReplicaId, number> = Object.create(null);
  for (const r of Object.keys(a)) out[r] = versionOf(a, r);
  for (const r of Object.keys(b)) out[r] = Math.max(versionOf(a, r), versionOf(b, r));
  return out;
}
