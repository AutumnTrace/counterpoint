/**
 * Interleaving behaviour, checked three ways:
 *
 * 1. Definition 1 of the paper (forward non-interleaving), stated directly
 *    over random concurrent histories.
 * 2. "Typing sessions": groups of replicas type words at the same spot while
 *    partitioned from each other (forward, backward, with backspaces, one
 *    session spread over two replicas). Each word must come out in one piece.
 * 3. The worked examples from the paper's figures, including the one where
 *    Fugue and FugueMax disagree.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Variant } from '../src/ops.ts';
import { NAMES, actionArb, historyArb, idStr, runActions, type Action } from './helpers/arbitraries.ts';
import { Cluster, type DocLike } from './helpers/cluster.ts';
import { IMPLS, VARIANTS, type Impl } from './helpers/impls.ts';

type Key = string; // a single character, or 'BS' for backspace

interface SessionSpec {
  readonly members: number;
  readonly dir: 'forward' | 'backward';
  readonly keys: readonly Key[];
}

const ALPHABETS = ['abcdefgh', 'ABCDEFGH', '01234567'];

const sessionArb = (alphabetIndex: number) =>
  fc
    .record({
      members: fc.integer({ min: 1, max: 2 }),
      dir: fc.constantFrom('forward' as const, 'backward' as const),
      keys: fc.array(
        fc.oneof(
          { weight: 5, arbitrary: fc.constantFrom(...ALPHABETS[alphabetIndex]!) },
          { weight: 1, arbitrary: fc.constant('BS') },
        ),
        { minLength: 1, maxLength: 8 },
      ),
    })
    .map((s): SessionSpec => (s.dir === 'backward' ? { ...s, keys: s.keys.filter((k) => k !== 'BS') } : s));

/**
 * Runs a shared base history, then lets each session type at `at` while
 * isolated from the other sessions, then merges everything.
 * Returns the merged text plus what each session produced locally.
 */
function runSessions(impl: Impl, variant: Variant, base: readonly Action[], at: number, sessions: readonly SessionSpec[]) {
  const docs: DocLike[] = [impl.create('base0', variant), impl.create('base1', variant)];
  const membersOf: number[][] = [];
  sessions.forEach((s, g) => {
    const members: number[] = [];
    for (let m = 0; m < s.members; m++) {
      members.push(docs.length);
      docs.push(impl.create(`s${g}-${NAMES[m]}`, variant));
    }
    membersOf.push(members);
  });
  const cluster = new Cluster(docs);
  runActions(
    cluster,
    base.map((a) => ({ ...a, r: a.r % 2 })),
  );
  cluster.deliverAll();
  const baseText = docs[0]!.toString();
  const index = at % (baseText.length + 1);

  const words = sessions.map(() => '');
  const carets = sessions.map(() => index);
  const longest = Math.max(...sessions.map((s) => s.keys.length));
  for (let k = 0; k < longest; k++) {
    sessions.forEach((s, g) => {
      const key = s.keys[k];
      if (key === undefined) return;
      const group = membersOf[g]!;
      const r = group[k % group.length]!;
      // Bring this member up to date with its own group only.
      cluster.deliverAll([r], new Set(group));
      if (s.dir === 'backward') {
        cluster.insert(r, index, key);
        words[g] = key + words[g];
      } else if (key === 'BS') {
        if (carets[g]! > index) {
          cluster.delete(r, carets[g]! - 1, 1);
          carets[g]!--;
          words[g] = words[g]!.slice(0, -1);
        }
      } else {
        cluster.insert(r, carets[g]!, key);
        carets[g]!++;
        words[g] += key;
      }
    });
  }
  cluster.deliverAll();
  const texts = docs.map((d) => d.toString());
  return { texts, words, prefix: baseText.slice(0, index), suffix: baseText.slice(index) };
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Plays the paper's figures: each step is [replica, index, text] or a sync. */
function play(impl: Impl, variant: Variant, names: string[]) {
  const cluster = new Cluster(names.map((n) => impl.create(n, variant)));
  return {
    cluster,
    type(r: number, index: number, text: string) {
      // One keystroke per character, like a person typing.
      for (let i = 0; i < text.length; i++) cluster.insert(r, index + i, text[i]!);
    },
    /** Delivers to `r` everything that `from` has generated so far. */
    receive(r: number, from: number) {
      cluster.deliverAll([r], new Set([from]));
    },
    text: (r: number) => cluster.docs[r]!.toString(),
  };
}

describe.each(IMPLS)('$name', (impl) => {
  describe.each(VARIANTS)('%s', (variant) => {
    it('satisfies forward non-interleaving (Definition 1) on random histories', () => {
      fc.assert(
        fc.property(historyArb(2, 4, 60), ([n, actions]) => {
          const cluster = new Cluster(NAMES.slice(0, n).map((name) => impl.create(name, variant)));
          runActions(cluster, actions);
          cluster.deliverAll();
          const order = cluster.docs[0]!.idsInOrder().map(idStr);
          const pos = new Map(order.map((id, i) => [id, i]));
          // Earliest element (tombstones included) per left origin.
          const first = new Map<string, number>();
          for (const { op, leftOrigin } of cluster.log) {
            if (op.kind !== 'insert') continue;
            for (let k = 0; k < op.text.length; k++) {
              const lo = k === 0 ? idStr(leftOrigin) : `${op.id.replica}:${op.id.counter + k - 1}`;
              const p = pos.get(`${op.id.replica}:${op.id.counter + k}`)!;
              first.set(lo, Math.min(first.get(lo) ?? Infinity, p));
            }
          }
          // ...must sit immediately after that left origin.
          for (const [lo, p] of first) {
            expect(p, `first child of ${lo}`).toBe(lo === 'start' ? 0 : pos.get(lo)! + 1);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('never interleaves concurrent typing sessions at the same position', () => {
      fc.assert(
        fc.property(
          fc.array(actionArb(2), { maxLength: 25 }),
          fc.nat(),
          fc.integer({ min: 2, max: 3 }).chain((k) => fc.tuple(...Array.from({ length: k }, (_, g) => sessionArb(g)))),
          (base, at, sessions) => {
            const { texts, words, prefix, suffix } = runSessions(impl, variant, base, at, sessions);
            for (const t of texts) expect(t).toBe(texts[0]);
            const allowed = permutations(words).map((p) => prefix + p.join('') + suffix);
            expect(allowed).toContain(texts[0]);
          },
        ),
        { numRuns: 300 },
      );
    });

    it('figure 1: "eggs" and "bread" typed concurrently stay readable', () => {
      const p = play(impl, variant, ['alice', 'bob']);
      p.type(0, 0, 'milk\n');
      p.receive(1, 0);
      p.type(0, 5, 'eggs\n');
      p.type(1, 5, 'bread\n');
      p.receive(0, 1);
      p.receive(1, 0);
      expect(['milk\neggs\nbread\n', 'milk\nbread\neggs\n']).toContain(p.text(0));
      expect(p.text(1)).toBe(p.text(0));
    });

    it('figure 3: prepending list items (backward at line granularity)', () => {
      const p = play(impl, variant, ['alice', 'bob']);
      p.type(0, 0, 'Shopping\n');
      p.receive(1, 0);
      const at = 'Shopping\n'.length;
      for (const line of ['* bananas\n', '* apples\n', 'Fruit:\n']) p.type(0, at, line);
      for (const line of ['* cake\n', '* bread\n', 'Bakery:\n']) p.type(1, at, line);
      p.receive(0, 1);
      p.receive(1, 0);
      const fruit = 'Fruit:\n* apples\n* bananas\n';
      const bakery = 'Bakery:\n* bread\n* cake\n';
      expect([`Shopping\n${fruit}${bakery}`, `Shopping\n${bakery}${fruit}`]).toContain(p.text(0));
      expect(p.text(1)).toBe(p.text(0));
    });

    it('figure 6: the order AXBC is forced, so X and C cannot stay adjacent', () => {
      const p = play(impl, variant, ['r1', 'r2', 'r3']);
      p.type(0, 0, 'A');
      p.type(1, 0, 'B');
      p.type(2, 0, 'C');
      p.receive(0, 2);
      expect(p.text(0)).toBe('AC');
      p.type(0, 1, 'X');
      p.receive(0, 1);
      expect(p.text(0)).toBe('AXBC');
      p.cluster.deliverAll();
      for (let r = 0; r < 3; r++) expect(p.text(r)).toBe('AXBC');
    });
  });
});

describe.each(IMPLS)('$name: figure 7, where Fugue and FugueMax differ', (impl) => {
  // Replicas a, b, c insert A, B, C concurrently (ordered by id: A < B < C).
  // c sees A and inserts X between A and C; b sees A and inserts Y between
  // A and B. X and Y are right children of A with different right origins.
  function run(variant: Variant) {
    const p = play(impl, variant, ['a', 'b', 'c']);
    p.type(0, 0, 'A');
    p.type(1, 0, 'B');
    p.type(2, 0, 'C');
    p.receive(2, 0);
    expect(p.text(2)).toBe('AC');
    p.type(2, 1, 'X');
    p.receive(1, 0);
    expect(p.text(1)).toBe('AB');
    p.type(1, 1, 'Y');
    p.cluster.deliverAll();
    const texts = p.cluster.docs.map((d) => d.toString());
    expect(new Set(texts).size).toBe(1);
    return texts[0];
  }

  it('FugueMax keeps Y next to its right origin B: AXYBC (the unique maximal order)', () => {
    expect(run('fugue-max')).toBe('AXYBC');
  });

  it('Fugue orders the siblings X, Y by id instead: AYXBC', () => {
    expect(run('fugue')).toBe('AYXBC');
  });
});
