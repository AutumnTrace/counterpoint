# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The delete log stores runs of single-character deletes (backspace or
  forward delete) as one shared range, like the delete-run record on the
  wire. A retained single-character delete now costs 12 bytes instead of
  244 on the replica that made it, and 13 instead of 133 on one that
  received it (`npm run bench:delete-log`). The `automerge-paper` replay
  drops from 72.2 MB to 55.5 MB of heap. Sync messages and snapshots are
  unchanged, byte for byte.

## [0.1.0] - 2026-11-23

### Added

- `TextDoc`: a Fugue / FugueMax text CRDT with index-based `insert` and
  `delete`, `apply` for remote ops, change events and stable anchors.
- An order-statistic B+tree over all elements (tombstones included) for
  O(log n) index lookups, inserts and deletes.
- `SimpleFugue`, a direct transcription of the paper's Algorithm 1, used as
  the oracle in differential property tests.
- Causal delivery: per-replica counters, version vectors, a dependency
  buffer, idempotent re-delivery and trimming of partially seen runs.
- Delta sync with `changesSince` / `encodeChangesSince` and `applyUpdate`.
- Binary encoding (LEB128 varints) for updates, version vectors and
  snapshots; `save()` and `TextDoc.load()`.
- A naive Logoot-style baseline (`@autumntrace/counterpoint/baseline`) that
  interleaves, for comparison only.
- The partition playground: three peers, a simulated network with
  latency, reordering and duplication, a message log, per-peer version
  vectors, a Fugue tree view and a Fugue-vs-baseline interleaving scenario.
- Property tests (fast-check) for convergence, non-interleaving, encoding
  round trips and delta sync; Playwright end-to-end tests; a benchmark that
  replays real editing traces.

[0.1.0]: https://github.com/AutumnTrace/counterpoint/releases/tag/v0.1.0
