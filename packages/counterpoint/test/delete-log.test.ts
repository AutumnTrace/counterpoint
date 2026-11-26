import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeUpdate } from '../src/encoding.ts';
import type { DeleteOp, Op } from '../src/ops.ts';
import { TextDoc } from '../src/text-doc.ts';
import { VARIANTS } from './helpers/impls.ts';

// Runs of single-character deletes are stored as one shared object in the
// log. These tests check that the log still hands back every delete exactly
// as it was made, so sync messages and snapshots are unchanged.

type Edit =
  | { readonly t: 'type'; readonly r: number; readonly at: number; readonly text: string }
  | { readonly t: 'backspace' | 'forward'; readonly r: number; readonly at: number; readonly n: number }
  | { readonly t: 'range'; readonly r: number; readonly at: number; readonly len: number }
  | { readonly t: 'sync'; readonly from: number; readonly to: number; readonly shuffle: number };

const r = fc.nat(1);
const editArb: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('type' as const), r, at: fc.nat(), text: fc.string({ unit: fc.constantFrom(...'abcxyz'), minLength: 1, maxLength: 6 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('backspace' as const), r, at: fc.nat(), n: fc.integer({ min: 1, max: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('forward' as const), r, at: fc.nat(), n: fc.integer({ min: 1, max: 8 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('range' as const), r, at: fc.nat(), len: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('sync' as const), from: r, to: r, shuffle: fc.nat() }) },
);

/** Two replicas that remember every op they applied, in the order they applied them. */
function setup(variant: (typeof VARIANTS)[number]) {
  const docs = [new TextDoc({ replicaId: 'ada', variant }), new TextDoc({ replicaId: 'ben', variant })];
  const applied = docs.map((doc) => {
    const ops: Op[] = [];
    doc.onChange((e) => ops.push(e.op));
    return ops;
  });
  return { docs, applied };
}

function run(docs: TextDoc[], edits: readonly Edit[]): void {
  for (const e of edits) {
    if (e.t === 'sync') {
      if (e.from === e.to) continue;
      const ops = decodeUpdate(docs[e.from]!.encodeChangesSince(docs[e.to]!.version())).ops;
      // Out of order delivery goes through the buffer, which releases deletes one by one.
      for (let i = ops.length - 1; i > 0; i--) {
        const j = (e.shuffle + i * 7919) % (i + 1);
        [ops[i], ops[j]] = [ops[j]!, ops[i]!];
      }
      docs[e.to]!.applyAll(ops);
      expect(docs[e.to]!.pendingCount).toBe(0);
      continue;
    }
    const doc = docs[e.r]!;
    if (e.t === 'type') {
      doc.insert(e.at % (doc.length + 1), e.text);
    } else if (e.t === 'range') {
      if (doc.length === 0) continue;
      const at = e.at % doc.length;
      doc.delete(at, Math.min(e.len, doc.length - at));
    } else if (e.t === 'backspace') {
      // A caret after position `at`, pressing backspace n times.
      for (let k = 0, caret = e.at % (doc.length + 1); k < e.n && caret > 0; k++) doc.delete(--caret, 1);
    } else {
      for (let k = 0, caret = doc.length === 0 ? 0 : e.at % doc.length; k < e.n && caret < doc.length; k++) doc.delete(caret, 1);
    }
  }
}

/** The deletes a peer at `since` would get, from the ops a replica applied: by replica, then counter. */
function expectedDeletes(applied: readonly Op[], since: Record<string, number>): DeleteOp[] {
  return applied
    .filter((op): op is DeleteOp => op.kind === 'delete' && op.id.counter >= (since[op.id.replica] ?? 0))
    .sort((a, b) => (a.id.replica === b.id.replica ? a.id.counter - b.id.counter : a.id.replica < b.id.replica ? -1 : 1))
    .map((op) => ({ kind: 'delete', id: { ...op.id }, targets: op.targets.map((t) => ({ ...t })) }));
}

const deletesIn = (ops: readonly Op[]) => ops.filter((op) => op.kind === 'delete');

describe.each(VARIANTS)('delete log (%s)', (variant) => {
  it('changesSince returns every delete as it was applied, from any version', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 60 }), fc.nat(), fc.nat(), (edits, cutA, cutB) => {
        const { docs, applied } = setup(variant);
        run(docs, edits);
        docs.forEach((doc, i) => {
          const version = doc.version();
          // Any prefix of each replica's log, including cuts in the middle of a run.
          const since = { ada: cutA % ((version.ada ?? 0) + 1), ben: cutB % ((version.ben ?? 0) + 1) };
          expect(deletesIn(doc.changesSince({}))).toEqual(expectedDeletes(applied[i]!, {}));
          expect(deletesIn(doc.changesSince(since))).toEqual(expectedDeletes(applied[i]!, since));
        });
      }),
      { numRuns: 300 },
    );
  });

  it('a snapshot keeps the delete log and loads back to the same bytes', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 60 }), (edits) => {
        const { docs, applied } = setup(variant);
        run(docs, edits);
        docs.forEach((doc, i) => {
          const bytes = doc.save();
          const loaded = TextDoc.load(bytes);
          expect(deletesIn(loaded.changesSince({}))).toEqual(expectedDeletes(applied[i]!, {}));
          expect(loaded.save()).toEqual(bytes);
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe('delete runs', () => {
  const del = (replica: string, counter: number, target: string, at: number): DeleteOp => ({
    kind: 'delete',
    id: { replica, counter },
    targets: [{ replica: target, counter: at, length: 1 }],
  });

  it('hands back each delete where a run would end: direction, target replica, op shape', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    ada.insert(0, 'abcdefgh'); // ada:0..7
    ben.applyUpdate(ada.encodeChangesSince());
    ben.insert(8, 'XY'); // ben:0..1
    ada.applyUpdate(ben.encodeChangesSince(ada.version()));

    ada.delete(7, 1); // backspace over h, g
    ada.delete(6, 1);
    ada.delete(0, 1); // a, then forward delete b, c
    ada.delete(0, 1);
    ada.delete(0, 1);
    ada.delete(3, 1); // X, then Y: another replica's characters
    ada.delete(3, 1);
    ada.delete(0, 2); // d, e: one op with a two-character target
    ada.delete(0, 1); // f

    expect(ada.toString()).toBe('');
    expect(deletesIn(ada.changesSince({}))).toEqual([
      del('ada', 8, 'ada', 7),
      del('ada', 9, 'ada', 6),
      del('ada', 10, 'ada', 0),
      del('ada', 11, 'ada', 1),
      del('ada', 12, 'ada', 2),
      del('ada', 13, 'ben', 0),
      del('ada', 14, 'ben', 1),
      { kind: 'delete', id: { replica: 'ada', counter: 15 }, targets: [{ replica: 'ada', counter: 3, length: 2 }] },
      del('ada', 16, 'ada', 5),
    ]);
  });

  it('keeps deleting the same character twice as two log entries', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    ada.insert(0, 'ab');
    ben.applyUpdate(ada.encodeChangesSince());
    const fromAda = ada.delete(1, 1);
    const fromBen = ben.delete(1, 1); // concurrently, the same character
    ada.apply(fromBen);
    ben.apply(fromAda);
    expect(ada.toString()).toBe('a');
    expect(ada.save()).toEqual(ben.save());
    expect(deletesIn(ada.changesSince({}))).toEqual([fromAda, fromBen]);
  });
});
