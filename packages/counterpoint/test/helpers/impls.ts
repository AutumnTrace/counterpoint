import type { Variant } from '../../src/ops.ts';
import { SimpleFugue } from '../../src/reference/simple-fugue.ts';
import type { DocLike } from './cluster.ts';

export interface Impl {
  readonly name: string;
  create(replicaId: string, variant: Variant): DocLike;
}

/** Every implementation the shared behavioural tests run against. */
export const IMPLS: readonly Impl[] = [
  { name: 'SimpleFugue', create: (r, v) => new SimpleFugue(r, v) },
];

export const VARIANTS: readonly Variant[] = ['fugue', 'fugue-max'];
