/**
 * Turns "the textarea used to say `before`, now it says `after`, and the
 * caret ended up at `caret`" into one splice.
 *
 * Plain prefix/suffix matching is ambiguous when characters repeat: typing
 * "a" at the start of "aa" looks the same as typing it at the end. For text
 * that is harmless, but for a CRDT it decides which neighbours the new
 * character attaches to. Every edit a textarea makes (typing, paste,
 * backspace, delete, cut) ends at the caret, so the common suffix may not
 * reach left of it; that pins the edit to where the user actually was.
 */
export interface Splice {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

export function diffText(before: string, after: string, caret: number): Splice {
  const maxSuffix = Math.min(before.length, after.length, Math.max(0, after.length - caret));
  let suffix = 0;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const maxPrefix = Math.min(before.length, after.length) - suffix;
  let prefix = 0;
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  return {
    index: prefix,
    deleteCount: before.length - suffix - prefix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
