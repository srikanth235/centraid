# Following a phone store

The phone's own stores (contacts, calendars, reminders, a picked folder, the health store) are read one way into the vault. Nothing is written back. What a member is promised is in [arrive-take-out](../product/rulings/arrive-take-out.md); this page is where the code lives.

## The three layers

- **Shell reader.** It reads the store and returns a snapshot. It decides nothing and names no command.
- **Follow coordinator** (`crates/screens/src/follow`). It decides when to read and hands the snapshot to the store's follower.
- **Vault command** (`crates/vault/src/commands/follow.rs`). It merges the snapshot. The merge is the vault's alone.

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

- `SYSTEMS` is a table of `SystemMap` rows, one per system: contacts, calendar, files, phone_reminders, health and statement (an account's import, not a phone store). Each row names the command (`follow.<system>`), the kind it fills, the columns it owns, its match keys, what a record gone from a complete read does (`Gone`), and its children. The engine knows no system by name.
- `follow.stop` retires an origin and deletes nothing. `follow.take_stated` copies a stated value back. `follow.advance_cursor` moves a read position that no record rides with.
- A complete read that loses at least `DOUBTED_AT_LEAST` (5) followed rows, and more than half of them, is doubted: nothing is trashed and the answer says how many. The owner is never matched, given a source or trashed.
- `arrival.rs` is not following. An item that came in from outside rather than by typing (vCard, Markdown, CSV, scan, upload, camera roll, picker) records an origin and a source with an empty `stated`, and nothing re-reads it.

## Adding or changing a followed store

1. Vault first. Add or edit the `SystemMap` row, and use [vault-model](vault-model.md) for the schema digest, the `origin.system` and `source` CHECKs in `contracts/migrations/001_baseline.sql`, `contracts/schema/vault-commands.txt` and the app manifest action.
2. Add the `Store` variant, its `key`, its `source` words and its `shown_by` screen. Write the follower's `habit_read`, `followed_in`, `read_effect` and `run`, add the `Read` variant and its arm in `result`, and add the arm to `begin`, `habit` and `read` in the coordinator. Add a `PhoneWatch` source in `start` if the OS announces changes. Health reads through `device_of` and `window` and has no `followed_in`; Files wakes `imports.files` instead of `begin`, `habit` and `read`.
3. A new read or watch is a new effect in the screens protobuf. Use [screen](screen.md) for the proto, the registry and the parity rule, and [ffi](ffi.md) if the ABI is touched.
4. Write the reader in both shells (below). Say in the one that cannot read the store why (Android's `reminders_read` answers `UNAVAILABLE`).
5. A refused or partial read is one plain status line, the same words for every store (`Report::sentence`). It is not a failure.

## The shells' readers

- **Android:** `session/ShellEffects.kt` performs `calendar_read` and `contacts_read` (it checks the permission, and asks only when `ask_permission` is set), `phone_watch` through `PhoneWatchers.kt` (a content observer), and `health_read` through `AndroidHealth` (`kit/HealthConnectReader.kt`; a background window reads it with no screen and never asks). Snapshots come from `readCalendarSnapshot`, `readContactsSnapshot` and `FolderReader` in `screens/docs/DocsFolders.kt`.
- **iOS:** `ScreenStore.swift` dispatches the same effects to `PhoneCalendar`, `PhoneContacts`, `PhoneReminders`, `HealthKitReader` and `Docs/DocsFollow.swift`. Its watch listens for `EKEventStoreChanged` and `CNContactStoreDidChange`.
- Both answer a watch under the one effect id that asked, each time the store changes.

## Tests

- `crates/screens/tests/follow_coordinator.rs` plays the shell and asserts on counts of reads and permission asks, never on time. `follow_reconnect.rs` covers the page. The gate's unit tests in `gate.rs` take instants as arguments.
- `crates/vault/tests/follow_*.rs`, `calendar_follow.rs` and `arrival.rs` cover the merge, retire and arrival. See [tests](../land/tests.md).
