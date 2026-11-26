/**
 * What a retained delete costs in memory.
 *
 *   node --expose-gc bench/delete-log.ts
 *
 * Types N characters one keystroke at a time, then removes them again with
 * N single-character deletes (backspace, or forward delete). The baseline is
 * the same N characters removed by one delete op. Both leave the same
 * tombstones, so the heap difference is the delete log: N - 1 more entries.
 * Measured for the replica that made the edits and for one that received
 * them as an update (decoded ops, nothing else holding on to them).
 */
import { decodeUpdate, encodeUpdate } from '../src/encoding.ts';
import type { Op } from '../src/ops.ts';
import { TextDoc } from '../src/text-doc.ts';

const N = 100_000;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');

function heapUsed(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

type Removal = 'backspace' | 'forward delete' | 'one delete op';

function edit(removal: Removal): { doc: TextDoc; ops: Op[] } {
  const doc = new TextDoc({ replicaId: 'author' });
  const ops: Op[] = [];
  for (let i = 0; i < N; i++) ops.push(doc.insert(i, 'x'));
  if (removal === 'one delete op') ops.push(doc.delete(0, N));
  else for (let i = N - 1; i >= 0; i--) ops.push(doc.delete(removal === 'backspace' ? i : 0, 1));
  if (doc.length !== 0) throw new Error('not everything was deleted');
  return { doc, ops };
}

/** Heap held by a document built by `build`, which must not keep anything else alive. */
function measure(build: () => TextDoc): number {
  const before = heapUsed();
  let doc: TextDoc | null = build();
  const after = heapUsed();
  if (doc.elementCount !== N) throw new Error('unexpected element count');
  doc = null;
  return after - before;
}

const local = (removal: Removal) => measure(() => edit(removal).doc);
const remote = (removal: Removal) => {
  const update = encodeUpdate(edit(removal).ops, 'fugue-max');
  return measure(() => {
    const doc = new TextDoc({ replicaId: 'reader' });
    doc.applyAll(decodeUpdate(update).ops);
    return doc;
  });
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
const runs = 5;

console.log(`# delete log memory, ${fmt(N)} characters, node ${process.version}, median of ${runs}`);
console.log('| replica | removal | heap | bytes per extra delete |');
console.log('|---|---|--:|--:|');
for (const [name, fn] of [
  ['editing', local],
  ['receiving', remote],
] as const) {
  const base = median(Array.from({ length: runs }, () => fn('one delete op')));
  console.log(`| ${name} | one delete op | ${fmt(base)} B | |`);
  for (const removal of ['backspace', 'forward delete'] as const) {
    const heap = median(Array.from({ length: runs }, () => fn(removal)));
    console.log(`| ${name} | ${removal} | ${fmt(heap)} B | ${fmt((heap - base) / (N - 1))} |`);
  }
}
