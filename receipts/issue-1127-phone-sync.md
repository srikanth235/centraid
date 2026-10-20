# Issue #1127 — People, Agenda, Photos and Docs follow what the phone holds

Worked as an umbrella by orchestration: one root agent, six lanes (A to F) as sub-agent sessions on their own branches, merged into `claude/phone-sync-1127`. The owner's rulings are R-1127-1 to 10; R-1127-11 to 15 were decided while building ([decisions.md](../docs/decisions.md#the-phone-is-followed-one-way-1127)).

## What changed

- **Vault (lane A, amended by B and C).** Rung two, `contracts/migrations/002_phone_link.sql`: `phone_origin` (an account, calendar or picked folder, with the label the member knows it by) and `phone_link` (source, the phone's kind-prefixed id, origin, a real foreign key to `core_entity` with `ON DELETE SET NULL` so a purge leaves a tombstone, fingerprint, `detached_at`, `last_seen_at`), with triggers holding the link to its source's kind, a tombstone to never get a row again and a detach to be one way. Six commands: `phone.link`, `phone.touch`, `phone.detach`, `phone.forget`, `phone.origin`, `phone.retire_origin`. Both tables page through the door. Rung two is unreleased and was amended in place. `people.edit_important_date` / `people.delete_important_date` and `schedule.edit_event_occurrence`'s `restore` were added for followed birthdays and exceptions.
- **Engine (lane B, gaps closed by C).** `PhoneSync` in `mobile/shared/.../sync/phone/`: a `PhoneSnapshot` and the vault's links plan adopt, add, update, trash, detach, hold and forget, by fingerprint. An origin that left the phone, or lost at least five and more than half of its followed rows in one complete read, is held and asked about; an incomplete read never trashes. `ContactsImport` and `CalendarImport` are its first passes.
- **Following (lanes C, D).** `PhoneFollowBridge` + `FollowGate` (2 s coalescing, one pass per source, one queued) behind app-side `ContactsFollow` / `CalendarFollow`. iOS follows on becoming active, `CNContactStoreDidChange` and `EKEventStoreChanged`; Android on `onStart` and `ContentObserver`s. Each shell draws the "Keep its N events?" question with Keep the default. Readers carry durable ids (R-1127-10) and origins.
- **Photos edits (lane E).** A20: an edit made in the phone's Photos app comes in over its camera original; the delete guard's witness is the rendition's version.
- **Docs folders (lane F).** Docs follows folders the member picks: Follow a folder, Followed folders, Stop following; new file → document, changed → revision, removed → trash.
- **Root.** The README formatting, the lane C, D and F merges, a platform-neutral add-your-account line and its spec, a real-core test for lane F's reads and revision write (`crates/core/src/api.rs`), R-1127-1 to 15 in `docs/decisions.md` with R-ONBOARD-4 pointed at them, ONT-42 in `docs/vault-ontology.md`, and the CHANGELOG line.

## Verification

Run on the merged umbrella, `claude/phone-sync-1127`, at the close.

```sh
cargo test --locked --no-fail-fast -p centraid-vault -p centraid-core -p centraid-core-ffi
```

Outcome: pass, 61 suites, 1,078 tests, 0 failed.

```sh
cargo test --locked -p centraid-vault --test ladder_ddl
```

Outcome: pass, 3 tests: the ladder-head DDL fixture regenerates without a diff.

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home cargo xtask gate --profile mobile-jvm
```

Outcome: pass. The first run at the close failed one spec, `PhoneSnapshotSpec`, which pinned the old add-your-account wording ("Accounts", iOS's Settings path); the spec now holds the new property (names the phone's Settings, no platform path), and the rerun passed.

iOS: lane F built and launched the app on its own simulator from its branch, which is this umbrella less the add-your-account wording and the lane F core test; lane C built it before that.

**Checked by hand, by the lanes, each on its own simulator:**

- Lane C (iOS): Contacts imported (8 people); a contact added in Contacts appeared in People; a name edited in Centraid and changed again in Contacts kept the Centraid edit and detached; a contact deleted in Contacts went to People's trash; an event added in Calendar followed in and a deleted one went to the trash; a limited-access import read 2 people; Keep on a hand-injected held account detached its 3 rows and trashed none.
- Lane F (iOS): the app builds, installs and launches with the folder code in it.

**Not verified:**

- The Android shell: no Android SDK here, so lanes D and F's Android code is not compiled.
- On iOS: the folder picker, bookmark staleness, a file added, changed and deleted in Files; the Move to trash answer and a real vanish hold; editing a followed event then changing it on the phone.
- No Maestro flow: `simctl addmedia` cannot add `.ics`, and a flow cannot edit the Contacts app.

## Decisions

- R-1127-11 to 15 (tombstone, vanish guard, phone-owned birthday and exceptions, empty origins registered, one gate) are the root's, recorded in decisions.md for the owner to re-judge.
- A file's id is `local:<folder>/<path>`, not `local:<path>` as the lane F brief said: a link is unique by `(source, phone_id)`, and one path can sit in two followed folders.
- One merged commit's subject was 117 characters; the hook refused every later commit on the branch. The history was rewritten once (`filter-branch --msg-filter`, one subject, trees verified identical) on the umbrella and the lane C and D branches, before anything was pushed.

## Known gaps, for the owner

- A vault that imported a source and later trashes its only origin stops following it until the member taps Import again.
- Docs: files land at Docs' top level and a subfolder's files take their file name as title; a refused file is retried at every pass with no backoff, and its staged bytes are not cleaned up; a re-picked folder is matched by path (iOS) or tree URI (Android).
- The fingerprint's vault half for Docs takes two page reads, because the door cannot project a join.
