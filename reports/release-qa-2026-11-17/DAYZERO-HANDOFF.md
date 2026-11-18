# Day zero: handoff

## Done (commits on fix/1202-release-qa-blockers)

1. cd1af6ff5 One Home at every stage. `HomeTile.holds` (the app holds something of the member's, apart from having something to show) grades the stage; `springboard()` is FirstRun only when no app holds anything and the starter notes alone do not count (`tiles.rs` `starters_only`). `fold` always uses CONTENT_ORDER and `content_size` (no first-run order, no medium invitations). `HomeData.welcome` replaces day_one_title/body. Ruling words in `strings/home.rs` (`tile_empty_*`, `tile_quiet_*`). Calendar looks back 366 days and Reminders reads the board counts to decide `holds`; Money has `MoneyHomeTile.held`. Both shells draw a WelcomeCard over the one grid; the DayOne views are gone. Maestro home.yaml and selectors.md updated.
2. 3d82d2d40 Starter rows only in Notes (`core/src/starters.rs`: TASKS removed, bodies as FirstOpenNotes). Test: `shell_home::a_fresh_vault_is_day_zero_...` (uses new `Driver::first_vault`). Maestro flows home-search, search-correction, agenda-task-from-search, onboarding no longer rely on a starter task.
3. f086e7b57 + 5900e049a Backup seat: `HomeBackupLine.action`; unpaired line is "Not backed up yet · Pair", empty on day zero, and told only 24 h after `BackupStatusResponse.first_item_ms` (one MIN per kind over entity_by_created, starters and founding person excluded). Test `backup::line::pair_tests` (23 h/25 h).

Checks: clippy -D warnings clean for screens/core; nextest on shell_home, vault_home, vault_shelf, agenda_glance, reminders_page, lib backup:: pass. Android `compileDebugKotlin` passes (needs `-Pcentraid.android=true`). Swift is not compiled locally.

## Not done

4. Each app's first open (FirstOpenCalendar/People/Notes/Docs/Money/Health): the apps already have day-one empty states (`empty_day_one*` in each screens module); compare each to its board (one sentence, one import, "Or tap + to write one.", Docs and Money show the add as the button, Notes lists "TO GET YOU STARTED") and fix words in `strings/`. Health's button is "Turn on Apple Health".
5. Refused permission states: Home's Photos widget reads "Photo access is off · Open Settings" (widget only); Photos app (PhotosRefused board): "Photo access is off." / "Turn it on in Settings to import your camera roll." / Open Settings. No second ask, alert or badge. `PhotoAccessRemedy.kt` exists on Android.
6. Locker first check / first item: LockerFirstCheck ("Step 1 of 2", "Confirm it's you", ...) and LockerFirstItem ("Step 2 of 2", "Add your first item.", "Add an item", ...). The Home tile already reads "Set up Locker" while Locker holds no item (no set-up fact exists; item count stands in for it).
7. Backup before pairing (BackupUnpaired board): "Not backed up yet", "This phone holds the only copy of your vault.", "Pair a backup device", "TO PAIR" 1/2 steps, "The recovery key comes after the first backup."

## Notes for the owner

- Commit trailer used is "Claude Sonnet 5.5" per the harness attribution reminder (the brief said Opus 5.5).
- Locker's "set up" is inferred from item count; a real fact would need an owner call.
