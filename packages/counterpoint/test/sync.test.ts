/**
 * The causal-delivery layer: replicas exchange real encoded messages over a
 * hostile network (reordering, duplication, loss while partitioned), then
 * heal and reconcile with version-vector delta sync.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeUpdate, encodeUpdate } from '../src/encoding.ts';
import type { Op } from '../src/ops.ts';
import { TextDoc } from '../src/text-doc.ts';
import { dominates, mergeVersions, sameVersion, versionOf } from '../src/version.ts';
import { NAMES, idStr } from './helpers/arbitraries.ts';
import { Net, netActionArb, tally } from './helpers/net.ts';
import { VARIANTS } from './helpers/impls.ts';

describe.each(VARIANTS)('sync (%s)', (variant) => {
  it('converges despite reordering, duplication and partitions', () => {
    tally.applied = tally.duplicate = tally.buffered = tally.lost = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }).chain((n) => fc.tuple(fc.constant(n), fc.array(netActionArb(n), { maxLength: 120, size: 'max' }))),
        ([n, actions]) => {
          const net = new Net(NAMES.slice(0, n).map((r) => new TextDoc({ replicaId: r, variant })));
          net.run(actions);
          net.heal();
          const [first, ...rest] = net.docs;
          const order = first!.idsInOrder().map(idStr).join(' ');
          for (const d of rest) {
            expect(d.toString()).toBe(first!.toString());
            expect(d.idsInOrder().map(idStr).join(' ')).toBe(order);
            expect(sameVersion(d.version(), first!.version())).toBe(true);
            // Same state, same canonical log: snapshots are byte-identical.
            expect(d.save()).toEqual(first!.save());
          }
          for (const d of net.docs) expect(d.pendingCount).toBe(0);
          // A replica that only ever saw one full delta ends up identical too.
          const fresh = new TextDoc({ replicaId: 'zed', variant });
          fresh.applyUpdate(first!.encodeChangesSince({}));
          expect(fresh.toString()).toBe(first!.toString());
          expect(fresh.idsInOrder().map(idStr).join(' ')).toBe(order);
        },
      ),
      { numRuns: 300 },
    );
    expect(tally.buffered).toBeGreaterThan(100);
    expect(tally.duplicate).toBeGreaterThan(100);
    expect(tally.lost).toBeGreaterThan(100);
  });

  it('delta sync sends exactly what the peer is missing', () => {
    fc.assert(
      fc.property(
        fc.array(netActionArb(2), { maxLength: 80, size: 'max' }),
        fc.array(netActionArb(2), { maxLength: 80, size: 'max' }),
        (shared, diverged) => {
          const net = new Net(['ada', 'ben'].map((r) => new TextDoc({ replicaId: r, variant })));
          net.run(shared);
          net.heal();
          net.up[0]![1] = net.up[1]![0] = false;
          net.run(diverged.filter((a) => a.t === 'ins' || a.t === 'del'));
          const [ada, ben] = net.docs as [TextDoc, TextDoc];
          const forBen = ada.changesSince(ben.version());
          for (const op of forBen) {
            expect(op.id.replica).toBe('ada'); // ben already has everything else
            expect(op.id.counter).toBeGreaterThanOrEqual(versionOf(ben.version(), 'ada'));
          }
          expect(ada.changesSince(ada.version())).toEqual([]);
          ben.applyAll(forBen);
          ada.applyAll(ben.changesSince(ada.version()));
          expect(ada.toString()).toBe(ben.toString());
          expect(ada.pendingCount + ben.pendingCount).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('buffering', () => {
  it('holds ops until their dependencies arrive, in any order', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ops: Op[] = [];
    for (const ch of 'hello world') ops.push(ada.insert(ada.length, ch));
    ops.push(ada.delete(0, 6));
    const ben = new TextDoc({ replicaId: 'ben' });
    const statuses = [...ops].reverse().map((op) => ben.apply(op));
    expect(statuses.slice(0, -1).every((s) => s === 'buffered')).toBe(true);
    expect(statuses.at(-1)).toBe('applied');
    expect(ben.pendingCount).toBe(0);
    expect(ben.toString()).toBe('world');
  });

  it('ignores duplicates and keeps only the unseen tail of a longer resent run', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    const first = ada.insert(0, 'abc');
    expect(ben.apply(first)).toBe('applied');
    expect(ben.apply(first)).toBe('duplicate');
    ada.insert(3, 'def');
    // Regenerated from state, the two ops come back as one run "abcdef".
    const [run] = ada.changesSince({});
    expect(run).toMatchObject({ kind: 'insert', text: 'abcdef' });
    expect(ben.apply(run!)).toBe('applied');
    expect(ben.toString()).toBe('abcdef');
    expect(ben.version()).toEqual({ ada: 6 });
  });

  it('releases a long out-of-order backlog without quadratic work', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ops: Op[] = [];
    for (let i = 0; i < 20_000; i++) ops.push(ada.insert(i % 7 === 0 ? 0 : ada.length, 'x'));
    const ben = new TextDoc({ replicaId: 'ben' });
    const t0 = performance.now();
    for (let i = ops.length - 1; i >= 0; i--) ben.apply(ops[i]!);
    expect(ben.toString()).toBe(ada.toString());
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('rejects an update made for the other variant', () => {
    const max = new TextDoc({ replicaId: 'ada', variant: 'fugue-max' });
    const plain = new TextDoc({ replicaId: 'ben', variant: 'fugue' });
    max.insert(0, 'hi');
    expect(() => plain.applyUpdate(max.encodeChangesSince())).toThrow(/fugue-max/);
  });

  it('round-trips op lists through the binary encoding', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben-with-a-long-name' });
    const ops: Op[] = [ada.insert(0, 'Hello 🌍 \u{d800}x')];
    ben.applyAll(ops);
    ops.push(ben.insert(3, 'XYZ'), ben.delete(1, 4), ben.insert(0, '>'));
    expect(decodeUpdate(encodeUpdate(ops, 'fugue-max'))).toEqual({ variant: 'fugue-max', ops });
  });
});

describe('version vectors', () => {
  it('compare and merge pointwise, treating missing replicas as 0', () => {
    const a = { ada: 3, ben: 1 };
    const b = { ben: 2, cy: 0 };
    expect(dominates(a, b)).toBe(false);
    expect(dominates(mergeVersions(a, b), a)).toBe(true);
    expect(mergeVersions(a, b)).toEqual({ ada: 3, ben: 2, cy: 0 });
    expect(sameVersion({ ada: 1, ben: 0 }, { ada: 1 })).toBe(true);
    expect(versionOf({}, 'toString')).toBe(0);
  });
});
