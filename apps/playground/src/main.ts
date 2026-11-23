import './style.css';
import { TextDoc, sameVersion } from '@autumntrace/counterpoint';
import { LINKS, SimNetwork } from './network.ts';
import { Peer, type PeerSpec } from './peer.ts';
import { authoredChars, authoredHtml, runScenario } from './scenario.ts';
import { LogView } from './views/log-view.ts';
import { NetworkView } from './views/network-view.ts';
import { renderTree } from './views/tree-view.ts';

const SPECS: readonly PeerSpec[] = [
  { key: 'ada', name: 'Ada' },
  { key: 'ben', name: 'Ben' },
  { key: 'cy', name: 'Cy' },
];
const WELCOME = 'Type in any editor.\nCut a link, keep typing on both sides, then heal it.\n';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const log = new LogView($<HTMLOListElement>('#log'));
let dirty = true;
const net = new SimNetwork({
  onDeliver: (msg, outcome, lost) => {
    log.add(msg, outcome, lost);
    dirty = true;
  },
  onLinksChanged: () => {
    netView.renderLinks();
    for (const p of peers) p.render();
    dirty = true;
  },
});
const peers = SPECS.map((spec, i) => new Peer(spec, i, net));
net.attach(peers);
const netView = new NetworkView(net, (link) => {
  const up = !net.up[link];
  const [a, b] = LINKS[link]!;
  log.note(`${up ? 'Healed' : 'Cut'} the link ${SPECS[a]!.name} – ${SPECS[b]!.name}.`);
  net.setLink(link, up);
});
$('#net').append(netView.svg);
$('#peers').append(...peers.map((p) => p.el));
for (const p of peers) p.onUpdate = () => (dirty = true);

/** Fresh replicas that all start from the same `text`: one op by Cy, already everywhere. */
function reset(text: string): void {
  net.clear();
  for (let i = 0; i < LINKS.length; i++) net.up[i] = true;
  netView.renderLinks();
  const docs = SPECS.map((s) => new TextDoc({ replicaId: s.key }));
  if (text.length > 0) {
    const op = docs[2]!.insert(0, text);
    docs[0]!.apply(op);
    docs[1]!.apply(op);
  }
  peers.forEach((p, i) => p.reset(docs[i]!));
  log.clear();
  dirty = true;
}

function converged(): boolean {
  if (!net.quiet) return false;
  const [a, ...rest] = peers;
  return rest.every(
    (p) => p.doc.toString() === a!.doc.toString() && sameVersion(p.doc.version(), a!.doc.version()) && p.doc.pendingCount === 0,
  );
}

// ------------------------------------------------------------- controls

function bindSlider(id: string, apply: (v: number) => void, show: (v: number) => string): void {
  const input = $<HTMLInputElement>(`#${id}`);
  const out = $<HTMLOutputElement>(`#${id}-out`);
  const update = () => {
    const v = Number(input.value);
    apply(v);
    out.textContent = show(v);
  };
  input.addEventListener('input', update);
  update();
}
bindSlider('latency', (v) => (net.latency = v), (v) => `${v} ms`);
bindSlider('jitter', (v) => (net.jitter = v), (v) => (v === 0 ? 'off' : `up to +${v} ms`));
bindSlider('dup', (v) => (net.duplication = v), (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`));

$('#partition').addEventListener('click', () => {
  log.note('Cut Ada off from both peers.');
  net.setLink(0, false);
  net.setLink(2, false);
});
$('#heal').addEventListener('click', () => {
  log.note('Healed every link.');
  for (let i = 0; i < LINKS.length; i++) net.setLink(i, true);
});
$('#reset').addEventListener('click', () => {
  reset(WELCOME);
  $('#scenario-result').replaceChildren();
});

const scenarioButton = $<HTMLButtonElement>('#scenario');
scenarioButton.addEventListener('click', async () => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.panel button')];
  buttons.forEach((b) => (b.disabled = true));
  const result = $('#scenario-result');
  result.innerHTML = '<p class="hint">Typing…</p>';
  try {
    const doc = await runScenario({ peers, net, log, reset, converged });
    result.innerHTML = `
      <div class="result result--good" data-testid="result-fugue">
        <h3>Fugue (this library) <small>${converged() ? 'all three replicas agree' : 'still syncing'}</small></h3>
        <pre>${authoredHtml(authoredChars(doc))}</pre>
      </div>`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// ---------------------------------------------------------------- tree

let treePeer = 0;
const tabs = $('#tree-tabs');
SPECS.forEach((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.role = 'tab';
  b.textContent = s.name;
  b.dataset['testid'] = `tree-tab-${s.key}`;
  b.addEventListener('click', () => {
    treePeer = i;
    dirty = true;
  });
  tabs.append(b);
});

// ---------------------------------------------------------------- loop

const syncState = $('#sync-state');
let treeKey = '';
function frame(now: number): void {
  net.tick(now);
  netView.renderMessages(now);
  if (dirty) {
    dirty = false;
    // Redraw the tree only when the shown replica actually changed.
    const doc = peers[treePeer]!.doc;
    const key = `${treePeer} ${doc.replicaId} ${JSON.stringify(doc.version())} ${doc.elementCount} ${doc.length}`;
    if (key !== treeKey) {
      treeKey = key;
      renderTree($('#tree'), doc);
      [...tabs.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === treePeer)));
    }
    const ok = converged();
    const anyDown = net.up.some((u) => !u);
    syncState.dataset['state'] = ok ? 'ok' : net.quiet && anyDown ? 'diverged' : 'busy';
    syncState.textContent = ok
      ? 'replicas agree'
      : net.quiet && anyDown
        ? 'partitioned'
        : `${net.inFlight.length} in flight`;
  }
  if (!net.quiet) dirty = true;
  requestAnimationFrame(frame);
}

reset(WELCOME);
requestAnimationFrame(frame);

// Handy in the console.
Object.assign(globalThis, { counterpoint: { peers, net } });
