/**
 * The interleaving scenario: Ada is partitioned, she and Ben both type a
 * line at the end of the same list one keystroke at a time, and the network
 * heals. Afterwards the merged text is shown with each character coloured
 * by the replica that typed it.
 *
 * The same keystrokes are replayed on three replicas of the naive baseline
 * (dense position ids, see packages/counterpoint/src/baseline), which are
 * merged the same way, to show what Fugue is avoiding.
 */
import { TextDoc } from '@autumntrace/counterpoint';
import { NaiveDoc, type NaiveOp } from '@autumntrace/counterpoint/baseline';
import type { SimNetwork } from './network.ts';
import type { Peer } from './peer.ts';
import type { LogView } from './views/log-view.ts';

export const BASE = 'Shopping:\n- milk\n';
export const ADA_LINE = '- eggs\n';
export const BEN_LINE = '- bread\n';

export interface ScenarioContext {
  readonly peers: readonly Peer[];
  readonly net: SimNetwork;
  readonly log: LogView;
  /** Resets every replica to `text`, already shared by all of them. */
  reset(text: string): void;
  converged(): boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/** The keystrokes both sides make, in the order they are made. */
export function keystrokes(): { who: 'ada' | 'ben'; index: number; char: string }[] {
  const out: { who: 'ada' | 'ben'; index: number; char: string }[] = [];
  for (let i = 0; i < Math.max(ADA_LINE.length, BEN_LINE.length); i++) {
    if (i < ADA_LINE.length) out.push({ who: 'ada', index: BASE.length + i, char: ADA_LINE[i]! });
    if (i < BEN_LINE.length) out.push({ who: 'ben', index: BASE.length + i, char: BEN_LINE[i]! });
  }
  return out;
}

export interface ScenarioResult {
  readonly fugue: TextDoc;
  readonly naive: NaiveDoc;
}

export async function runScenario(ctx: ScenarioContext, keystrokeMs = 110): Promise<ScenarioResult> {
  const [ada, ben] = ctx.peers as [Peer, Peer, Peer];
  ctx.reset(BASE);
  // The baseline gets the same history: Cy wrote the list, everyone has it.
  const [nAda, nBen, nCy] = ['ada', 'ben', 'cy'].map((r) => new NaiveDoc(r)) as [NaiveDoc, NaiveDoc, NaiveDoc];
  for (const op of nCy.insert(0, BASE)) {
    nAda.apply(op);
    nBen.apply(op);
  }
  const naiveOps: NaiveOp[] = [];
  ctx.log.note('Scenario: Ada is cut off. She and Ben each add an item to the end of the list.');
  ctx.net.setLink(0, false); // Ada–Ben
  ctx.net.setLink(2, false); // Ada–Cy
  for (const k of keystrokes()) {
    (k.who === 'ada' ? ada : ben).typeAt(k.index, k.char);
    naiveOps.push(...(k.who === 'ada' ? nAda : nBen).insert(k.index, k.char));
    await sleep(keystrokeMs / 2);
  }
  await sleep(Math.max(400, ctx.net.latency + ctx.net.jitter));
  ctx.log.note('Healing: each side sends its version vector and gets back what it is missing.');
  ctx.net.setLink(0, true);
  ctx.net.setLink(2, true);
  await until(() => ctx.converged(), 20_000 + 6 * (ctx.net.latency + ctx.net.jitter));
  for (const d of [nAda, nBen, nCy]) for (const op of naiveOps) d.apply(op);
  return { fugue: ada.doc, naive: nAda };
}

/** Whether both new lines appear whole in `text`. */
export function keptWhole(text: string): boolean {
  return text.includes(ADA_LINE) && text.includes(BEN_LINE);
}

/** The document's text as HTML, each character coloured by its author. */
export function authoredHtml(chars: readonly { char: string; author: string }[]): string {
  const esc = (c: string) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c);
  let html = '';
  let open: string | null = null;
  for (const { char, author } of chars) {
    if (author !== open) {
      if (open !== null) html += '</span>';
      html += `<span class="c-${author}">`;
      open = author;
    }
    html += esc(char);
  }
  if (open !== null) html += '</span>';
  return html;
}

export function authoredChars(doc: TextDoc | NaiveDoc): { char: string; author: string }[] {
  const text = doc.toString();
  const author = doc instanceof TextDoc ? (i: number) => doc.idAt(i).replica : (i: number) => doc.authorAt(i);
  return Array.from({ length: text.length }, (_, i) => ({ char: text[i]!, author: author(i) }));
}
