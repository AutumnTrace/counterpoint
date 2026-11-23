import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffText } from '../src/diff.ts';

const apply = (s: string, d: { index: number; deleteCount: number; insert: string }) =>
  s.slice(0, d.index) + d.insert + s.slice(d.index + d.deleteCount);

describe('diffText', () => {
  it('uses the caret to place an edit among repeated characters', () => {
    expect(diffText('aa', 'aaa', 1)).toEqual({ index: 0, deleteCount: 0, insert: 'a' });
    expect(diffText('aa', 'aaa', 3)).toEqual({ index: 2, deleteCount: 0, insert: 'a' });
    expect(diffText('abba', 'aba', 1)).toEqual({ index: 1, deleteCount: 1, insert: '' }); // backspace
    expect(diffText('abc', 'x', 1)).toEqual({ index: 0, deleteCount: 3, insert: 'x' }); // select all, type
  });

  it('always reproduces the new text, and finds the exact splice given the caret', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', '\n'), maxLength: 20 }),
        fc.nat(),
        fc.nat(),
        fc.string({ unit: fc.constantFrom('a', 'b'), maxLength: 5 }),
        (before, i, n, insert) => {
          const index = i % (before.length + 1);
          const deleteCount = n % (before.length - index + 1);
          const after = before.slice(0, index) + insert + before.slice(index + deleteCount);
          const d = diffText(before, after, index + insert.length);
          expect(apply(before, d)).toBe(after);
          // The splice found may be shorter (shared characters) but never
          // extends past where the edit really ended.
          expect(d.index + d.insert.length).toBeLessThanOrEqual(index + insert.length);
        },
      ),
      { numRuns: 500 },
    );
  });
});
