# `centraid-evalworld` — the seeded world an assistant evaluation is scored against

**Two** vaults, not one — see "The SECOND world" below. Deterministic. Written through the **real typed commands**. Dense enough across all eight apps that a question about either has more than one plausible answer.

```bash
cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world
```

That writes four things into the directory:

| Path | What it is |
| --- | --- |
| `world.db` | the vault |
| `world.bytes` | its content store — the same `centraid_blobs::ByteStore` a gateway serves |
| `keys/` | Locker key custody: the key file `K` is sealed under |
| `inventory.json` | **the artifact a corpus lane reads**: every row by id, label, entity, date and state |

The build takes about 35 seconds and leaves a 30 MB `world.db`. It folds the write-ahead log back in at the end: the vault sets `wal_autocheckpoint = 0` because under capture the application owns checkpoints, and nothing in a build owned one — at 73 rows that was invisible, at five thousand it was a **1.4 GB `-wal` beside a 4 KB database**, copied once per session by `evalsuite`.

It refuses a directory that already holds a founded vault, and there is no `--force`.

## The SECOND world, and why there is one

`crates/evalsuite`'s `suite.json` and `blind.json` are two corpora over THIS world. That holds out wording and nothing else: a third of the blind set's handles name rows the primary suite also names, and 58% of its requests share a three-gram with a primary one. A fine-tune that has memorised _the dentist is Neha Rao, the trip is Tahoe_ transfers straight across, and the blind-versus-primary gap then reports a generalisation nobody measured.

So this crate seeds two worlds:

| `Scenario` | owner | the weekend away | the professional | source |
| --- | --- | --- | --- | --- |
| `First` (default) | Sam Whitaker | Tahoe | a dentist | `scenario.rs` + `bulk.rs` |
| `Second` | Dara Okonjo | Mendocino | an optometrist | `scenario2.rs` + `bulk2.rs` |

```bash
cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world
cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world-2 --scenario 2
```

They share their SHAPE, because the shape is what makes a vault a vault and is not the thing being held out: all eight apps, ~5,250 rows, recurrence, a long tail of old notes, few counterparties carrying many transactions, photo bursts, duplicated names, soft-deleted rows in seven apps, a link graph, tags, collections, and a collision structure of the same kind — two people sharing a first name, a place with several photographs, a task and an event sharing a title, five obligations across five people, four albums, a document trashed inside its thirty-day window.

**They share no proper noun.** Not a person, not a place, not a trip, not a merchant, not a notebook, not a folder, not a photo-burst caption — and not a label TEMPLATE either, because a tail that reused `"Notes — {} ({})"` would hand a candidate the shape of a label it had already been fitted to. `tests/world2.rs::the_two_worlds_share_no_proper_noun` tokenises every label of both worlds and asserts the vocabularies do not intersect, so the claim is checked rather than intended.

What a proper noun IS, for that test: a capitalised token this world writes somewhere other than at the START of a label. A label is a sentence and its first word is capitalised by orthography, not because it names anything — "Water the plants" and "Water bill 004" share a verb and a utility, not a cast. Multi-word names survive the rule through their tails ("Emerald Bay" is label-initial everywhere; `Bay` is not), and one-letter tokens are English rather than names.

`bulk2.rs`'s generators take a `Vocabulary` rather than reading constants, so a THIRD world is a word list and not a third file. `bulk.rs` is not yet pointed at it — it was held by another lane when this was written — and that is the only reason the two tails are separate functions.

## Why the world is built and not fixtured

`crates/apps/*/tests/parity.rs` rebuilds a vault from `contracts/schema/vault-ddl.sql` plus a `rows.json` bundle. For a parity suite that is right; here it is not. A hand-written row carries no `core_entity` sibling, no `row_version`, no ledger entry and no FTS trigger firing — so a runtime scored against one is scored against a vault no member has. Every row here goes through `Vault::execute`.

It is also why this crate holds **no SQL**. `cargo xtask rules`' `sql-confinement` allows SQL only under `crates/{ontology,vault,search}` and `crates/apps/kit`. The two rows the scenario has to _discover_ rather than mint — the calendar `Vault::found` writes, and the place a photograph's coordinate collapsed into — are read through `PageQuery` + `centraid_apps_kit::testdoor::TestDoor`, which is statements-as-data.

## Determinism, and the one place it stops

`FixedClock` + `SeededIds`. The same seed replays the same ids in the same order, and every date is arithmetic from `NOW_MS` (2026-06-15T09:00:00.000Z) rather than from a wall clock — a suite whose expected answers drift with the calendar goes red on a Tuesday for no reason anybody can act on.

**Locker ciphertext is the exception, and deliberately so.** `encrypt_under_locker_key` draws a fresh nonce per call and the key comes from the OS, so two builds hold the same locker _rows_ sealed under different _bytes_. That is the property the locker's custody rests on; it is not one to fixture away. The determinism suite therefore compares the inventory, which is what a corpus author writes against — not files.

**A command that forgets to stamp `created_at` is the other way it stops, and it is a bug rather than a property.** `schedule.add_task` did exactly that: it let both `created_at` and `updated_at` fall through to the column DEFAULT, `strftime('now')` — the **wall** clock — while `set_task_status` and `delete_task` stamped from the injected one. Every trashed task (36) and every completed one (667) therefore carried a state change dated _before_ its own creation, and the Tasks board, which pages by `created_at`, was ordering this world by whenever the build happened to run. Fixed at the command (`crates/vault/src/commands/schedule.rs`), because this crate holds no SQL and could not have worked around it. Six tables still take a wall-clock `created_at` — `core_entity`, `core_transaction`, `schedule_event_ext`, `social_circle`, `tally_expense_payer`, `tally_expense_split` — and none of them carries a state stamp to contradict; `crates/evalsuite/DEFECTS.md` #23 is the record.

## The shape of the world

**5,268 rows**: `agenda=627 docs=326 locker=125 notes=1506 people=260 photos=443 tally=1271 tasks=710`. Ninety-five of them are the STORY — one household's week, every collision in the table below — and the rest is the long tail a real vault carries around it (`src/bulk.rs`).

By entity, where a corpus author is most likely to look: `core.event` 627, `knowledge.note` 1,507, `schedule.task` 710, `core.document` 326, `tally.expense` 1,256, `core.content_item` 427, `core.party` 180, `locker.item` 125, `people.important_date` 38, `social.contact_channel` 40, **`core.place` 12**, **`tally.obligation` 5**, **`core.activity` 5**, `tally.group` 6, **`media.album` 4**.

The five bold-ish counts are the ones this world deliberately grew on 2026-09-21, and every one of them was a SINGLETON or close to it before. A singleton is not a fact about a vault, it is a free pass: while the world held one obligation, "does anybody owe anybody anything" was answered by returning the only obligation row there is, and a runtime that never read `direction` scored the same as one that did. The four new obligations all point the OTHER way — owed TO the owner — so exactly one party is still owed money BY them and every case that names a person keeps its answer while getting harder.

Beside the rows, the world now carries the EDGES a lived-in vault grows:

| edge | how many | why |
| --- | --- | --- |
| `schedule_attendee` | 4 story events, ~17 tail events | "who's coming to this" was a question about a title. **"Dinner with Neha" has none on purpose** — it is the one event whose whole value is that nothing in the vault says which Neha |
| `core_link` | 16 | the apps shared a WORD and nothing else. The trip's plan is joined to its events, its documents, its note and its expenses; the dentist's rows are joined to the party. **The trashed permit could not be joined to anything**: `core.link_entities` refuses a subject that is not live, so the graph cannot answer "was this deleted thing part of the trip" |
| `core_tag` (member labels) | 21 rows across four apps | the packing list was the only tagged row in the world |
| `core_collection_entry` | 8 collections with entries | two notebooks and a folder already existed; what is new is that a NOTEBOOK and a FOLDER may share a name and hold different rows — "Travel" and "Health" are both |

The tail is why the world exists at this size. "Open all eight boards and read every label" is free at 73 rows and impossible at 73,000, so a 73-row corpus cannot decide search-versus-board — the one architectural question an assistant evaluation is for — and every recall number it produces is inflated, because a naive keyword query is a far better strategy over 73 rows than over a vault somebody has lived in.

What the tail is made of: two years of logbook behind the Tasks board (700 completed items), two years of one-slot-a-day calendar, 1,500 old notes over sixteen subjects, a ledger of 1,250 expenses across twelve recurring merchants and four groups, eight photo bursts of two dozen frames each at eight coordinates, 212 more people whose first names are carried by a dozen apiece and whose birthdays are ordinary rather than unique, and a 120-item Locker.

### It collides one step to the side of the story's nouns

The first cut deepened them directly — more rows saying "dentist", more saying "Emerald Bay" — and the hand-written reference fell from 129/129 to 63 of 85 sessions, every failure returning the whole expected answer _and more besides_, not one expected row missed.

**Deepening the suite's own nouns does not make the suite harder, it makes its ground truth wrong.** A note titled "Tahoe — loose ends" really _is_ a note about Tahoe; a case expecting one row was written against a vault that held one. So the tail says `Dental check`, `Donner weekend`, `the lake place` instead: the same neighbourhoods, different words. A reader that understands meaning has a thousand more rows to tell apart; an exact-token index is not confused by them, so no expected answer moved. It also makes the near-miss the interesting measurement — the gap between matching tokens and matching meaning is now visible, where in a 73-row world there was nothing to be wrong about.

That rule governs the tail's VOCABULARY. It does not govern its structure, and the structural collisions are at full strength: a dozen people to a first name, birthdays as an ordinary row, a two-year logbook, eight more named-able places, a Locker nobody can read end to end. No tail row's own date falls within 200 days of the world's now.

### What the scale showed about the doors

Two things only a big world can say, both worth having:

- **The Tasks board hands back 50 logbook rows and no more**, newest-completed first, whatever limit is passed — by design, "its size is the screen's". So a logbook of 700 is _not walkable_ through the board door: "what did I finish last spring" is unanswerable by scanning and needs a query. At 73 rows the logbook was two rows and the cap was invisible.
- **A board scan of Locker is no longer free**, which is why the tail seeds 120 sealed items. See the Locker section below.

### Scarcity is not difficulty

Scaling exposed a second thing. Five cases passed only because the world was small — the only Priya, the only Ana with a birthday, the only task carrying an estimate, "home" meaning _everywhere that is not the trip_, "what have I ticked off" over a two-row logbook. Deepening any of those does not make the question harder, it makes it wrong.

**A corpus may not be kept honest by keeping the world thin.** Each of the five was rewritten to narrow by something real — a full name, a role, a window, a named place, a second row carrying the same field — and only then was the tail allowed to deepen. Three plantings in the story exist for that reason and are marked in the source: `Home` is a named place, `Plan the Tahoe trip` carries a second `effort_min`, and the two completed tasks are ticked off last so their completion stamps are this week's.

What the tail still avoids is a shorter list, and every item is ground truth it would _change_ rather than crowd: recurring `MM-DD` reminders inside the months the story's calendar covers (a recurring date cannot be put safely in the past), starred photographs (a flag with no window behind it), and any label that would make a handle resolve to two rows.

**The world's source names no case and no question.** It records the property each constraint protects and nothing more — a second corpus is authored blind against this world, and a comment naming what is scored would hand it the answers.

The tail is written FIRST and the clock is then jumped forward, so every story row's `created_at` is exactly what it was at 73 rows. The ids move; the suite names rows by stable handle and does not care.

People is the app whose rows are mostly NOT parties. A debt, a birthday, a logged call, a phone number and a journal entry are each their own row, in the table the command actually writes — `tally_obligation`, `people_important_date`, `core_activity`, `social_contact_channel`, `knowledge_note` — and each carries its salient scalar in `Entity::value`. "Who do I owe money to" is answered by a party; "how much" is answered by `12500`, and a corpus that could only name the party would score a candidate correct for finding the debt and saying the wrong number. The one genuine exception is **cadence**, which is a column on `people_profile` and has no id: it rides on the party row's `value`.

## The planting

A world where exactly one row says "dentist" scores every candidate architecture as excellent at a job it never had to do. So the world plants, and each planted row carries a `planted:` note into `inventory.json` saying what it collides with.

| Planted | Where |
| --- | --- |
| Eight rows saying **dentist**, across six apps | notes ×2 (one trashed), docs, tasks ×2 (same due day), agenda, tally, locker |
| Four parties matching **Neha** — two whole people, one bare-first-name Tally friend | people ×2, tally ×1 |
| Five matching **Marco**, one of them a trashed misspelling | people ×3, tally ×1, photos ×1 |
| An **event and a place with the same name** — "Emerald Bay" — plus a note, a document and a Locker login | agenda, photos, notes, docs, locker |
| A **task and an event with the same title** — "Book the Tahoe cabin" | tasks, agenda |
| **Overlapping windows**: a trip spanning `+5…+8`, a task due `+7`, three rows landing on `+2`/`+3` | tasks, agenda |
| **Soft-deleted rows in seven apps**, several colliding with live labels | notes, docs, tasks, tally, photos, locker, people |

Every event slot is disjoint, because `schedule.propose_event` refuses a busy overlap vault-wide. The overlapping windows this world needs are therefore between the calendar and the board — which is also where they overlap in a real week.

## Locker is the app the search plane cannot reach

`crates/search` has seven domains and Locker is not one: _"a secret cannot become a link target by adding a probe"_. The absence is structural, so asking that door for `locker.item` is a typed refusal rather than an empty page. Two Locker rows here carry labels that collide with rows other apps hold, precisely so a candidate runtime that reaches every app through one text index is scored against what it structurally cannot see.

It holds **125 items**, not five. At five, "open the board and read every label" was free — and a free board scan of the one app a searcher structurally cannot reach would have been the single place a board-scanner paid nothing while a searcher paid everything, which is exactly the artefact that corrupts the search-versus-board comparison this world exists to price. The tail's secrets are really sealed, under the story's own custody, through the same helper: the key is now founded ahead of the long tail so it exists before anything needs it.

## What is NOT here

The corpus and the scoring. This crate answers "what is in the vault"; it has no opinion about what a good answer to a question about it looks like, and it must not grow one — a world that knew the questions would be a world shaped to them.
