/**
 * A deliberately naive list CRDT, kept only as a foil for Fugue in tests and
 * in the playground's side-by-side comparison. Do not use it for anything.
 *
 * It is a stripped-down Logoot: every character gets an identifier from a
 * dense, totally ordered space (a path of digits, each tagged with the
 * replica and counter that created it), and the document is the characters
 * sorted by identifier. New identifiers are chosen deterministically just
 * after the left neighbour. It converges, but two replicas typing at the
 * same spot pick the same digits for their first, second, third character,
 * so the replica tie-break alternates them: "eggs" and "bread" merge into
 * something like "ebgrgesad" (figure 1 of the Fugue paper).
 */

const BASE = 1n << 16n;

/** One level of an identifier. */
export interface Atom {
  readonly digit: number;
  readonly replica: string;
  readonly counter: number;
}

export type NaiveId = readonly Atom[];

export type NaiveOp =
  | { readonly kind: 'insert'; readonly id: NaiveId; readonly char: string }
  | { readonly kind: 'delete'; readonly id: NaiveId };

const BEGIN: NaiveId = [{ digit: 0, replica: '', counter: 0 }];
const END: NaiveId = [{ digit: Number(BASE - 1n), replica: '', counter: 0 }];

export function compareNaiveIds(a: NaiveId, b: NaiveId): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.digit !== y.digit) return x.digit - y.digit;
    if (x.replica !== y.replica) return x.replica < y.replica ? -1 : 1;
    if (x.counter !== y.counter) return x.counter - y.counter;
  }
  return a.length - b.length;
}

/** The first `n` digits of `id` as one base-2^16 number, padded with zeros. */
function prefix(id: NaiveId, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; i++) v = v * BASE + BigInt(i < id.length ? id[i]!.digit : 0);
  return v;
}

const key = (id: NaiveId) => id.map((a) => `${a.digit}.${a.replica}.${a.counter}`).join('/');

interface Entry {
  readonly id: NaiveId;
  readonly char: string;
}

export class NaiveDoc {
  readonly replicaId: string;
  private readonly entries: Entry[] = [];
  private readonly removed = new Set<string>();
  private counter = 0;

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  get length(): number {
    return this.entries.length;
  }

  toString(): string {
    return this.entries.map((e) => e.char).join('');
  }

  /** The replica that typed the character at `index`. */
  authorAt(index: number): string {
    const id = this.entries[index]!.id;
    return id[id.length - 1]!.replica;
  }

  insert(index: number, text: string): NaiveOp[] {
    const ops: NaiveOp[] = [];
    for (let k = 0; k < text.length; k++) {
      const p = index + k === 0 ? BEGIN : this.entries[index + k - 1]!.id;
      const q = index + k === this.entries.length ? END : this.entries[index + k]!.id;
      const op: NaiveOp = { kind: 'insert', id: this.allocate(p, q), char: text[k]! };
      this.apply(op);
      ops.push(op);
    }
    return ops;
  }

  delete(index: number, length = 1): NaiveOp[] {
    const ops = this.entries.slice(index, index + length).map((e): NaiveOp => ({ kind: 'delete', id: e.id }));
    for (const op of ops) this.apply(op);
    return ops;
  }

  /** Idempotent, and works in any order (a delete that arrives first wins). */
  apply(op: NaiveOp): void {
    const k = key(op.id);
    const i = this.search(op.id);
    const found = i < this.entries.length && compareNaiveIds(this.entries[i]!.id, op.id) === 0;
    if (op.kind === 'delete') {
      this.removed.add(k);
      if (found) this.entries.splice(i, 1);
    } else if (!found && !this.removed.has(k)) {
      this.entries.splice(i, 0, { id: op.id, char: op.char });
    }
  }

  /** First index whose id is >= `id`. */
  private search(id: NaiveId): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareNaiveIds(this.entries[mid]!.id, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Logoot's allocation with the randomness taken out: find the shortest
   * prefix length with room between p and q, take the smallest digit
   * sequence after p's, and reuse p's or q's atoms where the digits match
   * so the new id still sorts between them. The last atom is always this
   * replica's, which keeps ids unique (its digit never equals p's there).
   */
  private allocate(p: NaiveId, q: NaiveId): NaiveId {
    let n = 0;
    let gap = 0n;
    while (gap < 1n) {
      n++;
      gap = prefix(q, n) - prefix(p, n) - 1n;
    }
    let r = prefix(p, n) + 1n;
    const digits: number[] = [];
    for (let i = 0; i < n; i++) {
      digits.unshift(Number(r % BASE));
      r /= BASE;
    }
    const counter = ++this.counter;
    return digits.map((digit, i): Atom => {
      if (i === n - 1) return { digit, replica: this.replicaId, counter };
      if (i < p.length && p[i]!.digit === digit) return p[i]!;
      if (i < q.length && q[i]!.digit === digit) return q[i]!;
      return { digit, replica: this.replicaId, counter };
    });
  }
}
