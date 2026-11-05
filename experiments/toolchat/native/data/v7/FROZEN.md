# data-v7: the frozen eval sets S2 was judged on

Two sets were scored for every S2 checkpoint: val and test. They are frozen: the files are the artefact, and the tree holds only their hashes. They are held out. `python3 ../../artefacts.py fetch` brings them from the private data version its manifest pins (`artefacts.json`, `data-v7`, R-1088-16) into this directory, and `artefacts.py check` verifies them against the hashes below. `crates/assist-eval` reads `val.jsonl` and `worlds/` here by default.

The Python that built, refroze and checked them (`eval/build_sets.py`, `regen.py`, `score.py`, `authored/`) is retired (#1171). The sets are not rebuilt, and a new data version is made only by `cargo run -p centraid-datagen -- build --version vN`. The per-turn change lists and the commands of the old tooling are in git history, at the commit before the one that retired it.

Version 7.4 (val) and 6 (test). val: gold regenerated on the nt15 runtime on 2026-10-06 under the owner's rulings of that day, descending from version 7 (gold regenerated from version 6 with the phase-7 runtime (#1044) on 2026-10-03; 42 turns changed in 40 sessions) plus 23 turns in 20 sessions corrected by verified gold fixes on 2026-10-04. test: version 6 (gold regenerated with the stage-2 runtime on 2026-10-02). The test of version 7 was never built: the owner deferred it until after the phase-7 training run. The planned v8 (test world-disjoint from val) was never run and is not pursued: datagen's val, test and noise splits replace it.

## Rules

- Test is scored only at milestones. Nothing is derived on it: no fix, no threshold, no training example.
- Every fix and decision is derived on val.
- No val or test session is trained on. The val worlds (T03, T12, T23) were held out of training whole.

## The sets

One session per line: `id`, `set`, `world`, `today`, `me`, `tags`, `turns` (each turn: `user`, `gold`, `ref`, `tags`). `worlds/` holds the world JSON the sessions run in (A to G, T03, T12, T23).

| set | file | sessions | turns | worlds |
| --- | --- | --- | --- | --- |
| val | `val.jsonl` | 655 | 2,055 | A 109, B 105, C 105, D 141, T03 65, T12 65, T23 65 |
| test | `test.jsonl` | 656 | 2,075 | A 110, B 105, C 105, D 140, T03 66, T12 65, T23 65 |

val and test are the two halves of one pool of 1,311 sessions on the same seven worlds. `split.json` records the split (seed 0, stratified by world and min(turns, 5)) and the origin of every session:

| origin      | sources                                   | pool | val | test |
| ----------- | ----------------------------------------- | ---- | --- | ---- |
| `val-v3.1`  | the authored sessions of T03, T12 and T23 | 391  | 195 | 196  |
| `test-v3.1` | the hand-written sessions of A to D       | 450  | 224 | 226  |
| `e1`        | recipe-authored sessions on A to D        | 470  | 236 | 234  |

The sources of these sessions are not kept (R-1088-16, and the authored recipes were deleted in #1171): the sets carry the gold corrections of v3 and v3.1 and the regenerated gold of v5, v6 and v7, which those sources do not.

## Hashes

```
5d3d9035737ad0de19d4cf0406316e3b4b27f55a4cb2e64320126cda89308502  val.jsonl
fedc45825fc3505d8147ee50560775b6b5e615b94d391dbe06d4d9ad04a8ed20  test.jsonl
e0685c65c7ce377e1559488760e6ed55a9e3f7b445c2a3daee7be62ba13d5d0d  split.json
```

`python3 ../../artefacts.py check` fails when a file differs from `artefacts.json`, which pins the same bytes.

## Lineage

- v3 corrected the gold of the first scored sets (the 450 hand-written sessions of A to D, the 391 authored sessions of the val worlds) to the conventions audit; v3.1 added gold fixes.
- v5 regenerated the gold with the stage-1 runtime (#1044: matching, status, the write path, the session loop): val 41 and test 17 turns changed by a named convention (ask-options, bulk-cap, refusal, repair, status).
- v6 regenerated the gold with the stage-2 runtime (container readouts, status words, `next`, `last one`): val 8 and test 3 turns changed.
- v7 (val only, 2026-10-03, phase-7 runtime): 42 turns changed in 40 sessions. v7.1 (2026-10-04) added 23 turns in 20 sessions after a blind audit of the 57 sessions every scored model failed. v7.2 and v7.3 are refreezes on the nt8 and nt10 runtimes (v7.3 with four owner rulings that add accepted alternatives). v7.4 (2026-10-06, nt15) applies the owner's rulings of that day: conventions (`messaging`, `what-else`, and others), a table of val-only gold fixes, and G20's two conventions for the same debt.
- The exact per-turn lists (every changed turn, its old and new gold, the reason) were in the previous version of this file and in the `CHANGES.md` of the v3 eval directory at commit e464acab; they are evidence, not state, and are in git history.
