import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NAMES, historyArb, idStr, runActions } from './helpers/arbitraries.ts';
import { Cluster } from './helpers/cluster.ts';
import { IMPLS, VARIANTS } from './helpers/impls.ts';

describe.each(IMPLS)('$name', (impl) => {
  describe.each(VARIANTS)('%s', (variant) => {
    it('converges under any causal delivery order', () => {
      fc.assert(
        fc.property(historyArb(2, 4, 60), ([n, actions]) => {
          const cluster = new Cluster(NAMES.slice(0, n).map((name) => impl.create(name, variant)));
          runActions(cluster, actions);
          cluster.deliverAll();
          const texts = cluster.docs.map((d) => d.toString());
          const orders = cluster.docs.map((d) => d.idsInOrder().map(idStr).join(' '));
          for (let i = 1; i < n; i++) {
            expect(texts[i]).toBe(texts[0]);
            expect(orders[i]).toBe(orders[0]);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('matches a plain string when used by a single replica', () => {
      fc.assert(
        fc.property(historyArb(1, 1, 80), ([, actions]) => {
          const doc = impl.create('solo', variant);
          let model = '';
          for (const a of actions) {
            if (a.t === 'ins') {
              const i = a.at % (model.length + 1);
              doc.insert(i, a.text);
              model = model.slice(0, i) + a.text + model.slice(i);
            } else if (a.t === 'del' && model.length > 0) {
              const i = a.at % model.length;
              const len = Math.min(a.len, model.length - i);
              doc.delete(i, len);
              model = model.slice(0, i) + model.slice(i + len);
            }
            expect(doc.toString()).toBe(model);
            expect(doc.length).toBe(model.length);
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
