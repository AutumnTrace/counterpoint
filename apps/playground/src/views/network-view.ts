/**
 * The triangle: three peers, three links you can click to cut or heal, and
 * every in-flight message drawn as a dot travelling along its link.
 */
import { LINKS, type Msg, type SimNetwork } from '../network.ts';

const SVG = 'http://www.w3.org/2000/svg';
const POS: readonly (readonly [number, number])[] = [
  [160, 46], // Ada
  [52, 214], // Ben
  [268, 214], // Cy
];
const NAMES = ['Ada', 'Ben', 'Cy'];
const KEYS = ['ada', 'ben', 'cy'];

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class NetworkView {
  readonly svg: SVGSVGElement;
  private readonly linkEls: SVGGElement[] = [];
  private readonly dots: SVGGElement;
  private readonly net: SimNetwork;

  constructor(net: SimNetwork, onToggle: (link: number) => void) {
    this.net = net;
    this.svg = el('svg', { viewBox: '0 0 320 260', class: 'net', role: 'group', 'aria-label': 'Network between the three peers' });

    LINKS.forEach(([a, b], i) => {
      const [x1, y1] = POS[a]!;
      const [x2, y2] = POS[b]!;
      const g = el('g', {
        class: 'net__link',
        role: 'button',
        tabindex: 0,
        'data-testid': `link-${KEYS[a]}-${KEYS[b]}`,
      });
      g.append(
        el('line', { x1, y1, x2, y2, class: 'net__wire' }),
        el('line', { x1, y1, x2, y2, class: 'net__hit' }),
      );
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const badge = el('g', { class: 'net__badge', transform: `translate(${mx} ${my})` });
      badge.append(el('circle', { r: 11 }), el('path', { d: 'M-4 -4 L4 4 M4 -4 L-4 4' }));
      g.append(badge);
      const toggle = () => onToggle(i);
      g.addEventListener('click', toggle);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      this.linkEls.push(g);
      this.svg.append(g);
    });

    this.dots = el('g', { class: 'net__dots' });
    this.svg.append(this.dots);

    POS.forEach(([x, y], i) => {
      const g = el('g', { class: `net__node net__node--${KEYS[i]}`, transform: `translate(${x} ${y})` });
      g.append(el('circle', { r: 26 }));
      const label = el('text', { 'text-anchor': 'middle', dy: '0.35em' });
      label.textContent = NAMES[i]!;
      g.append(label);
      this.svg.append(g);
    });
    this.renderLinks();
  }

  renderLinks(): void {
    this.linkEls.forEach((g, i) => {
      const up = this.net.up[i]!;
      const [a, b] = LINKS[i]!;
      g.classList.toggle('is-down', !up);
      g.setAttribute('aria-pressed', String(!up));
      g.setAttribute('aria-label', `${up ? 'Cut' : 'Heal'} the link between ${NAMES[a]} and ${NAMES[b]}`);
      g.querySelector('title')?.remove();
      const title = el('title');
      title.textContent = `${NAMES[a]} – ${NAMES[b]}: ${up ? 'connected (click to cut)' : 'cut (click to heal)'}`;
      g.prepend(title);
    });
  }

  /** Redraws in-flight messages. Called every animation frame. */
  renderMessages(now: number): void {
    const msgs = this.net.inFlight;
    while (this.dots.childElementCount > msgs.length) this.dots.lastElementChild!.remove();
    while (this.dots.childElementCount < msgs.length) {
      const g = el('g');
      g.append(el('circle'));
      this.dots.append(g);
    }
    msgs.forEach((m: Msg, i) => {
      const g = this.dots.children[i] as SVGGElement;
      const span = Math.max(1, m.deliverAt - m.sentAt);
      const t = Math.min(1, Math.max(0, (now - m.sentAt) / span));
      const [x1, y1] = POS[m.from]!;
      const [x2, y2] = POS[m.to]!;
      // Start and stop at the node rims rather than the centres.
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const along = 28 + t * (len - 56);
      // Messages in opposite directions travel on either side of the wire.
      const side = m.from < m.to ? 1 : -1;
      const x = x1 + ux * along - uy * 5 * side;
      const y = y1 + uy * along + ux * 5 * side;
      g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      g.setAttribute('class', `net__msg net__msg--${KEYS[m.from]} net__msg--${m.kind}${m.copy ? ' is-copy' : ''}`);
      const c = g.firstElementChild as SVGCircleElement;
      c.setAttribute('r', m.kind === 'catch-up' ? '6.5' : m.kind === 'hello' ? '4.5' : '4');
    });
  }
}
