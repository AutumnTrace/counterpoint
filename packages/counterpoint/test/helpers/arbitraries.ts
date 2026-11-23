import fc from 'fast-check';
import type { Id } from '../../src/id.ts';
import type { Cluster, DocLike } from './cluster.ts';

export type Action =
  | { readonly t: 'ins'; readonly r: number; readonly at: number; readonly text: string }
  | { readonly t: 'del'; readonly r: number; readonly at: number; readonly len: number }
  | { readonly t: 'deliver'; readonly r: number; readonly pick: number };

const letters = fc.constantFrom(...'abcxyz');

/** Random local edits and deliveries for `replicas` replicas. */
export function actionArb(replicas: number): fc.Arbitrary<Action> {
  const r = fc.nat(replicas - 1);
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant('ins' as const),
        r,
        at: fc.nat(),
        text: fc.string({ unit: letters, minLength: 1, maxLength: 3 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ t: fc.constant('del' as const), r, at: fc.nat(), len: fc.integer({ min: 1, max: 3 }) }),
    },
    { weight: 5, arbitrary: fc.record({ t: fc.constant('deliver' as const), r, pick: fc.nat() }) },
  );
}

/** A replica count together with a history for that many replicas. */
export function historyArb(minReplicas = 2, maxReplicas = 4, maxActions = 60) {
  return fc
    .integer({ min: minReplicas, max: maxReplicas })
    .chain((n) => fc.tuple(fc.constant(n), fc.array(actionArb(n), { maxLength: maxActions })));
}

export function runActions<D extends DocLike>(cluster: Cluster<D>, actions: readonly Action[]): void {
  for (const a of actions) {
    const doc = cluster.docs[a.r]!;
    if (a.t === 'ins') {
      cluster.insert(a.r, a.at % (doc.length + 1), a.text);
    } else if (a.t === 'del') {
      if (doc.length === 0) continue;
      const index = a.at % doc.length;
      cluster.delete(a.r, index, Math.min(a.len, doc.length - index));
    } else {
      cluster.deliverOne(a.r, a.pick);
    }
  }
}

export const NAMES = ['ada', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal'];

export const idStr = (id: Id | null) => (id === null ? 'start' : `${id.replica}:${id.counter}`);
