import type { ReplicaId } from './id.ts';
import type { Side } from './ops.ts';
import type { Leaf } from './order-tree.ts';

/**
 * One character, alive or deleted, and its place in the Fugue tree.
 *
 * Elements are never removed: a deleted element becomes a tombstone that
 * keeps its tree position (other elements may hang off it) and its
 * character (so it can be re-sent to a peer that never saw it).
 */
export class Elem {
  readonly replica: ReplicaId;
  readonly counter: number;
  readonly char: string;
  deleted = false;
  /** Tree parent. The root sentinel is the only element whose parent is null. */
  readonly parent: Elem | null;
  readonly side: Side;
  /** Next element (tombstones included) when this one was created; null = end. */
  readonly rightOrigin: Elem | null;
  /** Same-side children in traversal order. Allocated lazily; most stay null. */
  left: Elem[] | null = null;
  right: Elem[] | null = null;
  /** The order-tree leaf currently holding this element (null for the root). */
  leaf: Leaf | null = null;

  constructor(
    replica: ReplicaId,
    counter: number,
    char: string,
    parent: Elem | null,
    side: Side,
    rightOrigin: Elem | null,
  ) {
    this.replica = replica;
    this.counter = counter;
    this.char = char;
    this.parent = parent;
    this.side = side;
    this.rightOrigin = rightOrigin;
  }
}

/** Last element of `e`'s subtree in traversal order. */
export function lastDescendant(e: Elem): Elem {
  let cur = e;
  while (cur.right !== null && cur.right.length > 0) cur = cur.right[cur.right.length - 1]!;
  return cur;
}

/** First element of `e`'s subtree in traversal order. */
export function firstDescendant(e: Elem): Elem {
  let cur = e;
  while (cur.left !== null && cur.left.length > 0) cur = cur.left[0]!;
  return cur;
}
