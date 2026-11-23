# counterpoint

A from-scratch TypeScript implementation of the Fugue text CRDT
(Weidner & Kleppmann, [*The Art of the Fugue*](https://arxiv.org/abs/2305.00583)).

Work in progress.

- `TextDoc`: Fugue / FugueMax with an order-statistic B-tree for index lookups,
  change events and stable anchors.
- `SimpleFugue` (`src/reference/`): the paper's Algorithm 1 transcribed
  directly, O(n) per operation. Used as the oracle in differential tests.

```sh
npm install
npm test
npm run bench -w @autumntrace/counterpoint   # downloads two editing traces first
```
