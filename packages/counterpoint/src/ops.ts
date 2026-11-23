import type { Id, IdRange } from './id.ts';

export type Side = 'left' | 'right';

/**
 * Which sibling order to use. Both variants come from Weidner & Kleppmann,
 * "The Art of the Fugue". They differ only in how right-side siblings are
 * ordered; every replica of a document must use the same variant.
 */
export type Variant = 'fugue' | 'fugue-max';

/**
 * Inserts a run of characters. The first character becomes a child of
 * `parent` on `side`; every following character is the right child of the
 * one before it. That is exactly the tree shape the paper's algorithm
 * produces for a user typing the run one key at a time, so a run op is just
 * a compressed form of N single-character inserts.
 */
export interface InsertOp {
  readonly kind: 'insert';
  /** Id of the first character. Character k has counter `id.counter + k`. */
  readonly id: Id;
  readonly text: string;
  /** `null` means the invisible root node. */
  readonly parent: Id | null;
  readonly side: Side;
  /**
   * The element that followed the insertion point (tombstones included) when
   * the run was created, or `null` for the end of the document. FugueMax
   * orders right-side siblings by it. For `side: 'left'` it always equals
   * `parent`.
   */
  readonly rightOrigin: Id | null;
}

/** Marks elements as deleted. Consumes exactly one counter value (`id`). */
export interface DeleteOp {
  readonly kind: 'delete';
  readonly id: Id;
  readonly targets: readonly IdRange[];
}

export type Op = InsertOp | DeleteOp;

/** How many counter values an op occupies on its replica. */
export function opSpan(op: Op): number {
  return op.kind === 'insert' ? op.text.length : 1;
}
