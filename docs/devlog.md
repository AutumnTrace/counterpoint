# Devlog

Notes on things that went wrong, or looked wrong, while building this, in
the order they happened. Numbers are from my machine (Ryzen 7 9800X3D,
Node 24.21).

## Milestone 1: the literal algorithm

**A figure-6 test that "failed" for the wrong reason.** The first run of the
paper's figure 6 example (`A`, `B`, `C` inserted concurrently, then `X`
between `A` and `C`) came back `ABC` instead of `AXBC` on one replica. The
algorithm was fine. My test harness delivers ops causally and FIFO per
origin: replica 2 was told to receive replica 1's ops, but `X` depends on `C`,
which replica 2 did not have yet, so `X` stayed queued, and the next call
only delivered replica 3's ops. The test now finishes with a full
`deliverAll()`. Lesson for the rest of the build: when a CRDT test fails,
check the delivery harness before the CRDT.

**What each test actually covers.** Before trusting the suite I broke the
FugueMax sibling rule on purpose (inverted the right-origin comparison).
Only the figure 7 test noticed. The Definition 1 property (forward
non-interleaving) kept passing, which is correct: the order of right-side
siblings with *different* right origins has nothing to do with forward
non-interleaving. Forcing every insert to be a right child of its left
origin, on the other hand, broke the string model test and the typing
session property immediately. Good to know which test guards which rule.

## Milestone 2: the order tree

**The property tests were tiny.** After adding the B-tree, the whole suite,
including 300-run property tests over "histories of up to 400 actions", ran
in about 200 ms. That was too fast. I sampled the generator directly:

```
fc.array(fc.nat(), { maxLength: 400 })   -> avg length 4.9, max 10
fc.array(..., { maxLength: 400, size: 'max' }) -> avg 188, max 398
```

fast-check's default `size: 'small'` caps generated arrays at about 10
elements regardless of `maxLength`. Every history in milestone 1 had at most
10 actions, and the order tree's leaves (128 items) had never split in any
test. All arbitraries now pass `size: 'max'`, and there is a separate "long
histories" case (up to 800 actions with 60-character inserts, documents of a
few thousand elements) so the differential test against `SimpleFugue`
crosses leaf and branch splits. The suite went from 0.2 s to about 3 s.

**Mutating the order tree.** Same exercise as above. Disabling branch splits
survived, which is fine: wide branches are slower, not wrong. Adding an
off-by-one to `indexOf` for branch children larger than 5,000 elements also
survived, because no test built a branch that large; the same off-by-one
for every child that is itself a branch (any tree more than two levels
deep) was caught by both the model test and the invariant checker. The checker (`assertInvariants`) verifies counts, parent
pointers, leaf pointers and the leaf chain after every random run.

**Measuring memory is easy to get wrong.** The first isolated measurement of
"one element object plus its `right: [e]` array" came out at 0.1 bytes per
element. V8 had collected the array I was measuring: the variable was dead
after the loop, and V8's bytecode liveness analysis lets the GC reclaim it
even though it is still in scope. Keeping it alive until after the second
heap reading gave 171 bytes per element. Most of that is because Node does
not enable pointer compression, so every field is 8 bytes. The full trace
measured 316 bytes per element at this point.

**A concurrency benchmark that didn't exercise anything.** The first version
of "two replicas type 10,000 characters at the same spot, then merge" started
from `[]` and typed between the brackets. Both runs became *left* children
of `]`, and placing a left child before its parent never walks a subtree, so
the merge measured nothing interesting. Typing after the last character makes
both runs right children of the same node, so the second one has to be placed
after the last node of the first run's subtree, which is the O(depth) walk
the benchmark is meant to show.

## Milestone 3: sync and encoding

**The first full delta sync was a megabyte.** Encoding every op
individually, the update that brings an empty replica up to date with the
`automerge-paper` trace was 1,026 kB for 102 kB of text. 77,463 single
character deletes at 6-7 bytes each, plus absolute 3-byte counters on every
record. Two changes fixed most of it: counters are stored as deltas from
where that replica's previous record ended (usually 0, so one byte), and
runs of single-character deletes whose targets step by +1 or -1 (forward
delete, backspace) are folded into one record. The update is now 280 kB.

**The snapshot format I designed first lost to the op log.** My first
`save()` wrote the document in document order: the text, deleted spans, the
tree as runs of elements with compact "parent is the element before me"
links, the delete log, and a loader that rebuilt the B-tree bottom-up and
validated the whole structure. It was 312 kB and loaded in 81 ms. The plain
op log in the update format was 280 kB and replayed in 33 ms. The reason:
the document-order encoding found 10,824 runs where the op log has 6,288
insert runs, because inserting into the middle of an earlier run splits it
in document order but not in counter order, and 10,047 of those runs needed
an explicit parent id. I deleted the document-order format (about 330 lines,
along with the bulk loader it needed) and made `save()` the op log with a
different header byte. Loading now goes through the same integration path as
every other op, so there is one less decoder that could disagree with it.

**Making the sync test prove it did something.** The network property test
reorders, duplicates and drops messages, but a test like that can pass
vacuously if, say, buffering never happens. It now counts what the replicas
did across all runs and asserts each path was hit. Typical totals over 300
runs: 4,802 ops applied, 2,404 duplicates ignored, 2,607 buffered, 869
messages lost on cut links. After healing, the replicas must have identical
text, element order, version vectors and *byte-identical snapshots*, which
needed one more change: `changesSince` walks replicas in sorted order instead
of `Map` insertion order, so the regenerated log is canonical.

**Delete ops were the biggest memory cost per op.** Keeping every delete op
for delta sync raised the trace's heap from 55 MB to 79 MB. The log slot for
a delete now stores only the target ranges (the op's own id is implied by the
slot), which brought it back to 72 MB.

## Milestone 4: playground

The first layout put the network panel and the scenario panel side by side
above the editors. At 1280×900 the editors started below the fold, which
defeats the point of watching a partition. The editors are now three
horizontal strips next to the network diagram, stacked like the staves of a
score, which also suited the name.

The editor binding turns `input` events into ops with a prefix/suffix diff,
which is ambiguous with repeated characters: typing `a` at the start of `aa`
looks the same as typing it at the end. For text that is harmless; for a
CRDT it decides which neighbours the character attaches to. Every textarea
edit ends at the caret, so the diff never lets the common suffix extend left
of it. There is a property test for that.

## Milestone 5: the baseline

The concurrent-typing property is run against both implementations: Fugue
must pass, the naive baseline must fail. The first run reported that *Fugue*
failed, with the counterexample `["", 0, "a", "a"]`. The base text was the
empty string and my test adapter called `TextDoc.insert(0, "")`, which throws
by design. The baseline's adapter silently did nothing for empty text, so
only Fugue's side blew up. With the adapter fixed, Fugue passes and the
baseline fails as intended; fast-check shrinks its failure to an empty
document where Ada types `aa` and Ben types `A`, merging to `aAa`.

## Milestone 6: media and numbers

The hero GIF is recorded from the real playground with Playwright and
encoded with gifenc. The first capture had 505 frames with gaps of about
25 ms. Browsers stretch GIF frame delays under 20 ms to 100 ms, so frames
that close together would play back several times too slowly. Frames are
now kept at least 60 ms apart, and each frame stores only the pixels that
changed (the rest is transparent), which keeps the file around 0.3 MB.

The first full benchmark run overlapped with an `npm install`; some rows
came out up to about 10% slower (remote apply 52.5 ms against 48.2 ms on the
rerun). The numbers in the README are from the rerun on an otherwise idle
machine.
