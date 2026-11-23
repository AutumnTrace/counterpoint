/**
 * A hostile network for tests: replicas exchange real encoded messages that
 * can be reordered, duplicated, or lost on links that are cut.
 */
import fc from 'fast-check';
import { encodeUpdate } from '../../src/encoding.ts';
import type { Op } from '../../src/ops.ts';
import type { TextDoc } from '../../src/text-doc.ts';

export type NetAction =
  | { readonly t: 'ins'; readonly r: number; readonly at: number; readonly text: string }
  | { readonly t: 'del'; readonly r: number; readonly at: number; readonly len: number }
  | { readonly t: 'deliver'; readonly pick: number }
  | { readonly t: 'dup'; readonly pick: number }
  | { readonly t: 'link'; readonly a: number; readonly b: number }
  | { readonly t: 'sync'; readonly a: number; readonly b: number };

export const netActionArb = (n: number): fc.Arbitrary<NetAction> => {
  const r = fc.nat(n - 1);
  return fc.oneof(
    { weight: 5, arbitrary: fc.record({ t: fc.constant('ins' as const), r, at: fc.nat(), text: fc.string({ unit: fc.constantFrom(...'abcxyz'), minLength: 1, maxLength: 4 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('del' as const), r, at: fc.nat(), len: fc.integer({ min: 1, max: 4 }) }) },
    { weight: 6, arbitrary: fc.record({ t: fc.constant('deliver' as const), pick: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('dup' as const), pick: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('link' as const), a: r, b: r }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('sync' as const), a: r, b: r }) },
  );
};

/** Totals across all property runs, to check the tests really exercise each path. */
export const tally = { applied: 0, duplicate: 0, buffered: 0, lost: 0 };

/** Replicas, links that can be cut, and a bag of in-flight messages. */
export class Net {
  readonly docs: TextDoc[];
  readonly up: boolean[][];
  readonly inFlight: { to: number; from: number; bytes: Uint8Array }[] = [];

  constructor(docs: TextDoc[]) {
    this.docs = docs;
    this.up = docs.map(() => docs.map(() => true));
  }

  broadcast(from: number, op: Op): void {
    const bytes = encodeUpdate([op], this.docs[from]!.variant);
    this.docs.forEach((_, to) => {
      if (to !== from && this.up[from]![to]) this.inFlight.push({ to, from, bytes });
    });
  }

  deliver(pick: number): void {
    if (this.inFlight.length === 0) return;
    const [m] = this.inFlight.splice(pick % this.inFlight.length, 1);
    // A message on a link that was cut in the meantime is lost.
    if (!this.up[m!.from]![m!.to]) {
      tally.lost++;
      return;
    }
    const summary = this.docs[m!.to]!.applyUpdate(m!.bytes);
    tally.applied += summary.applied;
    tally.duplicate += summary.duplicate;
    tally.buffered += summary.buffered;
  }

  /** Anti-entropy between two replicas, both directions, via binary messages. */
  sync(a: number, b: number): void {
    if (a === b || !this.up[a]![b]) return;
    const da = this.docs[a]!;
    const db = this.docs[b]!;
    db.applyUpdate(da.encodeChangesSince(db.version()));
    da.applyUpdate(db.encodeChangesSince(da.version()));
  }

  run(actions: readonly NetAction[]): void {
    for (const a of actions) {
      if (a.t === 'ins' || a.t === 'del') {
        const doc = this.docs[a.r]!;
        if (a.t === 'ins') this.broadcast(a.r, doc.insert(a.at % (doc.length + 1), a.text));
        else if (doc.length > 0) {
          const i = a.at % doc.length;
          this.broadcast(a.r, doc.delete(i, Math.min(a.len, doc.length - i)));
        }
      } else if (a.t === 'deliver') this.deliver(a.pick);
      else if (a.t === 'dup') {
        if (this.inFlight.length > 0) this.inFlight.push(this.inFlight[a.pick % this.inFlight.length]!);
      } else if (a.t === 'link') {
        if (a.a !== a.b) this.up[a.a]![a.b] = this.up[a.b]![a.a] = !this.up[a.a]![a.b];
      } else this.sync(a.a, a.b);
    }
  }

  heal(): void {
    for (const row of this.up) row.fill(true);
    while (this.inFlight.length > 0) this.deliver(0);
    for (let round = 0; round < 2; round++) {
      for (let a = 0; a < this.docs.length; a++) for (let b = a + 1; b < this.docs.length; b++) this.sync(a, b);
    }
  }
}

