# Day zero: handoff

## Done (commits on fix/1202-release-qa-blockers)

1. cd1af6ff5 One Home at every stage. `HomeTile.holds` (the app holds something of the member's, apart from having something to show) grades the stage; `springboard()` is FirstRun only when no app holds anything and the starter notes alone do not count (`tiles.rs` `starters_only`). `fold` always uses CONTENT_ORDER and `content_size` (no first-run order, no medium invitations). `HomeData.welcome` replaces day_one_title/body. Ruling words in `strings/home.rs` (`tile_empty_*`, `tile_quiet_*`). Calendar looks back 366 days and Reminders reads the board counts to decide `holds`; Money has `MoneyHomeTile.held`. Both shells draw a WelcomeCard over the one grid; the DayOne views are gone. Maestro home.yaml and selectors.md updated.
2. 3d82d2d40 Starter rows only in Notes (`core/src/starters.rs`: TASKS removed, bodies as FirstOpenNotes). Test: `shell_home::a_fresh_vault_is_day_zero_...` (uses new `Driver::first_vault`). Maestro flows home-search, search-correction, agenda-task-from-search, onboarding no longer rely on a starter task.
3. f086e7b57 + 5900e049a Backup seat: `HomeBackupLine.action`; unpaired line is "Not backed up yet · Pair", empty on day zero, and told only 24 h after `BackupStatusResponse.first_item_ms` (one MIN per kind over entity_by_created, starters and founding person excluded). Test `backup::line::pair_tests` (23 h/25 h).

Checks: clippy -D warnings clean for screens/core; nextest on shell_home, vault_home, vault_shelf, agenda_glance, reminders_page, lib backup:: pass. Android `compileDebugKotlin` passes (needs `-Pcentraid.android=true`). Swift is not compiled locally.

## Pieces 4 to 7 (done)

4. First open: a82640af7 (EmptyState.hint; the import is drawn in the card's action slot by `emptyAction`/`actionSlot` in both kits; Calendar, People), d6605d0e4 (Notes: `NotesLibraryData.first_open` card over the starters, section "To get you started", `notes::fold::starters_only` shared with Home), 11e320d6a (Docs on Recents, Money Activity with no account), 9813866ac (Health "Turn on {store}").
5. fed0b9ac0: `HomeEvent.PhotoAccessTold` from the camera roll; the Photos widget reads "Photo access is off · Open Settings"; the Photos app's empty library behind a Denied grant is the card with Open Settings and no banner.
6. 8f31fd51c: `LockerWall.step/steps/step_label` (first check while no item) and `LockerHomeData.step*` (first item); `Home.holds_none` reads the item count while locked.
7. 076549aef: `BackupHomeData.unpaired` (BackupUnpaired), shells draw it instead of the ordinary page.

## Notes for the owner

- Commit trailer used is "Claude Sonnet 5.5" per the harness attribution reminder (the brief said Opus 5.5).
- Locker's "set up" is inferred from item count; a real fact would need an owner call.
