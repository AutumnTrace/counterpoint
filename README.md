# counterpoint

A from-scratch TypeScript implementation of the Fugue text CRDT
(Weidner & Kleppmann, [*The Art of the Fugue*](https://arxiv.org/abs/2305.00583)).

Work in progress.

- `packages/counterpoint`: `TextDoc` (Fugue / FugueMax with an order-statistic
  B-tree), causal delivery with version vectors and delta sync, and a varint
  binary encoding for updates and snapshots. `src/reference/SimpleFugue` is the
  paper's Algorithm 1 transcribed directly and serves as the test oracle.
- `apps/playground`: three peers on a simulated network you can partition,
  with latency, reordering and duplication controls, a message log and a view
  of each replica's Fugue tree, and a scenario that runs the same concurrent
  keystrokes through Fugue and through a deliberately naive baseline
  (`@autumntrace/counterpoint/baseline`, dense Logoot-style ids) side by side.

```sh
npm install
npm test          # unit and property tests
npm run dev       # playground on http://localhost:5173/counterpoint/
npm run e2e       # Playwright against the built playground (uses installed Chrome)
npm run bench     # downloads two editing traces first
```
