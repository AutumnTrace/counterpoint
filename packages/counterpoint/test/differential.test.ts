/**
 * TextDoc reaches the paper's order by a different route (it never walks
 * the tree to compute an index), so check it against the literal
 * transcription: same actions, same delivery choices, and at every step
 * the generated ops and the full element order must be identical.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SimpleFugue } from '../src/reference/simple-fugue.ts';
import { TextDoc } from '../src/text-doc.ts';
import { NAMES, historyArb, idStr } from './helpers/arbitraries.ts';
import { Cluster } from './helpers/cluster.ts';
import { VARIANTS } from './helpers/impls.ts';

describe.each(VARIANTS)('TextDoc vs SimpleFugue (%s)', (variant) => {
  const cases = [
    { name: 'short histories', arb: historyArb(2, 4, 80), runs: 400 },
    // Long runs of text push the order tree through leaf and branch splits.
    { name: 'long histories', arb: historyArb(2, 3, 800, 60), runs: 10 },
  ];
  it.each(cases)('produces identical ops and identical element order: $name', ({ arb, runs }) => {
    fc.assert(
      fc.property(arb, ([n, actions]) => {
        const names = NAMES.slice(0, n);
        const fast = new Cluster(names.map((r) => new TextDoc({ replicaId: r, variant })));
        const slow = new Cluster(names.map((r) => new SimpleFugue(r, variant)));
        for (const a of actions) {
          const doc = slow.docs[a.r]!;
          if (a.t === 'ins') {
            const i = a.at % (doc.length + 1);
            expect(fast.insert(a.r, i, a.text)).toEqual(slow.insert(a.r, i, a.text));
          } else if (a.t === 'del') {
            if (doc.length === 0) continue;
            const i = a.at % doc.length;
            const len = Math.min(a.len, doc.length - i);
            expect(fast.delete(a.r, i, len)).toEqual(slow.delete(a.r, i, len));
          } else {
            expect(fast.deliverOne(a.r, a.pick)).toBe(slow.deliverOne(a.r, a.pick));
          }
          const fo = fast.docs[a.r]!.idsInOrder().map(idStr).join(' ');
          const so = slow.docs[a.r]!.idsInOrder().map(idStr).join(' ');
          expect(fo).toBe(so);
          expect(fast.docs[a.r]!.toString()).toBe(doc.toString());
        }
      }),
      { numRuns: runs },
    );
  });
});
