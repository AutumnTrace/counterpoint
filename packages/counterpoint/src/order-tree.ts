/**
 * The document order, materialised.
 *
 * The Fugue tree defines the order of elements, but answering "which element
 * is at index i?" by walking that tree costs O(n). Instead, every element
 * also lives in this B+tree-like structure, which stores all elements
 * (tombstones included) in document order. Leaves hold small arrays of
 * elements; every node caches its total and visible element counts, so both
 * index -> element and element -> index are O(log n) plus a scan of one leaf.
 *
 * The Fugue tree only decides *where* a new element goes (right after some
 * existing element, or right before one); this structure makes that cheap.
 * Elements are never removed, so there is no merge/rebalance on delete.
 */
import type { Elem } from './element.ts';

const LEAF_MAX = 128;
const LEAF_TARGET = 96; // size of the leaves a split produces
const BRANCH_MAX = 32;
const BRANCH_TARGET = 24;

export class Leaf {
  items: Elem[];
  visible = 0;
  parent: Branch | null = null;
  next: Leaf | null = null;
  prev: Leaf | null = null;

  constructor(items: Elem[]) {
    this.items = items;
    for (const e of items) {
      e.leaf = this;
      if (!e.deleted) this.visible++;
    }
  }

  get size(): number {
    return this.items.length;
  }
}

export class Branch {
  children: Node[];
  size = 0;
  visible = 0;
  parent: Branch | null = null;

  constructor(children: Node[]) {
    this.children = children;
    for (const c of children) {
      c.parent = this;
      this.size += c.size;
      this.visible += c.visible;
    }
  }
}

type Node = Leaf | Branch;

/** Splits `n` items into `ceil(n / target)` nearly equal chunk lengths. */
function chunkLengths(n: number, target: number): number[] {
  const k = Math.max(1, Math.ceil(n / target));
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

function chunk<T>(xs: T[], target: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const len of chunkLengths(xs.length, target)) {
    out.push(xs.slice(at, at + len));
    at += len;
  }
  return out;
}

export class OrderTree {
  private root: Node;
  private head: Leaf;

  constructor() {
    this.head = new Leaf([]);
    this.root = this.head;
  }

  /** Number of elements, tombstones included. */
  get size(): number {
    return this.root.size;
  }

  /** Number of visible (non-deleted) elements. */
  get visible(): number {
    return this.root.visible;
  }

  first(): Elem | null {
    return this.head.items[0] ?? null;
  }

  /** The element at visible index `index`. */
  atVisible(index: number): Elem {
    const [leaf, i] = this.locateVisible(index);
    return leaf.items[i]!;
  }

  /** Number of visible elements before `e` (whether or not `e` is deleted). */
  visibleIndexOf(e: Elem): number {
    const leaf = e.leaf!;
    let count = 0;
    for (const x of leaf.items) {
      if (x === e) break;
      if (!x.deleted) count++;
    }
    let node: Node = leaf;
    for (let p = node.parent; p !== null; node = p, p = p.parent) {
      for (const c of p.children) {
        if (c === node) break;
        count += c.visible;
      }
    }
    return count;
  }

  /** Number of elements (tombstones included) before `e`. */
  indexOf(e: Elem): number {
    const leaf = e.leaf!;
    let count = leaf.items.indexOf(e);
    let node: Node = leaf;
    for (let p = node.parent; p !== null; node = p, p = p.parent) {
      for (const c of p.children) {
        if (c === node) break;
        count += c.size;
      }
    }
    return count;
  }

  /** The element after `e` in document order, tombstones included. */
  next(e: Elem): Elem | null {
    const leaf = e.leaf!;
    const i = leaf.items.indexOf(e);
    if (i + 1 < leaf.items.length) return leaf.items[i + 1]!;
    return leaf.next === null ? null : leaf.next.items[0]!;
  }

  /** Inserts `elems` (in order) right after `ref`, or at the very start if null. */
  insertAfter(ref: Elem | null, elems: Elem[]): void {
    if (ref === null) this.insertAt(this.head, 0, elems);
    else this.insertAt(ref.leaf!, ref.leaf!.items.indexOf(ref) + 1, elems);
  }

  /** Inserts `elems` (in order) right before `ref`, or at the very end if null. */
  insertBefore(ref: Elem | null, elems: Elem[]): void {
    if (ref !== null) {
      this.insertAt(ref.leaf!, ref.leaf!.items.indexOf(ref), elems);
      return;
    }
    let last = this.head;
    while (last.next !== null) last = last.next;
    this.insertAt(last, last.items.length, elems);
  }

  /** Flags `e` as deleted and updates the counts. Returns false if it already was. */
  markDeleted(e: Elem): boolean {
    if (e.deleted) return false;
    e.deleted = true;
    for (let node: Node | null = e.leaf!; node !== null; node = node.parent) node.visible--;
    return true;
  }

  /** Up to `count` visible elements starting at visible index `index`. */
  visibleRange(index: number, count: number): Elem[] {
    const out: Elem[] = [];
    if (count <= 0) return out;
    let [leaf, i]: [Leaf | null, number] = this.locateVisible(index);
    while (leaf !== null && out.length < count) {
      const items = leaf.items;
      for (; i < items.length && out.length < count; i++) {
        if (!items[i]!.deleted) out.push(items[i]!);
      }
      leaf = leaf.next;
      i = 0;
    }
    return out;
  }

  /** Calls `fn` for every element in document order. */
  forEach(fn: (e: Elem) => void): void {
    for (let leaf: Leaf | null = this.head; leaf !== null; leaf = leaf.next) {
      for (const e of leaf.items) fn(e);
    }
  }

  /** Visible text, in order. */
  text(): string {
    const parts: string[] = [];
    for (let leaf: Leaf | null = this.head; leaf !== null; leaf = leaf.next) {
      let s = '';
      for (const e of leaf.items) if (!e.deleted) s += e.char;
      parts.push(s);
    }
    return parts.join('');
  }

  /** Throws if any cached count or pointer is inconsistent. For tests. */
  assertInvariants(): void {
    const check = (node: Node, parent: Branch | null): [number, number] => {
      if (node.parent !== parent) throw new Error('bad parent pointer');
      if (node instanceof Leaf) {
        let vis = 0;
        for (const e of node.items) {
          if (e.leaf !== node) throw new Error('bad leaf pointer');
          if (!e.deleted) vis++;
        }
        if (vis !== node.visible) throw new Error('bad leaf visible count');
        return [node.items.length, vis];
      }
      let size = 0;
      let vis = 0;
      for (const c of node.children) {
        const [s, v] = check(c, node);
        size += s;
        vis += v;
      }
      if (size !== node.size || vis !== node.visible) throw new Error('bad branch counts');
      return [size, vis];
    };
    check(this.root, null);
    let n = 0;
    for (let leaf: Leaf | null = this.head; leaf !== null; leaf = leaf.next) {
      if (leaf.next !== null && leaf.next.prev !== leaf) throw new Error('bad leaf links');
      n += leaf.items.length;
    }
    if (n !== this.root.size) throw new Error('leaf chain does not cover the tree');
  }

  // ---------------------------------------------------------------- internals

  private locateVisible(index: number): [Leaf, number] {
    if (!Number.isInteger(index) || index < 0 || index >= this.root.visible) {
      throw new RangeError(`index ${index} out of range (length ${this.root.visible})`);
    }
    let node: Node = this.root;
    while (node instanceof Branch) {
      let child: Node | undefined;
      for (const c of node.children) {
        if (index < c.visible) {
          child = c;
          break;
        }
        index -= c.visible;
      }
      node = child!;
    }
    const items = node.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.deleted) continue;
      if (index === 0) return [node, i];
      index--;
    }
    throw new Error('order tree counts are corrupt');
  }

  private insertAt(leaf: Leaf, offset: number, elems: Elem[]): void {
    if (elems.length === 0) return;
    const items = leaf.items;
    if (elems.length < 4096) items.splice(offset, 0, ...elems);
    else leaf.items = items.slice(0, offset).concat(elems, items.slice(offset));
    let vis = 0;
    for (const e of elems) {
      e.leaf = leaf;
      if (!e.deleted) vis++;
    }
    leaf.visible += vis;
    for (let p = leaf.parent; p !== null; p = p.parent) {
      p.size += elems.length;
      p.visible += vis;
    }
    if (leaf.items.length > LEAF_MAX) this.splitLeaf(leaf);
  }

  private splitLeaf(leaf: Leaf): void {
    const [keep, ...rest] = chunk(leaf.items, LEAF_TARGET);
    leaf.items = keep!;
    leaf.visible = 0;
    for (const e of leaf.items) if (!e.deleted) leaf.visible++;
    const fresh = rest.map((items) => new Leaf(items));
    let prev = leaf;
    const after = leaf.next;
    for (const f of fresh) {
      prev.next = f;
      f.prev = prev;
      prev = f;
    }
    prev.next = after;
    if (after !== null) after.prev = prev;
    this.addSiblings(leaf, fresh);
  }

  private splitBranch(branch: Branch): void {
    const [keep, ...rest] = chunk(branch.children, BRANCH_TARGET);
    branch.children = keep!;
    branch.size = 0;
    branch.visible = 0;
    for (const c of branch.children) {
      branch.size += c.size;
      branch.visible += c.visible;
    }
    this.addSiblings(
      branch,
      rest.map((kids) => new Branch(kids)),
    );
  }

  /** Places `fresh` right after `node` under the same parent. Totals are unchanged. */
  private addSiblings(node: Node, fresh: Node[]): void {
    if (fresh.length === 0) return;
    const parent = node.parent;
    if (parent === null) {
      this.root = new Branch([node, ...fresh]);
      return;
    }
    parent.children.splice(parent.children.indexOf(node) + 1, 0, ...fresh);
    for (const f of fresh) f.parent = parent;
    if (parent.children.length > BRANCH_MAX) this.splitBranch(parent);
  }
}
