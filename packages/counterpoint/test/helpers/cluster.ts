/**
 * A tiny in-memory "network" for tests: a set of replicas, a global log of
 * every op ever generated, and per-replica bookkeeping of what has been
 * delivered where. Delivery can be restricted to causally ready ops (for
 * implementations that do no buffering of their own) or left wide open.
 */
import type { Id } from '../../src/id.ts';
import type { Op } from '../../src/ops.ts';

export interface DocLike {
  readonly replicaId: string;
  insert(index: number, text: string): Op;
  delete(index: number, length?: number): Op;
  apply(op: Op): unknown;
  toString(): string;
  readonly length: number;
  idsInOrder(): Id[];
  has(id: Id): boolean;
  idAt(index: number): Id;
}

export interface LogEntry {
  readonly op: Op;
  readonly origin: number;
  /** For inserts: the visible element left of the insertion point (null = start). */
  readonly leftOrigin: Id | null;
}

export class Cluster<D extends DocLike> {
  readonly docs: D[];
  readonly log: LogEntry[] = [];
  /** delivered[r] holds log indices already applied at replica r. */
  readonly delivered: Set<number>[];

  /** When true, only ops whose dependencies are present get delivered. */
  readonly causal: boolean;

  constructor(docs: D[], causal = true) {
    this.docs = docs;
    this.causal = causal;
    this.delivered = docs.map(() => new Set<number>());
  }

  insert(r: number, index: number, text: string): Op {
    const doc = this.docs[r]!;
    const leftOrigin = index === 0 ? null : doc.idAt(index - 1);
    return this.record(r, doc.insert(index, text), leftOrigin);
  }

  delete(r: number, index: number, length = 1): Op {
    return this.record(r, this.docs[r]!.delete(index, length), null);
  }

  private record(r: number, op: Op, leftOrigin: Id | null): Op {
    this.log.push({ op, origin: r, leftOrigin });
    this.delivered[r]!.add(this.log.length - 1);
    return op;
  }

  /** Log indices that replica r has not seen and could apply now. */
  deliverable(r: number): number[] {
    const out: number[] = [];
    const blockedOrigins = new Set<number>();
    for (let i = 0; i < this.log.length; i++) {
      if (this.delivered[r]!.has(i)) continue;
      const entry = this.log[i]!;
      if (!this.causal) {
        out.push(i);
        continue;
      }
      // FIFO per origin: an op is only ready once its predecessors are.
      if (blockedOrigins.has(entry.origin)) continue;
      if (this.ready(r, entry.op)) out.push(i);
      blockedOrigins.add(entry.origin);
    }
    return out;
  }

  private ready(r: number, op: Op): boolean {
    const doc = this.docs[r]!;
    if (op.kind === 'insert') {
      return (op.parent === null || doc.has(op.parent)) && (op.rightOrigin === null || doc.has(op.rightOrigin));
    }
    return op.targets.every((t) => {
      for (let c = t.counter; c < t.counter + t.length; c++) {
        if (!doc.has({ replica: t.replica, counter: c })) return false;
      }
      return true;
    });
  }

  deliver(r: number, logIndex: number): void {
    this.docs[r]!.apply(this.log[logIndex]!.op);
    this.delivered[r]!.add(logIndex);
  }

  /** Delivers one pending op to replica r, chosen by `pick`. False if none. */
  deliverOne(r: number, pick: number): boolean {
    const ready = this.deliverable(r);
    if (ready.length === 0) return false;
    this.deliver(r, ready[pick % ready.length]!);
    return true;
  }

  /** Delivers everything everywhere (only ops from `origins`, if given). */
  deliverAll(targets: readonly number[] = this.docs.map((_, i) => i), origins?: ReadonlySet<number>): void {
    for (let progress = true; progress; ) {
      progress = false;
      for (const r of targets) {
        for (const i of this.deliverable(r)) {
          if (origins && !origins.has(this.log[i]!.origin)) continue;
          this.deliver(r, i);
          progress = true;
        }
      }
    }
  }
}

/** Mulberry32: a tiny seeded PRNG so failures can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
