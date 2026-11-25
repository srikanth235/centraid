# UNPLUGGED (#1214, checkpoint 1)

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
| `alerts.rs` (whole module, out of `lib.rs`) | K8 | keyed by entity and offset; the new `alert` is keyed by reminder id and lives in the index file. `Vault::advance_alerts` returns 0 and the commit guard writes no alerts until K8 |
| `task_counts.rs` (out of `lib.rs`) | tasks lane | read flag edges |

## Kernel code that is a stub or a minimal patch (compiled; each lane finishes its own)

| Where | What was done | Owner |
|---|---|---|
| `commands/follow/systems.rs` | `SYSTEMS` is empty; the per-system maps are in this file's history at `40b18d2c`. The engine (`merge.rs`, `commands.rs`) is untouched and its tests are aside | K9 and each app lane (re-adds its map) |
| `commands/edge.rs` | `Rel::Links`/`Attendee`, `state` and the reverse-link dedupe removed; shape check reads `entity_kind.linkable` for `*`; `anchor` carries `"v":1` | K5 |
| `links.rs` | compiles (`Kind::Workout`, no `Links` rel); **its SQL still reads the old `links` edges** and is wrong | K5 |
| `commands/note.rs` | compiles; still writes the old columns (`notebook_id`, `wikilink` edges), so `note.create`, `note.edit` and the rest fail against the new tables until K11 rewrites it. A note is made in tests with `common::insert_note` | K11 |
| `commands/follow/` (the pass) | a follow pass commits through `Vault::commit` or `Command::as_actor`; it must say `Actor::Store { origin_id }` (`CommitTx::set_actor`) so its revisions carry `actor = 'store'` and the origin, which the table's CHECK demands of a store. `follow::system_of` (read only by the old cause parsing) is gone | K9 |
| `history/write.rs`, `commands/event/times.rs` | `history.keep_version` keeps `table.column` fields only; the event overlay (`attendee`, `reminder` lists, the `occurrence`/`DAY` day) is gone: an occurrence is outside a series' snapshot (B1) and guests and reminders are rows with their own keys. `commands/event/times.rs` still names `history::DAY` | calendar lane |
| `history/restore.rs` | a restore re-links a note only when its words came back different (`note::relink`), so restoring a note's words works once `commands/note.rs` is rewritten | K11 |
| `index/past.rs` | `EARLIER_COLUMNS` still names `occurrence` (outside a snapshot since B1, so no version holds one); the Locker's earlier plain cells are in the history and `ix.search_past`'s own comment says they are searched | K7 |
| `index.rs`, `index/text.rs`, `index/past.rs` | `DEPENDENTS` and `text_of` read the new tables; `search_owed` is keyed by `entity.n` and the label drain still works on it; **rows with `after IS NULL` (a whole entity owed after an index file is re-founded) are written by `Vault::open` and are not drained yet** | K7 |
| `file.rs` | founds and attaches `<stem>.index.db` (schema `ix`); a missing or stale one is founded again and owes every entity | K7 |
| `backup/files.rs` | `RENTERS` and the original-file read use `revision_blob`, `note_asset`, `locker_item_field.value_blob`, `photo.motion_blob`; **the index file is not yet kept out of a restore or rebuilt after one**, and the sealed-file hook is not written | K10 |
| `commands/blob.rs` | the variant check reads `derivative_variant.has_out` (no list in Rust); `blob.claim` helpers removed (dead) | K10 |
| `backup/drill.rs` | `dump` leaves the index's own queue (`search_owed`) out: a restored vault founds its index file again and owes it every entity, a live one does not | K10 |
| `log/guard.rs` | the census hides `geo`, `index_state` and their shadows | K7 |

## Test files under `tests/unplugged/`

Each is the old test of a thing the new schema changed; the owner rewrites it against the new tables
and moves it back.

- **K5 graph (edge.rs, links.rs, link and mention tables)**: `graph`, `links`, `shared_verbs_edges` (the edge half of the old `shared_verbs`; `edge.rs` still builds a relation's id with `model::concept_id`, which only a seeded concept has: a member's is minted, found by `concept(kind, key)`)
- **K7 index file (index/, writers, search_owed drain, geo)**: `index_owed`, `index_walks`, `page_source`
- **K8 reminders and alerts (alerts.rs, reminder, alert)**: `alerts`
- **K9 following (commands/follow/, arrival.rs, origin_cursor.rs)**: `arrival` (an arrival is two columns of `entity` now and makes no origin or source; `arrival::SYSTEMS` is read only by `follow/merge.rs`'s exclusion clause, now dead), `shared_verbs_people_follow`, `origin_cursor`, `follow_items`, `follow_reminders`, `follow_retire`, `follow_stated`, `follow_gaps`, `calendar_follow`
- **K10 blobs and backup, phone side (blob.rs, backup/)**: `backup_sim`, `restore_drill`, `blob_release` (the bytes under the trash, from the old `trash_and_bytes`), `shared_verbs_blobs` (`backup_snapshot` is plugged: its proof file is named by the `promises` rule)
- **K11 notes (commands/note.rs, note_portable.rs)**: `notes`, `note_portable`
- **K12 commitments and generated pages**: `commitments`, `stored_rules`, `ontology_page`, `ontology_widen`
- **app lane: calendar/tasks (event, ical, task, occurrence, reminders UI reads)**: `agenda`, `agenda_days`, `agenda_portable`, `agenda_wave2`
- **app lane: documents and photos**: `docs_photos`, `document_portable`, `photo_portable`, `store_health`
- **app lane: people (person, contact_point, touch, person_date)**: `people`, `person_portable`
- **app lane: money (money, txn, rule, csv, splits)**: the ignored TODO `a_line_split_across_categories_keeps_a_sum_when_one_is_purged` in `shared_verbs.rs` (purging a category drops the `txn_split` parts that name it; a line left with other parts no longer sums to its amount, which E3 leaves to this lane), `money_health`, `money_opening_rename`, `txn_portable`
- **app lane: health (workout, measurement, reading)**: `health_portable`, `workout_whole`
- **app lane: locker**: `locker_clock`, `locker_commands`, `locker_plaintext_gate`, `locker_wall`
- **app lane: chat (thread)**: `chat`
- **export (vault_export, every kind)**: `vault_export`, `unusual_input` (every app's export of unusual text; none of it the kernel)
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
