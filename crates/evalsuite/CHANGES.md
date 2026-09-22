# Post-freeze changes to the corpus and the world

The suite was frozen before any model was touched. Every change to `suite.json`, `blind.json` or the seeded world after that freeze is logged here with its reason, **and a changed run is a new label**: a number produced against one row of this file may not be compared with a number produced against another.

## 2026-09-21 — grammar and map repair (Lane M)

**A new label for `holdout.json` only.** `suite.json` and `blind.json` are byte-identical to the previous label (md5 `a83ddd4e25da52b6f415b8a4c9409aad` and `72a3e3aceb562e307a109292566bf1f6`); `holdout.json` changed and is now md5 `45083839b23c7cb8c5189f130f95eecd`. Every other change in this pass is to `grammar/map.json`, which is the MAPPING and not the corpus — a canonical is what the harness believes a turn means, and changing one changes no expectation.

### Corpus cases changed (`holdout.json`), with the reason

| case | was | is | why |
| --- | --- | --- | --- |
| `h56.0` args.title | `"Buy a dry bag"` | `"Order a dry bag"` | the REQUEST quotes the title: _"open an undated job titled 'Order a dry bag'"_. No paraphrase of that sentence can produce "Buy a dry bag", so the expectation was unreachable by construction and the case was the wrong side of the disagreement, not the canonical. DEFECTS #35 |
| `h59.0` args.description | `"Firewood"` | `"Driftwood"` | the same shape: the request quotes `'Driftwood'`. DEFECTS #35 |
| `h42.0` expected.ids | 4 ids (agenda, notes, docs, tally) | 7 ids (+ both optometrist tasks, + `locker/optometrist-portal`) | `h42` and `h45` next door disagreed about what the optometrist subject reaches: `h42` said four rows in four apps, `h45` says the rows "span the apps and one of them is a sealed Locker item". The world-2 inventory settles it — seven LIVE rows carry the practice's name, across six apps. `h45` was right. DEFECTS #36 |
| `h42` notes | "reaches four apps through the LINK graph" | rewritten: six apps, through the WORD, Locker included | the note described a link walk the case never asked for |
| `h45.0` expected.why | "span five apps" | "span six apps" | same count, corrected |

A scan of **every write canonical's string literals against its case's args** (`title`, `description`, `summary`, `label`, `reason`, `name`, `field`, `kind`, `status`, `type`) found exactly these two disagreements across all 434 mapped turns. Everything else the naive scan flagged is a handle or a date, which the canonical resolves rather than quotes.

### `grammar/map.json` — canonicals changed (no expectation moved)

Owner rulings, published as GRAMMAR.md §5 C1-C3 and in README's temporal section:

- **C1, "due" means open** — `b02.1`, `b06.0`, `b07.0`, `b55.0` gained `status != "completed"`. Verified against both worlds: no completed task is due inside any of those windows, so no expected id changes.
- **C2, a referent's number follows the rows written** — `s86.1`, `s88.1`, `s89.1`, `s90.1`: `on (them)` → `on (it)`, one row restored each. `s111.4` keeps `them` (its antecedent is the two-row list, not the write).
- **C3, "what's on <weekday>" is `things`** — `s58.0` `events during tomorrow` → `things during tomorrow`. Verified: that Tuesday carries no open task and no important date, so its two event ids stand.

Repairs:

- `s118.1` — retree only, from the `and`/`called` precedence fix (DEFECTS #34). It now means two photos, which is what the case expects.
- `b04.0` — reparenthesised so its `ordered by` still applies to the union. Same tree as before.
- `s117.4` — `parties called "Ray"` → `parties called "Ray Alvarez"`. Four Rays match the short name and R-C1 clarified; the sentence's "him" points at the Ray the previous turn named (GRAMMAR.md C14).
- `s92.1` — `obligations of (it)` → `obligations of (parties called "Ana Ferreira")`, same reason: the sentence supplied the antecedent.
- `h68.3` — `except (the earlier one)` → `except (photos called "Fog over")`. `the earlier one` has one sense, the ANSWER two turns back (GRAMMAR.md C13); here the row to exclude is the one the previous SENTENCE named.
- `s107.3`, `s113.3`, `h61.0`, `s112.1` — were `covered: false`; now carry canonicals under the two grammar additions (COVERAGE.md §8).

### Effect

`check.py` 430/4 uncovered → **434 / 0 uncovered / 0 failures**. The oracle ceiling: suite **114/120 → 120/120**, blind **60/60 → 60/60**, holdout **73/78 → 78/78**. The three ratchets in `crates/candidates/src/tests.rs` were raised to match.

## 2026-09-21 — the world got deeper and the corpus got wider (Lane C)

**Every number in this section is a new label.** The world grew by 21 rows and several hundred edges; the corpus grew from 90 sessions / 139 turns to **120 / 248**. A score produced before this pass may not be compared with one produced after it.

### The world (`crates/evalworld`)

Seeded through typed commands, as everything in that crate is. No SQL, no fixture rows.

| change | reason |
| --- | --- |
| **four more `tally.obligation` rows**, all owed TO the owner (Marco Ferreira 4,500; Ana Ferreira 7,800; Priya Raman 2,200; Ray Alvarez 15,000) | one debt made "does anybody owe anybody anything" answerable by returning the only obligation row there is, and a candidate that never read `direction` scored the same as one that did. **They point the other way on purpose**: exactly one party is still owed money BY the owner, so `s13`, `s14`, `s53`, `s83` and `b18` keep their expected rows and become harder — the direction is now load-bearing where before it was free. Adding a second `owe` would have made `s53`'s third turn ("pay it off") ambiguous and invalidated it in silence |
| **three more `core.activity` rows** (Ana Ferreira, Priya Raman, Ray Alvarez) | two interactions made "when did I last hear from X" answerable by returning whichever of the pair existed. `s78` still names the Marco row |
| **three more `media.album` rows** — "People of mine", "Around the house", "Rolls to sort" — **and none of them holds a Tahoe frame** | one album made `s15`/t2 ("what album is that in?") the only-album answer and `s15`/t3 the whole roll. Kept off the three trip frames deliberately: a frame in two albums would give `s15`/t2 two right answers |
| **eight tail places NAMED** (`Harbour walk`, `Mission rooftop`, `Donner shore`, `Fallen Leaf trail`, `City rooftop`, `Coast road`, `Rubicon water`, `The old flat`) | three named places made "where was this taken" a choice between three. Named once per COORDINATE, not once per burst: the bursts cycle through eight coordinates and naming the ninth would rename a row that already has a name |
| **the Tallac trailhead place recorded in the inventory**, under the name the product gives it — `38.9186, -120.0836` | a place nobody named is shown to the member as its own latitude and longitude. A world that recorded only the NAMED places would have hidden that from every corpus written against the file |
| **a sixth story document, "Trip receipts (sample)", trashed two days before the world's now** | DEFECT #27: `core.restore_document`'s success path was unreachable, so the corpus could only score its refusal. It is trashed with the last commands of the build rather than in place, so its window is a fact of the world and not of how long the seeding happens to take |
| **the Emerald Bay permit is now filed and binned at the TOP of the story** | it sat **six hours** inside its thirty-day grace window the moment the story grew by a dozen commands, which would have flipped `s87` from a refusal to a success in silence. It now has eleven days of margin, and `the_grace_windows_are_not_on_a_knife_edge` asserts seven days at BOTH ends so the next seeding change goes red instead of quiet. `docs()` runs first in the story for the same reason |
| **attendees on 4 story events and ~17 tail events** | "who's coming to this" was a question about a title. **"Dinner with Neha" deliberately has none**: it is the one event in the world whose whole value is that nothing in the vault says which Neha, and `s05`, `s31` and `s58` all turn on that |
| **`core_link` edges** — the Tahoe plan to its events, documents, note and expenses; the dentist's event, note, document and expense to Neha Rao | the apps shared a WORD and nothing else, so every cross-app question was a string match. **The trashed permit could not be linked**: `core.link_entities` has a `subject_is_live` precondition, so the graph can never answer "was this deleted thing part of the trip" — recorded rather than worked around |
| **21 rows tagged** `tahoe`, `dental` or `home` across four apps | the packing list was the only tagged row in the world |

### The corpus (`suite.json`)

**No pre-existing session or handle was edited.** The 30 new sessions were inserted and the file diffed before and after to prove it.

| change | reason |
| --- | --- |
| **15 `cross_app` sessions (`s91`–`s105`, 28 turns)** | 4 of 66 `ids` turns needed more than one app. A `cross_app` session's single correct answer is a JOIN — an attendee row, an obligation's party, a place id, an album's membership, a folder or a notebook — not a word two apps happen to share |
| **15 `deep` sessions (`s106`–`s120`, 81 turns, five to six turns each)** | the corpus's deepest session was three turns and fourteen multi-turn sessions had no back-reference at all. Every turn after the first carries a pro-form, a continuation marker or an ordinal into the previous answer, **or declares `topic_switch`** |
| two new categories in `validate-suite`'s closed set, `cross_app` and `deep` | a typo in a category is a silently mis-counted coverage report |
| `validate-suite`'s **depth check** | the cheapest way to fake a deep session is five questions in a row about the same noun, every one of which a candidate with no memory answers correctly. The check refuses a later turn that neither continues nor declares |
| `"topic_switch": true` on six turns | a turn that wanders carries no pro-form. Declaring it is what stops the guard being loosened to let it through |
| `recently` added to `check.py`'s window phrases; `notebooks`, `owed_to_me`, `place`, `attendee_party_ids` added to its fields | all four are facts an app's own reader computes, which is what the lexicon admits; `recently` is already in the README's temporal table |

### One case this pass had to reshape while writing it

| case | was | now | why |
| --- | --- | --- | --- |
| `s107`/t4 (new this pass) | the correction put the mis-moved task **back on Wednesday** | it moves that task to **Thursday** and the right task to Friday | a reschedule to the day the world already seeded is true of a vault nobody touched — DEFECT #4 in correction clothing. `no_write_expectation_holds_against_the_untouched_world` caught it, which is the guard doing exactly its job on a case written the same day |

**`s87` was NOT changed**, and the brief for this lane expected it to be. The permit's grace window is still lapsed — by eleven days now rather than by hours — so the refusal it scores is still real behaviour, and the success path DEFECT #27 asked for is reached by a new session (`s108`) that does both in one conversation: the trip receipts come back, and the permit cannot. Two cases where the brief expected one moved, and neither is a case that no longer means what it says.

## 2026-09-21 — every aggregate recomputed from the world (Lane G)

**No expectation changed. No number changed.** Ten `value` turns of the primary corpus gained a `recompute` block, which is a GUARD on a literal rather than a new literal: `validate-suite` re-derives each number from the world it just built and refuses the suite when the two disagree. Every one agreed on the run that added it, so this row is not a new label for any score — it is the existing labels becoming re-checkable.

| turn | how its number is now derived |
| --- | --- |
| `s09`/t1, `s65`/t2 | sum of the Tahoe Trip group's four live expenses (the same block `b20`/`b21` already carried) |
| `s21`/t1, `s21`/t2 | sum of every live expense dated `2026-05` and `2026-06` — a new `date_prefix` on `Recompute`, because the pile is a window and names no label |
| `s53`/t2, `s83`/t1 | sum of the live `Dentist balance` obligation |
| `s66`/t1 | sum of the live expenses in the `Clinic costs` group |
| `s68`/t1 | count of live content items dated `2026-06-04`…`2026-06-06` (`date_from`/`date_to`) |
| `s70`/t1 | the cadence of `Ray Okafor` — a new `op: "value"`, which requires EXACTLY ONE matching row. **See DEFECTS.md #32: the case says "Ray" and the world holds nine of them.** The guard pins one of the three whose cadence is 7, which keeps the number checkable against world drift and does not make the case unambiguous |
| `s71`/t1 | count of live tasks due before `2026-06-15` (`date_before`) |

`validate-suite` now REFUSES a `value` turn that carries no `recompute` unless it is named in `UNGUARDED_VALUE` with the reason no derivation reaches it. One turn is on that list — `s67`/t1 — and DEFECTS.md says what the world would have to record for it to come off.

## 2026-09-21 — the grammar map's findings, acted on (Lane R)

The grammar pass ([`grammar/COVERAGE.md`](grammar/COVERAGE.md) §5) mapped all 200 turns onto one meaning space and six disagreements fell out of it. They were filed as findings for the owner; this is the owner acting on them. **Every row is a new label** — a number produced before this pass may not be compared with one produced after it.

| change | reason |
| --- | --- |
| `s80` "text Neha and tell her I'm running late": `clarify` → **`refuse`**, and the category moves from `ambiguity_clarify` to `refusal` | **Owner ruling.** Sending a text reaches outside the vault, and if the assistant cannot send one at all then which Neha it would have sent to never arises. A question about which Neha followed by a refusal either way is a worse outcome for the member than the refusal alone. This closes the OPEN QUESTION raised at the end of `DEFECTS.md` — `textref` and the corpus disagreed about it, and `textref` was right. `ambiguity_clarify` keeps seven other cases that do not turn on the ordering. |
| `s13/t1` and `s14/t1` "do I owe Neha (Rao) anything?": expect `tally.obligation` ids, not `core.party` | **Owner ruling.** The same sentence expected a party in the suite and an obligation in the blind set (`b18/t1`), and no candidate could satisfy both. The answer to "do I owe X" is the DEBT — that is what the member wants to see; the party is only who it is owed to. The Neha disambiguation is untouched: only one of the three parties carries a debt, so the question still resolves rather than clarifying. **The cost is named rather than hidden**: the world holds exactly one obligation, so "return the only obligation" now passes these two turns on its own. The sessions still discriminate — `s13/t2` cannot resolve and `s14/t2` must settle the right debt — but neither first turn is standalone evidence any more, and the world wants a second obligation. |
| `s29/t1` "show me my photos from the trip" → **"…from the Tahoe trip"**, and `s68/t1` likewise | The window had NO ANCHOR: "the trip" compiled to the bare literal `2026-06-04..2026-06-06` and the reference hard-coded the same three days, so a candidate could only pass by knowing the answer. The trip is not an event, an album or a memory in this vault, but it is a Tally GROUP, and a group's expenses are dated — so the window is now derived, first spend to last. The request names the group so the anchor is findable. **The trashed expense counts towards the span**: a member who binned the ski rentals still went skiing that day. The expected ids and the count are unchanged. |
| `b21`: a first turn added, "what have we spent on the Tahoe trip so far?" | `b21`'s only turn opened with "how much of THAT did I pay for myself?" and its antecedent was `b20` — a **different session**. The blind reference resolved it by re-finding the trip group every time, so the crossing was invisible in the score. `b20` and `b21` now declare `correlation_group: "tahoe-trip-total"`, because the added turn is `b20`'s question in other words and a per-category average would otherwise count that retrieval twice. `validate-suite` grew an **opening check** so the next one fails rather than being noticed. |
| `s48`'s notes | It was filed under `correction` and read as an undo. It is not one: the first write stands and the second lands beside it. The notes say so and point at the undo sessions. |
| `s72`/`s73`'s notes | Named as an ADVERSARIAL PAIR: same anchor (Wednesday's two dentist tasks), different verb. A candidate that matches on the anchor gets one of the two wrong, which is the whole point of keeping them adjacent. |
| **`s86`–`s90` added**, category `undo` | **No turn in either corpus exercised a real undo.** `schedule.restore_task`, `core.restore_document`, `media.restore_asset`, `tally.undo_expense` and `people.undo_person` were all in the registry and unreached, which on a corpus that scores writes is a hole on the write side. The corpus's other four `undo` turns are WITHDRAWALS — nothing had been written, so nothing is rolled back. Seven predicates and seven licences were added with them; what each had to do to be DISCRIMINATING is DEFECT #25. **Four of the five commands are reached; `core.restore_document`'s success path is not**, because the one document this world seeds in the trash is past its grace window and a document the session trashes itself cannot be told from one that was never trashed (DEFECTS #26, #27). `s87` scores the refusal instead, which is real behaviour, and the gap is written down rather than papered over. |
| the `undo` category | Added to `validate-suite`'s closed set. Filing a rollback under `correction` or `abandonment` would make both counts say something they do not mean. |

## 2026-09-21 — the week convention (Lane T)

The corpus held two incompatible readings of "this week" and nothing said so. `s01` was answered by the reference as a calendar week (Monday–Sunday) and `s64` as a trailing seven days; both passed, because each case had been written against whichever reading its author had in mind. The convention is now published once — `README.md` §"What a temporal phrase means", implemented in `reference::calendar` — and `validate-suite` refuses a case whose expected rows fall outside the window its own words denote.

| change | reason |
| --- | --- |
| `s64`'s request: "what have I ticked off this week?" → **"what did I tick off last week?"** | Both expected rows were completed on Saturday 2026-06-13. Under the published calendar week, `this week` is 06-15…06-21 and the correct answer to the old request is **nothing** — the case asked one question and expected the answer to another. The CASE moved rather than the world: the world is shared with another lane, and moving a completion stamp would have moved rows under it. The expected ids are unchanged. |
| `s41`'s request: "what can I get done in about forty five minutes?" → **"which of my tasks is about a forty five minute job?"** | Ambiguous between a BAND (an estimate of about 45 min) and a BUDGET (anything that fits in 45 min). The world holds open tasks estimated at 15, 45 and 120 minutes, so the two readings give different answers and the 15-minute task was correct under one of them. Ruled in favour of the band — that is what the reference implemented and what the second estimate was seeded to test — and the request reworded so the budget reading is no longer available. The expected ids are unchanged. |

## 2026-09-21 — task timestamps (Lane T)

`schedule.add_task` was the one insert in `crates/vault/src/commands/schedule.rs` that did not stamp `created_at`/`updated_at`, so it fell through to the column DEFAULT — `strftime('now')`, the **wall** clock. A vault opened with a `FixedClock` therefore stamped every task with whenever the build happened to run, and `completed_at`/`deleted_at` (both written from the injected clock) sorted _before_ the row's own creation: 36 trashed tasks and 667 completed ones, in a world whose whole claim is determinism. Fixed at the command; the world was rebuilt and **no handle moved** — ids are minted from the seeded id stream and are untouched by a timestamp.

## 2026-09-21 — a SECOND WORLD and a scenario holdout (Lane H)

`blind.json` was built to be the held-out corpus and holds out **wording, not scenario**. Measured: 32% of its handles name rows `suite.json` also names, and **58.3% of its requests share a three-gram with a primary request**. Both corpora are written over one world, so a candidate that has memorised _the dentist is Neha Rao, the trip is Tahoe, the group is Tahoe Trip_ transfers straight across — and the blind-versus-primary gap then reports a generalisation nobody measured (review item A7).

Nothing in `suite.json`, `blind.json`, `reference.rs` or `nulls.rs` was touched. What was added:

| added | what it is |
| --- | --- |
| `centraid_evalworld::Scenario::Second` (`scenario2.rs`, `bulk2.rs`) | A **second seeded world** — 5,251 rows across all eight apps, the same shape and size class as the first, with a disjoint cast (Dara Okonjo, two Yusufs, two Hallas), a disjoint weekend away (Mendocino), a disjoint professional (an optometrist), disjoint places, merchants, notebooks, folders, bursts and label TEMPLATES. `build-eval-world -- <dir> --scenario 2`. |
| `holdout.json` | **78 sessions, 114 turns**, authored against world 2 by a lane that never opened `suite.json`. |
| `src/holdoutref.rs`, `run-holdout` | The holdout's hand-written reference. **78/78 sessions, 100%.** |
| `validate-suite --world 2` | Resolves handles against `target/eval-world-2/inventory.json` and deals world 2 for the untouched-world check. Clean on `holdout.json`: 9 of 9 aggregates recomputed, 23 write expectations refused by an untouched world. |
| `tests/holdout_overlap.rs` | Asserts the holdout shares **no proper noun** with either other corpus and prints the three-gram overlap. |
| `crates/evalworld/tests/world2.rs` | Asserts the two worlds' label vocabularies are **disjoint on proper nouns** — story and long tail alike. |

Measured after the change: **16.7%** of holdout requests share a three-gram with a primary request, against the blind set's **58.3%**; proper-noun overlap with `suite.json` ∪ `blind.json` is **zero**.

### Two corpus edits that were the corpus being wrong

| change | reason |
| --- | --- |
| Eleven holdout requests said "weekend" as a NOUN naming the trip ("the coast weekend") | `validate-suite`'s temporal check reads "weekend" as a WINDOW, which is the published convention, and the rows a trip question expects are not inside it. The requests were reworded to "the coast trip" before the corpus was frozen. The published convention won; the corpus moved. |
| `h68` turn 3 was answerable cold | `validate-suite`'s depth check refuses a `deep` turn that neither continues the conversation nor declares a topic switch. Reworded to carry the pro-form it depends on. |

### `blindref.rs`, fixed for the same defect the holdout was written to avoid

`blindref.rs` transcribed its expected answers as label lists — `labelled(ctx, App::Agenda, &["Morning run", "Dinner with Neha"])` for "what's on my calendar tomorrow?" — which is **DEFECT #3 in read clothing**: it proves the rows are writable, not that they are reachable, and a case reworded from "tomorrow" to "on the 20th" would have gone on passing. Eleven arms whose answer is a COMPUTED SET (a window, a status, a parent, a payer, a role, an anchored window) now compute it; `labelled` survives only where the member's own sentence names the row. Two smaller fixes went with it: `board` now drops the rows Docs and Tally mark trashed as well as the ones whose `deleted_at` is set, and an unresolved request answers `unhandled` rather than an empty `Plan::Ids` — an empty answer MATCHES an empty expectation, so the old fallthrough was a silent pass on exactly the turn a reference run exists to catch. `run-blind` is still 60/60.

### One lexicon gap, closed

`grammar/check.py`'s `WINDOW_PHRASES` was missing `next month`, which `README.md`'s own temporal table publishes. A canonical could not say what the convention already defines. Added — the checker catching up to the convention it reads, not the convention widening.

## 2026-09-22 — reference typed on the Notes board (orchestrator)

**Not a corpus change; no new label.** `suite.json`, `blind.json` and `holdout.json` are untouched. The Kind-surface lane made the Notes board emit its notebooks as rows (`knowledge.notebook`, the new `notebooks` Kind), and `reference.rs` read that board through seven untyped `like(App::Notes, None, …)` calls. One collided: the world seeds a notebook named "Tahoe scouting", so `s06.0` "find my notes about Tahoe" answered a notebook beside the note and `the_reference_passes_every_case` went red (2 rows against the expected 1). The expectation is right — the member asked for notes, and a notebook is not one — so the reference now names the entity it reads (`knowledge.note`) on all seven calls, the way `in_notebook` already did. The executor was never wrong here: it filters by Kind, which is why `run-oracle` stayed 100% throughout.
