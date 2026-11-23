/**
 * Replays real editing traces and reports throughput and memory.
 *
 *   node bench/fetch-traces.mjs          # once
 *   node --expose-gc bench/trace.ts      # all measurements
 *   node --expose-gc bench/trace.ts --quick
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Op } from '../src/ops.ts';
import { SimpleFugue } from '../src/reference/simple-fugue.ts';
import { TextDoc } from '../src/text-doc.ts';

type Patch = [pos: number, del: number, ins: string];
interface Trace {
  readonly name: string;
  readonly patches: Patch[];
  readonly endContent: string;
}

interface Editable {
  insert(index: number, text: string): Op;
  delete(index: number, length: number): Op;
  toString(): string;
}

const quick = process.argv.includes('--quick');
const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
const gc = (globalThis as { gc?: () => void }).gc;

function loadTrace(name: string): Trace {
  const raw = JSON.parse(gunzipSync(readFileSync(join(dataDir, `${name}.json.gz`))).toString('utf8')) as {
    endContent: string;
    txns: { patches: Patch[] }[];
  };
  return { name, patches: raw.txns.flatMap((t) => t.patches), endContent: raw.endContent };
}

function replay(doc: Editable, patches: readonly Patch[], limit = patches.length, ops?: Op[]): void {
  for (let i = 0; i < limit; i++) {
    const [pos, del, ins] = patches[i]!;
    if (del > 0) {
      const op = doc.delete(pos, del);
      ops?.push(op);
    }
    if (ins.length > 0) {
      const op = doc.insert(pos, ins);
      ops?.push(op);
    }
  }
}

/** Median and minimum wall time of `runs` measured calls after `warmup` unmeasured ones. */
function time(fn: () => void, warmup: number, runs: number): { median: number; min: number } {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    gc?.();
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)]!, min: samples[0]! };
}

function heapUsed(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

const fmt = (n: number, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const mb = (bytes: number) => `${fmt(bytes / 1024 / 1024, 1)} MB`;

function benchTrace(trace: Trace): void {
  const { patches } = trace;
  const inserted = patches.reduce((n, p) => n + p[2].length, 0);
  const deleted = patches.reduce((n, p) => n + p[1], 0);
  console.log(`\n## ${trace.name}`);
  console.log(`${fmt(patches.length)} patches, ${fmt(inserted)} chars inserted, ${fmt(deleted)} deleted, final length ${fmt(trace.endContent.length)}`);

  // Correctness first: the replay must reproduce the trace's final text.
  const ops: Op[] = [];
  const doc = new TextDoc({ replicaId: 'author' });
  replay(doc, patches, patches.length, ops);
  if (doc.toString() !== trace.endContent) throw new Error(`${trace.name}: final text does not match endContent`);

  const warmup = quick ? 1 : 3;
  const runs = quick ? 3 : 9;

  const local = time(() => replay(new TextDoc({ replicaId: 'author' }), patches), warmup, runs);
  console.log(`local replay      ${fmt(local.median, 1)} ms median (min ${fmt(local.min, 1)}) = ${fmt(patches.length / (local.median / 1000))} patches/s`);

  const remote = time(
    () => {
      const replica = new TextDoc({ replicaId: 'reader' });
      for (const op of ops) replica.apply(op);
    },
    warmup,
    runs,
  );
  const check = new TextDoc({ replicaId: 'reader' });
  for (const op of ops) check.apply(op);
  if (check.toString() !== trace.endContent) throw new Error(`${trace.name}: remote replay diverged`);
  console.log(`remote apply      ${fmt(remote.median, 1)} ms median (min ${fmt(remote.min, 1)}) for ${fmt(ops.length)} ops = ${fmt(ops.length / (remote.median / 1000))} ops/s`);

  if (gc) {
    const before = heapUsed();
    let kept: TextDoc | null = new TextDoc({ replicaId: 'author' });
    replay(kept, patches);
    const after = heapUsed();
    const elements = kept.idsInOrder().length;
    console.log(`memory            ${mb(after - before)} heap for ${fmt(elements)} elements (${fmt((after - before) / elements)} bytes/element)`);
    kept = null;
  } else {
    console.log('memory            (run with --expose-gc to measure)');
  }
}

/** Shows why the index structure matters: the paper's literal algorithm on trace prefixes. */
function benchSimple(trace: Trace): void {
  console.log(`\n## O(n) reference vs indexed, ${trace.name} prefixes`);
  console.log('| patches | SimpleFugue | TextDoc |');
  console.log('|--:|--:|--:|');
  const sizes = quick ? [2_500, 5_000] : [2_500, 5_000, 10_000, 20_000, 40_000];
  for (const n of sizes) {
    const slow = time(() => replay(new SimpleFugue('author'), trace.patches, n), 0, quick || n >= 20_000 ? 1 : 3);
    const fast = time(() => replay(new TextDoc({ replicaId: 'author' }), trace.patches, n), 1, 5);
    console.log(`| ${fmt(n)} | ${fmt(slow.median, 1)} ms | ${fmt(fast.median, 2)} ms |`);
  }
}

console.log(`# counterpoint trace benchmark`);
console.log(`node ${process.version}, ${cpus()[0]?.model.trim()}, ${quick ? 'quick mode' : 'full mode'}`);
const main = loadTrace('automerge-paper');
benchTrace(main);
benchTrace(loadTrace('seph-blog1'));
benchSimple(main);
benchConcurrent();

/**
 * Concurrency stress: two replicas each type `n` characters, one keystroke
 * at a time, at the same position while partitioned; then each applies the
 * other's ops. Placing the second run next to the first means walking the
 * first run's right-child chain once, so this is where the O(depth) part of
 * remote integration shows up.
 */
function benchConcurrent(): void {
  console.log('\n## Concurrent typing at one spot, then merge');
  console.log('| chars per side | merge, both directions (median) |');
  console.log('|--:|--:|');
  for (const n of quick ? [10_000] : [10_000, 50_000, 100_000]) {
    const samples: number[] = [];
    for (let run = 0; run < (quick ? 2 : 5); run++) {
      const a = new TextDoc({ replicaId: 'ada' });
      const b = new TextDoc({ replicaId: 'ben' });
      b.apply(a.insert(0, '>')); // typing after the last char: both runs are right children of '>'
      const opsA: Op[] = [];
      const opsB: Op[] = [];
      for (let i = 0; i < n; i++) opsA.push(a.insert(1 + i, 'a'));
      for (let i = 0; i < n; i++) opsB.push(b.insert(1 + i, 'b'));
      gc?.();
      const t0 = performance.now();
      for (const op of opsB) a.apply(op);
      for (const op of opsA) b.apply(op);
      samples.push(performance.now() - t0);
      if (a.toString() !== b.toString()) throw new Error('concurrent merge diverged');
    }
    samples.sort((x, y) => x - y);
    console.log(`| ${fmt(n)} | ${fmt(samples[samples.length >> 1]!, 1)} ms |`);
  }
}
