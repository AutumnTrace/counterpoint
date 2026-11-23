/**
 * A collaborative plain-text document: the Fugue / FugueMax tree for
 * deciding where characters go, plus an order-statistic tree (order-tree.ts)
 * for turning that into indexes quickly.
 */
import { Elem, firstDescendant, lastDescendant } from './element.ts';
import { compareIds, formatId, randomReplicaId, type Id, type IdRange, type ReplicaId } from './id.ts';
import type { DeleteOp, InsertOp, Op, Side, Variant } from './ops.ts';
import { OrderTree } from './order-tree.ts';

export interface TextDocOptions {
  /** Must be unique among live sessions. Defaults to a random id. */
  readonly replicaId?: ReplicaId;
  /** Defaults to 'fugue-max'. All replicas of a document must agree. */
  readonly variant?: Variant;
}

/** One visible change, with indexes valid at the moment it happens. */
export type TextChange =
  | { readonly kind: 'insert'; readonly index: number; readonly text: string }
  | { readonly kind: 'delete'; readonly index: number; readonly length: number };

export interface ChangeEvent {
  /** 'local' for edits made through insert()/delete(), 'remote' for apply(). */
  readonly origin: 'local' | 'remote';
  readonly op: Op;
  /** Apply these in order to a copy of the old text to get the new text. */
  readonly changes: readonly TextChange[];
}

/**
 * A position that follows the text around instead of a fixed index.
 * `stick: 'left'` attaches to the character before the position (a typing
 * caret: text inserted remotely at exactly this spot lands after it);
 * `stick: 'right'` attaches to the character after it. `id: null` means the
 * start (left) or end (right) of the document.
 */
export interface Anchor {
  readonly id: Id | null;
  readonly stick: 'left' | 'right';
}

export class MissingDependencyError extends Error {
  readonly missing: Id;
  constructor(missing: Id, context: string) {
    super(`${context}: element ${formatId(missing)} is not known here yet`);
    this.name = 'MissingDependencyError';
    this.missing = missing;
  }
}

export class TextDoc {
  readonly replicaId: ReplicaId;
  readonly variant: Variant;

  private readonly root = new Elem('', -1, '', null, 'right', null);
  private readonly order = new OrderTree();
  /** byReplica.get(r)[c] is the element with id (r, c), if c was an insert. */
  private readonly byReplica = new Map<ReplicaId, (Elem | undefined)[]>();
  private counter = 0;
  private readonly listeners = new Set<(event: ChangeEvent) => void>();

  constructor(options: TextDocOptions = {}) {
    this.replicaId = options.replicaId ?? randomReplicaId();
    this.variant = options.variant ?? 'fugue-max';
  }

  // ------------------------------------------------------------- reading

  /** Number of visible characters. */
  get length(): number {
    return this.order.visible;
  }

  toString(): string {
    return this.order.text();
  }

  /** Whether the element with this id has been integrated (deleted or not). */
  has(id: Id): boolean {
    return this.lookup(id) !== undefined;
  }

  /** Id of the visible character at `index`. */
  idAt(index: number): Id {
    return toId(this.order.atVisible(index));
  }

  /** Every element id in document order, tombstones included. */
  idsInOrder(): Id[] {
    const ids: Id[] = [];
    this.order.forEach((e) => ids.push(toId(e)));
    return ids;
  }

  // --------------------------------------------------------- local edits

  /** Inserts `text` at visible index `index`. Returns the op to broadcast. */
  insert(index: number, text: string): InsertOp {
    if (text.length === 0) throw new RangeError('insert: text is empty');
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`insert: index ${index} out of range (length ${this.length})`);
    }
    const leftOrigin = index === 0 ? this.root : this.order.atVisible(index - 1);
    // The next element in the traversal *including tombstones*.
    const next = leftOrigin === this.root ? this.order.first() : this.order.next(leftOrigin);
    let parent: Elem;
    let side: Side;
    if (leftOrigin.right === null || leftOrigin.right.length === 0) {
      parent = leftOrigin;
      side = 'right';
    } else {
      // leftOrigin has right children, so `next` is the first element of its
      // right subtree, and that element has no left children of its own.
      parent = next!;
      side = 'left';
    }
    const op: InsertOp = {
      kind: 'insert',
      id: { replica: this.replicaId, counter: this.counter },
      text,
      parent: parent === this.root ? null : toId(parent),
      side,
      rightOrigin: next === null ? null : toId(next),
    };
    this.integrateInsert(op, 'local');
    return op;
  }

  /** Deletes `length` visible characters starting at `index`. */
  delete(index: number, length = 1): DeleteOp {
    if (!Number.isInteger(length) || length <= 0) throw new RangeError('delete: length must be a positive integer');
    if (!Number.isInteger(index) || index < 0 || index + length > this.length) {
      throw new RangeError(`delete: range ${index}+${length} out of bounds (length ${this.length})`);
    }
    const targets: IdRange[] = [];
    let last: { replica: ReplicaId; counter: number; length: number } | null = null;
    for (const e of this.order.visibleRange(index, length)) {
      if (last !== null && last.replica === e.replica && last.counter + last.length === e.counter) {
        last.length++;
      } else {
        last = { replica: e.replica, counter: e.counter, length: 1 };
        targets.push(last);
      }
    }
    const op: DeleteOp = { kind: 'delete', id: { replica: this.replicaId, counter: this.counter }, targets };
    this.integrateDelete(op, 'local');
    return op;
  }

  // ------------------------------------------------------- remote edits

  /**
   * Integrates an op from another replica. Its dependencies (parent, right
   * origin, delete targets) must already be here.
   */
  apply(op: Op): void {
    if (op.kind === 'insert') this.integrateInsert(op, 'remote');
    else this.integrateDelete(op, 'remote');
  }

  // ------------------------------------------------------------- anchors

  anchor(index: number, stick: 'left' | 'right' = 'left'): Anchor {
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`anchor: index ${index} out of range (length ${this.length})`);
    }
    if (stick === 'left') return { id: index === 0 ? null : this.idAt(index - 1), stick };
    return { id: index === this.length ? null : this.idAt(index), stick };
  }

  /** Current index of an anchor. Survives remote edits and deletion of its character. */
  resolve(anchor: Anchor): number {
    if (anchor.id === null) return anchor.stick === 'left' ? 0 : this.length;
    const e = this.lookup(anchor.id);
    if (e === undefined) throw new MissingDependencyError(anchor.id, 'resolve');
    const before = this.order.visibleIndexOf(e);
    return anchor.stick === 'left' && !e.deleted ? before + 1 : before;
  }

  // -------------------------------------------------------------- events

  /** Subscribes to changes. Returns an unsubscribe function. */
  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ----------------------------------------------------------- internals

  private lookup(id: Id): Elem | undefined {
    return this.byReplica.get(id.replica)?.[id.counter];
  }

  private require(id: Id | null, context: string): Elem {
    if (id === null) return this.root;
    const e = this.lookup(id);
    if (e === undefined) throw new MissingDependencyError(id, context);
    return e;
  }

  private slots(replica: ReplicaId): (Elem | undefined)[] {
    let slots = this.byReplica.get(replica);
    if (slots === undefined) {
      slots = [];
      this.byReplica.set(replica, slots);
    }
    return slots;
  }

  private bump(id: Id, span: number): void {
    if (id.replica === this.replicaId) this.counter = Math.max(this.counter, id.counter + span);
  }

  private integrateInsert(op: InsertOp, origin: 'local' | 'remote'): void {
    const what = `insert ${formatId(op.id)}`;
    const parent = this.require(op.parent, what);
    const rightOrigin = op.rightOrigin === null ? null : this.require(op.rightOrigin, what);
    if (op.side === 'left' && (parent === this.root || rightOrigin !== parent)) {
      throw new Error(`${what}: a left child's right origin must be its (non-root) parent`);
    }
    if (op.text.length === 0) throw new Error(`${what}: empty text`);
    const slots = this.slots(op.id.replica);
    for (let k = 0; k < op.text.length; k++) {
      if (slots[op.id.counter + k] !== undefined) throw new Error(`${what}: element ${op.id.counter + k} already exists`);
    }

    // The run: first char hangs off `parent`, the rest form a right-child chain.
    const run: Elem[] = new Array(op.text.length);
    let prev: Elem | null = null;
    for (let k = 0; k < op.text.length; k++) {
      const e: Elem =
        prev === null
          ? new Elem(op.id.replica, op.id.counter, op.text[0]!, parent, op.side, rightOrigin)
          : new Elem(op.id.replica, op.id.counter + k, op.text[k]!, prev, 'right', rightOrigin);
      if (prev !== null) prev.right = [e];
      run[k] = e;
      slots[op.id.counter + k] = e;
      prev = e;
    }
    const first = run[0]!;

    // Place the first char among its same-side siblings...
    let siblings: Elem[];
    if (op.side === 'left') siblings = parent.left ??= [];
    else siblings = parent.right ??= [];
    const at = this.siblingIndex(siblings, first);
    siblings.splice(at, 0, first);

    // ...which pins down its neighbour in the traversal. The whole run is
    // `first`'s subtree for now, so it goes into the order as one block.
    if (op.side === 'right') {
      if (at === 0) this.order.insertAfter(parent === this.root ? null : parent, run);
      else this.order.insertAfter(lastDescendant(siblings[at - 1]!), run);
    } else if (at === siblings.length - 1) {
      this.order.insertBefore(parent, run);
    } else {
      this.order.insertBefore(firstDescendant(siblings[at + 1]!), run);
    }

    this.bump(op.id, op.text.length);
    if (this.listeners.size > 0) {
      this.emit({ origin, op, changes: [{ kind: 'insert', index: this.order.visibleIndexOf(first), text: op.text }] });
    }
  }

  /** Where `node` goes among its same-side siblings. */
  private siblingIndex(siblings: readonly Elem[], node: Elem): number {
    let i = 0;
    if (this.variant === 'fugue-max' && node.side === 'right' && siblings.length > 0) {
      // FugueMax: right siblings in reverse document order of their right
      // origins (the end of the document counts as last), ties by id.
      const pos = (e: Elem | null) => (e === null ? Infinity : this.order.indexOf(e));
      const mine = pos(node.rightOrigin);
      for (; i < siblings.length; i++) {
        const sib = siblings[i]!;
        const theirs = sib.rightOrigin === node.rightOrigin ? mine : pos(sib.rightOrigin);
        if (mine > theirs) break;
        if (mine === theirs && compareElems(node, sib) < 0) break;
      }
      return i;
    }
    while (i < siblings.length && compareElems(siblings[i]!, node) < 0) i++;
    return i;
  }

  private integrateDelete(op: DeleteOp, origin: 'local' | 'remote'): void {
    const what = `delete ${formatId(op.id)}`;
    const elems: Elem[] = [];
    for (const t of op.targets) {
      for (let c = t.counter; c < t.counter + t.length; c++) {
        elems.push(this.require({ replica: t.replica, counter: c }, what));
      }
    }
    const changes: { kind: 'delete'; index: number; length: number }[] = [];
    const track = this.listeners.size > 0;
    for (const e of elems) {
      if (e.deleted) continue;
      const index = track ? this.order.visibleIndexOf(e) : 0;
      this.order.markDeleted(e);
      if (!track) continue;
      const last = changes[changes.length - 1];
      if (last !== undefined && last.index === index) last.length++;
      else changes.push({ kind: 'delete', index, length: 1 });
    }
    this.slots(op.id.replica)[op.id.counter] = undefined;
    this.bump(op.id, 1);
    if (track) this.emit({ origin, op, changes });
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toId(e: Elem): Id {
  return { replica: e.replica, counter: e.counter };
}

function compareElems(a: Elem, b: Elem): number {
  return compareIds(a, b);
}
