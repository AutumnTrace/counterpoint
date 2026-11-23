export { TextDoc, MissingDependencyError } from './text-doc.ts';
export type {
  Anchor,
  ApplyStatus,
  ApplySummary,
  ChangeEvent,
  TextChange,
  TextDocOptions,
  TreeNode,
} from './text-doc.ts';
export { DecodeError, decodeUpdate, decodeVersion, encodeUpdate, encodeVersion } from './encoding.ts';
export { dominates, mergeVersions, sameVersion, versionOf } from './version.ts';
export type { VersionVector } from './version.ts';
export { compareIds, formatId, randomReplicaId, sameId } from './id.ts';
export type { Id, IdRange, ReplicaId } from './id.ts';
export { opSpan } from './ops.ts';
export type { DeleteOp, InsertOp, Op, Side, Variant } from './ops.ts';
