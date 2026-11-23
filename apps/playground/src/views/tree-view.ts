/**
 * Draws a replica's Fugue tree.
 *
 * Nodes are laid out by in-order traversal, so reading the drawing left to
 * right spells out the document (tombstones included, faded). Chains that
 * one insert op produced (each char the previous one's only right child)
 * are drawn as one box, which keeps the picture about as tall as the
 * structure is interesting rather than as tall as the text is long.
 */
import type { Id, TextDoc, TreeNode } from '@autumntrace/counterpoint';

const SVG = 'http://www.w3.org/2000/svg';
const CW = 15; // px per character cell
const RH = 46; // px per tree level
const LIMIT = 140;

interface Box {
  readonly nodes: TreeNode[];
  readonly side: 'left' | 'right';
  readonly left: Box[];
  readonly right: Box[];
  x: number;
  depth: number;
}

const sameId = (a: Id | null, b: Id | null) =>
  a === null || b === null ? a === b : a.replica === b.replica && a.counter === b.counter;

function boxOf(node: TreeNode): Box {
  const nodes = [node];
  let cur = node;
  while (cur.right.length === 1) {
    const next = cur.right[0]!;
    const continues =
      next.left.length === 0 &&
      next.id !== null &&
      cur.id !== null &&
      next.id.replica === cur.id.replica &&
      next.id.counter === cur.id.counter + 1 &&
      sameId(next.rightOrigin, cur.rightOrigin);
    if (!continues) break;
    nodes.push(next);
    cur = next;
  }
  return {
    nodes,
    side: node.side,
    left: node.left.map(boxOf),
    right: cur.right.map(boxOf),
    x: 0,
    depth: 0,
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const glyph = (c: string) => (c === '\n' ? '↵' : c === ' ' ? '·' : c);

export function renderTree(container: HTMLElement, doc: TextDoc): void {
  if (doc.elementCount === 0) {
    container.innerHTML = '<p class="tree__empty">Empty document: just the root.</p>';
    return;
  }
  if (doc.elementCount > LIMIT) {
    container.innerHTML = `<p class="tree__empty">The tree view draws documents up to ${LIMIT} characters, tombstones included. This one has ${doc.elementCount}. Press Reset or run the scenario to get a small one.</p>`;
    return;
  }
  const root = doc.inspectTree();
  const tops = root.right.map(boxOf);
  let x = 1; // column 0 is the root
  let maxDepth = 0;
  const layout = (b: Box, depth: number) => {
    b.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    for (const l of b.left) layout(l, depth + 1);
    b.x = x;
    x += b.nodes.length;
    for (const r of b.right) layout(r, depth + 1);
  };
  for (const t of tops) layout(t, 1);

  const width = (x + 1) * CW;
  const height = (maxDepth + 1) * RH + 12;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'tree', role: 'img' });
  svg.setAttribute('aria-label', `Fugue tree of ${doc.elementCount} elements`);
  const edges = svgEl('g', { class: 'tree__edges' });
  const boxes = svgEl('g', { class: 'tree__boxes' });
  svg.append(edges, boxes);

  const top = (d: number) => d * RH + 8;
  const rootX = CW / 2;
  const rootY = top(0) + 10;
  const rootG = svgEl('g', { class: 'tree__root', transform: `translate(${rootX} ${rootY})` });
  rootG.append(svgEl('circle', { r: 5 }));
  svg.append(rootG);

  const edge = (fromX: number, fromY: number, b: Box) => {
    const toX = (b.x + b.nodes.length / 2) * CW;
    const toY = top(b.depth);
    const midY = (fromY + toY) / 2;
    edges.append(
      svgEl('path', {
        d: `M${fromX} ${fromY} C${fromX} ${midY} ${toX} ${midY} ${toX} ${toY}`,
        class: `tree__edge tree__edge--${b.side}`,
      }),
    );
  };

  const draw = (b: Box) => {
    const y = top(b.depth);
    const g = svgEl('g', { class: 'tree__box' });
    g.append(svgEl('rect', { x: b.x * CW + 0.5, y, width: b.nodes.length * CW - 1, height: 22, rx: 4 }));
    b.nodes.forEach((n, k) => {
      const t = svgEl('text', {
        x: (b.x + k + 0.5) * CW,
        y: y + 15,
        'text-anchor': 'middle',
        class: `tree__char c-${n.id!.replica}${n.deleted ? ' is-deleted' : ''}`,
      });
      t.textContent = glyph(n.char);
      const title = svgEl('title');
      title.textContent = `${n.id!.replica}:${n.id!.counter} ${JSON.stringify(n.char)}${n.deleted ? ' (deleted)' : ''}${k === 0 ? `, ${n.side} child` : ''}`;
      t.append(title);
      g.append(t);
    });
    boxes.append(g);
    for (const l of b.left) {
      edge((b.x + 0.5) * CW, y + 22, l);
      draw(l);
    }
    for (const r of b.right) {
      edge((b.x + b.nodes.length - 0.5) * CW, y + 22, r);
      draw(r);
    }
  };
  for (const t of tops) {
    edge(rootX, rootY + 5, t);
    draw(t);
  }
  container.replaceChildren(svg);
}
