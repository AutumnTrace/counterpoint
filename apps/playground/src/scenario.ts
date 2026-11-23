/**
 * The interleaving scenario: Ada is partitioned, she and Ben both type a
 * line at the end of the same list one keystroke at a time, and the network
 * heals. Afterwards the merged text is shown with each character coloured
 * by the replica that typed it.
 */
import { TextDoc } from '@autumntrace/counterpoint';
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

export async function runScenario(ctx: ScenarioContext, keystrokeMs = 110): Promise<TextDoc> {
  const [ada, ben] = ctx.peers as [Peer, Peer, Peer];
  ctx.reset(BASE);
  ctx.log.note('Scenario: Ada is cut off. She and Ben each add an item to the end of the list.');
  ctx.net.setLink(0, false); // Ada–Ben
  ctx.net.setLink(2, false); // Ada–Cy
  for (const k of keystrokes()) {
    (k.who === 'ada' ? ada : ben).typeAt(k.index, k.char);
    await sleep(keystrokeMs / 2);
  }
  await sleep(Math.max(400, ctx.net.latency + ctx.net.jitter));
  ctx.log.note('Healing: each side sends its version vector and gets back what it is missing.');
  ctx.net.setLink(0, true);
  ctx.net.setLink(2, true);
  await until(() => ctx.converged(), 20_000 + 6 * (ctx.net.latency + ctx.net.jitter));
  return ada.doc;
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

export function authoredChars(doc: TextDoc): { char: string; author: string }[] {
  const text = doc.toString();
  return Array.from({ length: text.length }, (_, i) => ({ char: text[i]!, author: doc.idAt(i).replica }));
}
