export { compareIds, formatId, randomReplicaId, sameId } from './id.ts';
export type { Id, IdRange, ReplicaId } from './id.ts';
export { opSpan } from './ops.ts';
export type { DeleteOp, InsertOp, Op, Side, Variant } from './ops.ts';
export { MissingDependencyError, TextDoc } from './text-doc.ts';
export type { Anchor, ChangeEvent, TextChange, TextDocOptions } from './text-doc.ts';
