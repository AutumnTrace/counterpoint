import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DecodeError, decodeVersion, encodeVersion } from '../src/encoding.ts';
import { TextDoc } from '../src/text-doc.ts';
import { NAMES, idStr } from './helpers/arbitraries.ts';
import { VARIANTS } from './helpers/impls.ts';
import { Net, netActionArb } from './helpers/net.ts';

const historyArb = fc
  .integer({ min: 1, max: 3 })
  .chain((n) => fc.tuple(fc.constant(n), fc.array(netActionArb(n), { maxLength: 100, size: 'max' })));

function state(doc: TextDoc) {
  return {
    text: doc.toString(),
    order: doc.idsInOrder().map(idStr).join(' '),
    version: { ...doc.version() },
    log: doc.changesSince({}),
  };
}

describe.each(VARIANTS)('snapshots (%s)', (variant) => {
  it('save -> load reproduces the document, its log, and the same bytes', () => {
    fc.assert(
      fc.property(historyArb, fc.boolean(), ([n, actions], heal) => {
        const net = new Net(NAMES.slice(0, n).map((r) => new TextDoc({ replicaId: r, variant })));
        net.run(actions);
        if (heal) net.heal();
        for (const doc of net.docs) {
          const bytes = doc.save();
          const loaded = TextDoc.load(bytes, { replicaId: doc.replicaId });
          expect(loaded.variant).toBe(variant);
          expect(state(loaded)).toEqual(state(doc));
          expect(loaded.save()).toEqual(bytes);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a reloaded replica keeps editing and syncing as if nothing happened', () => {
    fc.assert(
      fc.property(historyArb, fc.array(netActionArb(3), { maxLength: 60, size: 'max' }), ([n, before], after) => {
        const net = new Net(NAMES.slice(0, n).map((r) => new TextDoc({ replicaId: r, variant })));
        net.run(before);
        // Every replica restarts from its own snapshot (messages in flight survive).
        net.docs.forEach((d, i) => (net.docs[i] = TextDoc.load(d.save(), { replicaId: d.replicaId })));
        net.run(after.map((a) => ('r' in a ? { ...a, r: a.r % n } : 'a' in a ? { ...a, a: a.a % n, b: a.b % n } : a)));
        net.heal();
        for (const d of net.docs) expect(d.toString()).toBe(net.docs[0]!.toString());
      }),
      { numRuns: 150 },
    );
  });
});

describe('snapshot decoding', () => {
  const sample = () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    ben.applyAll([ada.insert(0, 'hello world'), ada.delete(0, 1)]);
    ada.applyAll([ben.insert(5, ', brave new'), ben.delete(1, 2), ben.insert(0, 'H')]);
    ada.insert(ada.length, '!');
    return ada.save();
  };

  it('rejects every truncation with a DecodeError', () => {
    const bytes = sample();
    for (let len = 0; len < bytes.length; len++) {
      expect(() => TextDoc.load(bytes.slice(0, len)), `truncated to ${len}`).toThrow(DecodeError);
    }
  });

  it('either rejects a corrupted byte cleanly or loads a self-consistent document', () => {
    const bytes = sample();
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [1, 0x40, 0xff]) {
        const bad = bytes.slice();
        bad[i] = bad[i]! ^ flip;
        let doc: TextDoc;
        try {
          doc = TextDoc.load(bad);
        } catch (e) {
          if (!(e instanceof DecodeError)) throw new Error(`byte ${i} ^ ${flip}: ${String(e)}`);
          continue;
        }
        // Whatever loaded must still behave: save again, reload, edit.
        expect(TextDoc.load(doc.save()).toString()).toBe(doc.toString());
        doc.insert(0, 'x');
      }
    }
  });

  it('rejects a snapshot of the other variant when one is requested', () => {
    const doc = new TextDoc({ variant: 'fugue' });
    doc.insert(0, 'abc');
    expect(() => TextDoc.load(doc.save(), { variant: 'fugue-max' })).toThrow(/fugue/);
    expect(TextDoc.load(doc.save()).variant).toBe('fugue');
  });

  it('encodes version vectors', () => {
    const vv = JSON.parse('{"ada": 3, "ben with spaces": 1000000, "__proto__": 7}') as Record<string, number>;
    const doc = new TextDoc();
    const back = decodeVersion(encodeVersion(vv, 'fugue-max')).version;
    expect(Object.entries(back)).toEqual(Object.entries(vv));
    expect(decodeVersion(doc.encodeVersion()).version).toEqual({});
  });
});
