import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Id } from '../src/id.ts';
import { MissingDependencyError, TextDoc, type Anchor, type TextChange } from '../src/text-doc.ts';
import { NAMES, historyArb, runActions } from './helpers/arbitraries.ts';
import { Cluster } from './helpers/cluster.ts';

function applyChanges(text: string, changes: readonly TextChange[]): string {
  for (const c of changes) {
    text = c.kind === 'insert' ? text.slice(0, c.index) + c.text + text.slice(c.index) : text.slice(0, c.index) + text.slice(c.index + c.length);
  }
  return text;
}

describe('TextDoc basics', () => {
  it('inserts and deletes like a string', () => {
    const doc = new TextDoc({ replicaId: 'ada' });
    doc.insert(0, 'hello world');
    doc.delete(5, 6);
    doc.insert(5, ', counterpoint');
    expect(doc.toString()).toBe('hello, counterpoint');
    expect(doc.length).toBe(19);
  });

  it('round-trips ops between replicas', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    ben.apply(ada.insert(0, 'Hello!'));
    const a = ada.insert(5, ' Ada');
    const b = ben.insert(5, ' Ben');
    ada.apply(b);
    ben.apply(a);
    expect(ada.toString()).toBe(ben.toString());
    expect(['Hello Ada Ben!', 'Hello Ben Ada!']).toContain(ada.toString());
  });

  it('buffers ops whose dependencies are missing', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    const first = ada.insert(0, 'abc');
    const second = ada.insert(3, 'd');
    expect(ben.apply(second)).toBe('buffered');
    expect(ben.pending()).toEqual([second]);
    expect(ben.toString()).toBe('');
    expect(ben.apply(first)).toBe('applied');
    expect(ben.pendingCount).toBe(0);
    expect(ben.toString()).toBe('abcd');
  });

  it('cannot resolve an anchor to a character it has never seen', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    ada.insert(0, 'abc');
    expect(() => new TextDoc().resolve(ada.anchor(2))).toThrow(MissingDependencyError);
  });

  it('rejects out-of-range edits', () => {
    const doc = new TextDoc();
    expect(() => doc.insert(1, 'x')).toThrow(RangeError);
    expect(() => doc.insert(0, '')).toThrow(RangeError);
    doc.insert(0, 'abc');
    expect(() => doc.delete(2, 2)).toThrow(RangeError);
    expect(() => doc.delete(0, 0)).toThrow(RangeError);
  });

  it('generates a random replica id when none is given', () => {
    const a = new TextDoc();
    const b = new TextDoc();
    expect(a.replicaId).toMatch(/^[0-9a-z]{8}$/);
    expect(a.replicaId).not.toBe(b.replicaId);
  });
});

describe('change events', () => {
  it('replaying the emitted changes reproduces the text, local and remote', () => {
    fc.assert(
      fc.property(historyArb(2, 3, 80), ([n, actions]) => {
        const docs = NAMES.slice(0, n).map((r) => new TextDoc({ replicaId: r }));
        const mirrors = docs.map(() => '');
        docs.forEach((d, i) => d.onChange((e) => (mirrors[i] = applyChanges(mirrors[i]!, e.changes))));
        const cluster = new Cluster(docs);
        runActions(cluster, actions);
        cluster.deliverAll();
        docs.forEach((d, i) => expect(mirrors[i]).toBe(d.toString()));
      }),
      { numRuns: 200 },
    );
  });

  it('reports origin and can be unsubscribed', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    const seen: string[] = [];
    const off = ben.onChange((e) => seen.push(e.origin));
    ben.insert(0, 'x');
    ben.apply(ada.insert(0, 'y'));
    off();
    ben.insert(0, 'z');
    expect(seen).toEqual(['local', 'remote']);
  });
});

describe('anchors', () => {
  it('keep pointing at the same character through concurrent edits', () => {
    fc.assert(
      fc.property(historyArb(2, 3, 60), historyArb(2, 3, 60), fc.nat(), fc.boolean(), ([n, before], [, after], at, left) => {
        const docs = NAMES.slice(0, n).map((r) => new TextDoc({ replicaId: r }));
        const cluster = new Cluster(docs);
        runActions(cluster, before);
        const doc = docs[0]!;
        const index = at % (doc.length + 1);
        const anchor: Anchor = doc.anchor(index, left ? 'left' : 'right');
        runActions(
          cluster,
          after.map((a) => ({ ...a, r: a.r % n })),
        );
        cluster.deliverAll();
        // Expected: count visible characters up to (left) or before (right) the anchored id.
        const visible = new Set(Array.from({ length: doc.length }, (_, i) => key(doc.idAt(i))));
        let expected = 0;
        if (anchor.id === null) expected = anchor.stick === 'left' ? 0 : doc.length;
        else {
          for (const id of doc.idsInOrder()) {
            const k = key(id);
            if (k === key(anchor.id)) {
              if (anchor.stick === 'left' && visible.has(k)) expected++;
              break;
            }
            if (visible.has(k)) expected++;
          }
        }
        expect(doc.resolve(anchor)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('a caret stays put when someone types at the same spot', () => {
    const ada = new TextDoc({ replicaId: 'ada' });
    const ben = new TextDoc({ replicaId: 'ben' });
    ben.apply(ada.insert(0, 'abcdef'));
    const caret = ada.anchor(3); // abc|def
    ada.apply(ben.insert(3, 'XY'));
    ada.apply(ben.insert(0, '>> '));
    expect(ada.toString()).toBe('>> abcXYdef');
    expect(ada.resolve(caret)).toBe(6); // >> abc|XYdef
    ada.apply(ben.delete(4, 2)); // remove "bc", including the anchored "c"
    expect(ada.toString()).toBe('>> aXYdef');
    expect(ada.resolve(caret)).toBe(4); // >> a|XYdef
  });
});

const key = (id: Id) => `${id.replica}:${id.counter}`;
