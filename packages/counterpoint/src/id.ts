/**
 * Element identifiers.
 *
 * Every character ever inserted gets a globally unique id: the replica that
 * created it plus a per-replica counter. Delete operations also consume one
 * counter value, so a replica's counter doubles as a sequence number for
 * everything it has done (see VersionVector in sync.ts).
 */

/** Opaque, unique-per-session name of a replica. Compared as plain strings. */
export type ReplicaId = string;

export interface Id {
  readonly replica: ReplicaId;
  readonly counter: number;
}

/** A run of ids from one replica: counters `counter .. counter + length - 1`. */
export interface IdRange {
  readonly replica: ReplicaId;
  readonly counter: number;
  readonly length: number;
}

/**
 * The total order on ids used to break ties between same-side siblings.
 * Any deterministic total order works; this one is lexicographic on
 * (replica, counter), matching the paper.
 */
export function compareIds(a: Id, b: Id): number {
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.counter - b.counter;
}

export function sameId(a: Id | null, b: Id | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replica === b.replica && a.counter === b.counter;
}

/** Human-readable form, e.g. `ada:12`. Used in logs and errors. */
export function formatId(id: Id | null): string {
  return id === null ? '∅' : `${id.replica}:${id.counter}`;
}

/** Generates a short random replica id (8 base-36 characters). */
interface MinimalCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function randomReplicaId(): ReplicaId {
  const bytes = new Uint8Array(8);
  const crypto = (globalThis as { crypto?: MinimalCrypto }).crypto;
  if (crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}
