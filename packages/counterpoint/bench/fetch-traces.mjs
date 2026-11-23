// Downloads real-world editing traces from Joseph Gentle's editing-traces
// repository (https://github.com/josephg/editing-traces) into bench/data/,
// which is gitignored. Pinned to a commit so results are reproducible.
//
// automerge-paper: keystrokes from writing the LaTeX source of Kleppmann &
//   Beresford's "A Conflict-Free Replicated JSON Datatype", originally from
//   https://github.com/automerge/automerge-perf (CC BY 4.0).
// seph-blog1: keystrokes from writing https://josephg.com/blog/crdts-go-brrr/
//   (CC BY 4.0).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '762fa6c51605c88a05ebe5c4b9d4540caca30b97';
const TRACES = ['automerge-paper', 'seph-blog1'];
const dir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(dir, { recursive: true });

for (const name of TRACES) {
  const file = join(dir, `${name}.json.gz`);
  if (existsSync(file)) {
    console.log(`${name}: already present`);
    continue;
  }
  const url = `https://raw.githubusercontent.com/josephg/editing-traces/${COMMIT}/sequential_traces/ascii_only/${name}.json.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  console.log(`${name}: ${bytes.length} bytes, sha256 ${sha}...`);
}
