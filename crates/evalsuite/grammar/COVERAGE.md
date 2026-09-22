# Coverage of the 320 turns

Mapped against **`suite.json` md5 `a83ddd4e25da52b6f415b8a4c9409aad`** and **`blind.json` md5 `f07d889fddce64000690fe03f7bc8884`**. `map.json`'s own `note` carries the same two digests and `check.py` regenerates every tree from the canonical, so a corpus edit that this file has not seen shows up as a digest that does not match rather than as a map nobody re-read.

`python3 crates/evalsuite/grammar/check.py` → **434 canonicals parsed, 0 uncovered, 0 failures** (2026-09-21, Lane M; it was 430 / 4 / 0), against the 175 typed commands read live out of `crates/vault/src/commands`. The four turns that were uncovered are **closed by §8**: the owner ruled on 2026-09-21 that the two constructs they needed are additions the ontology supports, and both are now in the grammar.

**Re-mapped 2026-09-21 (Lane R).** The §5 findings 1, 2, 3, 5 and 6 were acted on rather than filed: `same?` is in the grammar and `s31.1` is covered, `b21` carries its own antecedent, `s13`/`s14`/`b18` agree on the kind, `s29`/`s68` derive their window, and five `undo` sessions (`s86`–`s90`) reach the five restore commands. The headline below is restated for the corpus as it now is; the per-category and skeleton tables in §1 and §4 are from the 200-turn pass and have NOT been recomputed, so they are a reading of the older corpus.

---

## 1. Headline

|              | covered | total   |
| ------------ | ------- | ------- |
| `suite.json` | **245** | 248     |
| `blind.json` | **72**  | 72      |
| **both**     | **317** | **320** |

The suite grew by 109 turns on 2026-09-21 (Lane C: 15 `cross_app` sessions and 15 `deep` ones). Their own numbers are in §6; the tables immediately below are the 200-turn pass and have not been recomputed.

The uncovered turn is gone: `s31.1` is covered by the `same?` addition ([GRAMMAR.md §1.1](GRAMMAR.md)), which is the 13th construct a corpus turn forced and the only one that is not a `Set` at all.

The blind set is a holdout on the grammar and it came out at **71/71**, with **28 of its 58 skeletons unseen in the suite**. That is the useful number in this document: the grammar was written against the ontology and then checked against a corpus authored by someone who had not read the corpus it was tuned against, and it did not need an addition to absorb it.

### by category

| category                | suite   | blind   | both        |
| ----------------------- | ------- | ------- | ----------- |
| `abandonment`           | 11 / 11 | 2 / 2   | 13 / 13     |
| `abstract_temporal`     | 12 / 12 | 9 / 9   | 21 / 21     |
| `ambiguity_clarify`     | 10 / 10 | 2 / 2   | 12 / 12     |
| `correction`            | 5 / 5   | 0 / 0   | 5 / 5       |
| `cross_app_hop`         | 13 / 14 | 1 / 1   | **14 / 15** |
| `deictic`               | 6 / 6   | 2 / 2   | 8 / 8       |
| `locker_only`           | 6 / 6   | 4 / 4   | 10 / 10     |
| `mixed_read_write`      | 11 / 11 | 4 / 4   | 15 / 15     |
| `narrowing_followup`    | 11 / 11 | 2 / 2   | 13 / 13     |
| `reference_into_result` | 9 / 9   | 5 / 5   | 14 / 14     |
| `refusal`               | 6 / 6   | 2 / 2   | 8 / 8       |
| `single_read`           | 9 / 9   | 17 / 17 | 26 / 26     |
| `value_read`            | 9 / 9   | 6 / 6   | 15 / 15     |
| `write_only`            | 5 / 5   | 12 / 12 | 17 / 17     |
| `write_set`             | 5 / 5   | 3 / 3   | 8 / 8       |

### by expectation type

| expectation | suite   | blind   | both        |
| ----------- | ------- | ------- | ----------- |
| `ids`       | 68 / 68 | 41 / 41 | 109 / 109   |
| `write`     | 22 / 22 | 18 / 18 | 40 / 40     |
| `no_action` | 22 / 23 | 5 / 5   | **27 / 28** |
| `value`     | 12 / 12 | 5 / 5   | 17 / 17     |
| `write_set` | 4 / 4   | 2 / 2   | 6 / 6       |

`no_action` splits three ways under the executor rules, and the split is not in the suite's own vocabulary: **9** are `refuse`, **14** are an emitted `clarify`, **5** are `nothing`. Only the five `nothing` turns have `nothing` as their canonical; the other 23 have a real meaning that the executor then declines, which is why they are counted covered.

---

## 2. The turn that was uncovered — and the addition that covers it

**`s31.1` — "is that the same Neha as my dinner on tuesday?"** (suite, `cross_app_hop`, expects `clarify`).

What the grammar lacks: an **identity question between two sets**. The turn is not a retrieval and not a projection — it asks whether two sets denote the same row, and the grammar has neither a boolean `Turn` nor a set-equality `Pred`. Writing it as `show (parties of (it))` would be mapping a different question.

**Added, 2026-09-21.** [GRAMMAR.md §1.1](GRAMMAR.md):

```
Turn := "same?" Set Set        -- executed as an id-set intersection test
```

and the clarify rule is written into the grammar rather than left to the executor: **an intersection over sets of unrelated kinds is `clarify`, never `no`** — two sets are of unrelated kinds when no `Link` (§2.3) joins their entities, and where a link does exist an empty intersection is a real `no`.

with the answer being `yes` / `no` / — under R-C4 — `clarify`, which is what this case wants: nothing relates the Tally member `Neha` to either People party, so the honest outcome is to say the vault cannot tell, not to answer `no`. Two other turns (`s35.0` "is the cabin booked?", `b08.0` "did I do the grocery run?") are also yes/no questions, but the corpus answers both with retrieval, so they need no boolean and are mapped as reads.

---

## 3. Where a suite turn FORCED a grammar addition

These are not accommodations of wording. Each is a construct the ontology supports and a plain `Kind / Link / Field / Pred / Agg` grammar does not reach — so each is signal about the ontology, and each is listed in [GRAMMAR.md](GRAMMAR.md) with the file it is derived from.

| # | addition | forced by | what it says about the ontology |
| --- | --- | --- | --- |
| A1 | `Field around Num` (BAND) | s41 | `effort_min` is an ESTIMATE, and a member who names one names a magnitude. No column and no `<=` expresses that. |
| A2 | anchored `Window` `from (Value) to (Value)` | s45, b16 | trips are not entities; a stay is two calendar rows, and any window over it must be read out of them. |
| A3 | `Set and Set` (union) | s16, s26, s45, s75, s82, b04, b11 | one subject genuinely spans kinds and apps; a per-app answer is the wrong answer. |
| A4 | `Set except Set` + the `the earlier one` ref | s15.2 | "what ELSE" needs the answer two turns back, not the last one. |
| A5 | `Field Cmp Field` | s46 | "never rotated" is a relation between two stamps; the vault records no flag. |
| A6 | `balance of Set in Set` | s67, s74 | what somebody owes is a signed fold over three tables, and `tally::balance` owns it. A grammar that re-derived it would be a second answer. |
| A7 | app-qualified `Kind` (`journal notes`, `members`) | s81, b31, s31, s43 | one entity behind two doors returns different rows; collapsing them loses rows the vault holds. |
| A8 | `next_occurrence` derived Field | s84, s85, b16 | `people_important_date` stores `month_day`. Without a projection there is no date to compare. |
| A9 | per-row `Args` binding (R-W2) | s74 | one instruction, three different amounts — the argument is a function of the anchor row. |
| A10 | verb CLASSES (`reschedule`, `delete`) | s02.1, s08, s36, s49.1, s72.1, s75, b47, b54, b59.1 | the member names an EFFECT before anyone knows the kind, and in this vault a title can be both a task and an event. |
| A11 | `nothing` as a third declination (R-N1) | s37 | "already in the trash" is neither a question nor a refusal. |
| A12 | the top kind `things` + R-T1/R-T2 | s03, s16, s26, s35, s36, s45, s82, b11 | a broad noun and a bare day window both reach across doors, and the FTS plane cannot answer either (no Locker domain, no place index). |

Two of these are load-bearing far beyond their turn count. **A7** and **A12** together are the reason the anchored-search design in the harness brief cannot be the whole runtime: seven of eight apps have a search domain, and the grammar needs eight doors plus two door-qualified kinds to say what the corpus asks.

---

## 4. Shape of the meaning space

Over the 199 covered canonicals:

**Set-expression depth** (constructors nested; the §1 bound is 5):

| depth                           | turns |
| ------------------------------- | ----- |
| 0 (a bare `nothing` / `refuse`) | 22    |
| 1                               | 15    |
| 2                               | 111   |
| 3                               | 35    |
| 4                               | 15    |
| 5                               | 1     |

**Link walks per turn:** 0 → 159, 1 → 39, 2 → 1. **Filters per turn** (`called` / `that` / `during`): 0 → 46, 1 → 119, 2 → 26, 3 → 7, 4 → 1. **Aggregate wrappers per turn:** 0 → 175, 1 → 22, 2 → 2.

The single depth-5 turn is `s78` (`first 1 of (activities of (parties called …) ordered by started_at desc)`). One walk and one filter is the modal shape; **93% of turns use at most one link walk and at most two filters**. An enumerator bounded at 2 walks / 4 filters / 1 aggregate covers this corpus with headroom, and those are the bounds stated in GRAMMAR.md §1.

### Canonical skeletons

Masking every literal, number, date and ordinal, the 199 canonicals use

> **118 distinct skeletons**

— 90 in the suite, 58 in the blind set, 28 of the blind set's unseen in the suite. **77 skeletons occur exactly once**, which is the number that should temper any claim from this corpus: a retrieval-style runtime whose candidate set is "the skeletons this corpus uses" would be scoring itself on a set where two thirds of the entries have one example.

**118 is the candidate-set size for this corpus** for a retrieval variant that ranks whole skeletons. For a generative variant the relevant number is the enumeration under the §1 bounds, which the terminal counts put far higher — 20 kinds × the FK graph × the field lexicon — so a retrieval variant is only viable if the skeleton set is CLOSED, and this corpus does not establish that it is.

Most-used skeletons:

| × | example |
| --- | --- |
| 8 | `show (notes called ?)` |
| 8 | `show (documents called ?)` |
| 6 | `show (events during ?)` |
| 6 | `show (events called ?)` |
| 5 | `nothing` |
| 5 | `people.log_interaction{…} on (parties called ?)` |
| 5 | `show (expenses of (groups called ?) that (paid_by = (members called ?)))` |
| 4 | `show (tasks that (due_at during ? and status != ?))` |

### Multi-turn

**55 of 200 turns are follow-ups** (45 sessions have more than one turn). By context move:

| move | follow-ups | notes |
| --- | --- | --- |
| `act` | 26 | a `Cmd` or `Value` over the previous answer — the commonest by far |
| `substitute` | 17 | one terminal swapped, shape kept |
| `refine` | 4 | a clause added over the previous ROWS |
| `undo` | 4 withdrawn + 5 rolled back | `s86`-`s90` take back a write that landed; the other four withdraw one that never did |
| `new` | 4 | thread dropped mid-session (s30.1, s51.1, s20.1, s61.1) |

Opening turns: every one of them `new`. The single `refine` that had no antecedent in its own session is gone (§5.1), and `validate-suite` now refuses another.

---

## 5. Findings for the corpus owner

These are not grammar gaps. They are places where mapping every turn onto one meaning space made a disagreement visible.

**All six were acted on by Lane R on 2026-09-21. Each is kept below with what was done, because the finding is the evidence and the fix is the state.**

1. ~~**`b21.0` refines a turn that is not in its session.**~~ **FIXED.** "How much of that did I pay for myself?" is the only opening turn in either corpus whose canonical needs a previous answer, and its antecedent (`b20`) is a DIFFERENT session. The blind reference resolves it through `ctx.history()`, which crosses the session boundary. Either the two belong in one session or the turn needs its own anchor. `b21` now opens with "what have we spent on the Tahoe trip so far?" and the narrowing turn answers inside its own session; `validate-suite` grew an OPENING CHECK that refuses any first turn whose deictic has no antecedent in its own sentence, unless the case expects no action (`b54`, where the missing referent IS the case).
2. ~~**The same question is answered with two different kinds.**~~ **RULED.** `s13.0` / `s14.0` ("do I owe Neha Rao anything?") expect `core.party` ids; `b18.0` — the same sentence — expects `tally.obligation` ids. Both are defensible and the grammar can say either (`parties that (owed_to_them is not null)` vs `obligations of (parties called …)`), but no candidate can satisfy both, and nothing in the corpus says which reading is meant. Ruled for the OBLIGATION: "do I owe X" asks what the debt is, and the party is only who it is owed to. `s13.0` and `s14.0` moved to `tally.obligation`; the Neha disambiguation is untouched, because only one of the three carries a debt.
3. ~~**`s29.0` / `s68.0` use a window with no anchor.**~~ **FIXED.** "From the trip" compiles to the bare literal `2026-06-04..2026-06-06`, because the scouting trip is not an event, an album membership or a memory in the vault — the reference hard-codes the same three days. Every other window in the corpus is either a calendar phrase or anchored to rows (A2). A candidate can only pass these two by knowing the dates, which is knowing the answer. Both now say "the Tahoe trip" and both windows are ANCHORED (A2) to the trip's own ledger: the trip runs from the first thing spent on the Tahoe Trip group to the last. The TRASHED expense counts towards the span — a member who binned the ski rentals still went skiing that day, and a window that moved when a receipt was deleted would be a window nobody could reason about.
4. ~~**`undo` conflates two different moves.**~~ **NAMED.** `s48`'s notes now say it is a CORRECTION and point at `s86`–`s90` for the rollback shape. The four `undo` turns are all WITHDRAWALS — nothing had been written, so nothing is rolled back. The corpus's actual rollback-shaped turn is `s48.1` ("sorry — it was the other Neha"), which is a CORRECTION: the second write stands beside the first and does not undo it. The move vocabulary in the brief has no name for that and this map files it as `substitute`.
5. ~~**Nothing in either corpus exercises a real `undo`**~~ **CLOSED.** Five sessions, `s86`–`s90`, category `undo`, one per command — and the interesting half is what they had to prove: a restored row looks exactly like a row that was never trashed, so the five discriminate three different ways: two name rows the WORLD SEEDS IN THE TRASH (`schedule.restore_task` and `media.restore_asset` stamp nothing at all, so there is nothing to read); two read the REVISION PLANE, where Tally and People record a row before they change it; and the document case scores a REFUSAL, because `core.restore_document` will not restore a document whose grace window has run out and this world seeds no document inside one (DEFECTS #26, #27). Four of the five commands are reached; the fifth's success path is named as unreachable rather than faked. Original finding: — a turn that takes back a write already made. `schedule.restore_task`, `core.restore_document`, `media.restore_asset`, `tally.undo_expense` and `people.undo_person` all exist in the registry and no turn reaches one. For a corpus that scores writes, that is a hole on the write side, not on the grammar side.
6. ~~**`s73`'s verb is not `reschedule`.**~~ **NAMED.** Both sessions' notes now call the pair adversarial and say which verb is which. "Tick off both of Wednesday's dentist tasks" is `schedule.set_task_status`, and the neighbouring `s72` is the reschedule. They share an anchor and differ only in the verb, which is exactly the pair a candidate that pattern-matches on the anchor gets wrong. Worth keeping adjacent and worth naming as a pair in the suite's notes.

---

## 6. The 109 turns Lane C added, and what they cost the grammar

15 `cross_app` sessions (28 turns) and 15 `deep` sessions (81 turns) were mapped as they were written, which is the first time the map has been built BEFORE the reference rather than after it.

|             | turns | covered |
| ----------- | ----- | ------- |
| `cross_app` | 28    | 28      |
| `deep`      | 81    | 78      |

By expectation: **84 `ids`, 16 `write`, 6 `value`, 2 `write_set`, 1 `no_action`**. By context move: **33 open a session, 70 refine or continue one, 6 are DECLARED topic switches** — a turn that wanders carries no pro-form, so the wandering is declared in `suite.json` (`"topic_switch": true`) and `validate-suite`'s depth check reads it rather than being loosened to admit it.

**75 canonical skeletons, 42 of them unseen in the first 200 turns.** The corpus's meaning space got wider, not just longer.

### Terminals the ontology already supported, and that a turn finally needed

Three, all of them facts an app's own reader already computes and hands back beside the row — which is what `FIELDS` admits — plus one window phrase the README's temporal table already published:

| terminal | the door that computes it | the turn that needed it |
| --- | --- | --- |
| `notebooks` | `centraid_apps_notes::queries::load_library` | `s93.1` — a Notes notebook and a Docs folder may share a NAME and hold different rows |
| `owed_to_me` | `centraid_apps_people::roster::load_people` | `s106.0` — the mirror of `owed_to_them`, and the direction the deepened world made load-bearing |
| `place` | `centraid_apps_photos::queries::load_library` | the place-anchored reads, which walk the place ROW and never a word in a title |
| `recently` (window) | `reference::calendar::recently`, README §temporal | `s108.0` — "did I bin anything in the last few days" |

### Three grammar signals — meanings the turn grammar cannot say

Not reworded, because rewording them would have made the corpus smaller rather than the grammar honest.

| turn | the meaning | why the grammar has no room |
| --- | --- | --- |
| `s107.3` | move one row to Thursday **and** another to Friday, in one turn | `s75` is a `write_set` the grammar reaches because ONE verb with ONE argument applies to a union of rows. Two writes with DIFFERENT arguments are two commands, and `turn` has room for one |
| `s113.3` | roll one expense back **and** trash another | the same shape, one layer up: a rollback and a trash are different verbs |
| `s112.1` | "which of these places have I got exactly two photos from?" | a COUNT OVER A WALK, inside a predicate. `pred` admits a literal, a field or a set as an operand, never an aggregate |

The fix for the first two is an ordered `do { … } then { … }` turn, which is the construct an ordered write LOG would need anyway (README, "Ordering _between_ the writes of a `write_set`. REFUSED, not missing"). The fix for the third is admitting `agg` as an operand. Both are additions to the grammar, and neither is made here: a grammar that grows to absorb every turn stops being a measurement of the corpus.

### Two ontology signals the mapping turned up

Neither is a defect of the corpus and both are facts about the product.

1. **The Photos door reports every `core_collection` row as an album.** `load_library` hands back notebooks and folders beside the four real albums, so "what albums have I got?" has twelve answers and no corpus can state one. `s109` opens on a photograph instead and reaches the albums through the frame that is in two of them.
2. **A place nobody named is shown to the member as its own coordinates.** `media.add_asset` mints one place row per rounded coordinate and names it with that coordinate, so the Tallac trailhead appears in Photos as `38.9186, -120.0836`. `s112` asks for the places rather than for the NAMED ones, and its twelfth expected row is that string.

## 7. The 114 turns `holdout.json` added, and the one they could not say

`holdout.json` is the third corpus and the only one written over the SECOND seeded world (`centraid_evalworld::Scenario::Second`) — a disjoint cast, places, weekend away and collision structure, so that one corpus holds out the SCENARIO and not only the wording. **113 of its 114 turns map onto the grammar unchanged**, which is the result worth reporting: the meaning space was derived from the ontology and not from the households, so a whole new household needed no new constructor.

One lexicon gap closed, and it was the CHECKER's and not the grammar's: `WINDOW_PHRASES` was missing `next month`, which `crates/evalsuite/README.md`'s temporal table already publishes. A canonical could not say what the convention already defines.

### The one turn the grammar cannot say

`h61` — _"cottage secured; clear both its reminders away"_ — expects a `write_set` of `task_completed` on the task and `event_cancelled` on the event that share the title "Reserve the Mendocino cottage".

**No Verb CLASS spans them.** A class is derived by grouping the registry on (effect, subject kind) — `delete` is `knowledge.delete_note` for a note and `core.trash_document` for a document because the EFFECT is one thing — and here the effect is not one thing: finishing a task and cancelling an event are different outcomes that happen to be what one sentence asks for about two rows of different kinds. A `Cmd` carries one Verb, so the turn needs either two Turns (which the corpus's unit is not) or a verb class over an effect the ontology does not name.

It is recorded here rather than absorbed. The grammar could be widened with a `retire` class, and should not be on the evidence of one turn: a grammar that grows to absorb every turn stops being a measurement of the corpus.

---

## 8. The four uncovered turns, closed (Lane M, 2026-09-21)

The three §6 signals and the one §7 signal are covered. Two constructs did it, both derived from the ontology and both stated in [GRAMMAR.md](GRAMMAR.md) §1.2 and §2.4:

| turn | the meaning | the construct |
| --- | --- | --- |
| `s107.3` | two rows to two different days, in one turn | `Cmd then Cmd` |
| `s113.3` | roll one expense back, trash another | `Cmd then Cmd` |
| `h61.0` | finish the task and cancel the event of one title | `Cmd then Cmd` |
| `s112.1` | "which of these places have I got exactly two photos from?" | `count of Kind Cmp Num` |

`then` rather than `and`: the ORDER is part of the meaning (`s113.3` must restore before it trashes) and `and` is already the union inside a `Set`. `count of Kind` as a PREDICATE rather than an aggregate operand: the walk's source is the row being filtered, so the grammar needs no correlated-reference terminal — which is the widening §6 was right to refuse.

Covering these four moved the oracle's ceiling on all three corpora to 100% (suite 114→120 of 120 sessions, holdout 73→78 of 78; blind was already 60/60). Three of the six suite sessions it gained were gained by the CASCADE: `s112`, `s107` and `s113` each had a later turn that could only be right if the uncovered turn in front of it had run.

## 9. Conventions, and a precedence bug (Lane M, 2026-09-21)

`GRAMMAR.md` grew a §5, "Conventions the corpus follows": three owner rulings (C1 "due" means open, C2 a referent's number follows the rows written, C3 "what's on <weekday>" is `things`) and eleven clarifications of rules §3 and §4 already carried but did not state. Eleven canonicals changed; no expected id changed for any of them.

`and` bound TIGHTER than the postfix `called` in both parsers, so `photos called "Ana" and photos called "Marco"` parsed as `(photos called "Ana" ∪ photos) called "Marco"` — one photo where `s118.1` means two. Fixed identically in `check.py` and `crates/candidates/src/canon.rs` (DEFECTS #34). Exactly two stored trees were touched by the reparse: `s118.1`, which is the fix, and `b04.0`, whose `ordered by` really did apply to the union and which is now written with the union parenthesised.

Two more lexicon/prose defects closed in the same pass, both found by the training-data lane generating FROM the grammar rather than from the corpus: `that one` was advertised in §3 and unreachable in both parsers (DEFECTS #37, fixed), and §1.1's `"same?" Set Set` production read as though a bare postfix chain were a legal operand when both parsers require a primary or a parenthesised set (DEFECTS #38, prose fixed, parsers unchanged).

---

## 10. The grammar, derived mechanically and diffed (Lane O, 2026-09-21)

GRAMMAR.md §2 was written by hand FROM the ontology, so it could have missed a construct the vault serves or invented one it cannot. `derive/derive_grammar.py` now walks the ontology itself — the DDL, the registries, the eight app manifests, the seven search domains and the typed command registry — and `derive/diff.py` compares the result against `check.py`'s lexicons, which are the grammar AS EXECUTED. The full result is [DIFF.md](DIFF.md); the headline is **A 12 · B 13 · C 4**, and the three that matter are these.

**The Verb lexicon was 18% larger than the registry.** `check.py` scraped every quoted `schema.name` string out of `crates/vault/src/commands/*.rs` and could not tell `core.trash_document` from `object_type: "core.document"`, so 175 terminals were admitted where 148 commands exist. No canonical used one of the 27 — but nothing would have said so, and GRAMMAR.md §2.7 repeated the miscount as fact. The lexicon is now generated from the nine `definitions()` listings.

**Three walks the grammar states are not one foreign key.** §2.3 says walks come "from the foreign keys, not from a second list". `places of (photos)` is two hops through `media_asset`, which holds `place_id` — `core_content_item` does not. `photos of (albums)` runs through `core_collection_entry`, which §2.3 names as a join table and which is not one: it relates rows through a `(target_type, target_id)` PAIR that no foreign key constrains. And `parties of (groups)` has four ≤3-hop paths, of which `tally_group → social_circle → core_party` reaches the circle's OWNER and only `→ social_circle_member → core_party` reaches its members. Twelve turns rest on the three.

**Four Fields are computed by nothing the product ships.** `next_occurrence`, `owed_to_me`, `owed_to_them` and `member_party_ids` appear in no column, no app crate and no app manifest — only in `crates/candidates/src/exec.rs` and the harness's own reference readers. §2.2 admits reader-computed Fields; these have no reader. Eight turns rest on them.

### The terminals are now generated

`derive/emit.py` writes `grammar/lexicon.py` and `crates/candidates/src/canon_terminals.rs` from `derived.json` plus `derive/terminals.json` (the names, which the ontology cannot supply), and `python3 check.py` fails when either committed file is stale. `canon.rs` described its lexicons as "transcribed from `grammar/check.py`" and a transcription is the thing that drifts — DEFECTS #34 was that failure one level up, in the productions. Productions stay hand-written in both.

### The twelve forced additions, and M's two, re-examined

Each §3 addition re-judged against the derivation: does it FALL OUT of the ontology (never a hack), or is it provably unsupported (a product gap)?

| # | addition | falls out of the derivation? | what the ontology does or does not say |
| --- | --- | --- | --- |
| A1 | `Field around Num` | **no — product gap** | the schema marks no column as an ESTIMATE. `effort_min` is a bare nullable `INTEGER` with no CHECK, no unit and no granularity. The band is a ruling; for it to be derivable the column needs an annotation. Recorded as `judgements` in `derived.json` so it is never mistaken for a projection. |
| A2 | anchored `Window` `from (Value) to (Value)` | **yes** | purely compositional: `dtstart` is a date Field and a `Value` over a one-row Set is already in the grammar. No new terminal. |
| A3 | `Set and Set` | **yes** | set algebra over id sets; adds no terminal and needs none. |
| A4 | `Set except Set` + `the earlier one` | **half** | `except` is set algebra and falls out. `the earlier one` is a terminal of the CONVERSATION; the vault has nothing to say about it, which is why it lives in `terminals.json` and not in the derivation. |
| A5 | `Field Cmp Field` | **yes** | mechanical: two columns of one table with the same derived shape. `locker_item.password_set_at` and `created_at` are both the `date` shape. |
| A6 | `balance of Set in Set` | **no — product gap** | `tally::balance::group_net` is a signed fold over three tables and nothing declares it. The ontology has no notion of an app-owned derived quantity, so every such aggregate must be a hand-written terminal. Same gap as A8. |
| A7 | app-qualified `Kind` | **yes, and larger than stated** | the eight manifests' read scopes yield **119** (entity, door) pairs. The grammar's 19 are a subset; 11 more boards with a label column are listed in DIFF.md A1. The ontology says this loudly. |
| A8 | `next_occurrence` | **no — product gap** | `people_important_date` stores `month_day` and no shipped reader projects a next date. DIFF.md B4. |
| A9 | per-row `Args` binding (R-W2) | **n/a** | an executor rule, not a terminal. |
| A10 | verb CLASSES | **yes** | grouping the registry on the effect in each handler's SQL yields `delete`, `restore`, `reschedule`, `complete` and `cancel` with no hand list. The derived `delete` class matches the hand-written one on 7 of 8 subjects; the eighth is a spelling (`media.asset` vs `core.content_item`, DIFF.md C1). |
| A11 | `nothing` (R-N1) | **yes** | 13 registry entities carry the `trash` lifecycle, so "already trashed" is a state the ontology holds and not an invention. |
| A12 | `things` + R-T1/R-T2 | **half** | the fan-out is exactly the eight manifests, which is mechanical. R-T2's membership (events ∪ open tasks ∪ important dates) is a product judgement the schema does not make. |
| M1 | `Cmd then Cmd` | **yes, from the command model** | not from the schema: from `CommitTx` and `Idempotency`. A sequence whose first declination is the outcome is the commit guard's own all-or-nothing, which R-W1 already states for a bulk write. |
| M2 | `count of Kind Cmp Num` | **yes** | a reverse foreign key plus a count. The derivation emits both the edge and `count` over every Kind; nothing about it is special-cased. |

Three product gaps, then, and they were one gap: **the ontology declared no DERIVED quantity.** `around` needs a column to say it is an estimate; `balance`, `next_occurrence` and the four ungrounded Fields needed an app to declare what computes them.

**The `derivedFields` block that would close them now exists.** Each owning app declares the field, what computes it and the tables that reader reads; `crates/apps/kit/src/manifest.rs` refuses an input the app's read scopes do not grant, and `emit.py` refuses a grammar Field no manifest declares. `balance` has a reader (`crates/apps/tally/src/balance.rs`); `next_occurrence`, `member_party_ids`, `owed_to_me` and `owed_to_them` are declared with `computedBy: null` and a `gap` note — the product ships nothing that computes them, which is now a STATEMENT in the manifest rather than something a reader had to discover. A1 (`around`) is unchanged: it still needs a column annotation, and stays in `judgements`.

**Egress is now derivable.** It was not: `CommandDefinition` declared `sealed_input`, `online_only`, `risk` and `confirm` and nothing that says an effect LEAVES the vault, all eight app manifests declared the same `actionSideEffect: "vault-write"`, and `exec.rs`'s `EGRESS_VERBS` was a one-name judgement that missed `locker.export` — R-R2's own worked example. The registry declares it now (`DECLARED_EGRESS` in `crates/vault/src/commands/mod.rs`), one line of reason per command with `none` written down like any other ruling; the derivation fails on a structural candidate nobody has ruled on, `emit.py` generates the set into both parsers, and `exec.rs` reads `canon::egress_verbs()`. DIFF.md §E.

**And so is the verb CLASS of every command.** A10 above is derivable because the effect is read off each handler's SQL — for 122 of the 148. The other 26 write through a helper or write nothing, so the SQL said nothing and the class was silently 82% derived. They declare it in `DECLARED_EFFECTS`, with the handler named in each reason, and where both the declaration and the SQL speak the derivation holds them to each other. Derivability is 100%.
