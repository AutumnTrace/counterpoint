/**
 * Binary encoding for updates (lists of ops) and version vectors.
 *
 * Everything is built from unsigned LEB128 varints, zigzag varints for
 * signed deltas, and strings stored as a length plus one varint per UTF-16
 * code unit (one byte per ASCII character, and lossless for any string,
 * including lone surrogates). Each message starts with a 5-byte header:
 * "cp", the format version, the message kind and the Fugue variant.
 *
 * Ids inside a message refer to replicas through a per-message table, and
 * counters that point at other elements are stored relative to the op's own
 * counter, which keeps them to a byte or two in practice.
 */
import type { Id, IdRange, ReplicaId } from './id.ts';
import type { DeleteOp, InsertOp, Op, Variant } from './ops.ts';
import type { VersionVector } from './version.ts';

export const FORMAT_VERSION = 1;

export const MESSAGE_KINDS = {
  update: 1,
  snapshot: 2,
  version: 3,
} as const;
export type MessageKind = keyof typeof MESSAGE_KINDS;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

// ------------------------------------------------------------------ bytes

export class Writer {
  private buf = new Uint8Array(256);
  private pos = 0;

  byte(b: number): void {
    if (this.pos === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.pos++] = b;
  }

  /** Unsigned LEB128, valid for any safe integer >= 0. */
  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`cannot encode ${n} as an unsigned varint`);
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }

  /** Zigzag: 0, -1, 1, -2, 2 ... map to 0, 1, 2, 3, 4 ... */
  int(n: number): void {
    this.uint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  str(s: string): void {
    this.uint(s.length);
    for (let i = 0; i < s.length; i++) this.uint(s.charCodeAt(i));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class Reader {
  private pos = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  byte(): number {
    if (this.pos >= this.bytes.length) throw new DecodeError('unexpected end of input');
    return this.bytes[this.pos++]!;
  }

  uint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (b < 0x80) break;
      scale *= 0x80;
      if (scale > Number.MAX_SAFE_INTEGER) throw new DecodeError('varint too long');
    }
    if (!Number.isSafeInteger(result)) throw new DecodeError('varint out of range');
    return result;
  }

  int(): number {
    const u = this.uint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  /** A count that must be plausible given the bytes left (each item >= `minBytes`). */
  count(minBytes = 1): number {
    const n = this.uint();
    if (n * minBytes > this.remaining) throw new DecodeError(`count ${n} exceeds the remaining input`);
    return n;
  }

  str(): string {
    const n = this.count();
    const units: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const u = this.uint();
      if (u > 0xffff) throw new DecodeError('code unit out of range');
      units[i] = u;
    }
    // fromCharCode takes arguments, so build long strings in slices.
    let s = '';
    for (let i = 0; i < n; i += 8192) s += String.fromCharCode(...units.slice(i, i + 8192));
    return s;
  }

  end(): void {
    if (this.pos !== this.bytes.length) throw new DecodeError(`${this.bytes.length - this.pos} trailing bytes`);
  }
}

// ----------------------------------------------------------------- header

const VARIANT_CODES: Record<Variant, number> = { fugue: 0, 'fugue-max': 1 };

export function writeHeader(w: Writer, kind: MessageKind, variant: Variant): void {
  w.byte(0x63); // 'c'
  w.byte(0x70); // 'p'
  w.byte(FORMAT_VERSION);
  w.byte(MESSAGE_KINDS[kind]);
  w.byte(VARIANT_CODES[variant]);
}

export function readHeader(r: Reader, kind: MessageKind): Variant {
  if (r.byte() !== 0x63 || r.byte() !== 0x70) throw new DecodeError('not a counterpoint message');
  const version = r.byte();
  if (version !== FORMAT_VERSION) throw new DecodeError(`unsupported format version ${version}`);
  const k = r.byte();
  if (k !== MESSAGE_KINDS[kind]) throw new DecodeError(`expected a ${kind} message, got kind ${k}`);
  const v = r.byte();
  if (v === 0) return 'fugue';
  if (v === 1) return 'fugue-max';
  throw new DecodeError(`unknown variant ${v}`);
}

// ---------------------------------------------------------- replica table

export class ReplicaTable {
  readonly names: ReplicaId[] = [];
  private readonly index = new Map<ReplicaId, number>();

  add(replica: ReplicaId): number {
    let i = this.index.get(replica);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(replica);
      this.index.set(replica, i);
    }
    return i;
  }

  get(replica: ReplicaId): number {
    const i = this.index.get(replica);
    if (i === undefined) throw new Error(`replica ${replica} missing from table`);
    return i;
  }

  write(w: Writer): void {
    w.uint(this.names.length);
    for (const name of this.names) w.str(name);
  }

  static read(r: Reader): ReplicaId[] {
    const n = r.count();
    const names: ReplicaId[] = [];
    for (let i = 0; i < n; i++) names.push(r.str());
    if (new Set(names).size !== names.length) throw new DecodeError('duplicate replica in table');
    return names;
  }
}

export function readReplica(r: Reader, names: readonly ReplicaId[]): ReplicaId {
  const i = r.uint();
  if (i >= names.length) throw new DecodeError(`replica index ${i} out of range`);
  return names[i]!;
}

/** A non-negative counter stored relative to `base`. */
export function readCounter(r: Reader, base: number): number {
  const c = base + r.int();
  if (c < 0 || !Number.isSafeInteger(c)) throw new DecodeError(`counter ${c} out of range`);
  return c;
}

/// ---------------------------------------------------------------- updates
//
// An update is a list of records. Each starts with a flags byte whose low
// two bits give the record kind:
//   0 insert       bit 2 = left side, bits 3-4 = parent mode, bits 5-6 = origin mode
//   1 delete       any delete op
//   2 delete run   k >= 2 consecutive single-character deletes from one
//                  replica whose targets step by +1 or -1 (forward delete or
//                  backspace), which is most of them when catching up
// then the replica index and the counter, stored as a zigzag delta from
// where that replica's previous record in the same update ended.

const INSERT = 0;
const DELETE = 1;
const DELETE_RUN = 2;
const PARENT_ROOT = 0;
const PARENT_PREVIOUS_CHAR = 1; // same replica, counter - 1: continuing to type
const PARENT_EXPLICIT = 2;
const ORIGIN_END = 0;
const ORIGIN_PARENT = 1;
const ORIGIN_EXPLICIT = 2;

/** A delete op of exactly one character: the shape delete runs are made of. */
function singleTarget(op: Op): IdRange | null {
  if (op.kind !== 'delete' || op.targets.length !== 1 || op.targets[0]!.length !== 1) return null;
  return op.targets[0]!;
}

/** Length of the delete run starting at ops[i] (1 if there is none). */
function deleteRunLength(ops: readonly Op[], i: number): number {
  const first = singleTarget(ops[i]!);
  if (first === null) return 1;
  let step = 0;
  let k = 1;
  for (; i + k < ops.length; k++) {
    const prev = ops[i + k - 1]!;
    const op = ops[i + k]!;
    const t = singleTarget(op);
    if (t === null || op.id.replica !== prev.id.replica || op.id.counter !== prev.id.counter + 1) break;
    if (t.replica !== first.replica) break;
    const d = t.counter - singleTarget(prev)!.counter;
    if ((d !== 1 && d !== -1) || (step !== 0 && d !== step)) break;
    step = d;
  }
  return k;
}

/**
 * Encodes ops as one self-contained message. Snapshots use the same layout
 * with a different kind byte, so one cannot be mistaken for the other.
 */
export function encodeUpdate(ops: readonly Op[], variant: Variant, kind: 'update' | 'snapshot' = 'update'): Uint8Array {
  const table = new ReplicaTable();
  for (const op of ops) {
    table.add(op.id.replica);
    if (op.kind === 'insert') {
      if (op.parent) table.add(op.parent.replica);
      if (op.rightOrigin) table.add(op.rightOrigin.replica);
    } else {
      for (const t of op.targets) table.add(t.replica);
    }
  }
  const records: [start: number, length: number][] = [];
  for (let i = 0; i < ops.length; ) {
    const k = deleteRunLength(ops, i);
    records.push([i, k]);
    i += k;
  }

  const w = new Writer();
  writeHeader(w, kind, variant);
  table.write(w);
  w.uint(records.length);
  const expected = new Array<number>(table.names.length).fill(0);
  for (const [start, k] of records) {
    const op = ops[start]!;
    const { replica, counter } = op.id;
    const ri = table.get(replica);
    const head = (flags: number) => {
      w.byte(flags);
      w.uint(ri);
      w.int(counter - expected[ri]!);
      expected[ri] = counter + (op.kind === 'insert' ? op.text.length : k);
    };
    if (op.kind === 'delete') {
      if (k > 1) {
        const t0 = op.targets[0]!;
        head(DELETE_RUN);
        w.uint(k);
        writeRef(w, table, t0, counter);
        w.byte(singleTarget(ops[start + 1]!)!.counter - t0.counter === 1 ? 0 : 1);
        continue;
      }
      head(DELETE);
      w.uint(op.targets.length);
      for (const t of op.targets) {
        writeRef(w, table, t, counter);
        w.uint(t.length);
      }
      continue;
    }
    const p = op.parent;
    const parentMode =
      p === null ? PARENT_ROOT : p.replica === replica && p.counter === counter - 1 ? PARENT_PREVIOUS_CHAR : PARENT_EXPLICIT;
    const ro = op.rightOrigin;
    const originMode =
      ro === null ? ORIGIN_END : p !== null && ro.replica === p.replica && ro.counter === p.counter ? ORIGIN_PARENT : ORIGIN_EXPLICIT;
    head(INSERT | (op.side === 'left' ? 4 : 0) | (parentMode << 3) | (originMode << 5));
    if (parentMode === PARENT_EXPLICIT) writeRef(w, table, p!, counter);
    if (originMode === ORIGIN_EXPLICIT) writeRef(w, table, ro!, counter);
    w.str(op.text);
  }
  return w.finish();
}

function writeRef(w: Writer, table: ReplicaTable, id: Id, base: number): void {
  w.uint(table.get(id.replica));
  w.int(id.counter - base);
}

function readRef(r: Reader, names: readonly ReplicaId[], base: number): Id {
  const replica = readReplica(r, names);
  return { replica, counter: readCounter(r, base) };
}

export function decodeUpdate(bytes: Uint8Array, kind: 'update' | 'snapshot' = 'update'): { variant: Variant; ops: Op[] } {
  const r = new Reader(bytes);
  const variant = readHeader(r, kind);
  const names = ReplicaTable.read(r);
  const n = r.count(3);
  const expected = new Array<number>(names.length).fill(0);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const flags = r.byte();
    const kind = flags & 3;
    const ri = r.uint();
    if (ri >= names.length) throw new DecodeError(`replica index ${ri} out of range`);
    const replica = names[ri]!;
    const counter = readCounter(r, expected[ri]!);
    if (kind === DELETE_RUN) {
      if (flags !== DELETE_RUN) throw new DecodeError('bad delete-run flags');
      const k = r.uint();
      // Each folded delete expands to a small object; cap the expansion so
      // a few corrupt bytes cannot ask for billions of them.
      if (k < 2 || k > 1_000_000) throw new DecodeError('bad delete-run length');
      const t0 = readRef(r, names, counter);
      const step = r.byte() === 0 ? 1 : -1;
      if (t0.counter + step * (k - 1) < 0) throw new DecodeError('delete run goes below zero');
      for (let j = 0; j < k; j++) {
        ops.push({
          kind: 'delete',
          id: { replica, counter: counter + j },
          targets: [{ replica: t0.replica, counter: t0.counter + step * j, length: 1 }],
        } satisfies DeleteOp);
      }
      expected[ri] = counter + k;
      continue;
    }
    const id: Id = { replica, counter };
    if (kind === DELETE) {
      if (flags !== DELETE) throw new DecodeError('bad delete flags');
      const k = r.count(3);
      const targets: IdRange[] = [];
      for (let j = 0; j < k; j++) {
        const t = readRef(r, names, counter);
        const length = r.uint();
        if (length === 0) throw new DecodeError('empty delete target');
        targets.push({ replica: t.replica, counter: t.counter, length });
      }
      ops.push({ kind: 'delete', id, targets } satisfies DeleteOp);
      expected[ri] = counter + 1;
      continue;
    }
    if (kind !== INSERT || flags & 0x80) throw new DecodeError('bad insert flags');
    const side = flags & 4 ? 'left' : 'right';
    const parentMode = (flags >> 3) & 3;
    const originMode = (flags >> 5) & 3;
    let parent: Id | null;
    if (parentMode === PARENT_ROOT) parent = null;
    else if (parentMode === PARENT_PREVIOUS_CHAR) {
      if (counter === 0) throw new DecodeError('no previous character');
      parent = { replica, counter: counter - 1 };
    } else if (parentMode === PARENT_EXPLICIT) parent = readRef(r, names, counter);
    else throw new DecodeError('bad parent mode');
    let rightOrigin: Id | null;
    if (originMode === ORIGIN_END) rightOrigin = null;
    else if (originMode === ORIGIN_PARENT) {
      if (parent === null) throw new DecodeError('right origin cannot be the root');
      rightOrigin = parent;
    } else if (originMode === ORIGIN_EXPLICIT) rightOrigin = readRef(r, names, counter);
    else throw new DecodeError('bad right-origin mode');
    const text = r.str();
    if (text.length === 0) throw new DecodeError('empty insert');
    ops.push({ kind: 'insert', id, text, parent, side, rightOrigin } satisfies InsertOp);
    expected[ri] = counter + text.length;
  }
  r.end();
  return { variant, ops };
}

// --------------------------------------------------------- version vectors

export function encodeVersion(vv: VersionVector, variant: Variant): Uint8Array {
  const w = new Writer();
  writeHeader(w, 'version', variant);
  const entries = Object.entries(vv).filter(([, n]) => n > 0);
  w.uint(entries.length);
  for (const [replica, n] of entries) {
    w.str(replica);
    w.uint(n);
  }
  return w.finish();
}

export function decodeVersion(bytes: Uint8Array): { variant: Variant; version: VersionVector } {
  const r = new Reader(bytes);
  const variant = readHeader(r, 'version');
  const n = r.count(2);
  const version: Record<ReplicaId, number> = Object.create(null);
  for (let i = 0; i < n; i++) {
    const replica = r.str();
    if (Object.hasOwn(version, replica)) throw new DecodeError('duplicate replica in version');
    version[replica] = r.uint();
  }
  r.end();
  return { variant, version };
}
