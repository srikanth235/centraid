# Issue #1144 — Backup says what every app's data holds, in bytes

The design is the "Backup screen with byte figures" canvas: the screen backed up, catching up, with two devices and videos off, and today's screen for comparison. Today's screen spoke only of "photos and files"; the backup carries every app's records.

## What changed

- **The vault's holdings, by kind** (`crates/vault/src/backup/holdings.rs`, new): live rows per entity kind, rows written since a moment (trash included), workouts, days and readings for the vault's own person, which files a photograph or a document owns (derivatives follow their source), and the vault file's pages. Every statement plans through an index: `crates/core/tests/query_plans.rs` passes with `contracts/ledgers/query-plans.json` untouched.
- **The ledger's held bytes** (`Ledger::held_bytes`): the sum of the sizes each acknowledgement recorded for one gateway.
- **The core's per-app fold** (`crates/core/src/phone/holdings.rs`, new): one `AppHolding` per catalogue app, in the catalogue's order. Photos and Docs count their originals; every other app counts its own kind's live rows; Health counts days with a reading and its workouts. A size is the app's own files plus a share of the vault file and of the files no app owns, divided by record rows with the remainder handed out heaviest first, so the rows add up to `total_bytes` to the byte. "Edits waiting" counts rows written at or after the newest acknowledged snapshot. `standing` now records each file's outcome (confirmed, waiting, left out), and a video left out no longer counts toward `pending_bytes`, so "to go" counts only what will move.
- **Wire** (`phone.proto`): `BackupStatusResponse` gains `apps` (12), `total_bytes` (13), `confirmed_bytes` (14), `left_out_items` (15), `left_out_bytes` (16); `Destination` gains `held_bytes` (8); new `AppHolding`. (`backup_screens.proto`): `BackupDestinationRow.held` (6), new `BackupAppRow`, `BackupHomeData.apps_heading` (28) and `apps` (29). All additions; nothing renumbered or reserved.
- **The screen** (`crates/screens/src/backup`): `line::detail` is the line's byte clause ("All 5.0 GB from 8 apps is backed up.", "4.6 of 5.0 GB from 8 apps is backed up.", "5.0 GB from 8 apps, none of it backed up yet.", and "8.4 GB of videos is left out." when videos are off); a reading without per-app rows keeps the counts. `apps.rs` (new) makes "In this backup": biggest first, each row's detail ("312 notes · 38 MB", "1,203 of 1,240 photos and videos · 4.0 of 4.4 GB"), the left-out note, and the status ("Backed up", "37 waiting", "3 edits waiting", "Not backed up"). A destination row says "Holds 5.1 GB". "Back up now" says "Backing up — 380 MB to go". `claim::bytes` keeps one decimal for gigabytes under a hundred and still rounds down. `shell::home::app_name` is shared with the rows.
- **Shells**: iOS `BackupViews.swift` and Android `BackupScreens.kt` draw "In this backup" (the app mark, name, detail, note, and the status in the attention tone while something waits) and the held line on each device.
- **Docs**: `docs/mobile-offline.md` says what the status now carries.

## Open questions for the owner

1. **Shared bytes are divided by record rows.** The vault file has no per-app accounting short of `dbstat`, which walks every page of the file on each read; the screen re-reads every two seconds while a run goes. Rows are a proxy: a Health reading and a note weigh the same. The alternative is `dbstat` behind a cache that the snapshot refreshes. Recommendation: keep rows until someone sees a share that misleads.
2. **Files no app owns** (an avatar, a revision's bytes, a chat image) go into the shared pool rather than to People or Notes, because attributing them needs scans the query-plan sweep refuses without new indexes. Recommendation: leave them pooled; it is a few MB.
3. **Photos and Docs count what the backup holds**, trashed items included until their purge, so the count can be a few higher than the app's own library. Recommendation: keep it, because the screen describes the backup and not the library.
4. **Health measurement edits are not counted as "edits waiting"**: a reading has no `updated_at`. They still travel in the next snapshot.

## Verification

```sh
cargo test -p centraid-core --lib holdings          # 4 passed: the fold, the share, the roster
cargo test -p centraid-core --test backup_holdings  # 2 passed: against a real gateway
cargo test -p centraid-core --test query_plans      # 2 passed: no new scan, no allowlist row
cargo test -p centraid-screens                      # 368 lib + every integration binary passed
cargo xtask gate --profile local
```

**Not verified:** the Android view is not compiled (no Android SDK here), and the iOS view is not compiled (no Xcode here). Neither was checked on a device.
