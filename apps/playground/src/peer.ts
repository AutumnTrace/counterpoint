/**
 * One peer: a TextDoc replica bound to a <textarea>.
 *
 * Local typing becomes ops through diffText(); remote changes are written
 * back into the textarea with the caret re-placed through anchors, so a
 * peer that is typing keeps its place while text appears around it.
 */
import { TextDoc, decodeVersion, encodeUpdate, type Op, type VersionVector } from '@autumntrace/counterpoint';
import { diffText } from './diff.ts';
import { describeOps, describeUpdate, type Msg, type Receiver, type SimNetwork } from './network.ts';

export interface PeerSpec {
  readonly key: 'ada' | 'ben' | 'cy';
  readonly name: string;
}

export class Peer implements Receiver {
  readonly spec: PeerSpec;
  readonly index: number;
  doc: TextDoc;
  readonly el: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  private readonly versionEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly pendingEl: HTMLElement;
  private readonly net: SimNetwork;
  /** What the textarea showed after the last sync with the document. */
  private mirror = '';
  /** Called after any change to the document or its sync state. */
  onUpdate: () => void = () => {};

  constructor(spec: PeerSpec, index: number, net: SimNetwork) {
    this.spec = spec;
    this.index = index;
    this.net = net;
    this.doc = new TextDoc({ replicaId: spec.key });

    this.el = document.createElement('article');
    this.el.className = `peer peer--${spec.key}`;
    this.el.innerHTML = `
      <header class="peer__head">
        <span class="peer__dot" aria-hidden="true"></span>
        <h3 class="peer__name">${spec.name}</h3>
        <span class="peer__status" data-testid="status-${spec.key}"></span>
        <span class="peer__pending" data-testid="pending-${spec.key}"></span>
        <span class="peer__version" title="Version vector: how many ops from each replica this peer has applied"></span>
      </header>
      <textarea class="peer__editor" data-testid="editor-${spec.key}" spellcheck="false"
        autocapitalize="off" autocomplete="off" aria-label="${spec.name}'s editor"></textarea>`;
    this.textarea = this.el.querySelector('textarea')!;
    this.versionEl = this.el.querySelector('.peer__version')!;
    this.statusEl = this.el.querySelector('.peer__status')!;
    this.pendingEl = this.el.querySelector('.peer__pending')!;

    this.textarea.addEventListener('input', (e) => {
      if ((e as InputEvent).isComposing) return; // wait for compositionend
      this.syncFromTextarea();
    });
    this.textarea.addEventListener('compositionend', () => this.syncFromTextarea());
  }

  /** Replaces the replica (used by Reset and the scenario). */
  reset(doc: TextDoc): void {
    this.doc = doc;
    this.mirror = doc.toString();
    this.textarea.value = this.mirror;
    this.render();
  }

  // ------------------------------------------------------------- local

  private syncFromTextarea(): void {
    const now = this.textarea.value;
    if (now === this.mirror) return;
    const { index, deleteCount, insert } = diffText(this.mirror, now, this.textarea.selectionEnd);
    if (deleteCount > 0) this.broadcast(this.doc.delete(index, deleteCount));
    if (insert.length > 0) this.broadcast(this.doc.insert(index, insert));
    this.mirror = this.doc.toString();
    this.render();
  }

  /** Scripted typing (the scenario): edits the doc as if typed at `index`. */
  typeAt(index: number, text: string): void {
    const op = this.doc.insert(index, text);
    this.broadcast(op);
    this.mirror = this.doc.toString();
    this.textarea.value = this.mirror;
    this.textarea.setSelectionRange(index + text.length, index + text.length);
    this.render();
  }

  private broadcast(op: Op): void {
    const bytes = encodeUpdate([op], this.doc.variant);
    const label = describeOps([op]);
    for (const to of this.net.neighbours(this.index)) this.net.send(this.index, to, 'ops', bytes, label);
  }

  // ------------------------------------------------------------ remote

  hello(to: number): void {
    const vv = this.doc.version();
    this.net.send(this.index, to, 'hello', this.doc.encodeVersion(), `I have ${formatVersion(vv)}`);
  }

  receive(msg: Msg): string {
    if (msg.kind === 'hello') {
      const { version } = decodeVersion(msg.bytes);
      const missing = this.doc.changesSince(version);
      if (missing.length === 0) return 'already up to date';
      this.net.send(this.index, msg.from, 'catch-up', encodeUpdate(missing, this.doc.variant), describeOps(missing));
      return `sent back ${missing.length} op${missing.length === 1 ? '' : 's'}`;
    }

    const before = this.doc.version();
    const pendingBefore = this.doc.pendingCount;
    const summary = this.preservingSelection(() => this.doc.applyUpdate(msg.bytes));
    // Route around partitions: pass new ops on to neighbours that cannot
    // hear the sender directly.
    const fresh = this.doc.changesSince(before);
    if (fresh.length > 0) {
      const bytes = encodeUpdate(fresh, this.doc.variant);
      for (const to of this.net.neighbours(this.index)) {
        if (to !== msg.from && !this.net.isUp(msg.from, to)) this.net.send(this.index, to, 'ops', bytes, `relay: ${describeUpdate(bytes)}`);
      }
    }
    this.render();
    const parts: string[] = [];
    if (summary.applied) parts.push(`applied ${summary.applied}`);
    if (summary.buffered) parts.push(`buffered ${summary.buffered} (waiting for earlier ops)`);
    if (summary.duplicate) parts.push(`ignored ${summary.duplicate} duplicate${summary.duplicate === 1 ? '' : 's'}`);
    const released = pendingBefore + summary.buffered - this.doc.pendingCount;
    if (released > 0) parts.push(`released ${released} buffered`);
    return parts.join(', ') || 'nothing to do';
  }

  /** Runs `fn` (which changes the doc) without moving this peer's caret or selection. */
  private preservingSelection<T>(fn: () => T): T {
    const ta = this.textarea;
    if (ta.value !== this.mirror) this.syncFromTextarea(); // never lose a local edit
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const direction = ta.selectionDirection;
    // A caret sticks to the character before it; a selection's edges stick
    // inward, so text arriving exactly at an edge stays outside it.
    const a = this.doc.anchor(start, start === end ? 'left' : 'right');
    const b = start === end ? a : this.doc.anchor(end, 'left');
    const scroll = ta.scrollTop;
    const result = fn();
    const text = this.doc.toString();
    if (text !== this.mirror) {
      this.mirror = text;
      ta.value = text;
      ta.setSelectionRange(this.doc.resolve(a), this.doc.resolve(b), direction);
      ta.scrollTop = scroll;
    }
    return result;
  }

  // ------------------------------------------------------------ render

  render(): void {
    const vv = this.doc.version();
    this.versionEl.innerHTML = (['ada', 'ben', 'cy'] as const)
      .map((r) => `<span class="vv vv--${r}"><b>${r}</b>${vv[r] ?? 0}</span>`)
      .join('');
    const pending = this.doc.pendingCount;
    this.pendingEl.textContent = pending > 0 ? `${pending} buffered` : '';
    const neighbours = this.net.neighbours(this.index).length;
    this.statusEl.textContent = neighbours === 2 ? 'online' : neighbours === 1 ? 'one link down' : 'partitioned';
    this.statusEl.dataset['state'] = neighbours === 2 ? 'ok' : neighbours === 1 ? 'warn' : 'off';
    this.onUpdate();
  }
}

export function formatVersion(vv: VersionVector): string {
  const entries = Object.entries(vv).filter(([, n]) => n > 0);
  return entries.length === 0 ? 'nothing' : entries.map(([r, n]) => `${r}:${n}`).join(' ');
}
