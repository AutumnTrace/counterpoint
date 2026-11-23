/**
 * The naive baseline is a real CRDT (it converges) that interleaves. The
 * same "typing sessions" property Fugue passes is expected to fail here,
 * which also shows the property is able to catch interleaving at all.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NaiveDoc, type NaiveOp } from '../src/baseline/naive.ts';
import { TextDoc } from '../src/text-doc.ts';
import type { Op } from '../src/ops.ts';

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Base text from one replica, then two replicas type a word each at `at`, keystroke by keystroke. */
function concurrentWords<D, O>(
  make: (r: string) => D,
  insert: (d: D, i: number, s: string) => O[],
  apply: (d: D, op: O) => void,
  text: (d: D) => string,
  base: string,
  at: number,
  words: [string, string],
): string[] {
  const [a, b, c] = [make('ada'), make('ben'), make('cy')];
  for (const op of insert(c, 0, base)) {
    apply(a, op);
    apply(b, op);
  }
  const index = at % (base.length + 1);
  const ops: O[] = [];
  for (let k = 0; k < Math.max(words[0].length, words[1].length); k++) {
    if (k < words[0].length) ops.push(...insert(a, index + k, words[0][k]!));
    if (k < words[1].length) ops.push(...insert(b, index + k, words[1][k]!));
  }
  for (const d of [a, b, c]) for (const op of ops) apply(d, op);
  return [a, b, c].map(text);
}

const naive = {
  make: (r: string) => new NaiveDoc(r),
  insert: (d: NaiveDoc, i: number, s: string) => d.insert(i, s),
  apply: (d: NaiveDoc, op: NaiveOp) => d.apply(op),
  text: (d: NaiveDoc) => d.toString(),
};
const fugue = {
  make: (r: string) => new TextDoc({ replicaId: r }),
  insert: (d: TextDoc, i: number, s: string): Op[] => (s.length === 0 ? [] : [d.insert(i, s)]),
  apply: (d: TextDoc, op: Op) => void d.apply(op),
  text: (d: TextDoc) => d.toString(),
};

describe('NaiveDoc (baseline)', () => {
  it('converges under any delivery order, with duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ r: fc.nat(2), at: fc.nat(), del: fc.boolean(), text: fc.string({ unit: fc.constantFrom('a', 'b', 'c'), minLength: 1, maxLength: 3 }) }),
          { maxLength: 40, size: 'max' },
        ),
        fc.nat(),
        (edits, seed) => {
          const docs = ['ada', 'ben', 'cy'].map((r) => new NaiveDoc(r));
          const ops: NaiveOp[] = [];
          for (const e of edits) {
            const d = docs[e.r]!;
            if (e.del && d.length > 0) ops.push(...d.delete(e.at % d.length, 1));
            else ops.push(...d.insert(e.at % (d.length + 1), e.text));
          }
          for (const [i, d] of docs.entries()) for (const op of shuffle([...ops, ...ops], seed + i)) d.apply(op);
          expect(docs[1]!.toString()).toBe(docs[0]!.toString());
          expect(docs[2]!.toString()).toBe(docs[0]!.toString());
        },
      ),
      { numRuns: 200 },
    );
  });

  it('interleaves the paper\'s figure 1 example', () => {
    const [text] = concurrentWords(naive.make, naive.insert, naive.apply, naive.text, 'milk\n', 5, ['eggs\n', 'bread\n']);
    expect(text).toBe('milk\nebgrgesa\nd\n');
    const [fugueText] = concurrentWords(fugue.make, fugue.insert, fugue.apply, fugue.text, 'milk\n', 5, ['eggs\n', 'bread\n']);
    expect(fugueText).toBe('milk\neggs\nbread\n');
  });

  it('fails the non-interleaving property that Fugue passes', () => {
    const wordArb = fc.string({ unit: fc.constantFrom(...'abcdef'), minLength: 1, maxLength: 6 });
    const property = <D, O>(impl: {
      make: (r: string) => D;
      insert: (d: D, i: number, s: string) => O[];
      apply: (d: D, op: O) => void;
      text: (d: D) => string;
    }) =>
      fc.property(fc.string({ unit: fc.constantFrom('x', 'y'), maxLength: 8 }), fc.nat(), wordArb, wordArb, (base, at, w1, w2) => {
        const upper = w2.toUpperCase();
        const [text] = concurrentWords(impl.make, impl.insert, impl.apply, impl.text, base, at, [w1, upper]);
        const i = at % (base.length + 1);
        const ok = [base.slice(0, i) + w1 + upper + base.slice(i), base.slice(0, i) + upper + w1 + base.slice(i)];
        return ok.includes(text!);
      });
    const fr = fc.check(property(fugue), { numRuns: 300 });
    expect(fr.failed).toBe(false);
    const result = fc.check(property(naive), { numRuns: 300, seed: 42 });
    expect(result.failed).toBe(true);
    // fast-check shrinks the failure down to the smallest interleaving case.
    expect(result.counterexample).toEqual(['', 0, 'aa', 'a']);
  });
});
