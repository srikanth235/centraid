# Eval session sources

Provenance of the scored sets in `../sets/` (frozen, see `../FROZEN.md`). The sessions are in the vocabulary of `../gold.py`: a session is its turns, each turn a user message, the accepted effects (gold) and the reference calls (ref).

The frozen jsonl in `../sets/` is the artefact. The v3 and v3.1 gold corrections were applied to the jsonl and are not in these sources, so a rebuild from them does not reproduce `sets/val.jsonl` or `sets/test.jsonl`. `../build_sets.py check` compares session ids only: every session of the sets must come from a source listed here, and every source session must be in a set.

| source | sessions | what |
| --- | --- | --- |
| `A.py`, `B.py`, `C.py`, `D_dev.py`, `D_test.py` | 450 | hand-written on worlds A to D (109, 100, 100, 41, 100). Ids keep the names they were written under (`dev-A-001`, `test-B-001`, ...); the prefix is not a split. Origin `test-v3.1` in `sets/split.json`. |
| `e1/A*.py`, `e1/B.py`, `e1/C*.py`, `e1/D*.py` | 470 | recipe-authored on worlds A to D (110, 110, 110, 140; ids `A-E001`, ...) with the recipe of `authored/BRIEF.md`, written and checked with `authored/evalkit`. All 470 are in val or test. Origin `e1`. |
| `authored/sessions/T03*.py`, `T12*.py`, `T23*.py` | 391 | the authored val worlds (not in this directory). Origin `val-v3.1`. |
| `e2/E*.py`, `e2/F*.py`, `e2/G*.py` | v8 (not yet frozen) | blind-authored on the held-out worlds E, F and G (`../worlds/`), about 120 sessions each, ids `E-E001`, `F-E001`, `G-E001` upward, with the e1 recipe and a hardness brief (`world(..., "eval")`). They become the test set of v8 (D-1044-14), world-disjoint from val: `../build_sets.py freeze-v8` compiles them, prepares them with the conventions and never the fixes, and derives their gold through the reference run. Origin `e2`. |

450 + 470 + 391 = 1,311 sessions, 655 in `sets/val.jsonl` and 656 in `sets/test.jsonl`; in v8 all 1,311 are in val (`sets/split.json` records the half each was in) and test is the e2 sessions. Worlds A to D live in `../worlds/`, T03, T12 and T23 in `authored/worlds/`.
