/**
 * A fake network between the three peers. Every message is a real encoded
 * counterpoint message (update, version vector or catch-up) carried with
 * configurable latency, random extra delay (which reorders messages) and
 * random duplication. Cutting a link drops anything sent over it and
 * anything still in flight on it.
 */
import { decodeUpdate, type Op } from '@autumntrace/counterpoint';

export type MsgKind = 'ops' | 'hello' | 'catch-up';

export interface Msg {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly kind: MsgKind;
  readonly bytes: Uint8Array;
  readonly label: string;
  readonly sentAt: number;
  readonly deliverAt: number;
  /** True for the extra copy made by the duplication setting. */
  readonly copy: boolean;
}

export interface Receiver {
  /** Handles a delivered message; returns a short outcome for the log. */
  receive(msg: Msg): string;
  /** Sends this peer's version vector to `to`, starting a catch-up. */
  hello(to: number): void;
}

export interface NetworkHooks {
  /** A message was delivered (`outcome` describes what the receiver did) or lost. */
  onDeliver(msg: Msg, outcome: string, lost: boolean): void;
  onLinksChanged(): void;
}

/** Undirected links: 0 = Ada–Ben, 1 = Ben–Cy, 2 = Ada–Cy. */
export const LINKS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [0, 2],
];

export class SimNetwork {
  latency = 400; // ms
  jitter = 0; // up to this many extra ms per message, at random
  duplication = 0; // probability of sending a second copy
  readonly up = [true, true, true];
  inFlight: Msg[] = [];
  private nextId = 1;
  private readonly peers: Receiver[] = [];
  private readonly hooks: NetworkHooks;

  constructor(hooks: NetworkHooks) {
    this.hooks = hooks;
  }

  attach(peers: Receiver[]): void {
    this.peers.splice(0, this.peers.length, ...peers);
  }

  linkBetween(a: number, b: number): number {
    return LINKS.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  isUp(a: number, b: number): boolean {
    return this.up[this.linkBetween(a, b)] ?? false;
  }

  neighbours(peer: number): number[] {
    return [0, 1, 2].filter((p) => p !== peer && this.isUp(peer, p));
  }

  send(from: number, to: number, kind: MsgKind, bytes: Uint8Array, label: string): void {
    if (!this.isUp(from, to)) return;
    const now = performance.now();
    const copies = Math.random() < this.duplication ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      this.inFlight.push({
        id: this.nextId++,
        from,
        to,
        kind,
        bytes,
        label,
        sentAt: now,
        deliverAt: now + this.latency + Math.random() * this.jitter,
        copy: c === 1,
      });
    }
  }

  setLink(link: number, up: boolean): void {
    if (this.up[link] === up) return;
    this.up[link] = up;
    this.hooks.onLinksChanged();
    if (up) {
      // Reconnected: each side says what it has, the other answers with
      // whatever is missing (see Peer.receive).
      const [a, b] = LINKS[link]!;
      this.peers[a]!.hello(b);
      this.peers[b]!.hello(a);
    }
  }

  /** Delivers every message that is due. Call once per animation frame. */
  tick(now: number): void {
    if (this.inFlight.length === 0) return;
    const due = this.inFlight.filter((m) => m.deliverAt <= now).sort((x, y) => x.deliverAt - y.deliverAt);
    if (due.length === 0) return;
    const dueIds = new Set(due.map((m) => m.id));
    this.inFlight = this.inFlight.filter((m) => !dueIds.has(m.id));
    for (const m of due) {
      if (!this.isUp(m.from, m.to)) {
        this.hooks.onDeliver(m, 'lost: link cut while in flight', true);
        continue;
      }
      this.hooks.onDeliver(m, this.peers[m.to]!.receive(m), false);
    }
  }

  clear(): void {
    this.inFlight = [];
  }

  /** True when nothing is in flight. */
  get quiet(): boolean {
    return this.inFlight.length === 0;
  }
}

/** Short human description of an update's contents, for the log. */
export function describeOps(ops: readonly Op[]): string {
  if (ops.length === 0) return 'nothing';
  if (ops.length === 1) {
    const op = ops[0]!;
    if (op.kind === 'insert') return `insert ${JSON.stringify(op.text)} as ${op.id.replica}:${op.id.counter}`;
    const n = op.targets.reduce((sum, t) => sum + t.length, 0);
    return `delete ${n} char${n === 1 ? '' : 's'} (${op.id.replica}:${op.id.counter})`;
  }
  const inserted = ops.reduce((n, op) => n + (op.kind === 'insert' ? op.text.length : 0), 0);
  const deletes = ops.filter((op) => op.kind === 'delete').length;
  const parts = [`${ops.length} ops`];
  if (inserted) parts.push(`${inserted} chars inserted`);
  if (deletes) parts.push(`${deletes} deletes`);
  return parts.join(', ');
}

export function describeUpdate(bytes: Uint8Array): string {
  return describeOps(decodeUpdate(bytes).ops);
}
