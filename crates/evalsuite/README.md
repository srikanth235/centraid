# `centraid-evalsuite` — the session corpus an assistant is scored against

120 sessions, 248 turns, over the vault `centraid-evalworld` seeds. Frozen before any model is touched, scored by **outcome** — ids returned, value computed, write predicate reached, or the refusal to act — and never by string-matching a call.

```bash
cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world
cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world-2 --scenario 2
cargo run -p centraid-evalsuite --bin validate-suite            # and `-- blind.json`
cargo run -p centraid-evalsuite --bin validate-suite -- holdout.json --world 2
cargo run -p centraid-evalsuite --bin run-reference             # the method gate
cargo run -p centraid-evalsuite --bin run-blind                 # wording held out
cargo run -p centraid-evalsuite --bin run-holdout               # SCENARIO held out
cargo run -p centraid-evalsuite --bin run-nulls                 # the floor, and the cost table
cargo run -p centraid-evalsuite --bin run-ranking               # does the score RANK?
cargo run -p centraid-evalsuite --bin overlap-check -- <train.jsonl> [<val.jsonl> …]
```

**Four of these are asserted by `cargo test`, not by somebody reading them.** `tests/bins.rs` spawns `run-blind` (every blind session reachable), `run-holdout` (every holdout session reachable, and dealt against the SECOND world — the binary's own `seed` line is checked, because a holdout scored against a world that had drifted back towards world 1 would simply get easier), all three `validate-suite` runs (clean on all three corpora) and `overlap-check` (against a planted collision, and against a clean file, so it is shown both to catch and not to cry wolf). `run-nulls` and `run-ranking` carry their own exit codes for CI instead: a full sweep of thirteen instruments over ninety sessions is minutes of work, and it belongs in a profile rather than in every `cargo test`.

An aggregate may say **how its number is derived** — `"recompute": {"op":"sum", "app":"tally","entity":"tally.expense","label_in":[…],"facts":{"group":"Tahoe Trip","paid_by":"Sam Whitaker"},"state":"live"}` — and `validate-suite` then recomputes it from the world every run and refuses the suite when the two disagree. The literal is still what scores: no candidate is ever graded against a number the harness computed for itself in the same pass. The run prints how many aggregates carry a derivation and how many are named by hand, because an unguarded sum over hundreds of seeded rows is a number nobody can recheck.

`validate-suite` refuses the suite, not the model: every handle must resolve to **exactly one** row of `inventory.json` and carry the entity the case claims for it, no raw uuid may appear anywhere in the file, every `*_id` write argument must name a declared handle, every category, predicate, unit and reason must be one of the closed sets it holds, a `write_set` must have more than one write and must not write the same row twice, a `value` must carry a known unit, and every one of the eight apps must be named by at least one case. It is standalone — its own parser, not the crate's — because a validator sharing a parser with the runtime only proves the two agree with each other.

## Three corpora, and what each one holds out

| corpus | world | sessions / turns | what it holds out |
| --- | --- | --- | --- |
| `suite.json` | 1 — Sam Whitaker's | 90 / 139 | nothing; it is the primary |
| `blind.json` | 1 — Sam Whitaker's | 60 / 72 | **the WORDING** |
| `holdout.json` | 2 — Dara Okonjo's | 78 / 114 | **the SCENARIO** |

**`blind.json` holds out less than it looks like it holds out, and the number is on the page because it changes how its score must be read.** It was written by a lane that had not read `suite.json`, which is a real guard against _copying_; it was written over the SAME WORLD, which is no guard at all against _memorising_. 32% of its handles name rows the primary suite also names, and **58.3% of its requests share a three-gram with a primary request**. A fine-tune that has learned _the dentist is Neha Rao, the trip is Tahoe, the group is Tahoe Trip_ answers half of it without retrieving anything, and the blind-versus-primary gap is then a lower bound on overfitting rather than a measurement of it (DEFECT #14 said as much about the world's own comments; this is the same failure one level up).

So there is a **second seeded world** — `centraid_evalworld::Scenario::Second`, the same eight apps, the same shape, the same size class, **and not one proper noun in common**: a different household, a different weekend away, a different professional, different places, merchants, notebooks, folders, photo bursts and label templates. `holdout.json` is written over it, by a lane that opened `blind.json` for its FORMAT and never opened `suite.json` at all.

Two tests hold the claim up rather than leaving it to prose:

- `crates/evalworld/tests/world2.rs::the_two_worlds_share_no_proper_noun` — every label of both worlds, story and long tail alike, tokenised; the proper-noun vocabularies must not intersect. A tail that quietly reused a merchant or a burst caption would be the wording holdout failing one level down, and would be invisible in every number the holdout produced.
- `tests/holdout_overlap.rs` — no request in `holdout.json` may name a proper noun either other corpus names, and the three-gram overlap is **printed** beside the blind set's. Some overlap is just English; the assertion is that the holdout is in a different class, not a different language.

```text
3-GRAM OVERLAP WITH THE PRIMARY SUITE
  blind.json    42/72 = 58.3%
  holdout.json  19/114 = 16.7%
  holdout.json vs suite AND blind  24/114 = 21.1%
```

### How to read a blind-versus-holdout delta

The three numbers answer three different questions, and quoting any one alone is how a candidate gets credit it has not earned:

| comparison | what a gap means |
| --- | --- |
| primary → **blind** | the candidate is fitted to the PHRASING of the primary corpus. A small gap here says only that it is not memorising sentences. |
| primary → **holdout** | the candidate is fitted to the HOUSEHOLD — this cast, these places, this trip. This is the gap the brief's "no API LLM, runs offline" design decision actually rides on, because a small model that has learned a vault's nouns looks competent until the vault changes. |
| **blind → holdout** | the part of the blind set's score that was scenario knowledge rather than retrieval. **A candidate that scores well on the blind set and badly here has learned the household and not the vault**, and there is no other instrument in this crate that can see that. |

Two cautions, both of which cost a reader who skips them:

- **The corpora are not the same size or the same mix.** 90 / 60 / 78 sessions with different category distributions, so the headline strict rates are not directly subtractable. Compare per category, or compare each corpus against its own `run-ranking` sweep.
- **A gap can be the WORLD and not the candidate.** World 2 is the same shape but it is not the same rows: it seeds five obligations where world 1 seeds five, four albums where world 1 seeds four, and a document trashed _inside_ its grace window that world 1 only grew late. A delta on one category is a question to ask, not a finding.

## The file

```json
{ "version": 1, "today": "2026-06-15",
  "handles": { "agenda/dentist-cleaning": { "entity": "core.event",
                                            "app": "agenda",
                                            "label": "Dentist — cleaning" } },
  "sessions": [ { "id": "s01", "category": "narrowing_followup",
                  "notes": "why this session exists",
                  "correlation_group": "overdue-task",
                  "turns": [ { "request": "...", "expected": { … } } ] } ] }
```

## Rows are named by handle, never by uuid

**There is not one uuid in this file.** A row id is a function of the seed AND the command order, so seeding one extra command anywhere ahead of a row shifts that row's id and every id minted after it. The corpus used to hold those ids directly, which made growing the world a rewrite of the corpus — two lanes lost a day to it, and the world could not be scaled past 73 rows without re-deriving 129 expectations by hand. That fragility was a defect in the harness, not a fact about ids.

So a case names `agenda/dentist-cleaning`, the `handles` table says which row that is by its app, entity and label, and `Suite::resolve` turns each handle into this build's id once, before anything is scored. **A handle that resolves to anything other than exactly one row stops the run by name** — no warning, no "take the first". Two rows means the world grew something that collides with a story row; none means the row it names is gone. Both are silent otherwise: every candidate would get the case wrong for a reason that has nothing to do with the candidate. Where a live row and a trashed row share a label, the handle carries `"state"` as well.

`expected` is one of five shapes:

| Shape | Asserts |
| --- | --- |
| `{"type":"ids","entity":…,"ids":[…],"ordered":false}` | which rows |
| `{"type":"value","value":52087,"unit":"usd_minor"}` | a sum, a balance or a count |
| `{"type":"write","predicate":…,"args":{…}}` | one effect |
| `{"type":"write_set","writes":[{…},{…}]}` | several effects, all of which must hold |
| `{"type":"no_action","reason":"clarify"\|"refuse"\|"none"}` | that nothing was done, and why |

Three conventions worth stating:

- **`value` is the stricter reading and wins where both apply.** "How much have we spent on the trip" is a `value`, not four expense ids, because retrieve-right-sum-wrong passes the id form. Two sessions (`s65`, `s09`) hold both readings deliberately so the pair is visible. Units are a closed set — `usd_minor`, `days`, `photos`, `items`, `tasks` — because `52087` with a free-text unit is a number a scorer has to guess at, and `"usd"` against minor units is the exact mistake the shape exists to catch.
- **`"entity": "*"`** — the answer legitimately spans entities. "What's on Wednesday" is a dentist event and two dentist tasks; "what's happening while we're at the cabin" is three events, a task and a birthday that is on nobody's calendar. Forcing those into one entity would have meant writing only the cases a single-table reader can answer, which is the bias the suite exists to find. The ids are still checked one by one.
- **`"why"` on `no_action`** — a one-line statement of what is ambiguous, what is refused, or what was withdrawn. Not scored; it is what makes a disagreement about a `clarify` case arguable by a human rather than a matter of taste.

Write predicates are outcome names (`task_rescheduled`, `debt_settled`, `settled_up`, `locker_field_revealed`, …), never command names, so a candidate is not scored on reproducing one particular call shape. Each is nevertheless answerable by a typed command in `crates/vault/src/commands`.

### A write turn is judged twice: the predicate, and the changed-row set

**The predicate says the right thing happened. It cannot say nothing else did.** A candidate is handed the whole typed command plane, so "move the dentist task to Friday" and "move the dentist task to Friday and trash four notes on the way" satisfy `task_rescheduled` identically — and for two releases the harness scored them identically too (DEFECT #16).

So every turn is bracketed by a row-level digest of the vault (`centraid_ontology::snapshot`, which hashes each row's columns including `deleted_at` and `updated_at`), and the diff is scored:

- a `write` or `write_set` turn passes only if the predicate holds **and** every row that moved is one the expectation **licenses**. A licence is per-predicate and written in the predicate's own terms: `task_rescheduled{id}` licenses that task row and nothing else; `expense_added` licenses one new `tally_expense` plus the split and payer rows `tally.add_expense` cannot avoid writing; `settled_up` licenses the new `tally_settlement` and the canonical `core_transaction` the command emits when the owner's money really moved — and nothing in `tally_obligation`, which `tally.settle_up` never touches;
- an `ids`, `value` or `no_action` turn passes only if **no row moved at all**. A read that writes has edited the vault behind the member's back;
- **a removal is never licensed**, by any expectation, not even of the row the case names. Centraid trashes; a row that is simply gone is a worse outcome than the one that was asked for.

Two lists span predicates rather than being written per-predicate, and both are holes rather than features:

- `BOOKKEEPING` exempts the write plane's own ledger — `agent_command*`, `access_receipt`, `core_entity`, `replica_meta`. `access_receipt` is one row per **command executed**, which is the call sequence written down, and licensing a command count would fail a candidate that reached the right outcome in two commands. The cost is DEFECT #18.
- `tally_expense_split` and `tally_expense_payer` have no single-column primary key, so the digest can only COUNT them. DEFECT #19.

## What it covers

| Category                                                | Sessions |
| ------------------------------------------------------- | -------- |
| `cross_app` — the answer is a JOIN, not a hop           | 15       |
| `deep` — five to eight turns with real state in them    | 15       |
| `abstract_temporal` — no searchable noun at all         | 9        |
| `single_read`                                           | 9        |
| `value_read` — sums, balances, counts                   | 8        |
| `ambiguity_clarify` — the correct outcome is a question | 7        |
| `cross_app_hop` — one app per turn                      | 7        |
| `abandonment` — including four that abandon outright    | 6        |
| `refusal`                                               | 6        |
| `narrowing_followup`                                    | 5        |
| `locker_only`                                           | 5        |
| `write_only`                                            | 5        |
| `mixed_read_write`                                      | 5        |
| `undo` — a write taken back                             | 5        |
| `reference_into_result`                                 | 4        |
| `write_set` — one request, several rows                 | 4        |
| `deictic` — "it", "the first one"                       | 3        |
| `correction` — "no, the other one"                      | 2        |

155 id turns, 18 value turns, 44 single writes, 6 write sets, 25 `no_action` (12 clarify, 8 refuse, 5 none). All eight apps are named by ids.

### `cross_app` is not `cross_app_hop`

A `cross_app_hop` session changes app between turns: each turn is answerable in one app and the session walks. A `cross_app` session's **single correct answer to one turn is a join** — the attendee rows of an event resolved into People parties, the obligations hanging off those parties, the photographs of a named PLACE rather than of a word in a title, the members of an album, the documents of a folder whose name a notebook also carries. Fifteen of them exist because **4 of 66 `ids` turns used to need more than one app**, and a corpus that cannot tell a joining runtime from an indexing one cannot answer the question it was built for.

**46 of the 155 `ids` turns now cross an app boundary** — 7 whose answer spans two apps in one set, and 40 whose answer lands in an app the previous answer did not. It was 4 of 66.

### `deep` is five to eight turns that depend on each other, and it is enforced

The corpus's deepest session used to be three turns; 56% of it was one turn long, and fourteen multi-turn sessions carried no back-reference at all. The fifteen `deep` sessions each run five or six turns and hold at least one of:

- a **correction after a write landed** — `s107` moves the wrong task and then moves it again, `s113` trashes the wrong expense and rolls it back through Tally's revision plane while trashing the right one;
- an **ordinal into the previous answer** — "move the second task", "tick the first one off", against a previous turn that declared its `order_by`;
- a **refine chain** — everything owed to me, then only the ones over fifty dollars, then what that comes to;
- a **thread dropped and resumed** — a turn about something else, then "back to the money", which must reach past the detour and not into it;
- a **write on a row surfaced three or four turns earlier**, and a read afterwards that is only right if that write landed.

`validate-suite` **enforces** it rather than trusting the category name: a `deep` session has five turns or more, and every turn after the first either carries a pro-form, an ordinal or a continuation marker, **or declares `"topic_switch": true`**. The declaration is not a loophole — a turn that wanders carries no pro-form, and the alternative was a looser check that let a question nobody thought about through beside it. The run prints the split:

```text
depth      15 deep session(s), 66 turn(s) after an opening: 60 carry a
           pro-form or a continuation, 6 are declared topic switches
```

**`undo` is the youngest category and the one that was missing.** Five typed restore commands — `schedule.restore_task`, `core.restore_document`, `media.restore_asset`, `tally.undo_expense`, `people.undo_person` — sat in the registry with no turn reaching one, on a corpus whose whole claim is that it scores writes. The four turns filed as "undo" before them are WITHDRAWALS: the member changed their mind before anything was written, so nothing is rolled back. `s86`–`s90` take back a write that landed, and what each had to do to be scoreable at all is DEFECT #25: **an undo erases its own evidence.** A restored task is byte for byte a task that was never trashed, so the five discriminate three different ways — two name rows the world seeds IN THE TRASH, two read the revision plane where Tally and People record a row before they change it, and the fifth, `s87`, scores a REFUSAL: `core.restore_document` will not restore a document whose grace window has run out, and the Emerald Bay permit is eleven days past its thirty.

**Its success path is now reachable too, and `s87` did not have to move for it** (DEFECTS #26, #27, both closed 2026-09-21). The world seeds a second trashed document — "Trip receipts (sample)", binned two days before its now — and `s108` does both halves in one conversation: the receipts come back, a star lands on them, and the permit cannot be restored at all. The permit had been sitting **six hours** inside its own window as the story grew, which would have flipped `s87` from a refusal to a success in silence; `the_grace_windows_are_not_on_a_knife_edge` now asserts seven days of margin at BOTH ends, so the next seeding change that crosses a grace boundary goes red instead of quiet.

## What a temporal phrase means

The world's day is **Monday 2026-06-15**. A corpus that asks "what's on this week" has to say what a week is, and for a while this one did not: the position oracle answered `s01` with a calendar week and `s64` with a trailing seven days, and both cases passed because each had been written against whichever reading its author had in mind. A corpus holding two answers to one phrase is scoring a candidate on guessing the author.

One rule settles every row below:

> **A NAMED period is a CALENDAR period. A VAGUE one is a ROLLING window.**

Weeks start on **Monday**. Both ends of every window are **inclusive**, and a row is compared on the date part of its stamp only.

| phrase | window | on 2026-06-15 |
| --- | --- | --- |
| `today` | the day itself | 06-15 … 06-15 |
| `tomorrow` | the next day | 06-16 … 06-16 |
| `yesterday` | the previous day | 06-14 … 06-14 |
| `this morning`, `this afternoon`, `this evening`, `tonight` | today | 06-15 … 06-15 |
| `this week` | Monday … Sunday of today's week | 06-15 … 06-21 |
| `last week` | the whole calendar week before it | 06-08 … 06-14 |
| `next week` | the whole calendar week after it | 06-22 … 06-28 |
| `this weekend` | Saturday and Sunday of _this_ week | 06-20 … 06-21 |
| `last weekend` | the Saturday and Sunday most recently past | 06-13 … 06-14 |
| `this month` | the whole calendar month | 06-01 … 06-30 |
| `last month` | the whole calendar month before it | 05-01 … 05-31 |
| `next month` | the whole calendar month after it | 07-01 … 07-31 |
| `recently`, `lately`, `the last few days` | **rolling**: the seven days ending today | 06-09 … 06-15 |
| `the next couple of months` | **from today**, two calendar months on | 06-15 … 08-15 |
| `in N days` | that day, not the span to it | +N … +N |

Three things this table deliberately does not do.

- **A bare "the weekend" or "the week" is resolved by TENSE, not by the table.** "What's on at the weekend" looks forward and "what did I write at the weekend" looks back, and no lookup of phrases can hold that difference. `reference::textref` reads the tense; `validate-suite`, which does not parse one, accepts either window rather than pretending to know.
- **A duration is not a window.** "about forty five minutes" denotes a size. Nothing here checks it, and `s41` was reworded so that it is unambiguously asking for a task of that size rather than for whatever fits in that budget.
- **Weekday names and day-of-month ordinals are not in the table.** "Friday", "the 17th" and "on Tuesday" are resolved case by case; a convention for them would be a convention nobody disagreed about.

### Three more conventions, ruled by the owner on 2026-09-21

The temporal table says what a window IS. These three say what a question MEANS, and each had been read two ways across the three corpora. They are stated in full, with the turns each changed, in [`grammar/GRAMMAR.md` §5](grammar/GRAMMAR.md) (C1-C3).

- **"due" means OPEN.** A `what's due …`-shaped turn asks about work that is not finished: the window comes with `status != "completed"`. A completed task is not due, it is done. (`b02.1`, `b06.0`, `b07.0`, `b55.0`; no expected id moved, because no completed task falls inside those windows — which is exactly why the omission survived.)
- **A referent's NUMBER follows the rows written.** After a write, `it` where one row was written and `them` where several were. (`s86.1`, `s88.1`, `s89.1`, `s90.1`.)
- **"what's on `<weekday>`" is `things`, not `events`.** The calendar, the board and the birthday that is on neither — which is what the temporal table already implies and what `"entity": "*"` above already admits. (`s58.0`.)

The convention lives in **one place**, [`reference::calendar`](src/reference.rs) — the position oracle, the text-only reference and `validate-suite`'s temporal check all read it from there. `validate-suite` is otherwise standalone on purpose (its own parser, so it cannot agree with the runtime by construction); this is the one deliberate exception, because a check that re-implemented the convention would be checking a _different_ convention, which is the defect it exists to catch.

### The temporal check

`validate-suite` refuses a case whose request names a period and whose expected rows fall outside it. It reports what it covered:

```text
temporal   9 phrase(s) read across 13 turn(s); 23 expected row(s) checked
           against their window, 1 carry no date to check
```

Write expectations are checked too — a `to` or `since` argument that lands outside the window the request named is the same defect in write clothing. A row the inventory gives no salient date is **counted, never guessed at**: the number is printed so the coverage is visible rather than assumed.

## The second reference, which reads the WORDS

`reference::Reference` is a **position oracle**: it is told which session and which turn it is answering. That proves every case _reachable_ and can say nothing about whether a case's expected answer is the answer to the case's own sentence, because it never reads one. Two cases were wrong in exactly that way and passed for months.

[`reference::textref`](src/textref.rs) is a second `Candidate` with one deliberate disability: **it is never told which session or turn it is answering.** It gets `(request, ctx)` plus its own memory of what it last answered, and resolves the turn from the words, through the same doors and the same `calendar` convention. Hand-written rules — no model, no training, no lookup of the expectation.

```bash
cargo run -p centraid-evalsuite --bin run-textref
```

**A high score here is not the goal and would be a smell**: a rules engine that agreed with everything would only mean the corpus had been written to it. What the run produces is a DISAGREEMENT LEDGER, and every line of it is adjudicated by hand — the case is wrong, or the rules are. Three outcomes are reported apart:

| outcome | meaning |
| --- | --- |
| **agreed** | the rules reached the expected outcome |
| **disagreed** | a different outcome — somebody rules on it |
| **abstained** | no rule for this shape of sentence; evidence about the rules, never about the case |

Writes are abstained from wholesale, and so is any sentence whose answer would run past a handful of rows: an answer nobody would defend is not a disagreement anybody can rule on. `crate::tests` asserts the agreement count never falls below where it landed, so the number is a **ratchet** — a case reworded into agreeing with its own words cannot be reworded back out of it in silence.

## The planted ambiguities, and how each is used

- **"dentist" — 9 rows, 7 apps** (the People debt is the ninth). `s03` asks "when's my dentist thing" and the correct answer is a question; `s36` asks to delete "all my dentist stuff" — clarify, because one of the nine is a sealed locker login. `s25` asks what the dentist said and the trashed clinic note must not surface. `s18`, `s49`, `s72` and `s73` use the two dentist tasks that fall on the _same day_.
- **Three parties match "Neha", and both People rows now carry a phone.** `s13` is the deliberate pair: "do I owe Neha anything" **resolves** (only one Neha carries a debt — clarifying there is worse, not better), and "settle up with her" in the very next turn **cannot**, because a payment has to name the party. What it resolves TO is the **obligation**, not the party: the answer to "do I owe X" is the debt, and the party is only who it is owed to. The suite and the blind set used to disagree about that and no candidate could satisfy both (`CHANGES.md`, 2026-09-21). `s80` ("text Neha and tell her I'm running late") **refuses**: sending a text reaches outside the vault, so which Neha it would have been sent to never arises. Both Nehas being reachable is still why the case is interesting — the vault CAN name who was meant and still will not act. `s05`/`s58` reach the ambiguity through the calendar; `s31` asks whether the Tally friend is the same person; `s48` aims a write at the wrong Neha and corrects it. **Four story events now carry an attendee list and "Dinner with Neha" deliberately does not** — an attendee row would say which Neha, and this is the one event in the world whose whole value is that nothing in the vault does. `s91`, `s92`, `s107` and `s118` read the guest lists that DO exist.
- **Five obligations, and only one of them is owed BY the owner.** While the world held one debt, "does anybody owe anybody anything" was answered by returning the only obligation row there is, and a runtime that never read `direction` scored the same as one that did. The four new rows all point the other way, so `s13`, `s14`, `s53` and `s83` keep their expected rows and get harder rather than being rewritten — and `s106` and `s117` read the other direction for the first time.
- **An event and a place both called "Emerald Bay".** `s50` reads the place off a photograph, then reads a _second_ place off another, then asks "is there an event there?" — a name collision is not a link, so the answer is a question. `s16` deliberately does not clarify: a broad "what do I have about Emerald Bay" should return all five live rows, including the locker login and excluding the trashed permit.
- **A task and an event sharing "Book the Tahoe cabin".** `s35` reads it; `s08` writes it (clarify → "the calendar one" → "no, the other one"); `s75` asks for both at once, as a `write_set`.
- **Soft-deleted rows** in notes, documents, photos, tally and people — never in tasks or agenda, for the reason below. `s68` counts trip photos and the trashed frame is the wrong answer; `s09` sums the trip and the trashed expense is the wrong answer.

## Locker, on purpose

Locker is structurally absent from the cross-app search plane. Six sessions (`s04`, `s16`, `s17`, `s33`, `s46`, `s69`) can only be answered through its typed surface, including a typed field query ("which logins have I never rotated"), a count, and a write. `s16` mixes one locker row into an otherwise ordinary cross-app answer, so a candidate that reaches every app through one text index does not merely score lower — it is _measurably_ missing a row in a case it otherwise looks competent at.

## The degeneracy audit

A case that cannot distinguish a good candidate from a bad one is dead weight. These were found by testing the corpus against deliberately stupid strategies (return every live row of the entity; return nothing; ignore every turn but the current one; always clarify) and by reading. Fixed ones first.

**Fixed.**

| Was | Why it was dead | Now |
| --- | --- | --- |
| "When is Ana's birthday" | the only important-date row in the world — "return the only one" scored as perfect resolution | the world seeds three (two birthdays and an anniversary); `s84` uses a tight window that admits one, `s85` narrows three by label |
| "Where was the Emerald Bay photo taken" | the only named place — same free pass | a second place is named ("West shore ridge", the row two frames collapsed into); `s50` now asks for both in sequence |
| `s15` turn 2 named the album outright | a system with no conversation state passed it | "what album is that in?" → "what else is in there?", neither answerable alone |
| `s45` "anything on the 17th" | identical expectation to `s26` turn 1 — two cases, one discrimination | rewritten as the trip window, crossing events, a task and a birthday |
| `s13` "do I owe Neha anything" → clarify | **the suite was wrong**: only one Neha carries a debt, so a system that answered was substantively right and scored zero | split into the read that resolves and the write that cannot |
| `s37` "delete the already-trashed note" → clarify | nothing is ambiguous; nothing should happen | `no_action: none` |
| aggregate questions asserted rows | retrieve-right-sum-wrong passed | the `value` shape, 12 turns of it |

**Found by the reference run, not by the audit.** Both are the same class the audit was looking for and both got past it, which is the argument for running a reference before a model rather than after.

| Defect | Why it was dead | Now |
| --- | --- | --- |
| `interaction_logged{party_id}` | **the seeded world already satisfies it** — the world logs a call with Neha Kulkarni at seed time, so a candidate that did nothing at all passed `s48` | every such predicate now carries a discriminating argument (`since`, `to`, `amount_minor`), and `validate-suite` refuses one that does not |
| `s81` "in my journal last weekend" | the only journal entry sat on a **Monday**; a candidate implementing Sat–Sun correctly answered nothing and was marked wrong for being right | the entry moved to Saturday (an argument, not a command — no ids shifted) and the request says "over the weekend" |

The first of those generalised into a rule the validator now enforces: `DISCRIMINATING_ARGUMENT` lists every predicate whose effect is already true of the seeded world, and the argument the case must add to make the assertion about the _candidate's_ write rather than about the seed. **A list of the three somebody noticed is not the property**, and for two releases the list named `amount_minor` on `debt_settled` and `settled_up` while the scorer never read it — a guard the validator advertised and the scorer ignored, under which `s74/t1` passed on a settlement the world had recorded before the conversation started. The property itself is now asserted, exhaustively, over both corpora: `no_write_expectation_holds_against_the_untouched_world` deals a fresh world and requires every single write expectation in `suite.json` and `blind.json` to REFUSE it, and `validate-suite` runs the same check against a candidate that claims a write and makes none (DEFECT #17). Every other write predicate was re-checked by hand against seed state: the two tasks `s18`/`s73` complete are open at seed, the photograph `s29` files is not in that album, the document `s60` stars is not starred (only the packing list is), and every reschedule moves a row off the day it was seeded on.

**Known-weak, kept, and why.**

1. **`s06`/t3 and `s59`/t2 expect an empty answer.** A system that returns nothing passes them. Both are the _third or second_ turn of a session whose earlier turns it would fail, and both encode a real property (the only Emerald Bay document is trashed; there are no May photographs), so they are scoreable only in combination. They should never be counted as standalone evidence.
2. ~~**`s15`/t2 returns the only album in the world.**~~ — **fixed.** The world now seeds four, and none of the three new ones holds a Tahoe frame: a frame in two albums would have given "what album is that in?" two right answers. It is still the middle turn of a chain and its worth is still the chain.
3. ~~**`s41` "what can I get done in forty five minutes"**~~ — **fixed.** Exactly one task carried `effort_min`, so "return the task that has an effort" passed without reading the number. The world now gives a second open task an estimate far outside the band, which stable handles made a safe change.
4. **`s19` turns 2 and 3 are topically, not referentially, dependent.** "Do I have the rental agreement?" is answerable cold. It still exercises the cross-app hop; it does not exercise conversation state.
5. **`no_action` is 24 turns of 139 — 17%.** Always-clarify buys 12, always-refuse 7, do-nothing-and-say-so 5. That is the intended floor, but it means no `no_action` reason can be read alone: report precision _and_ recall per reason, or a candidate buys a sixth of the suite by never answering. Lane C's `an_always_clarify_candidate_scores_perfect_recall_and_poor_precision` test exists to keep that visible.
6. **Five more cases passed only because the world was small**, and all five are now re-scoped: `s12` and `s39` narrow by a full name and by a role rather than by there being one Ana and one Priya; `s59` asks for a place the world names rather than for everything that is not the trip; `s64` asks for the week rather than for the logbook entire. The world was not kept thin to protect them — see `crates/evalworld/README.md`. What is still on this list: `s40` (a star with no window behind it), and `s84`/`s85` (they enumerate the answer inside their window by hand, so the world may seed no recurring reminder in those months).
7. **`s71` and `s02` are the same rows in two shapes** (count vs ids), as are `s65` and `s09`. Deliberate pairs, not duplicates — but they are correlated, and a per-category average double-counts them.
8. **`s67`'s net balance of `8201` is confirmed** — recomputed from the vault through Tally's own fold rather than from this corpus' arithmetic. It is a _net_, so a candidate answering the gross share is out by 3615. Not weak; listed here because it was the case most likely to be wrong and now is not.

## How a run is reported

**The headline is a session number, and only a session number.** 38 of this suite's turns fall to some degenerate instrument that understands nothing (38 of 129, measured before the five `undo` sessions were added); they survive only because the sessions around them fail. A turn-level rate is therefore not a score, and neither runner prints one except under a heading that says so.

`run-reference` and `run-nulls` lead with three columns:

| column | what it is |
| --- | --- |
| `sessions` | STRICT: every turn of the session correct. The headline. |
| `graded` | mean session grade; a rows turn is F1 over its ids. Partial credit, never a verdict. |
| `de-duplicated` | the same two numbers with correlated sessions collapsed into one unit. |

Two registers are printed with every run, because the score is not safe to quote without them:

- **scoreable only in combination** — `s06/t3` and `s59/t2` expect an _empty_ answer, so answering nothing passes them. They mean something only beside the turns before them.
- **undeclared ordering** — see item 3 below.

Decline precision and recall are printed with a per-reason caveat attached to the number rather than under it. `clarify`, `refuse` and `none` have 0% recall for every non-degenerate instrument, because a retrieval-only runtime never emits a decline: **these reasons separate a candidate that chooses to decline from one that does not, and measure nothing about how well it declines.**

### Cost is a column, never a term in the score

Every run prints what the answers COST, beside what they were worth:

| column | what it is |
| --- | --- |
| `calls` | door calls made — `search`, `open`, `field`, `seal`, `write` — counted per door and summed. |
| `rows` | rows handed back through those doors. Opening a board hands back the board. |
| `ms` | the candidate's own wall clock, p50 / p95 / max per turn and the total. |
| `writes` | commands the vault EXECUTED. A refused command is a call and not a write, and the two are counted apart. |

The brief's first two words are _offline and fast_, and until this existed the harness could not tell a candidate that opens all eight boards from one that asks the FTS plane a single question: they score the same. They no longer read the same. `run-nulls` prints the table for every instrument, which is where the scan-versus-search question is finally visible — `BoardOnly` and `SearchOnly` answer the same corpus through one door each.

**It is never folded into the score.** A cost term in the verdict would be this harness choosing an architecture, which is the one thing the rest of the crate refuses to do; the trade between a slow right answer and a fast wrong one is the reader's to make, with both numbers in front of them. The harness's OWN costs — the vault digest scans and the per-session world deal — are printed apart and charged to nobody, because no shipped runtime pays them.

### What a run costs, and why it stopped costing double

`run-reference` over the whole corpus: **86 s**, of which the candidate's own door time is ~10 s. It was 222 s. The difference is entirely in the harness's own measurement, and neither half of the fix weakens what the digest catches:

- `centraid_ontology::snapshot::SnapshotCache` remembers each table's shape, so the `PRAGMA table_info` sweep over ~140 tables is paid once per world instead of once per turn. The digests are computed from the same columns in the same order.
- `Dealt::digest` gates the scan on SQLite's `total_changes`. The vault holds ONE connection, so an unchanged counter is proof that no row moved — not a heuristic about it — and the ~80% of turns that never write reuse the answer. A turn that wrote re-scans in full, including a write the vault rolled back.
- The digest before a session's first turn is taken ONCE for the whole run and primed into each freshly dealt world, which is sound exactly because dealing is deterministic. `two_fresh_deals_digest_alike` is what keeps that from being an assumption.

`run-reference` prints the scan count beside the milliseconds: **53 scans for 248 turns**, one per turn that moved a row rather than one per turn.

And the same arithmetic applies to `cargo test`, which was **17 minutes** of running the identical reference pass five times over. It is **under 7** now, with nothing removed:

- one reference run per process (`reference_report()`), shared by every test that wants the reference over the unchanged suite — a test with a mutated suite, a different candidate or a fresh world still runs its own;
- the write-side tests run over `sessions_that_write()` — the same assertion over the sessions the assertion mentions, with no write turn dropped;
- the in-process ranking test sweeps two dial settings over thirty sessions, because the property is that the score MOVES with the dial; `run-ranking` sweeps five settings over both corpora in full.

### Does the score RANK, or does it only floor?

`run-ranking` answers it. `degraded::DegradedReference{p}` is the reference with a dial: right with probability `p`, otherwise the best instrument that understands nothing (`KeywordBoth`). The draw is a hash of `(seed, session, turn)` — deterministic, reproducible, and NESTED, so every turn right at `p = 0.5` is also right at `p = 0.9` and the columns may be read across.

```text
                 PRIMARY (90 sessions)          BLIND (60 sessions)
   p      strict      graded    calls       strict     graded    calls
0.00        3.3%       11.4%     3694         6.7%      14.8%     2156
0.50       47.8%       54.8%     1706        53.3%      60.0%     1073
0.70       63.3%       70.3%     1166        66.7%      73.5%      725
0.90       81.1%       86.9%      543        86.7%      91.0%      311
1.00      100.0%      100.0%      173       100.0%     100.0%       93
```

Both columns are monotone in `p` on both corpora, and the bin **exits non-zero** if either ever stops being: a suite that cannot tell 0.5 from 0.9 is a suite nobody should rank candidates with, and that has to be a failure rather than a paragraph. The `calls` column moves the other way, which is the whole argument for keeping cost out of the score: **keyword overlap is cheaper than being right.**

### Training must never have seen the corpus

```bash
cargo run -p centraid-evalsuite --bin overlap-check -- <train.jsonl> [<val.jsonl> …]
```

Four questions, two of them fatal. **Fatal:** an exact request collision (normalised for case, punctuation and spacing) between the training file and either corpus, and a `template_id` shared between the training file and a validation file — holding out WORDING while training on the TEMPLATE holds out nothing. **Reported for a person to rule on:** the 4-gram collision rate, which is partly just English, and proper-noun leaks — the names and places the corpora are built on appearing in training requests, which is what quietly lets a model resolve an anchor without retrieving anything.

### Correlated sessions

A session may declare `"correlation_group": "<name>"`. Sessions sharing a name are averaged into one unit before the de-duplicated column is taken. `s71`/`s02` are the overdue task as a count and as a row; `s65`/`s09` are the trip's four expenses as a list and as a sum. Both pairs are deliberate — the _shapes_ are what is being told apart — but a per-category average counts the same retrieval twice. The raw column stays on the page beside the collapsed one; collapsing is a second reading, not a correction.

The group must be **declared**, never inferred: `s71` and `s02` share no id at all (one expects a number), so no overlap detector could find that pair.

## What still cannot be expressed

1. **Anything that depends on soft-delete in tasks or agenda.** Those two doors disagree: neither filters `deleted_at`, so the trashed task "Return the library books" (due Thursday the 18th) is absent from the FTS door and present on the board. "What's due this week" would score _which door a candidate happened to use_. Every task window here is chosen to miss the 18th — overdue, next week, Wednesday. **When that is fixed, that case is the first to add.**
2. **The content of a row.** `s61` can assert which note answers "what does the shortlist say about Truckee", not that the right half of it was read. Retrieval is scoreable; comprehension is not.
3. **Ordering the suite does not itself define.** `ordered: true` appears only where the corpus can state the order it means (two tasks, 09:00 then 14:00). The scorer now makes that claim explicit: an `ids` case may carry `order_by`, the sort it asserts, in words. The sequence is scored strictly either way — relaxing it would weaken the verdict — but every `ordered` turn with **no** `order_by` is listed in the run reports' UNDECLARED ORDERING register, and three live cases (`s18/t1`, `s49/t1`, `s72/t1`) are in exactly that state. "The second photo" was drafted and dropped: four frames, two sharing a capture minute, no stated sort — it would have scored sort choice rather than reference resolution. `s29` reaches into the previous result by content instead.
4. **`locker_field_revealed` is barely observable.** Revealing a sealed cell changes no row a scorer reads; the only trace is a `locker.reveal_receipt`. The scorer does look there — `declining_to_reveal_fails_the_locker_reveal_case` is that assertion — but the changed-row set cannot help it: a receipt is filed for _every_ command, so it is exempt globally and a reveal against an item nobody asked about is invisible (DEFECT #18).
5. ~~**Partial credit.**~~ **Closed.** The verdict is still all-or-nothing — it is what defeats a breadth-dumping candidate outright — but the scorer now reports a **graded score** beside it: each rows turn is scored F1 over its ids, each session is the mean of its turns, and the headline is the mean over sessions. Four of five Emerald Bay rows now scores 0.89 against 0.00 for none, which is the finding `s16` was built to produce. F1 and not recall, on purpose: `EverythingOfEntity` leads every candidate on id recall and is graded near the floor.
6. **Interleaved and resumed threads.** Every session here is linear. "Do that thing we talked about before the interruption" needs a reference across an abandonment, and the corpus has no way to mark which earlier turn a later one resumes.
7. **Ordering _between_ the writes of a `write_set`. REFUSED, not missing.** All listed writes must hold; nothing says one must precede another, and nothing can: predicates read the vault _after_ the turn, and two orderings of the same writes leave the same vault. A `write_set` that sets `"ordered": true` therefore **fails with a complaint naming the refusal** rather than having the flag quietly ignored. Scoring write order needs an ordered write _log_ in the outcome vocabulary, not a flag here — and that would be the harness scoring a call sequence, which is the one thing it is built not to do.
