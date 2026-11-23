# counterpoint

A from-scratch TypeScript implementation of the Fugue text CRDT
(Weidner & Kleppmann, [*The Art of the Fugue*](https://arxiv.org/abs/2305.00583)).

Work in progress. This first cut is the paper's Algorithm 1 transcribed
directly (`SimpleFugue`, O(n) per operation), with the FugueMax sibling rule,
plus property tests for convergence and non-interleaving.

```sh
npm install
npm test
```
