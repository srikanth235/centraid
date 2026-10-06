# Frozen eval sets

Three sets are scored for every checkpoint: trainfit, val and test, all in `sets/`. They are frozen. The files are the artefact, and a change to any of them is a new version (see "A new version").

Version 7.1 (val) and 6 (test). val: version 7 (gold regenerated from version 6 with the phase-7 runtime (#1044) on 2026-10-03; 42 turns changed in 40 sessions, each by a named convention or a listed fix) plus 23 turns in 20 sessions corrected on 2026-10-04 by verified gold fixes (see the lineage); reference check 2026-10-04. test: version 6 (gold regenerated from version 5 with the stage-2 runtime on 2026-10-02; eleven turns changed, val 8, test 3). The test of version 7 or 8 is not built: the owner deferred the test set until after the phase-7 training run, so test is not scored against the phase-7 runtime until it is. trainfit: drawn anew on 2026-10-03 (seed 0, 9 from each of the 35 train worlds) from the phase-7 train regeneration (`data/README.md`).

## Rules

- Test is scored only at milestones. Nothing is derived on it: no fix, no threshold, no training example.
- Every fix and decision is derived on val, with trainfit beside it.
- No val or test session is trained on. The val worlds are held out whole (`authored/split.py`), and `data/train.jsonl.gz` holds none of the sessions in `sets/`.

## The sets

One session per line: `id`, `set`, `world`, `today`, `me`, `tags`, `turns` (each turn: `user`, `gold`, `ref`, `tags`). A trainfit row also carries `replay`.

| set | file | sessions | turns | worlds |
| --- | --- | --- | --- | --- |
| val | `sets/val.jsonl` | 655 | 2,055 | A 109, B 105, C 105, D 141, T03 65, T12 65, T23 65 |
| test | `sets/test.jsonl` | 656 | 2,075 | A 110, B 105, C 105, D 140, T03 66, T12 65, T23 65 |
| trainfit | `sets/trainfit.jsonl` | 315 | 998 | the 35 train worlds, 9 each |

val and test are the two halves of one pool of 1,311 sessions on the same seven worlds. A to D are in `worlds/`. T03, T12 and T23 are the val worlds of `authored/split.json`, held out of training whole. `sets/split.json` records the split (seed 0, stratified by world and min(turns, 5)) and the origin of every session:

| origin      | sources                                   | pool | val | test |
| ----------- | ----------------------------------------- | ---- | --- | ---- |
| `val-v3.1`  | the authored sessions of T03, T12 and T23 | 391  | 195 | 196  |
| `test-v3.1` | the hand-written sessions of A to D       | 450  | 224 | 226  |
| `e1`        | recipe-authored sessions on A to D        | 470  | 236 | 234  |

The sources are in `sessions/` (`sessions/README.md`). They are provenance only: the sets carry the gold corrections of v3 and v3.1 and the regenerated gold of v5 and v6, which the sources do not.

trainfit is a fixed sample of the training sessions: 12 per train world, all in `data/train.jsonl.gz`, none in val or test. A row is the row of the train build's `<W>.gold.jsonl`. After a train rebuild, `build_sets.py trainfit --keep-ids` refreshes the same sessions. Drawing a new sample is a new version.

## Hashes

```
c518b66426128adc79dd2240570903d6c42880e9f1210912982096193139c550  sets/val.jsonl
fedc45825fc3505d8147ee50560775b6b5e615b94d391dbe06d4d9ad04a8ed20  sets/test.jsonl
c461ca08297e2d26e727eb9fac262d70b40a02461f7d5f4db7a65d475d675a31  sets/trainfit.jsonl
e0685c65c7ce377e1559488760e6ed55a9e3f7b445c2a3daee7be62ba13d5d0d  sets/split.json
```

`python3 build_sets.py check` fails when a file differs from these lines. It also fails on a duplicate id, a wrong `set` field, a session of a train world in val or test, a session of `data/train.jsonl.gz` that is in val or test, a trainfit session that is not in `data/train.jsonl.gz`, a split.json that disagrees with the files or with the sources of its origins, and a gold key that the world's keys file does not have.

## Reference check

A gold item is verified by running its reference calls through the runtime and scoring the run (`run.py --model ref`, then `score.py`). `python3 build_sets.py ref` does this for val, then test, and exits 1 unless both reach 100% of sessions and turns.

| set  | sessions  | turns         |
| ---- | --------- | ------------- |
| val  | 655 / 655 | 2,055 / 2,055 |
| test | 656 / 656 | 2,075 / 2,075 |

Version 6 was checked against the stage-2 runtime (`nativetools`, sha256 `1b3af4607607...`) on 2026-10-02: the refreeze output before it was copied, and the files in `sets/` after, both score 100% on val and test. The val of version 7 was checked against the phase-7 runtime (sha256 `83f2affa7e65...`) on 2026-10-03: 655 / 655 sessions and 2,055 / 2,055 turns; test was not rerun on it.

## Lineage

The first scored sets were the 450 hand-written sessions of worlds A to D (test) and the 391 authored sessions of the val worlds T03, T12 and T23 (val). v3 corrected their gold to the conventions audit (`authored/conventions_audit.md` at commit e464acab). v3.1 applied four convention rulings to the v3 gold (SPEC.md section 14.1: `since` closes at today in an aggregate, end of month, a bare ordinal or month-day in a write, verb applicability). v4 pooled the v3.1 val and test with 470 recipe-authored sessions on worlds A to D and split the pool at random, stratified by world and min(turns, 5), seed 0, so that val and test cover the same seven worlds.

v5 regenerated the gold with the stage-1 runtime (#1044: matching, status, the write path, the session loop). `build_sets.py refreeze` replaced the gold of every turn whose reference run fails it, or passes it but a convention says the gold is a superseded reading, by one accept derived from the run (D-1044-7 to D-1044-10 and the cap of 12 rows). Every change was explained by a convention; a change none explained would have kept the old gold. 13 gold repairs edited the reference calls and the gold of 13 val turns first: ten from the diagnosis of the v3 run, and three the owner ruled on (T23-046 and test-D-097 accept either reading, T12-129 adds the row answer beside the decline). Sessions, turns and the split are v4's. Turns changed, by convention:

| convention  | val | test |
| ----------- | --- | ---- |
| ask-options | 10  | 6    |
| bulk-cap    | 0   | 1    |
| refusal     | 10  | 7    |
| repair      | 13  | 0    |
| status      | 16  | 3    |

The session and turn of every changed turn (ids only):

- val ask-options (10): A-E107 t1, B-E088 t1, B-E088 t3, B-E093 t1, T12-016 t3, T12-085 t3, T23-114 t1, dev-A-063 t3, dev-D-021 t3, test-D-071 t2
- val refusal (10): B-E099 t2, C-E025 t3, T12-012 t2, T12-077 t5, T12-097 t2, T23-055 t1, T23-060 t2, T23-060 t4, T23-098 t1, test-C-061 t2
- val repair (13): C-E050 t2, D-E008 t2, T03-019 t1, T03-043 t1, T03-088 t2, T12-127 t3, T12-129 t3, T23-046 t1, T23-050 t5, T23-055 t2, T23-077 t5, test-B-060 t3, test-D-097 t1
- val status (16): A-E034 t3, A-E086 t1, A-E109 t1, A-E109 t3, B-E070 t3, B-E077 t1, B-E077 t4, D-E082 t1, T03-025 t2, T03-025 t3, T12-073 t5, T12-073 t6, T12-080 t2, dev-A-002 t3, dev-A-090 t1, test-C-092 t1
- test ask-options (6): A-E017 t3, A-E021 t4, B-E036 t3, B-E092 t1, T03-105 t1, dev-D-040 t1
- test bulk-cap (1): test-D-013 t3
- test refusal (7): B-E051 t2, C-E024 t1, C-E043 t2, C-E044 t2, D-E032 t1, T12-028 t5, test-C-058 t2
- test status (3): B-E082 t1, D-E054 t1, T12-053 t4

v6 regenerated the gold with the stage-2 runtime (#1044: container readouts, status words, `next`, `last one`). `build_sets.py refreeze` ran the reference check, and every changed turn carries a convention; UNEXPLAINED is 0 and name-match is 0. 11 turns changed in 11 sessions, all of them turns the old gold failed; none passed and was tightened. Sessions, turns and the split of val and test are v5's.

trainfit was drawn anew (seed 0, 12 per train world) from the train rebuild of the same version: the rebuild adds collision rows to the train worlds (`authored/gen/collide.py`) and a session whose gold change no convention explains is dropped, 176 of 3,869 (4.5%, 98 of them a listing or count that now includes a collision row, 34 a write the runtime answers with a name question), and 17 of the 300 sessions of v5's sample were among them, so `--keep-ids` refused. The train data is `data/train.jsonl.gz` (3,693 sessions); `data/README.md` records its build. Turns changed, by convention:

| convention | val | test |
| ---------- | --- | ---- |
| container  | 6   | 3    |
| next       | 2   | 0    |

The session and turn of every changed turn (ids only):

- val container (6): A-E044 t2, T03-014 t3, T03-051 t1, T03-070 t2, T03-131 t5, T12-083 t1
- val next (2): C-E005 t2, D-E132 t1
- test container (3): B-E055 t1, T03-057 t1, T12-059 t2

The per-turn change list of v3 (every edited turn, its old and new gold, the reason) is the `CHANGES.md` of the v3 eval directory at commit e464acab. It is evidence, not state, and is not copied here. The change lists of v5 and v6, with the text of their val turns, is kept the same way.

v7 (val only; run 2026-10-03 with the phase-7 runtime: val 655 sessions, 2,055 turns, 42 turns changed in 40 sessions, 15 that failed the old gold and 27 that passed it and were tightened; by convention composed-answer 9, composed-ask 6, composed-refusal 3, container-or-row 1, due-active 2, focus-wins 1, group-or-value 2, narrowed-balance 5, refusal 2, superlative 10, what-else 1, and the fixes below; UNEXPLAINED 0, name-match 0. The test half was not run: the test set is deferred, see the header) applies the gold rulings of the persistent-failure read ([D-1044-13](../../../../docs/decisions.md)). It changes gold in three ways, all in `regen.py`, none by hand in `sets/`:

v7.1 (val only; run 2026-10-04 with the phase-7 runtime, sha256 `83f2affa7e65...`: val 655 / 655 sessions, 2,055 / 2,055 turns, UNEXPLAINED 0). A blind audit of the 57 sessions every scored model failed (the phase-6 and phase-7 0.8B runs and a zero-shot frontier probe) and of the frontier probe's failed read and write turns proposed 47 fixes; an adversarial check accepted 23, rejected 18 (no rule decides them, or they would teach a wrong rule: a by-`#n` pick of one instance of a series, a decline of an explicit create, reversals of G10 and G14) and left 6 to the owner. The 23, as `regen.py` FIXES: what-else 5 (G2: A-E011 t3, B-E101 t4, D-E085 t4, D-E100 t4, T03-059 t3), superlative 5 (G3: B-E048 t3, C-E052 t4, D-E093 t3, D-E098 t4, T23-050 t4), who-is-people 6 (SPEC §8.7: A-E004, A-E071, B-E061, C-E052 t1, C-E078 t1, T23-069 t3), A-E051 t1-t3 ("before december" is a plain date bound), D-E036 t1 (G15, the composed ask), test-D-008 t2 (the cap), D-E058 t4 (§8.8, G9), T03-026 t3 (the person's own words). The refreeze changed exactly these 23 turns and two alternative accepts it derived (T03-071 t3 group-or-value, A-E051 t2 superlative). No scored run loses a session: phase-7 424 to 430, phase-6 440 to 444, frontier probe 515 to 528.

- Conventions, rules over the message applied to val and test alike, reported per set by `refreeze` (turns changed, by convention): `messaging` (G1), `what-else` (G2, widened to "besides X" and to rows offered, written or named), `superlative` (G3), `group-or-value` (G4), `container-or-row` (G8), `focus-wins` (G11), `bulk-cap` (G13, a request the message bounds), `due-active` (G23, "what's due <span>" is the active rows), and `composed-ask`, `composed-decline`, `composed-refusal` (slice M1), and four from the blind gold audit of the prepared val (G1, 200 turns judged without the gold): `kindless` (K1, the kind of "what's left this weekend" and "what's still on today": "left" reads the task or event of the turn before, tasks as a first read, "on" is the calendar unless the message goes on), `narrowed-balance` (K2, "just the household one" after a person's balance: the group's net or the person's part in the group's currency), `broken-off` (K3, a request broken off mid-sentence runs only the last complete request) and `bare-plural` (K4, several rows named by a bare plural with no all, every, each, both or everyone are asked about, not written to; the runtime's closed list, read by `test_audit.py`); and `series-ask` (M5d and M5e, ruled on val: a write by the name of a recurring series of events or of tasks, with no date, ordinal, pick word or all-word in the message, is the runtime's ask over the series, and an old gold that wrote to one instance is replaced by it; a pronoun for a name the message itself states is no pick word). `superlative`, `group-or-value`, `container-or-row` and `narrowed-balance` add an accepted alternative beside the gold and never replace it. `messaging`, `due-active` and `kindless` also rewrite the reference calls before the run (`prepare_session`); the rest explain a change the run makes.
- Fixes: the table `regen.FIXES`, val sessions only (no test session was analysed, so none is fixed); a turn with a replaced or added gold is pinned, and a run that fails it is UNEXPLAINED. A rewritten message carries a `rewritten` note with the old text.
- G20 was audited: C-E053 t1 (+872.60 USD, the person's balance, positive = they owe me) and t2 (-872.60 USD, Lukas's net in the Home group, positive = the group owes him) are the same debt under the two conventions of the runtime. No change.

| session | turn | ruling | changes | why |
| --- | --- | --- | --- | --- |
| T03-071 | 3 | G5 | ref+gold | 'break those down by status' follows 'any of those high priority': the narrowed set (@2, two tasks), not the 9 of the first turn (@1) |
| D-E043 | 2 | G6 | ref+gold | 'how many are starred' after 'how many neighbors' counts the neighbors, not everyone saved |
| B-E042 | 3 | G7 | ref+gold | 'we leave on the twenty second then' is a statement: an acknowledgement or an open question, no write and no read of the drive event |
| D-E108 | 3 | G9 | ref+gold | 'and the car registration one' after 'bring it back' carries the verb: a restore, not a read |
| D-E108 | 4 | G9 | ref+gold | the row is back since the turn before: 'that one too' restores nothing (already) |
| D-E106 | 1 | G10 | ref+gold | 'add a note, there's an idea for the garage': the clause is the body; the turn creates the note |
| D-E106 | 3 | G10 | ref+gold | the note of the turn before is the second note created: +2, $c2 |
| D-E106 | 4 | G10 | ref+gold | the note of the turn before is the second note created: +2, $c2 |
| D-E106 | 5 | G10 | gold | the note of the turn before is the second note created: +2 |
| A-E110 | 2 | G12 | add | 'the work one' among notes that mention the roadmap: the note in the Work notebook, or the note named '...at work'; both are defensible |
| A-E110 | 3 | G12 | add | 'add ... to it' follows whichever note 'the work one' picked |
| D-E036 | 1 | G15 | add | 'lucia's birthday is march 3rd': a person has no birthday field, so decline; an event on 3 March is as good a reading |
| T12-098 | 5 | G16 | user | the dates line resolves a bare 'thursday' to this Thursday; the gold meant last Thursday, so the message says so |
| T12-080 | 2 | G17 | add | 'anything else on for this week': what is on is the events as much as the tasks |
| D-E098 | 1 | G18 | add | 'the guadalajara lists': the four packing lists alone, or those and the shopping list |
| T03-073 | 2 | G21 | add | three events of that name and 'sunday' said one turn earlier: the Sunday one, or an ask with the two upcoming ones |
| D-E134 | 4 | G11 | ref (gold derived) | right after the user starred the guest wifi, 'the wifi password' is that one: focus wins over an ask (the gold is derived: focus-wins) |
| D-E053 | 3 | G13 | ref (gold derived) | 'just the ones i already finished' is bounded by its wording: the write is a delete of the completed tasks, and the runtime's cap asks (the gold is derived: bulk-cap) |
| D-E066 | 1 | A1 | ref+gold | 'tick off update budget spreadsheet, the december numbers are finally done': December singles out the one of five open duplicates due in December (tk742); the reference completes it with a `when`, and the ask over the five stays as an alternative |

M1d-next (D-E132 t1) is the one fix the final runtime asked for: a "next" no longer redirects a call linked to a row of another kind, so "book club members, for the invite to the next one" answers the group's five members, not the empty answer of the old runtime. A1 is the one gold-wrong turn of the blind audit that v7 did not already repair (A-E002 t1 is repaired by `due-active`, C-E013 t1 by `composed-refusal`). Not applied: G14 (keep), G19 (keep), G22 (wait for P1.5), G24 (none). Every fix is val; a fix lists a ref only where the old reference could not reach the new gold.

Run it with the phase-7 runtime (`NATIVETOOLS` the binary, `EVAL_VAULTS` the seeded vaults of `seed_worlds.py`):

```
python3 regen.py refreeze --out OUT --jobs 8     # prepares val and test into OUT/pre, runs the reference, writes OUT/sets
python3 build_sets.py ref --sets-dir OUT/sets    # 100% of sessions and turns, or a gold error or a runtime bug
```

`OUT/prepared.md` lists what was prepared (val with the reason of every turn, test with ids and conventions), `OUT/sets/changes.md` what the conventions changed. Any UNEXPLAINED turn keeps its gold and exits 1. Then copy `OUT/sets/val.jsonl` and `test.jsonl` into `sets/`, record the counts and hashes here, and run `python3 build_sets.py check`.

v8 (prepared, not yet run: the test counts, the hashes and the reference result are filled in when `freeze-v8` has run) makes test world-disjoint from val ([D-1044-14](../../../../docs/decisions.md)). Six phases of fixes were derived on val's seven households, and the test of v4 to v7 (a random half of one pool) sat on the same seven, so it could not tell a harness tuned to those households from one that generalises. Nothing already derived is redone: the gold of v7 is kept.

- val is the v7 val and the v7 test folded into one set: 1,311 sessions and 4,130 turns on A 219, B 210, C 210, D 281, T03 131, T12 130, T23 130 (655 sessions of the v7 val, then 656 of the v7 test). Ids, origins and gold are v7's; the `set` field of the 656 sessions that were test is the only byte that changes. `sets/split.json` is version 8: every session records its origin and `v7`, the half it was in, and `folded` records the 656 that came from test.
- test is the e2 sessions: the sources `sessions/e2/<W>*.py`, about 120 per world on E and F (ordinary households) and G (a large one, D-sized), written blind to val and to every fix with the e1 recipe and a hardness brief, ids `<W>-E001` upward, worlds in `worlds/`. They go through the reference run with the conventions of D-1044-13, the four of the blind audit (K1 to K4) and `series-ask` included, and never its fixes (`regen.prepare_session(fixes=False)`); a turn the run fails that no convention explains is UNEXPLAINED and stops the build. No e2 world is a val world or a train world, and no e2 id is a val id.
- trainfit is drawn anew (seed 0): 9 from each of the 35 train worlds of `authored/split.json`, 315 sessions (8 would be 280), from the train regeneration of the same version.
- `build_sets.py check` fails unless val and test are on disjoint worlds, no val or test world is a train world, trainfit holds exactly the train worlds with the same count from each, every val session records its v7 half, and every test session has the origin `e2` (`ORIGINS` knows the sources `sessions/e2/*.py` as it knows `sessions/e1/*.py`). Until the files of v8 and the redrawn trainfit are in `sets/`, `check` fails on the sets of v6 and v7: their halves share every world, and trainfit lacks the train worlds `authored/split.json` has added since.

The text of the sections above that v8 replaces, to take over when the files are in `sets/` (the counts of test and trainfit and the hashes are the run's):

- Rules: test is scored only at milestones and nothing is derived on it; every fix and decision is derived on val, with trainfit beside it; no val or test session is trained on (val is held out whole, test is held out of val and of train, `data/train.jsonl.gz` holds none of the sessions in `sets/`); val and test are on disjoint worlds.
- Sets: val 1,311 sessions, 4,130 turns, A 219, B 210, C 210, D 281, T03 131, T12 130, T23 130; test the e2 sessions, E n, F n, G n (counts at the run); trainfit 315 sessions, the 35 train worlds, 9 each.
- Origins: `val-v3.1` 391, `test-v3.1` 450 and `e1` 470 sessions, all in val (v7: 195 + 196, 224 + 226, 236 + 234 by half); `e2` the test.
- Reference check: val and test each 100% of sessions and turns with the runtime of the run.
- Hashes: `sets/val.jsonl`, `sets/test.jsonl`, `sets/trainfit.jsonl`, `sets/split.json` as `check --sets-dir OUT/sets` prints them (it also writes `OUT/check.txt`).

Run it with the phase-7 runtime (`NATIVETOOLS` the binary, `EVAL_VAULTS` the vault directory; `sets/` holds the pair of v7, or `--sets-dir DIR` does with its val.jsonl and test.jsonl, and `sets/split.json` stands in for a refreeze output that has none), in this order:

```
python3 seed_worlds.py E F G                                  # vaults and keys files of the new worlds (worlds/E.keys.json ...)
python3 build_sets.py freeze-v8 --dry-run [--train-gold 'GLOB']   # reads, compiles, prepares, validates; writes nothing, no runtime
python3 build_sets.py freeze-v8 --out OUT --jobs 8            # the fold, the e2 build; exit 1 on any UNEXPLAINED turn (a new OUT each time)
python3 build_sets.py ref --sets-dir OUT/sets --sets test --jobs 8   # the gate, from scratch: 100% of sessions and turns
python3 build_sets.py check --sets-dir OUT/sets               # hashes to record; trainfit is not there yet
cp OUT/sets/val.jsonl OUT/sets/test.jsonl OUT/sets/split.json sets/
python3 build_sets.py trainfit --train-gold 'TRAIN_OUT/*.gold.jsonl'   # after the train regeneration: sets/trainfit.jsonl, 9 per world
python3 build_sets.py check                                   # after the hashes and counts are recorded above
```

`OUT/prepared.md` lists the turns the conventions rewrote in the test sessions, `OUT/refreeze/changes.md` what they changed in its gold. `--train-gold` on `freeze-v8` draws trainfit into `OUT/sets` in the same run (the dry run then checks that the draw is possible). `--ref-out` reuses a reference run of exactly these prepared sessions; the `ref` gate runs the reference again from scratch whatever was reused.

## A new version

Any change to a file in `sets/` is a new version: new sessions, a gold correction, a different split.

1. Make the change. New sessions: put their source in `sessions/`, then `python3 build_sets.py pool [LABEL=]FILE ... --seed 0 --out DIR` pools the sessions of the FILEs and splits the whole pool into `DIR/val.jsonl`, `DIR/test.jsonl` and `DIR/split.json`. The current val and test keep their origins (from `sets/split.json`); give each new FILE a LABEL. A gold correction: edit the jsonl. A runtime change: `python3 build_sets.py refreeze --out DIR` runs the reference check with the current runtime and writes `DIR/val.jsonl` and `DIR/test.jsonl` with the gold of every stale turn derived from the run, and a change list that names the convention behind each change (an UNEXPLAINED change keeps the old gold and exits 1; a name-match is only reported, with the old gold kept, and exits 1). Check DIR with `python3 build_sets.py ref --sets-dir DIR`, then copy it. Since v8 `check` rejects a val and a test on the same worlds: `pool` is for adding sessions to val's worlds, and the test set is its own worlds (`freeze-v8`).
2. Copy the files into `sets/`. A pool with a new origin needs its sources added to `ORIGINS` in `build_sets.py`.
3. `python3 build_sets.py ref` must report 100% of sessions and turns on val and test. A failing item is a gold error or a runtime bug: fix that, never the check.
4. Record here the counts, the origin table, the hashes, the reference result and, in the lineage, why. `python3 build_sets.py check` passes only when the hashes here are the files' hashes.

trainfit follows the same order with `python3 build_sets.py trainfit --train-gold 'GLOB'` (a new draw, seed 0, 12 per train world) in step 1.
