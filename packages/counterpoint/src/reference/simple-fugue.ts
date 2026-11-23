/**
 * A direct transcription of Algorithm 1 from Weidner & Kleppmann,
 * "The Art of the Fugue" (plus the FugueMax sibling rule from section 5.3).
 *
 * Every query walks the whole tree, so each operation is O(n). It exists for
 * two reasons: it is short enough to check against the paper line by line,
 * and the property tests use it as an oracle for the indexed implementation
 * in text-doc.ts, which has to reach the same order by a much less obvious
 * route.
 *
 * It assumes causal delivery: `apply` throws if an op references an element
 * this replica has not seen yet.
 */
import { compareIds, formatId, sameId, type Id, type ReplicaId } from '../id.ts';
import type { DeleteOp, InsertOp, Op, Side, Variant } from '../ops.ts';

interface Node {
  readonly id: Id | null; // null only for the root
  readonly char: string;
  deleted: boolean;
  readonly parent: Node | null;
  readonly side: Side;
  /** Only meaningful for right children (FugueMax). `null` = end of list. */
  readonly rightOrigin: Node | null;
  readonly left: Node[];
  readonly right: Node[];
}

const key = (id: Id): string => `${id.counter}@${id.replica}`;

export class SimpleFugue {
  readonly replicaId: ReplicaId;
  readonly variant: Variant;
  private readonly root: Node = {
    id: null,
    char: '',
    deleted: true,
    parent: null,
    side: 'right',
    rightOrigin: null,
    left: [],
    right: [],
  };
  private readonly nodes = new Map<string, Node>();
  private counter = 0;

  constructor(replicaId: ReplicaId, variant: Variant = 'fugue-max') {
    this.replicaId = replicaId;
    this.variant = variant;
  }

  // ---------------------------------------------------------------- queries

  /** All nodes except the root, in list order, tombstones included. */
  nodesInOrder(): Node[] {
    const out: Node[] = [];
    this.traverse((n) => out.push(n));
    return out;
  }

  toString(): string {
    let s = '';
    this.traverse((n) => {
      if (!n.deleted) s += n.char;
    });
    return s;
  }

  get length(): number {
    let n = 0;
    this.traverse((node) => {
      if (!node.deleted) n++;
    });
    return n;
  }

  /** Ids of every element in list order (tombstones included). */
  idsInOrder(): Id[] {
    return this.nodesInOrder().map((n) => n.id as Id);
  }

  has(id: Id): boolean {
    return this.nodes.has(key(id));
  }

  /** Id of the visible character at `index`. */
  idAt(index: number): Id {
    let seen = 0;
    for (const n of this.nodesInOrder()) {
      if (n.deleted) continue;
      if (seen++ === index) return n.id!;
    }
    throw new RangeError(`idAt: index ${index} out of range`);
  }

  // ----------------------------------------------------------- local edits

  /** Inserts `text` so that its first character ends up at `index`. */
  insert(index: number, text: string): InsertOp {
    if (text.length === 0) throw new RangeError('insert: empty text');
    const order = this.nodesInOrder();
    // leftOrigin: the (index-1)th visible node, or the root.
    let leftOrigin = this.root;
    let pos = -1; // position of leftOrigin in `order`
    if (index > 0) {
      let seen = 0;
      for (let i = 0; i < order.length; i++) {
        if (order[i]!.deleted) continue;
        if (++seen === index) {
          leftOrigin = order[i]!;
          pos = i;
          break;
        }
      }
      if (seen < index) throw new RangeError(`insert: index ${index} out of range`);
    } else if (index < 0) {
      throw new RangeError(`insert: index ${index} out of range`);
    }
    // rightOrigin: the next node in the traversal *including tombstones*.
    const rightOrigin = pos + 1 < order.length ? order[pos + 1]! : null;

    let parent: Node;
    let side: Side;
    if (leftOrigin.right.length === 0) {
      parent = leftOrigin;
      side = 'right';
    } else {
      // leftOrigin has right children, so the next node is one of its
      // descendants and has no left children (Theorem 1 in the paper).
      parent = rightOrigin!;
      side = 'left';
    }
    const op: InsertOp = {
      kind: 'insert',
      id: { replica: this.replicaId, counter: this.counter },
      text,
      parent: parent.id,
      side,
      rightOrigin: rightOrigin === null ? null : rightOrigin.id,
    };
    this.apply(op);
    return op;
  }

  /** Deletes `length` visible characters starting at `index`. */
  delete(index: number, length = 1): DeleteOp {
    if (length <= 0) throw new RangeError('delete: length must be positive');
    const targets: { replica: string; counter: number; length: number }[] = [];
    let seen = 0;
    for (const n of this.nodesInOrder()) {
      if (n.deleted) continue;
      if (seen >= index && seen < index + length) {
        const id = n.id!;
        const last = targets[targets.length - 1];
        if (last && last.replica === id.replica && last.counter + last.length === id.counter) {
          last.length++;
        } else {
          targets.push({ replica: id.replica, counter: id.counter, length: 1 });
        }
      }
      seen++;
    }
    if (index < 0 || index + length > seen) {
      throw new RangeError(`delete: range ${index}+${length} out of bounds (length ${seen})`);
    }
    const op: DeleteOp = {
      kind: 'delete',
      id: { replica: this.replicaId, counter: this.counter },
      targets,
    };
    this.apply(op);
    return op;
  }

  // ------------------------------------------------------------ delivery

  apply(op: Op): void {
    if (op.id.replica === this.replicaId) {
      this.counter = Math.max(this.counter, op.id.counter + (op.kind === 'insert' ? op.text.length : 1));
    }
    if (op.kind === 'delete') {
      for (const t of op.targets) {
        for (let c = t.counter; c < t.counter + t.length; c++) {
          this.get({ replica: t.replica, counter: c }).deleted = true;
        }
      }
      return;
    }
    let parent = op.parent === null ? this.root : this.get(op.parent);
    let side = op.side;
    const rightOrigin = op.rightOrigin === null ? null : this.get(op.rightOrigin);
    if (side === 'left' && !sameId(op.parent, op.rightOrigin)) {
      throw new Error(`insert ${formatId(op.id)}: a left child's rightOrigin must be its parent`);
    }
    for (let k = 0; k < op.text.length; k++) {
      const id: Id = { replica: op.id.replica, counter: op.id.counter + k };
      if (this.nodes.has(key(id))) throw new Error(`duplicate element ${formatId(id)}`);
      const node: Node = {
        id,
        char: op.text[k]!,
        deleted: false,
        parent,
        side,
        rightOrigin,
        left: [],
        right: [],
      };
      this.insertSibling(side === 'left' ? parent.left : parent.right, node);
      this.nodes.set(key(id), node);
      // The rest of the run hangs off this character as right children.
      parent = node;
      side = 'right';
    }
  }

  // ------------------------------------------------------------ internals

  private get(id: Id): Node {
    const n = this.nodes.get(key(id));
    if (!n) throw new Error(`missing dependency ${formatId(id)} (causal delivery violated)`);
    return n;
  }

  private insertSibling(siblings: Node[], node: Node): void {
    let i = 0;
    if (this.variant === 'fugue-max' && node.side === 'right') {
      // FugueMax: right-side siblings in *reverse* list order of their right
      // origins (end of list counts as last), ties broken by id.
      const order = this.nodesInOrder();
      const pos = (n: Node | null) => (n === null ? Infinity : order.indexOf(n));
      const mine = pos(node.rightOrigin);
      while (i < siblings.length) {
        const theirs = pos(siblings[i]!.rightOrigin);
        if (mine > theirs) break;
        if (mine === theirs && compareIds(node.id!, siblings[i]!.id!) < 0) break;
        i++;
      }
    } else {
      while (i < siblings.length && compareIds(siblings[i]!.id!, node.id!) < 0) i++;
    }
    siblings.splice(i, 0, node);
  }

  /**
   * Depth-first in-order traversal: left children, the node, right children.
   * Iterative, because sequential typing builds right-child chains that are
   * as deep as the run is long and would overflow the call stack.
   */
  private traverse(visit: (n: Node) => void): void {
    const nodes: Node[] = [this.root];
    const steps: number[] = [0];
    while (nodes.length > 0) {
      const top = nodes.length - 1;
      const node = nodes[top]!;
      const step = steps[top]!;
      steps[top] = step + 1;
      const nLeft = node.left.length;
      if (step < nLeft) {
        nodes.push(node.left[step]!);
        steps.push(0);
      } else if (step === nLeft) {
        if (node !== this.root) visit(node);
      } else if (step - nLeft - 1 < node.right.length) {
        nodes.push(node.right[step - nLeft - 1]!);
        steps.push(0);
      } else {
        nodes.pop();
        steps.pop();
      }
    }
  }
}
