/**
 * A collaborative plain-text document: the Fugue / FugueMax tree for
 * deciding where characters go, an order-statistic tree (order-tree.ts) for
 * turning that into indexes quickly, and a small causal-delivery layer so
 * ops can arrive late, early, twice, or in bulk after a partition.
 */
import { Elem, firstDescendant, lastDescendant } from './element.ts';
import { DecodeError, decodeUpdate, encodeUpdate, encodeVersion } from './encoding.ts';
import { compareIds, formatId, randomReplicaId, type Id, type IdRange, type ReplicaId } from './id.ts';
import { opSpan, type DeleteOp, type InsertOp, type Op, type Side, type Variant } from './ops.ts';
import { OrderTree } from './order-tree.ts';
import { versionOf, type VersionVector } from './version.ts';

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
  /** 'local' for edits made through insert()/delete(), 'remote' for applied ops. */
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

/** What `apply` did with an op. */
export type ApplyStatus = 'applied' | 'duplicate' | 'buffered';

export interface ApplySummary {
  applied: number;
  duplicate: number;
  buffered: number;
}

export class MissingDependencyError extends Error {
  readonly missing: Id;
  constructor(missing: Id, context: string) {
    super(`${context}: element ${formatId(missing)} is not known here yet`);
    this.name = 'MissingDependencyError';
    this.missing = missing;
  }
}

/**
 * A replica's log entry at one counter: the inserted element, or the
 * targets of the delete op that used it (the op's id is implied by the slot,
 * so only the targets are kept).
 */
type Slot = Elem | readonly IdRange[] | undefined;

interface Pending {
  readonly op: Op;
  readonly key: string;
  /** Released once the waited-on replica's version exceeds this counter. */
  readonly need: number;
}

export class TextDoc {
  readonly replicaId: ReplicaId;
  readonly variant: Variant;

  private readonly root = new Elem('', -1, '', null, 'right', null);
  private readonly order = new OrderTree();
  /**
   * The log, indexed by replica then counter: an Elem for every inserted
   * character, the delete targets for every counter a delete used.
   */
  private readonly slots = new Map<ReplicaId, Slot[]>();
  /** How many counters of each replica have been applied (a version vector). */
  private readonly clock = new Map<ReplicaId, number>();
  /** Buffered ops, grouped by the replica whose progress they wait for. */
  private readonly waiting = new Map<ReplicaId, MinHeap<Pending>>();
  private readonly bufferedKeys = new Set<string>();
  private readonly listeners = new Set<(event: ChangeEvent) => void>();

  constructor(options: TextDocOptions = {}) {
    this.replicaId = options.replicaId ?? randomReplicaId();
    this.variant = options.variant ?? 'fugue-max';
  }

  /**
   * Loads a document saved with `save()`. Pass the same `replicaId` only to
   * resume that replica's own session (it continues its counter); by default
   * the loaded copy gets a fresh id.
   */
  static load(bytes: Uint8Array, options: TextDocOptions = {}): TextDoc {
    const { variant, ops } = decodeUpdate(bytes, 'snapshot');
    if (options.variant !== undefined && options.variant !== variant) {
      throw new Error(`snapshot uses ${variant}, not ${options.variant}`);
    }
    const doc = new TextDoc({ ...options, variant });
    try {
      doc.applyAll(ops);
    } catch (e) {
      throw new DecodeError(`snapshot contains an invalid op: ${(e as Error).message}`);
    }
    if (doc.pendingCount > 0) throw new DecodeError('snapshot refers to elements it does not contain');
    return doc;
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

  /** Total number of elements ever inserted, tombstones included. */
  get elementCount(): number {
    return this.order.size;
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
      id: { replica: this.replicaId, counter: this.versionOf(this.replicaId) },
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
    const op: DeleteOp = {
      kind: 'delete',
      id: { replica: this.replicaId, counter: this.versionOf(this.replicaId) },
      targets,
    };
    this.integrateDelete(op, 'local');
    return op;
  }

  // ------------------------------------------------------- remote edits

  /**
   * Integrates an op from anywhere. Ops can arrive in any order and any
   * number of times: one that is already here is ignored, one whose
   * dependencies are missing waits in a buffer until they arrive.
   */
  apply(op: Op): ApplyStatus {
    const status = this.receive(op);
    if (status === 'applied') this.drain(op.id.replica);
    return status;
  }

  applyAll(ops: Iterable<Op>): ApplySummary {
    const summary: ApplySummary = { applied: 0, duplicate: 0, buffered: 0 };
    for (const op of ops) summary[this.apply(op)]++;
    return summary;
  }

  /** Decodes and applies an update produced by `encodeUpdate` / `encodeChangesSince`. */
  applyUpdate(bytes: Uint8Array): ApplySummary {
    const { variant, ops } = decodeUpdate(bytes);
    if (variant !== this.variant) throw new Error(`update uses ${variant}, this document uses ${this.variant}`);
    return this.applyAll(ops);
  }

  /** Ops that are waiting for dependencies, oldest first within each replica. */
  pending(): Op[] {
    const out: Op[] = [];
    for (const heap of this.waiting.values()) for (const p of heap.items()) out.push(p.op);
    return out;
  }

  get pendingCount(): number {
    return this.bufferedKeys.size;
  }

  // ---------------------------------------------------------------- sync

  /** For each replica, how many of its counters have been applied here. */
  version(): VersionVector {
    const vv: Record<ReplicaId, number> = Object.create(null);
    for (const [r, n] of this.clock) vv[r] = n;
    return vv;
  }

  /**
   * Everything applied here that a peer at version `since` lacks, as ops.
   * Inserts are regenerated from the elements themselves (merged into runs
   * where possible); deletes come straight from the log.
   */
  changesSince(since: VersionVector = {}): Op[] {
    const ops: Op[] = [];
    // Sorted, so the output (and therefore save()) is canonical.
    for (const replica of [...this.clock.keys()].sort()) {
      const have = this.clock.get(replica)!;
      const slots = this.slots.get(replica)!;
      for (let c = versionOf(since, replica); c < have; ) {
        const slot = slots[c];
        if (slot === undefined) throw new Error(`log hole at ${replica}:${c}`);
        if (!(slot instanceof Elem)) {
          ops.push({ kind: 'delete', id: { replica, counter: c }, targets: slot });
          c++;
          continue;
        }
        let text = slot.char;
        let last = slot;
        let n = c + 1;
        for (; n < have; n++) {
          const e = slots[n];
          if (!(e instanceof Elem) || e.parent !== last || e.side !== 'right' || e.rightOrigin !== last.rightOrigin) break;
          text += e.char;
          last = e;
        }
        ops.push({
          kind: 'insert',
          id: { replica, counter: c },
          text,
          parent: slot.parent === this.root ? null : toId(slot.parent!),
          side: slot.side,
          rightOrigin: slot.rightOrigin === null ? null : toId(slot.rightOrigin),
        });
        c = n;
      }
    }
    return ops;
  }

  /** `changesSince` as a binary update. */
  encodeChangesSince(since: VersionVector = {}): Uint8Array {
    return encodeUpdate(this.changesSince(since), this.variant);
  }

  /** This document's version vector as a binary message (the "what I have" half of a sync). */
  encodeVersion(): Uint8Array {
    return encodeVersion(this.version(), this.variant);
  }

  /**
   * The whole document: every op it has applied, in the update encoding
   * (inserts regenerated as runs, tombstones and the delete log included).
   * Buffered ops are not part of it.
   */
  save(): Uint8Array {
    return encodeUpdate(this.changesSince({}), this.variant, 'snapshot');
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

  // ------------------------------------------------- inspection (for UIs)

  /**
   * The Fugue tree as plain data, for visualising small documents.
   * Children are listed in traversal order.
   */
  inspectTree(): TreeNode {
    const build = (e: Elem): TreeNode => ({
      id: e === this.root ? null : toId(e),
      char: e.char,
      deleted: e === this.root ? false : e.deleted,
      side: e.side,
      rightOrigin: e.rightOrigin === null ? null : toId(e.rightOrigin),
      left: (e.left ?? []).map(build),
      right: (e.right ?? []).map(build),
    });
    return build(this.root);
  }

  // ----------------------------------------------------------- internals

  private versionOf(replica: ReplicaId): number {
    return this.clock.get(replica) ?? 0;
  }

  private lookup(id: Id): Elem | undefined {
    const slot = this.slots.get(id.replica)?.[id.counter];
    return slot instanceof Elem ? slot : undefined;
  }

  private require(id: Id | null, context: string): Elem {
    if (id === null) return this.root;
    const e = this.lookup(id);
    if (e === undefined) throw new MissingDependencyError(id, context);
    return e;
  }

  private slotsOf(replica: ReplicaId): Slot[] {
    let slots = this.slots.get(replica);
    if (slots === undefined) {
      slots = [];
      this.slots.set(replica, slots);
    }
    return slots;
  }

  /** Applies `op` now if it can be, otherwise buffers it. Does not drain the buffer. */
  private receive(op: Op): ApplyStatus {
    const have = this.versionOf(op.id.replica);
    if (op.id.counter + opSpan(op) <= have) return 'duplicate';
    if (op.id.counter < have) {
      // Part of this insert run is already here (a resent run can be longer
      // than the one first received). Keep the new tail: its first char's
      // parent is the previous char of the same run.
      const ins = op as InsertOp;
      const skip = have - ins.id.counter;
      op = {
        kind: 'insert',
        id: { replica: ins.id.replica, counter: have },
        text: ins.text.slice(skip),
        parent: { replica: ins.id.replica, counter: have - 1 },
        side: 'right',
        rightOrigin: ins.rightOrigin,
      };
    }
    const missing = this.firstMissing(op);
    if (missing !== null) {
      const key = `${op.kind}:${op.id.replica}:${op.id.counter}:${opSpan(op)}`;
      if (!this.bufferedKeys.has(key)) {
        this.bufferedKeys.add(key);
        let heap = this.waiting.get(missing.replica);
        if (heap === undefined) {
          heap = new MinHeap<Pending>((a, b) => a.need - b.need);
          this.waiting.set(missing.replica, heap);
        }
        heap.push({ op, key, need: missing.counter });
      }
      return 'buffered';
    }
    if (op.kind === 'insert') this.integrateInsert(op, 'remote');
    else this.integrateDelete(op, 'remote');
    return 'applied';
  }

  /** The first dependency of `op` that has not been applied yet, if any. */
  private firstMissing(op: Op): Id | null {
    const { replica, counter } = op.id;
    if (counter > this.versionOf(replica)) return { replica, counter: counter - 1 };
    if (op.kind === 'insert') {
      if (op.parent !== null && this.versionOf(op.parent.replica) <= op.parent.counter) return op.parent;
      if (op.rightOrigin !== null && this.versionOf(op.rightOrigin.replica) <= op.rightOrigin.counter) return op.rightOrigin;
      return null;
    }
    for (const t of op.targets) {
      const lastCounter = t.counter + t.length - 1;
      if (this.versionOf(t.replica) <= lastCounter) return { replica: t.replica, counter: lastCounter };
    }
    return null;
  }

  /** Releases buffered ops whose dependency has arrived, transitively. */
  private drain(start: ReplicaId): void {
    const work = [start];
    while (work.length > 0) {
      const replica = work.pop()!;
      const heap = this.waiting.get(replica);
      if (heap === undefined) continue;
      const have = this.versionOf(replica);
      while (heap.size > 0 && heap.peek()!.need < have) {
        const p = heap.pop()!;
        this.bufferedKeys.delete(p.key);
        if (this.receive(p.op) === 'applied') work.push(p.op.id.replica);
      }
      if (heap.size === 0) this.waiting.delete(replica);
    }
  }

  private advance(id: Id, span: number): void {
    this.clock.set(id.replica, id.counter + span);
  }

  private integrateInsert(op: InsertOp, origin: 'local' | 'remote'): void {
    const what = `insert ${formatId(op.id)}`;
    const parent = this.require(op.parent, what);
    const rightOrigin = op.rightOrigin === null ? null : this.require(op.rightOrigin, what);
    if (op.side === 'left' && (parent === this.root || rightOrigin !== parent)) {
      throw new Error(`${what}: a left child's right origin must be its (non-root) parent`);
    }
    if (op.text.length === 0) throw new Error(`${what}: empty text`);
    const slots = this.slotsOf(op.id.replica);

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

    this.advance(op.id, op.text.length);
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
        if (mine === theirs && compareIds(node, sib) < 0) break;
      }
      return i;
    }
    while (i < siblings.length && compareIds(siblings[i]!, node) < 0) i++;
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
    this.slotsOf(op.id.replica)[op.id.counter] = op.targets;
    this.advance(op.id, 1);
    if (track) this.emit({ origin, op, changes });
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Plain-data view of one tree node, from `inspectTree()`. */
export interface TreeNode {
  /** null for the root. */
  readonly id: Id | null;
  readonly char: string;
  readonly deleted: boolean;
  readonly side: Side;
  readonly rightOrigin: Id | null;
  readonly left: readonly TreeNode[];
  readonly right: readonly TreeNode[];
}

function toId(e: Elem): Id {
  return { replica: e.replica, counter: e.counter };
}

/** A small binary min-heap. */
class MinHeap<T> {
  private readonly data: T[] = [];
  private readonly less: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.less = compare;
  }

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  items(): readonly T[] {
    return this.data;
  }

  push(item: T): void {
    const d = this.data;
    d.push(item);
    for (let i = d.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (this.less(d[i]!, d[p]!) >= 0) break;
      [d[i], d[p]] = [d[p]!, d[i]!];
      i = p;
    }
  }

  pop(): T | undefined {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length > 0 && last !== undefined) {
      d[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l]!, d[m]!) < 0) m = l;
        if (r < d.length && this.less(d[r]!, d[m]!) < 0) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m]!, d[i]!];
        i = m;
      }
    }
    return top;
  }
}
