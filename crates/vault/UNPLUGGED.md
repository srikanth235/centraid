# UNPLUGGED (#1214, checkpoint 1)

## The pattern (notes, K11: copy `commands/note.rs`, `tests/notes.rs`)

Re-plugging a module, in order:
1. **Registry**: `pub mod` in `commands/mod.rs` and its `definitions` in `Registry::with_system_commands`; no verb the shared ones already are (`entity.move`, `retitle`, `trash`, `star`, `tag.add`, `edge.add`).
2. **Home and kind row**: create with `ctx.insert_entity_in`/`_under` (the home is `entity.parent_id`; refuse in a sentence with `entity::home_refusal`); a move is `entity.move`; a rename of anything linkable goes through `entity::rename`, a create through `insert_entity_*` (both call `note::resolve_waiting`).
3. **Lookups**: if your command says the kind needs a title, set its `entity_kind.may_be_unnamed` to 0 in the baseline seed; a size budget stays in the command, not a CHECK. Read an attribute (`entity_kind.linkable`, `home_shape`, `*_kind` rows), never a list of kinds in Rust; a new lookup value is a baseline row and `tests/lookups.rs`.
4. **History**: `history::TABLES` (kind row), `Role::Child` (child tables), `BLOB_SLOTS` (a rented blob, slot `<name>:<id>`), `OMITTED`/`CONTENT`; the commit door writes versions, the command never does. Do not collect a slotted blob in the handler: the new version names it.
5. **Search**: `Kind` SEARCHABLE (`model.rs`) and the kind's arm in `index/text.rs::text_of`; a labelling row goes in `DEPENDENTS`.
6. **Rules twice**: each sentence a precondition says is also a CHECK, key or trigger in the baseline, with a raw-SQL row in `tests/schema_rules.rs` (a baseline edit means `SCHEMA_DIGEST`, `format_identity.rs`, `cargo run -p centraid-vault --bin export-ladder-ddl > contracts/schema/vault-ddl.sql`).
7. **Tests**: against `tests/common/world.rs`; plan tests (`EXPLAIN QUERY PLAN`) assert an index name and no `TEMP B-TREE`/`SCAN`, never seconds. Move the old file out of `tests/unplugged/` (delete what tested removed behaviour, with a line saying why).
8. **Regenerate**: `export-commands > contracts/schema/vault-commands.txt` when verbs change; delete your rows here; run `cargo xtask rules`.

The v0 schema (`contracts/migrations/001_baseline.sql`, with the index file's own ladder in
`contracts/migrations/index/001_index.sql`) replaced the old baseline whole. Everything that was
written against the old tables is either rewritten (the kernel lane: `model.rs`, `lookups.rs`, the
founding, the index file, the history writer's columns) or **unplugged** here until the lane that
owns it rewrites it against the new tables. This file is deleted by the last lane.

How to read it: a *module* listed below is out of `commands/mod.rs` and the registry (its `.rs`
file is still in the tree, not compiled); a *test file* listed is under `tests/unplugged/`
(cargo does not discover it). To re-plug: add the `pub mod`, add its `definitions` to
`Registry::with_system_commands`, rewrite it against the new tables, and move the test file back
and make it pass. Tests of removed behaviour are deleted, not ported.

## Modules out of `commands/` (not compiled)

| Module | Owner | Why it cannot compile or run yet |
|---|---|---|
| `contact_point`, `person`, `person_portable` | people lane | `person` columns moved (`given`, `family`, `org`, `person_date`); birthday and anniversaries; `touch` is its own kind; merge is rewritten (A8) |
| `event` (`event/`), `event_portable`, `ical` | calendar lane | `Rel::Attendee` is `event_guest`; calendar is the home (`parent_id`); `location`; series split; `reminder` rows |
| `task`, `task_portable` | tasks lane | home is `parent_id`; `due_timing`, `scheduled_on`, `series_id`; reminders are rows |
| `document`, `document_portable`, `photo`, `photo_portable`, `place` | docs/photos lane | folder is the home; photo lat/lon, motion, no `blob UNIQUE`; no place from coordinates |
| `money`, `txn_portable`, `rule`, `csv` | money lane | `txn_split`, `entered`, no `void`, no `txn.currency`, `Flag` gone |
| `workout`, `measurement`, `health_portable` | health lane | `workout`, `touch` and `reading` are kinds; `measurement.origin_id`; `reading` |
| `thread` (chat) | chat lane | chats are ordinary trashable entities (L5); refusals/notices are lookups |
| `vault_export` | export | reads every kind |
| `locker` is **compiled, not registered** | locker lane | its SQL is the old Locker (memo, alias, address tables); its constants are read by `custody/` and `history/read.rs` |
| `task_counts.rs` (out of `lib.rs`) | tasks lane | read flag edges |

## Kernel code that is a stub or a minimal patch (compiled; each lane finishes its own)

| Where | What was done | Owner |
|---|---|---|
| `commands/follow/systems.rs` | `SYSTEMS` is empty: the engine (K9, done) reads what a system fills, retires, names and yields from `origin_system` and `source_shape`, so a map says only the kind's fields and how a record reads. **An app lane registers its system's map in one step, a `SystemMap` row in `SYSTEMS`** (the pass command `follow.<…>`, its schema and its preconditions are built from the rows by `follow::definitions`); the per-system maps of the old engine are in this file's history at `40b18d2c`. A map's `defaults` return only the kind's own columns the origin decides (the home is `entity.parent_id`, set by the engine when `home_shape` allows it); a map's `shape` puts instants in the clock's one form with `follow::canonical_instants`. Prove the map with `tests/common/follow.rs`'s pattern: `follow::definitions_for::<YourMaps>()` registered beside `entity::definitions()` | each app lane |
| `commands/note.rs` | compiles; still writes the old columns (`notebook_id`, `wikilink` edges), so `note.create`, `note.edit` and the rest fail against the new tables until K11 rewrites it. A note is made in tests with `common::insert_note` | K11 |
| `history/write.rs`, `commands/event/times.rs` | `history.keep_version` keeps `table.column` fields only; the event overlay (`attendee`, `reminder` lists, the `occurrence`/`DAY` day) is gone: an occurrence is outside a series' snapshot (B1) and guests and reminders are rows with their own keys. `commands/event/times.rs` still names `history::DAY` | calendar lane |
| `history/restore.rs` | a restore re-links a note only when its words came back different (`note::relink`), so restoring a note's words works once `commands/note.rs` is rewritten | K11 |

## Test files under `tests/unplugged/`

Each is the old test of a thing the new schema changed; the owner rewrites it against the new tables
and moves it back.

- **checkpoint 2/3: crates/ontology**: `ontology_graph` (was `graph`): tests `centraid_ontology::graph`'s catalogue of edge relations and column links and its Locker-wall reads. It waits because `crates/ontology` is rewritten in a later checkpoint (its list still names `links` and `attendee`, and there is no Locker wall now); the vault-only edge tests are `tests/graph.rs`
- **K5 graph, also**: `edge_walks` (the `edge_order` plan, moved out of `index_walks`; its fixture writes the old ids)
- **money and people lanes, also**: the budget-key plan and the contact-point index plan were in the old `index_walks`: each lane re-proves its own statement beside its own tests
- **K12 commitments and generated pages**: `commitments`, `stored_rules`, `ontology_page`, `ontology_widen`
- **app lane: calendar/tasks (event, ical, task, occurrence, reminders UI reads)**: `agenda`, `agenda_days`, `agenda_portable`, `agenda_wave2`, `calendar_follow`, `follow_reminders` (the phone Reminders' tasks), `lane_follow_items` (an event's guests), `lane_follow_stated` (an event's fields, a followed series' days), `lane_follow_gaps` (a series' overrides, a followed calendar the member trashed), `lane_follow_retire` (a calendar and the Reminders followed again)
- **app lane: documents and photos**: `docs_photos`, `document_portable`, `photo_portable`, `store_health`, `lane_follow_stated` (a followed document), `lane_follow_gaps` (a followed file claims its bytes in its command), `lane_origin_cursor` (`photo.add`'s `roll_cursor` and `roll_device`; the engine's own cursor tests are `tests/origin_cursor.rs`), `arrival` was deleted (below)
- **app lane: people (person, contact_point, touch, person_date)**: `people`, `person_portable`, `shared_verbs_people_follow` (the contacts pass through `follow.contacts`, and `person.merge` calls `follow::move_sources` for every source of the row that goes), `lane_follow_items` (contact points), `lane_follow_stated` (a person's fields and points), `lane_follow_gaps` (`person.merge` carries the phone links)
- **app lane: money (money, txn, rule, csv, splits)**: the ignored TODO `a_line_split_across_categories_keeps_a_sum_when_one_is_purged` in `shared_verbs.rs` (purging a category drops the `txn_split` parts that name it; a line left with other parts no longer sums to its amount, which E3 leaves to this lane), `money_health`, `money_opening_rename`, `txn_portable`, `lane_follow_gaps` (a statement line, its payee kept and its origin one per account; the engine's own statement test is `tests/follow_retire.rs`)
- **app lane: health (workout, measurement, reading)**: `health_portable`, `workout_whole`, `lane_follow_stated` (a followed workout's measures), `lane_follow_retire` (Health followed again), `lane_origin_cursor` (health days and a delta's deleted workouts; `follow::write_day_totals` is the one writer of `measurement.origin_id`)
- **app lane: locker**: `locker_clock`, `locker_commands`, `locker_plaintext_gate`, `locker_wall`
- **app lane: chat (thread)**: `chat`
- **export (vault_export, every kind)**: `vault_export`, `unusual_input` (every app's export of unusual text; none of it the kernel)
- **deleted by K9, with the reason**: `arrival` (an arrival is two columns of `entity` and makes no origin or source; the both-or-neither rule is `tests/schema_rules.rs` `a_trashed_by_names_a_trash_and_an_arrival_has_both_its_words`, and each lane proves the arrival its own command takes). The old `follow_*` and `origin_cursor` files were rewritten as engine tests (`tests/follow_retire.rs`, `follow_stated.rs`, `follow_items.rs`, `follow_gaps.rs`, `origin_cursor.rs`, `follow_totals.rs`, over the maps in `tests/common/follow.rs`); what they said of a named app kind stays aside as `lane_follow_*` and `lane_origin_cursor`, listed under its lane, for the lane to port or delete where an engine file already holds the case
- `schema_rules` (the earlier proof of the app tables' rules, written against the model before
  #1214): the lanes re-prove their own rules in the new `tests/schema_rules.rs`, which holds the
  kernel's.

Unit tests inside `src/` that read the old model were fixed where they were cheap (ids are minted
UUIDv7: `src/test_ids.rs`; `commands/locker/mod.rs`'s type list now reads `locker_type`).
`tests/format_identity.rs` carries the new schema digest as the "release" digest: no release has
shipped, so the baseline was replaced in place (#1214, Scope).

## Not done by this lane (so not here)

K5 to K12 as listed in the issue. `contracts/schema/vault-ddl.sql` and `contracts/schema/vault-commands.txt`
are regenerated by whoever changes the schema or the registry (`tests/command_list.rs` is plugged: a lane that
re-plugs a module regenerates the list in the same commit). The ontology page is regenerated at the end of the
checkpoint; `tests/ontology_page.rs` is aside until then. The index file's DDL has no generated fixture yet.
