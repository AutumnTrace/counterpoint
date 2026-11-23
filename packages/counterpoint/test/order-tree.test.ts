import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Elem } from '../src/element.ts';
import { OrderTree } from '../src/order-tree.ts';

const mk = (n: number) => new Elem('t', n, String.fromCharCode(97 + (n % 26)), null, 'right', null);

type Step = { readonly kind: 'after' | 'before' | 'delete'; readonly at: number; readonly count: number };

const stepArb: fc.Arbitrary<Step> = fc.record({
  kind: fc.constantFrom('after' as const, 'before' as const, 'delete' as const),
  at: fc.nat(),
  count: fc.integer({ min: 1, max: 300 }),
});

describe('OrderTree', () => {
  it('agrees with a plain array through thousands of inserts and deletes', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 20, maxLength: 120, size: 'max' }), (steps) => {
        const tree = new OrderTree();
        const model: Elem[] = [];
        let next = 0;
        for (const s of steps) {
          if (s.kind === 'delete') {
            if (model.length === 0) continue;
            const e = model[s.at % model.length]!;
            const wasDeleted = e.deleted;
            expect(tree.markDeleted(e)).toBe(!wasDeleted);
            continue;
          }
          const run = Array.from({ length: s.count }, () => mk(next++));
          if (model.length === 0) {
            tree.insertAfter(null, run);
            model.push(...run);
            continue;
          }
          const i = s.at % model.length;
          if (s.kind === 'after') {
            tree.insertAfter(model[i]!, run);
            model.splice(i + 1, 0, ...run);
          } else {
            tree.insertBefore(model[i]!, run);
            model.splice(i, 0, ...run);
          }
        }
        tree.assertInvariants();
        const visible = model.filter((e) => !e.deleted);
        expect(tree.size).toBe(model.length);
        expect(tree.visible).toBe(visible.length);
        expect(tree.text()).toBe(visible.map((e) => e.char).join(''));
        // Spot-check the index queries in both directions.
        for (let k = 0; k < 50 && model.length > 0; k++) {
          const i = (k * 7919) % model.length;
          const e = model[i]!;
          expect(tree.indexOf(e)).toBe(i);
          expect(tree.visibleIndexOf(e)).toBe(model.slice(0, i).filter((x) => !x.deleted).length);
          expect(tree.next(e)).toBe(model[i + 1] ?? null);
        }
        for (let k = 0; k < 50 && visible.length > 0; k++) {
          const i = (k * 104729) % visible.length;
          expect(tree.atVisible(i)).toBe(visible[i]);
          expect(tree.visibleRange(i, 17)).toEqual(visible.slice(i, i + 17));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('rejects out-of-range indexes', () => {
    const tree = new OrderTree();
    expect(() => tree.atVisible(0)).toThrow(RangeError);
    tree.insertAfter(null, [mk(0)]);
    expect(() => tree.atVisible(1)).toThrow(RangeError);
    expect(() => tree.atVisible(-1)).toThrow(RangeError);
  });
});
