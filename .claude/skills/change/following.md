# Following a phone store

The phone's own stores (contacts, calendars, reminders, a picked folder, the health store) are read one way into the vault. Nothing is written back. What a member is promised is in [arrive-take-out](../product/rulings/arrive-take-out.md); this page is where the code lives.

## The three layers

- **Shell reader.** It reads the store and returns a snapshot. It decides nothing and names no command.
- **Follow coordinator** (`crates/screens/src/follow`). It decides when to read and hands the snapshot to the store's follower.
- **Vault command** (`crates/vault/src/commands/follow/`). It merges the snapshot. The merge is the vault's alone.

## The coordinator

- `Store` in `follow/mod.rs` is the list: contacts, calendar, files, health, reminders. `Store::ALL` is the order a window follows them.
- `Follows` is the board the screens, the folder follower and the pass service share (`Ctx::follows`). It holds the asks and what the last pass said (`Report`).
- `coordinator.rs` is a service (`follow.coordinator`), not a screen. It hears four triggers:
  - the app coming forward, for every store;
  - `PhoneChanged`, answering the `PhoneWatch` it asks for at start (contacts, calendar, reminders);
  - `Follows::changed`, from a home that appeared, a pull to refresh or an import;
  - `Follows::window`, once a background window has finished its backup.
- A trigger carries no data. A missed one costs a pass later, and a doubled one writes nothing.
- `gate.rs` is the pure machine behind it. The first trigger arms a two-second settle, later ones join it, one pass runs per store, and any number of triggers during a pass queue exactly one more. It holds no clock and no thread.
- A pass reads the keychain habit first (did this device import or connect?) and stops there if not. Then it asks the shell for a read with `ask_permission` false and gives the answer to the store's `run` (`contacts::run`, `calendar::follow::run`, `health::follow::run`, `reminders::run`). Files are the exception: the coordinator wakes the folder follower (`imports.files`) by name and waits for it to say it ended.
- Each `run` sends one manifest action per origin (for example `follow-calendar`, which is the command `follow.calendar`), then reports through `Follows::read`, `denied`, `judged` and `refused`. Then the screen that shows the store is signalled to draw again (`Store::shown_by`).
- A read that never answers is dropped after `READ_TIMEOUT` (two minutes). An answer that names an older effect number is ignored (`effects_numbered`).
- `reconnect.rs` is the page a restore offers. It lists the origins the vault holds (`shell.followed-stores`, Reminders left out) that this phone does not follow, and connects nothing by itself.

## The vault

- **What a system is comes from the file.** `origin_system` (the kind of home a follow fills, `can_retire`, `on_device`) and `source_shape` (which kinds it yields) are seeded lookup rows in `001_baseline.sql`; no CHECK, trigger or `match` in Rust names a system. A new system is a seed row plus a map.
- **`follow::SYSTEMS` is a table of `SystemMap` rows** (`follow/systems.rs`, with the maps that live beside their kind: `person.rs`, `document.rs`, `photo.rs`, `task.rs`, `workout.rs`, `reading.rs`): contacts, calendar, files, camera_roll, phone_reminders, health (a workout map and a reading map) and statement (an account's import, not a phone store). A row says the command (`follow.<system>`), the kind it fills, the columns it owns, its match keys, what a record gone from a complete read does (`Gone`) and its children. A `defaults` fn returns only the kind's own columns the origin decides (the home is `entity.parent_id`, set by the engine). `follow::definitions` builds the pass commands, their schemas and preconditions from the rows; a test builds its own with `follow::definitions_for::<Maps>()` (`tests/common/follow.rs`).
- **One origin per store.** `UNIQUE (system, ref)` is the store, and `origin_one_per_home` makes a home (a calendar, a folder, a project, an account) filled by one origin whatever ref names it, so following the same store again finds the first. `follow.stop` retires the origin (`retired_at`, its cursor cleared) and deletes nothing; a retired origin keeps its home and its sources, and the same ref finds them. A statement cannot retire.
- **Every pass commits as the store** (`history::Actor::Store{origin_id}`): its revisions say `store` and name the origin.
- **`source.stated` is what each source last said, per source.** A record may have several sources (a merged person keeps every one); `follow::move_sources` is the one call a merge makes to move them to the survivor. `follow.take_stated` copies a stated field or item back; `follow.advance_cursor` moves a read position no record rides with (a cursor is the word of the install in `device_id`).
- **A health store's daily totals** are `follow::write_day_totals` (a `measurement` row per person, day and metric, a correction overwrites); a continuous series never lands row by row.
- A complete read that loses at least `DOUBTED_AT_LEAST` (5) followed rows, and more than half of them, is doubted for every system whose map is `Gone::Trash`: nothing is trashed and the answer says how many. The owner is never matched, given a source or trashed.
- **The baseline is the only rung.** A change to a map's columns or a lookup is an edit of `001_baseline.sql` and a regenerated digest (see [vault-model](vault-model.md)), not a migration.
- `arrival.rs` is not following. An item that came in from outside rather than by typing (vCard, Markdown, CSV, scan, upload, picker) is two columns of its `entity` row, `arrived_via` (a key of `arrival_via`) and `arrived_label`, both or neither; it makes no origin and no source, and nothing re-reads it. The camera roll is a followed store (`camera_roll`), not an arrival.

## Adding or changing a followed store

1. Vault first. Add or edit the `SystemMap` row and the `origin_system` and `source_shape` seed rows in `contracts/migrations/001_baseline.sql`, and use [vault-model](vault-model.md) for the schema digest, `contracts/schema/vault-commands.txt` and the app manifest action.
2. Add the `Store` variant, its `key`, its `source` words and its `shown_by` screen. Write the follower's `habit_read`, `followed_in`, `read_effect` and `run`, add the `Read` variant and its arm in `result`, and add the arm to `begin`, `habit` and `read` in the coordinator. Add a `PhoneWatch` source in `start` if the OS announces changes. Health reads through `device_of` and `window` and has no `followed_in`; Files wakes `imports.files` instead of `begin`, `habit` and `read`.
3. A new read or watch is a new effect in the screens protobuf. Use [app-plane](app-plane.md) for the proto, the registry and the parity rule, and [ffi](ffi.md) if the ABI is touched.
4. Write the reader in both shells (below). Say in the one that cannot read the store why (Android's `reminders_read` answers `UNAVAILABLE`).
5. A refused or partial read is one plain status line, the same words for every store (`Report::sentence`). It is not a failure.

## The shells' readers

- **Android:** `session/ShellEffects.kt` performs `calendar_read` and `contacts_read` (it checks the permission, and asks only when `ask_permission` is set), `phone_watch` through `PhoneWatchers.kt` (a content observer), and `health_read` through `AndroidHealth` (`kit/HealthConnectReader.kt`; a background window reads it with no screen and never asks). Snapshots come from `readCalendarSnapshot`, `readContactsSnapshot` and `FolderReader` in `screens/docs/DocsFolders.kt`.
- **iOS:** `ScreenStore.swift` dispatches the same effects to `PhoneCalendar`, `PhoneContacts`, `PhoneReminders`, `HealthKitReader` and `Docs/DocsFollow.swift`. Its watch listens for `EKEventStoreChanged` and `CNContactStoreDidChange`.
- Both answer a watch under the one effect id that asked, each time the store changes.

## Tests

- `crates/screens/tests/follow_coordinator.rs` plays the shell and asserts on counts of reads and permission asks, never on time. `follow_reconnect.rs` covers the page. The gate's unit tests in `gate.rs` take instants as arguments.
- `crates/vault/tests/follow_*.rs` and `origin_cursor.rs` are the engine, over the test maps in `tests/common/follow.rs`; each system's own file (`lane_follow_people.rs`, `calendar_follow.rs`, `docs_photos_follow.rs`, `follow_reminders.rs`, `health.rs`, `money.rs`) proves its map. `follow_gaps.rs` names the systems that trash what a read loses and the file that proves each one's doubted read, so a new one is red until it has a proof. See [tests](../land/tests.md).
