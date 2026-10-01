# Data-generation brief: what the training set is for, and when it is done

This is the brief for the _data set_. `BRIEF.md` is the brief for the _authors_ who write individual sessions; it must stay consistent with this document, and where they disagree this one wins.

## Goal

Produce a training set from which Qwen3.5-0.8B learns the general skill of driving the nativetools runtime, so that the fine-tuned model passes at least 90% of held-out test sessions it has never seen. The set is defined from the call grammar, the runtime's observable behaviour and a product-realism spec that we write ourselves. It is never defined from the test data.

## The three sets

Three names, no others: train, val, test.

| Set | What it is | Size | Use |
| --- | --- | --- | --- |
| Train | The authored worlds not in val (`authored/split.json`) | 25 worlds today; target 2,000-3,000 sessions across train | Learning |
| Val | Whole authored worlds held out of training: T03, T12, T23 (large, mid, small by rows; `authored/split.py`) | 391 sessions, 1,308 turns | Every fix, every decision, checkpoint picking |
| Test | The earlier hand-written sessions, worlds A to D (`eval/sets/test.jsonl`, frozen) | 450 sessions, 1,309 turns | Scored only at milestones |

Val is whole worlds, never a slice of a world: a world's people, places and rows are shared by all its sessions, so a random slice would leak them into training. `authored/split.py` picks the val worlds by a deterministic rule and writes `authored/split.json`; everything that builds or reads training data drops val worlds through its `drop_val` helper. `eval/build_sets.py` compiles `eval/sets/val.jsonl` in the eval session format (gold included), and val is scored exactly like test: `eval/seed_worlds.py` seeds the val worlds, then `eval/run.py --set sets/val.jsonl` and `eval/score.py`. The old generated corpus (`native/data/final/*.jsonl.gz`) is not mixed in.

Test is read only at milestones, for the final score and the distribution gate in §6, which is a pass/fail check run once per wave, never an optimisation target. Nothing measured on test (feature rates, gap rankings, embedding drift) may be used to shape train during authoring. All fixes, threshold choices and gap decisions are derived on val, which the model has not trained on.

The checkpoint trained before the split existed saw all 28 worlds, val worlds included. Its val numbers are inflated and are not a baseline; only a checkpoint trained without the val worlds gives an honest val score.

## What the model must learn

1. **The grammar.** Every tool, parameter, verb, kind, `where` field and operator, enum value, date shape, decline reason, `compute` op, `linked_to`, `undo`.
2. **The runtime's behaviour.** What comes back and what to do about it: `ambiguous:` replies, empty results, `already` (no-op writes), refused deletes, the 30-day restore window, trashed rows, unit rules on `where`, `linked_to` meaning _all_, named-month semantics, event non-overlap, photo undo restoring albums, knock-on diffs.
3. **Turn discipline.** Which calls end a turn (answer, ask, decline, a changing write) and which keep it open (`more=`, find, search, open, compute, an already-so write). When to `ask` with options instead of acting. When to `decline`, with which reason. How to repair after the runtime rejects a call.
4. **Conversation.** Carrying a referent across turns (`@prev`, `$new`, pronouns, "the second one"), multi-call turns, reading back a row just written, sessions of varying length.

## Acceptance criteria

The set is accepted only when every criterion below holds. They are checked on each pilot wave before scaling and again on the full set. A failed criterion is fixed by changing an authoring rule in `BRIEF.md`, the world spec or the generator, never by hand-editing counts toward a number.

### 1. Verification: 100%

Every session replays through the reference backend (`build.py`) and passes its own gold at every turn. A failing session is fixed or discarded. No record is emitted from an unverified session.

### 2. Scenario coverage: every reachable cell

Coverage is measured on _scenario cells_, not on single productions. A cell is a combination from one of the tables below. The universe of each table is derived from a fresh `nativetools export` plus the runtime rules, and the tool lists the unreachable cells explicitly so that "missing" and "impossible" are never confused.

Requirement: every reachable cell appears **at least 3 times corpus-wide, from at least 2 different worlds**. An uncovered reachable cell is a failure, not a warning.

| Table | Dimensions | Notes |
| --- | --- | --- |
| A. Act | verb × kind × selector | selector ∈ {named row, `where` filter, `@prev`, `$new`, multiple rows}. `create` has no selector. |
| B. Where | field × operator × value form | value form ∈ {literal, relative date, enum, unit-bearing, link count}. Includes the refused forms (`1 hour`, `2 weeks`) as repair turns. |
| C. Dates | kind × date shape | all points and all span shapes, including named-month rel 0/1 and open spans, on every kind with a date field. |
| D. Tool outcome | tool × outcome | answer {rows, value, empty}; find {hit, miss, ambiguous}; search {hit, miss}; act {changed, already, refused, ambiguous}; compute {each op}; ask {with, without options}; decline {each reason}; undo {after each verb class}. |
| E. Runtime behaviour | behaviour × kind | ambiguous, empty result, trashed row, restore window, refused delete, knock-on diff, `linked_to` all-semantics, photo undo, event overlap, on every kind where the runtime can produce it. |
| F. Conversation | structure | cross-turn referent by `@prev` / pronoun / ordinal; calls per turn 1, 2, 3, 4+; `more=` continuation; repair mid-session; write then read of the same row; session length 1–7. |
| G. Phrasing | verb × kind, tool × outcome | each reached in at least two of the three moods (direct command, question, indirect "can you"), and both with and without the row named verbatim wherever the turn names a row (not undo, decline, ask, compute). |

Order of magnitude: about 1,500–2,000 reachable cells. At 3 uses each and about 4 calls per session that is the 2,000–3,000 session target.

### 3. Runtime behaviours observed, not just authored

Measured on the replay (`replay_summary`), corpus-wide:

- turns where the runtime said `ambiguous:` — 3–7%
- turns with an empty-result recovery — at least 3%
- turns touching a trashed row — at least 5%
- sessions containing a repair (a rejected call followed by the correct one, vault refusals included) — 8–16%
- at least one `undo` per world

### 4. Shape of the corpus (product-realism spec)

These are our own targets for a believable personal assistant, not copies of test rates.

- session length spread over 1–7 turns; no single length above 40% of sessions
- turn outcomes mixed across answer-rows, answer-value, write, write+read, ask, decline, find-only; no outcome above 45% of turns
- asks 5–10% of turns
- at least 30% of user messages name a row verbatim; at least 30% refer by description, pronoun or ordinal
- every world has 15–20 locker items covering every locker type, and enough rows per kind that `where` filters return 0, 1 and many

### 5. Think traces are generated by code

Every `<think>` line in a training record is produced by `derive_think` in `build.py` from the call, the runtime's previous observation and the gold, deterministically. No model (Claude or any other) writes reasoning prose for training data, and authors do not write think text in the gold. A record whose think line cannot be derived is a build failure.

### 6. Distribution gate: AUC ≤ 0.70

After each wave, train a bge-small + cross-validated logistic-regression classifier to separate train user messages from test user messages. Every word of a row name or nickname from any world, train or test, is masked in both sets first: train and test use different people and places by design (§7), so unmasked text measures which world a message comes from, not how requests are phrased. Reference: the two halves of test (the old `dev` and `test` sessions), two independent samples of the same task, scored 0.50 masked (0.61 unmasked). The unmasked figure is printed for reference only.

- ≤ 0.70: pass
- 0.70–0.75: read the top-weighted features and fix the authoring rule behind them
- > 0.75: the wave is rejected

The fix is always a rule change in `BRIEF.md` or the spec. A count or a phrasing is never copied from test. Earlier standings (unmasked): wave 1 0.74, wave 2 0.78, old generated corpus 0.82.

### 7. Test-set hygiene

No test world file, row name or user phrasing appears in train. For user messages of six or more words, an exact match or a near-duplicate (cosine ≥ 0.95, bge-small) is a failure. Shorter messages ("how many is that", "and tuesday?") collide by nature of the task and are not counted.

### 8. Reproducibility

The full set rebuilds from the world builders, the session files and `build.py` alone, with identical output. Loss masks (`loss: False` on the bad call of a repair) are part of the record.

## Final acceptance

The fine-tuned model, quantised to Q4_K_M and run under llama.cpp within the phone latency budget, passes at least 90% of the 450 test sessions in a single scoring run. Test is read for scoring at milestones and at this point, not for tuning.

## Non-goals

- Matching test feature rates.
- Minimising drift against test as an iteration loop.
- Filling gaps ranked by test-set misses.
- Reasoning traces authored by a model.
- Reference operators or Qwen2.5 as data sources.

## Tooling this brief requires

- `coverage.py`: replace the one-dimensional tallies and the `--targets` option with tables A–G, a reachability list per table, and a failure report of uncovered reachable cells.
- `BRIEF.md`: remove the "Targets" section (test-derived rates) and rewrite "Coverage" to assign cells to worlds by rotation so every cell has two worlds.
- The solution-space page: drop the test columns; it compares train against the universe only.
- The drift check: keep as the §6 gate, run once per wave.
