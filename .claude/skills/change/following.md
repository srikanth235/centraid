# Following a phone store

The phone's own stores (contacts, calendars, reminders, a picked folder, the health store, the camera roll's grant) are read one way into the vault. Nothing is written back. What a member is promised is in [arrive-take-out](../product/rulings/arrive-take-out.md); the wire and its rules are [app-plane](app-plane.md) section 16; this page is where the code lives and what each shell performs.

## The three layers

- **Shell reader (target).** It reads the store when the core asks and answers with what the OS said and a snapshot. It decides nothing and names no command.
- **The follower** (`crates/core/src/follow/mod.rs`). It decides when to ask the shell to read, whether the OS may be asked, what the last pass said, and runs the vault command with the snapshot. The rooms read its state; they never decide it.
- **Vault command** (`crates/vault/src/commands/follow/`). It merges the snapshot. The merge is the vault's alone.

## The follower

- `Store` is the list: `contacts`, `calendar`, `reminders`, `files`, `health`, `camera_roll`. `key()` is the wire's `system` and the device key's suffix; `origin_system()` is the vault's (`reminders` is `phone_reminders`); `command()` is `follow.<system>` (Health also runs `follow.health_readings`).
- Enrolment is a device key, `follow.<store>` (app-plane D13), set when the OS grants the member's tap and deleted by a stop. A pass asks it first and asks nothing of a store this device did not enrol.
- Requests, all `FollowRequest` through `centraid_call` (the five symbols are untouched):
  - `ENROL` (a room's tap): one `store_read` effect with `ask_permission` true. The only place the OS is asked.
  - `TRIGGER` (app forward, a watch, a window): for each enrolled store the phone has not refused, one `store_read` with `ask_permission` false. An ask already in flight queues exactly one more; a third trigger replaces an ask nobody answered. No clock: the machine moves on triggers and answers.
  - `PASS` (the shell's answer): an answer to an ask that is not the store's current one is `stale` and ignored. `GRANTED` and `LIMITED` run `follow.<system>` with `input_json`; `REFUSED`, `RESTRICTED` and `UNAVAILABLE` block the store (no trigger asks again until the member taps `ENROL`); `CANCELLED` changes nothing.
  - `STOP`: runs `follow.stop` for each live origin of the store (or the one `{"ref"}`), forgets the habit, pushes `phone_watch` off and, for a folder, `release_grant`. Deletes nothing.
  - `STATUS`: what a room says (`FollowStatus`). A refused row's "Open Settings" is the room's own `open_settings` effect (app-plane section 17).
- A cursor lives on the origin row. Health's ask carries the cursor this install's origin holds (`entity.followed_stores`, the row whose `device_id` is this install; none or another install's is empty, a complete read). The answer's command input carries the new one in `origin.cursor`; the core sets `origin.device_id` itself, so it moves in the same commit as the records. A shell keeps no cursor.
- The window an ask places: Calendar 7 days back and 62 on; Health 365 days of totals and 90 days of workouts (`days_back`, `workouts_since_ms`). The shell reads the days in the phone's zone.
- After every request that changes a store's state the core pushes a change of the table `follow`; a room that built a follow row watches it and redraws.

## The rooms

`crates/screens/src/room/follow.rs` builds the rows and the stop confirm for every owning app's More: People `contacts`, Calendar `calendar`, Reminders `reminders`, Docs `files`, Health `health`, Photos `camera_roll`. A row is one of: "Follow Contacts" (not enrolled), "Following Contacts" with its read line and a destructive "Stop following Contacts" (enrolled; the stop opens a sheet `follow/stop/<store>` that says nothing is deleted), "Contacts is off" with the OS's sentence and an "Open Settings" tap (refused; "Follow Contacts" again tries once more), "Your phone doesn't allow Contacts" (restricted), or "Reminders isn't on this phone" (unavailable). A doubted or partial pass replaces the read line with the one sentence every store shares. Docs' "Followed folders" page stops one folder through `follow/stop/files:<ref>`.

## What each shell performs (target: the native lane builds these)

The channel and every other variant are app-plane section 17; the performers are the existing `ScreenPlatform.swift` and `kit/ScreenEffects.kt` families. For following:

| Effect (`Event.effect` or a room response) | The shell does |
| --- | --- |
| `store_read`, `contacts` | iOS `CNContactStore` (request access only if `ask_permission`); Android `ContactsContract` with `READ_CONTACTS` (request only if `ask_permission`). Answers `FollowRequest{PASS, ask_id = effect_id}` with `grant` and, if granted, `{"origin":{"ref","label"},"records":[{"external_id","fields"}],"complete"}` |
| `store_read`, `calendar` | iOS `EKEventStore` events and calendars from `days_back` to `days_on`; Android `CalendarContract`. A write-only iOS grant is `RESTRICTED`; a partial read is `LIMITED` with `complete` false |
| `store_read`, `reminders` | iOS `EKEventStore` reminders. Android has no store: answer `UNAVAILABLE` |
| `store_read`, `files` | With `ask_permission`, the system folder picker (iOS document picker with a security-scoped bookmark, Android `ACTION_OPEN_DOCUMENT_TREE`), then keep the grant (D9). Without it, read every folder whose grant is held. Answer one snapshot per folder; a dismissed picker is `CANCELLED` |
| `store_read`, `health` | iOS HealthKit, Android Health Connect, read permission only, for `chosen` over `days_back` and `workouts_since_ms`. With `cursor` answer a delta (changed rows only, ids of deleted workouts in `gone`) or a complete read when the cursor is unusable; put the new one in `origin.cursor`. `refused` names the types the OS refused; `background_refused` is Health Connect's. Input is `{"workouts": …, "readings": …}` |
| `store_read`, `camera_roll` | Ask the photo-library grant only if `ask_permission`; answer `grant`, no snapshot (the walk is the pass service's) |
| `phone_watch` (contacts, calendar, reminders) | iOS `EKEventStoreChanged` and `CNContactStoreDidChange`; Android content observers. On a change send `FollowRequest{TRIGGER, system}` |
| `open_settings` | iOS `UIApplication.openSettingsURLString`; Android `ACTION_APPLICATION_DETAILS_SETTINGS`. Answer `ShellDone` |
| `release_grant` (`ref`) | Release the folder's grant (D9) |

The shell also sends `TRIGGER` with no `system` each time the app comes forward and once when a granted background window opens (Android Health only, by the owner's decision). It sends nothing else, asks the OS only inside an ask whose `ask_permission` is true, and sends no snapshot of its own accord.

## Adding or changing a followed store

1. Vault first. Add or edit the `SystemMap` row, and use [vault-model](vault-model.md) for the schema digest, the `origin.system` and `source` CHECKs in `contracts/migrations/001_baseline.sql` and `contracts/schema/vault-commands.txt`.
2. Add the `Store` variant (its `key`, `origin_system`, `command`, `watched`) in the follower, its window in `follow_ask` if it has one, and its row in the owning app's More (`follow::items`, a `strings/follow.rs` noun and source).
3. A new kind of ask is a new `ShellEffect` variant in `room.proto`; use [ffi](ffi.md) if the ABI is touched.
4. Say in the shell that cannot read the store why (Android's Reminders answers `UNAVAILABLE`).
5. A refused or partial read is one plain status line, the same words for every store. It is not a failure.

## The vault

- `SYSTEMS` is a table of `SystemMap` rows, one per system: calendar, phone_reminders, contacts, health (workouts and readings), files, camera_roll and statement (an account's import, not a phone store). Each row names the command (`follow.<system>`), the kind it fills, the columns it owns, its match keys, what a record gone from a complete read does (`Gone`) and its children. A system that fills a home and is given none founds a container of the kind.
- `follow.stop` retires an origin and deletes nothing. `follow.take_stated` copies a stated value back. `follow.advance_cursor` moves a read position that no record rides with.
- A complete read that loses at least `DOUBTED_AT_LEAST` (5) followed rows, and more than half of them, is doubted: nothing is trashed and the answer says how many. The owner is never matched, given a source or trashed.
- `arrival.rs` is not following. An item that came in from outside rather than by typing (vCard, Markdown, CSV, scan, upload, camera roll, picker) records an origin and a source with an empty `stated`, and nothing re-reads it.

## Tests

- `crates/screens/tests/room_follow.rs` plays the shell over a real core and asserts on counts of reads and permission asks, never on time: a tap asks once, a background pass asks 0 times, a refusal makes 0 reads after, a stop keeps the rows and ends passes, a cursor resumes, triggers queue exactly one more, a stale answer changes nothing.
- `crates/screens/tests/room_core.rs` holds the follow request's verbs; `crates/vault/tests/follow_*.rs`, `calendar_follow.rs` and `arrival.rs` cover the merge, retire and arrival. See [tests](../land/tests.md).
- Not built (target): the native adapters above, and a reconnect page for a restored vault (a restored phone enrols each store once, by tap).
