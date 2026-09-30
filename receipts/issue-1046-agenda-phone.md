# Receipt — Agenda on the phone ([#1046](https://github.com/srikanth235/centraid/issues/1046))

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it. The state this umbrella produced lives in [docs/decisions.md](../docs/decisions.md#agenda-on-the-phone-1046), [mobile/README.md](../mobile/README.md#the-kit-the-app-queries-and-adding-an-app-screen), [ARCHITECTURE.md](../ARCHITECTURE.md) and [crates/core/README.md](../crates/core/README.md#app-queries); where this receipt and a doc disagree, the doc is current.

This umbrella ran in one working tree beside [#1047](https://github.com/srikanth235/centraid/issues/1047), which built the kit Agenda's later waves moved onto and the core follow-ups Agenda's editor needed. Where a change served both, it is recorded in [`receipts/issue-1047-app-ports.md`](issue-1047-app-ports.md) and cited from here.

## Checklist

The issue's acceptance criteria, as they stand at the doc pass. The root's closing section re-judges each against the final simulator walk.

- [x] Tapping the Agenda tile (and its all-apps entry) opens Agenda on iOS and Android — `AgendaScreens.tileRoute` (iOS), `AgendaRoutes.opens` (Android)
- [x] Day, Schedule and Waiting on show seeded events with recurrence expanded by the core, birthdays and due tasks as day context, and a now line on today — `AgendaHomeSpec` (21 cases) and the simulator screenshots of the view wave
- [x] Event detail shows guests and replies; RSVP and ask-to-cancel write through the command plane with pending and cancel-asked marks — `AgendaEventSpec` (11 cases)
- [x] Create and edit write `propose_event` / `edit_event` / `edit_event_occurrence`, including scope and skip on a series — `AgendaEditorSpec` (9 cases)
- [x] Denied, day-one, empty, loading and read-failure states render per the handoff copy — `AgendaHomeSpec`
- [x] The Home tile shows the next occurrence with a relative when-line, excluding cancelled and trashed events — `HomeAgendaTile.kt` on the arm
- [x] No rrule expansion outside Rust — the grep in [Verification](#verification)
- [ ] Docs updated; one receipt — this doc pass lands the docs; the closing section is the root's

## What changed

### Wave 1 — the read arm

`Request::AppQuery` ([R-1046-1](../docs/decisions.md#agenda-on-the-phone-1046)): a new request kind that runs a registered app query in the core and answers a typed message, with Agenda's four queries as the first arms — `upcoming`, `day_context`, `parties`, `search` — and, from #1047's core follow-up, `event` by id.

- `crates/api-proto/proto/centraid/core/v1/app_query.proto` — the request and answer oneofs, `AppQueryDenial`; `agenda.proto` — the typed answers (`AgendaUpcoming`, `AgendaDayContext`, `AgendaParties`, `AgendaSearch`, `AgendaEventDetail`).
- `crates/core/src/app_query.rs` — the door (`VaultDoor` over `Vault::keyset_page` plus the app kit's grammar), the dispatch, Agenda's conversion, the zone rule (`zone_of`: the request's `tz`, else the vault's, else `InvalidRequest`), and `ReadBoundReached` for a loader's ceiling.
- `crates/apps/agenda` — `local.rs` (civil readings in a zone), `detail.rs` (one event by id), the `deleted_at` filter on every statement (`tests/trash.rs`), and `upcoming` no longer answers a series' occurrences that ended before `from` (`tests/lower_bound.rs`).
- `mobile/core/src/jvmTest/.../AgendaQueryRoundTripSpec.kt` — `agenda.upcoming` over JNA against a seeded vault, a weekly series expanded.

### Wave 2 — the Home tile

`mobile/shared/.../shell/HomeAgendaTile.kt`: the tile reads `upcoming` through the arm, shows the next occurrence with a relative when-line (`CivilWords`), and no longer counts cancelled, past or trashed events. `sync/ScreenQueries.kt`'s `askCore` is shared by the tile and every app-query screen.

### Wave 3 — Agenda home

The screen contract, the machine and both views. `screen.proto`'s Agenda section (`AgendaHomeState`, `AgendaHomeData`, `AgendaDaySection`, `AgendaEventRow`, `AgendaNowLine`, the band, the toolbar and the chrome); `apps/agenda/AgendaHomeMachine.kt`, `AgendaFold.kt`, `AgendaReads.kt`, `AgendaBridge.kt`; `copy/agenda.json` and `AgendaCopy.kt`; `AgendaHomeView.swift` and `AgendaHomeScreen.kt`. The fold lives in the machine over the core's raw answers, so hiding a calendar, switching Schedule and Waiting, closing search or opening a due shelf re-folds with no read. One read is in flight at a time and a superseded answer is dropped.

Departures from the root's contract, accepted: the raw answers are Kotlin-side (`AgendaInput`), because `screen.proto` cannot import `centraid.core.v1` under prost's module layout; the day bar is on the state, not in the data, so ‹ › stay live while a stepped day loads; the Day read is padded a day either side of the anchor, because `commonMain` cannot compute a zone offset, and the fold keeps only rows whose local days fall in the window.

### Waves 4 and 5 — event detail, create and the editor

`apps/agenda/AgendaEventMachine.kt`, `AgendaEditorMachine.kt`, their reads, `AgendaWrites.kt`, `AgendaMarks.kt` and `AgendaScreenBridges.kt`; `Sources/Agenda/` (iOS) and `screens/agenda/` (Android), with the civil date and time pickers on each shell. RSVP is optimistic and reverts on refusal; cancel confirms, with the scope sheet as the confirm on a series ([R-1046-8](../docs/decisions.md#agenda-on-the-phone-1046)); the editor sends only changed fields with the `clear_*` flags, asks before discarding changes, and offers skip on an occurrence. `AgendaMarks` holds pending and cancel-asked marks on the session's scope, so a write outlives its screen and the home's chips follow it.

The core half the editor needed landed under #1047's core follow-up and is recorded there: event commands accept a wall clock plus `tz` (`crates/vault/src/commands/event_time.rs`, `crates/vault/tests/event_times.rs`, [R-1046-9](../docs/decisions.md#agenda-on-the-phone-1046)), a one-day all-day event is admitted with `dtend == dtstart`, `AgendaEvent.location_name` (field 33) is answered, and the `agenda_event` arm reads one event by id.

### Wave 6 — the doc pass

`mobile/README.md` (the kit, the registries, app queries, the device clock, which build steps a change needs), `ARCHITECTURE.md` (the phone's two read paths and the kit), `crates/core/README.md` (every arm and its range), `docs/glossary.md` (the phone-shell vocabulary), `docs/decisions.md` (R-1046-1…9), `CHANGELOG.md`, and this receipt. The doc pass is shared with #1047 and every doc it touched is listed in that receipt's doc-pass section.

## Decisions

Recorded in full at [docs/decisions.md — Agenda on the phone (#1046)](../docs/decisions.md#agenda-on-the-phone-1046).

| Id | Ruling |
| --- | --- |
| **R-1046-1** | A read that joins or expands is an app query the core runs; one query engine and one recurrence engine ([decisions](../docs/decisions.md#agenda-on-the-phone-1046), [#1046](https://github.com/srikanth235/centraid/issues/1046)). |
| **R-1046-2** | Civil time is the core's; the device states its zone on every read ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-3** | The band is Day · Schedule · Waiting · Search · More; Month and hour-grid Day are not drawn; More is a sheet ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-4** | Agenda lands on Day, anchored on the core's `today`, at now ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-5** | No birthday-lead setting; More carries Calendars and "What Agenda may read"; hidden calendars are session state — the issue's open question 2 ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-6** | Search is the core's FTS through `agenda_search`, and closing it clears it — the issue's open question 1 ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-7** | Day one appears only on Schedule ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-8** | A cancel is always confirmed on the phone and executes at once; the issue's open question 3 (D-1020-S6) answered from the phone's side ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |
| **R-1046-9** | An event's time is the member's wall clock plus the device's zone, resolved by the core ([decisions](../docs/decisions.md#agenda-on-the-phone-1046)). |

## Verification

Evidence from the slices' own runs; the logs are in the root's scratchpad, not the repository. No gate profile was run for this receipt ([Not run](#not-run-and-why)).

| Check | Outcome |
| --- | --- |
| `:shared:jvmTest`, wave 3a | **650 tests, 1 failed** — the pre-existing `NativeAccessibilityLintSpec` failure below. `AgendaHomeSpec` **21/21**. **Demonstrated red**: search-close was broken on purpose (the term survived close), the search case failed, and the code was restored. `AppReadsSpec` green with Agenda added. |
| `:shared:jvmTest`, after the kit and the #1047 shared wave (includes `AgendaEventSpec` and `AgendaEditorSpec`) | **837 tests, 1 failed** — the same pre-existing failure |
| `:core:jvmTest` (`AbiRoundTripSpec`, `AgendaQueryRoundTripSpec`) | BUILD SUCCESSFUL |
| `:androidApp:compileDebugKotlin`, `:shared:compileKotlinIosSimulatorArm64` | both compile (wave 3a); the iOS compile first caught `toSortedSet`, which is JVM-only |
| `cargo test -p centraid-api-proto`; `buf lint` | pass; `buf lint` reports only the existing `READ_MODE_NONE` in the Photos section |
| `cargo test` over the workspace, the last full run of the pass | **1,794 passed, 3 failed** — all three macOS-only, below |
| `xcodebuild … -scheme Centraid build` on the iOS 26 simulator | BUILD SUCCEEDED; Agenda home, event, editor, repeat sheet and cancel confirm walked on the seeded demo vault and screenshotted by the view wave |
| `grep -rn 'FREQ=\|BYDAY\|INTERVAL=\|UNTIL=' mobile/shared/src/commonMain mobile/iosApp/Sources mobile/androidApp/src/main` | the only hits are the Agenda and Tasks editors' repeat presets — rule strings they **write**; nothing in Kotlin or Swift ~~parses or~~ expands an rrule. Corrected (audit L2, fixed in #1047 F6): `AgendaEditorMachine.repeatKeyOf` splits a stored rule on `;` to recognise which preset it is — a classification, never an expansion |

### Known failures, and why

| Failure | Why it is not this umbrella's |
| --- | --- |
| `NativeAccessibilityLintSpec` — a null Compose `contentDescription` in `PhotoLightboxStage.kt` | Pre-existing: every slice reported it on `PhotoLightboxStage.kt`, a file neither umbrella changes, and the spec is unchanged. The runs after the native view waves are the root's to re-check for new Compose nulls |
| `crates/centraid` `a_system_install_refuses_an_instance_name_that_is_not_one` and `tests/gateway_install.rs` `a_system_install_with_a_bad_instance_name_refuses` | macOS only: `--system` is refused as "systemd, and this is macOS" before the instance name is checked, so the instance-name assertion never runs. Green on Linux. The order is [Q-1047-5](../docs/decisions.md#open-questions-for-the-owner-1046-1047) |
| `crates/vault` `a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` | macOS only: the test opens `/dev/full`, which is a Linux device; on a Mac the failure is "unable to open database", not `DiskFull` |

### Not run, and why

- **Android on an emulator.** `adb` hangs on the machine this ran on (the emulator's QEMU CPU thread stops responding), so Android is covered by `:androidApp:assembleDebug` and the JVM specs only.
- **The gate profiles** (`cargo xtask gate --profile pr`, `--profile mobile-jvm`). Owed at close.
- **The iOS test bundle** (`ScreenFixtureTests`). There are no `contracts/screens/agenda/` fixtures, so it would not cover Agenda anyway.

### Commands re-run at close

Run on the uncommitted close tree, 2026-09-29, after the `sql-confinement` fixes the [close](#close) records:

```
cargo xtask rules                                    # ok: all four rules; sql-confinement clean over 250 files
cargo test -p centraid-apps-agenda                   # passed: every target, detail.rs 3/3
cargo test -p centraid --test drain_wire             # passed: 7/7
cargo test -p centraid-apps-docs                     # passed (after oxfmt reflowed manifest.json)
cargo clippy -p centraid-apps-kit -p centraid-apps-agenda -p centraid --all-targets -- -D warnings   # exit 0
cargo fmt --all --check                              # exit 0
bun run format:check                                 # exit 0, 528 files
```

## Open items at the doc pass

**In progress when this section was written** — the root's closing section records how each ended:

- The shared follow-up: the editor onto wall clock plus `tz` instead of floating ([R-1046-9](../docs/decisions.md#agenda-on-the-phone-1046)); the event page onto `agenda_event` by id instead of a window padded around the picked day; `location_name` shown.
- View polish, and the final simulator verification of every screen and state.

**Owed, not started:**

- `AgendaDenied` → the kit's `Denied` (Agenda predates it).
- `AgendaEventChrome.back` says "Back"; it should name the parent, "Agenda".
- The event's `call_uri` has no button label in the chrome, and neither shell routes it to the OS yet.
- The editor has one combined day-and-time label; the pickers want separate ones.
- Android's civil pickers use `Calendar` in UTC (min SDK 24).
- No `contracts/screens/agenda/` fixtures; `PerAppLayoutSpec` does not list `apps.agenda` among its required packages.
- The editor's create mode was not seen on the simulator.
- Out of scope by the issue: the month grid, the hour-grid Day, quick-create on a slot, attachments, birthday notifications, holidays.

## Files

As of the doc pass, beside the shared hot spots (`screen.proto`, `nav/Navigation.kt`, `AppReadsSpec.kt`, `copy/shared.json`, `ShellModel.swift`, `CentraidApp.swift`, `MainActivity.kt`) and the doc-pass files, which are listed in [`issue-1047-app-ports.md`](issue-1047-app-ports.md#files). The root regenerates this list against the commit.

- `copy/`
  - `copy/agenda.json` — changed
- `crates/api-proto/proto/centraid/`
  - `crates/api-proto/proto/centraid/core/v1/agenda.proto` — new
  - `crates/api-proto/proto/centraid/core/v1/app_query.proto` — new
- `crates/apps/agenda/`
  - `crates/apps/agenda/Cargo.toml` — changed
  - `crates/apps/agenda/README.md` — changed
  - `crates/apps/agenda/manifest.json` — changed
- `crates/apps/agenda/src/`
  - `crates/apps/agenda/src/detail.rs` — new
  - `crates/apps/agenda/src/lib.rs` — changed
  - `crates/apps/agenda/src/local.rs` — new
  - `crates/apps/agenda/src/manifest.rs` — changed
  - `crates/apps/agenda/src/queries.rs` — changed
- `crates/apps/agenda/tests/`
  - `crates/apps/agenda/tests/detail.rs` — new
  - `crates/apps/agenda/tests/lower_bound.rs` — new
  - `crates/apps/agenda/tests/parity.rs` — changed
  - `crates/apps/agenda/tests/trash.rs` — new
  - `crates/apps/agenda/tests/year3.rs` — changed
- `crates/core/`
  - `crates/core/src/app_query.rs` — new
- `crates/vault/`
  - `crates/vault/src/commands/event_time.rs` — new
  - `crates/vault/tests/event_times.rs` — new
- `mobile/androidApp/src/main/`
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/AgendaHomeScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/CivilPickers.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaEditorScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaEventScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaRoutes.kt` — new
- `mobile/core/src/jvmTest/`
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/AgendaQueryRoundTripSpec.kt` — new
- `mobile/iosApp/Sources/Agenda/`
  - `mobile/iosApp/Sources/Agenda/AgendaEditorView.swift` — new
  - `mobile/iosApp/Sources/Agenda/AgendaEventView.swift` — new
  - `mobile/iosApp/Sources/Agenda/AgendaScreens.swift` — new
  - `mobile/iosApp/Sources/Agenda/CivilPickers.swift` — new
- `mobile/iosApp/Sources/`
  - `mobile/iosApp/Sources/AgendaHomeView.swift` — new
- `mobile/shared/src/androidMain/`
  - `mobile/shared/src/androidMain/kotlin/dev/centraid/shared/platform/PlatformServices.android.kt` — changed
- `mobile/shared/src/commonMain/`
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/AgendaCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEditorMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEditorReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEventMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEventReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaFold.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaHomeMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaMarks.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaScreenBridges.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaWrites.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/platform/PlatformServices.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeAgendaTile.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenQueries.kt` — new
- `mobile/shared/src/iosMain/`
  - `mobile/shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt` — changed
- `mobile/shared/src/jvmMain/`
  - `mobile/shared/src/jvmMain/kotlin/dev/centraid/shared/platform/PlatformServices.jvm.kt` — changed
- `mobile/shared/src/jvmTest/`
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaEditorSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaEventSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaHomeSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenQueryRuntimeSpec.kt` — new

## Close

Appended at the close pass on 2026-09-29, after #1047's last lanes; the sections above are left as the doc pass wrote them. The working tree was not yet committed when this was written, so the files below are named against `883ed247f`, the commit that landed the doc pass.

### Checklist, reconciled

Every box above still holds against the tree at close. The last one is now ticked: this section and the doc pass are the one receipt.

- [x] Docs updated; one receipt — the doc pass above, the close's docs in [`issue-1047-app-ports.md`](issue-1047-app-ports.md#close), and this section

What proves the boxes on a device is the [final walk](#final-walk).

### The doc pass's open items, and how each ended

**Landed in `883ed247f`** (they were in flight when the doc pass was written):

- The editor writes a wall clock plus `tz` ([R-1046-9](../docs/decisions.md#agenda-on-the-phone-1046)). The event page reads `agenda_event` by id instead of a window padded around the picked day, and it shows `location_name`.
- `AgendaDenied` is gone, and Agenda uses the kit's `Denied`.
- `AgendaEventChrome.back` names its parent, "Agenda".
- `call_uri` has a label (`AgendaCopy.JOIN_CALL`). Both shells hand the link to the OS: iOS in `AgendaEventView.swift`, Android in `AgendaEventScreen.kt`.

**Landed after it** (they are uncommitted at close):

- **A search hit on a repeating event opens the occurrence the member means.** Before, it opened the series' anchor, which could be years back.
  - The fields are `AgendaEvent.next_instance_key`, `next_original_start_local` and `next_local_start` (34–36). They name the first occurrence still running at or after the vault clock, within a year, with the series' exceptions applied.
  - The code is in `crates/apps/agenda/src/detail.rs`, tested in `crates/apps/agenda/tests/detail.rs`.
- **The event page names its own calendar.** `AgendaEventDetail.calendar` (4) carries the calendar's row, so the page reads no `upcoming` to find it. This was seen on the iOS simulator (#1047 L2).
- **An edit reads its event by id.** It uses the page's own `agenda_event` query, so an edit that starts from a search hit on a series finds its event. No padded window lists the series row (`AgendaEditorReads.kt`).
- **The editor says why Save is blocked only when there is a reason to.** That is after a change, or after Save was pressed; an untouched form says nothing (`AgendaEditorMachine.kt`).
- **The Home tile's count agrees in number:** `TILE_COUNT_ONE` and `TILE_COUNT_MANY` replace `TILE_COUNT_LABEL`.
- **On Android, the due shelf's accessibility label is `AgendaChrome.shelf_label` plus the count.** It uses the platform's expand and collapse actions instead of the "expanded"/"collapsed" words it spelled itself (#1047 L3).

**Still owed**, each with the reason it stays out of this umbrella:

- ~~There are no `contracts/screens/agenda/` fixtures, and `PerAppLayoutSpec` does not list `apps.agenda`.~~ **Landed after close (#1047 slice T3).** Fourteen fixtures in three directories, one per state message, built by `contracts/tools/build-screen-fixtures.ts`: `agenda/` (`AgendaHomeState`: `loading-first`, `denied`, `read-refused`, `today-with-now-line`, `nothing-on-this-day`, `day-one`, `search-no-match`), `agenda-event/` (`AgendaEventState`: `cancel-confirm`, `cancel-scope`, `gone`, `rsvp-parked`) and `agenda-editor/` (`AgendaEditorState`: `create-blocked`, `occurrence-repeat-locked`, `save-refused`). `ScreenFixtureSpec` and the iOS `ScreenFixtureTests` assert the same laws over the same bytes: a denial is the gate and not a failure, the first load anchors on no day, the now line is a row, an empty day is not an empty calendar, a series' cancel confirm is the scope sheet with nothing pre-chosen, gone is its own arm, a refused save keeps the editor, and every fixture sets exactly one content arm. `PerAppLayoutSpec` lists `dev.centraid.shared.apps.agenda`.
- The editor's create mode has not been seen on a simulator. It is on the [final walk](#final-walk)'s list.
- The issue leaves these out of scope: the month grid, the hour-grid Day, quick-create on a slot, attachments, birthday notifications and holidays.

### Verification at close

These are the #1047 lanes' runs over the shared tree, plus the close's own. The logs are in the root's scratchpad.

| Check | Outcome |
| --- | --- |
| `:shared:jvmTest`, full (JDK 21), the close's run | **977 tests, 0 failures, 0 errors**. `AgendaHomeSpec`, `AgendaEventSpec` and `AgendaEditorSpec` are green. |
| `:androidApp:compileDebugKotlin -Pcentraid.android=true` | BUILD SUCCESSFUL |
| `xcodebuild … test` on the iOS 26.4 simulator (#1047 E5) | **TEST SUCCEEDED, 61 tests, 0 failures** |
| `cargo test` for core, vault, the app crates and centraid (#1047 F3, D4) | all green except `vault/tests/disk_full.rs` (below) |
| `cargo xtask rules`, after the fix below | **all four ok**: `sql-confinement` (250 files, clean), `abi-five-symbols`, `no-listening-socket` and `commonmain-no-platform-import`. |
| `cargo test -p centraid-apps-agenda`, after the fix | green: `detail.rs` 3 passed, and every other test target |

**Landed at close: `sql-confinement` on `crates/apps/agenda/tests/detail.rs`.** The fixture read `schedule_calendar` with a `SELECT` and wrote `core_place` with an `INSERT`, both string literals outside the four crates that may hold SQL; it was already there in `883ed247f`. The test now reads the founding calendar through the app's own `load_upcoming`, and seeds the place through a new kit fixture, `centraid_apps_kit::fixtures::seed_place`, which lives in an allowed crate. The rule was not touched.

**Known failures:**

| Failure | Status |
| --- | --- |
| `crates/vault` `a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` | macOS only: the test opens `/dev/full`, a Linux device |

The gate profiles were not run by the close. The final walk and the PR push own them. `mobile-jvm` ends in `git diff --exit-code -- design copy mobile contracts/screens`, which cannot pass on an uncommitted tree.

## Final walk

The walk ran on 2026-09-29, on iOS sim 27BA36FC and Android AVD `centraid` (API 35), with both shells built fresh. Evidence: #1047's [final walk](issue-1047-app-ports.md#final-walk) and the `walk-ios-13…23` and `walk-android-07…16` screenshots.

**PASS on both shells:**
- Agenda's home (Day).
- New event (create mode), with the repeat sheet → Every day → Save.
- The event page.
- Edit mode: a changed title, then the "This event repeats" scope sheet → The whole series → Save, and the page shows the new title.
- The Cancel… confirm for a repeating event (This occurrence / This and the ones after / The whole series / Keep it) → Keep it.
- Search "standup": the hit on the daily series opens the occurrence.
- The event survived a restore from the 24 words: the home tile shows 7 events in the next 7 days on both shells.

No Agenda defect was found.

**Re-walk after #1047 F4** (2026-09-29; #1047's [re-walk](issue-1047-app-ports.md#the-re-walk-rw-after-f4)). F4 moved Android's Agenda search field onto the kit's `rememberFollowedText` (B1). On Android, "pick up the dry cleaning" typed at full `adb input` speed stayed exact and found "Pick up the dry cleaning, 17:00 to 17:30"; Close cleared the term, and reopening search showed an empty field. iOS Agenda was not touched. No Agenda defect was found.

## Audit

**Verdict: PASS**, with three low findings below. None of them refutes a claim the checklist or the close rests on. The independent auditor ran this on 2026-09-29 against the uncommitted close tree. The auditor did not write this work and changed no product code.

**Commands the auditor re-ran:**

| Check | Outcome |
| --- | --- |
| `cargo test --workspace --no-fail-fast` | 1,753 passed, **1 failed**, 7 ignored. The failure is `vault/tests/disk_full.rs:160` (`/dev/full`, macOS only), as the close records. The two install tests are no longer red. |
| `cargo test -p centraid-apps-agenda` | pass. `detail.rs` 3/3, `trash.rs` 3, `lower_bound.rs` 2. `year3` is `#[ignore]`d by design. |
| `:shared:jvmTest` (JDK 21) | **993 tests, 0 failures, 0 errors**, from the XML results. `AgendaHomeSpec`, `AgendaEventSpec` and `AgendaEditorSpec` are green. |
| `cargo xtask rules` | ok: all four rules, and `sql-confinement` is clean over 250 files |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all --check` | exit 0 |
| `bun run format:check` | exit 0, 528 files |

**Claims sampled (9), each checked against the code:**

1. **Tile route.** `AgendaScreens.tileRoute` and `AgendaRoutes.opens` exist. The final walk opens Agenda on both shells. **Holds.**
2. **No rrule expansion outside Rust.** The receipt's grep reproduces: the only hits are the preset tables. See L2 for the wording. **Holds.**
3. **Event by id, and the new fields.** `AgendaEventDetail.calendar = 4` is in `agenda.proto`, along with `next_instance_key`, `next_original_start_local` and `next_local_start` (34–36) and `location_name = 33`. `AgendaEventSpec` reads `agenda_event` by id and `tz`. **Holds.**
4. **The kit's `Denied`.** `AgendaDenied` has no reference left in `mobile/` or `crates/`. **Holds.**
5. **The event page's chrome.** `AgendaEventChrome.back` is `AgendaCopy.APP_TITLE` (`AgendaEventMachine.kt:688`). `JOIN_CALL` is twinned in `copy/agenda.json`. iOS routes the link through `openURL` (`AgendaEventView.swift:123`) and Android through `onCall` (`AgendaEventScreen.kt:139`). **Holds.**
6. **The tile count agrees in number.** `TILE_COUNT_ONE` and `TILE_COUNT_MANY` are in `AgendaCopy` and `copy/agenda.json`, and no `TILE_COUNT_LABEL` is left. **Holds.**
7. **The `sql-confinement` fix.** `tests/detail.rs` holds no SQL literal. It reads through `load_upcoming` and `fixtures::seed_place` (`crates/apps/kit/src/fixtures.rs:5196`), and the rule is untouched. **Holds.**
8. **The zone rule.** `zone_of` takes the request's `tz`, then the vault's, else refuses with `InvalidRequest` (`crates/core/src/app_query.rs:230`). See L1. **Holds.**
9. **The spec counts (21, 11, 9).** The tree now has 22, 12 and 10 cases, because later lanes added some. It is not a regression. **Holds.**

**Findings:**

- **L1 (low, cosmetic).** `crates/core/src/app_query.rs:238`: the `ZoneUnset::Missing` refusal is a multi-line string literal with no `\` continuations, so the detail carries two runs of 36 spaces. It was already in `883ed247f`.
- **L2 (low, wording).** The Verification row says "nothing in Kotlin or Swift parses … an rrule". `AgendaEditorMachine.repeatKeyOf` (`AgendaEditorMachine.kt:586`) does tokenise a stored rule on `;` to recognise a preset. That is a classification, not an expansion, so R-1046-1 holds, but the sentence overstates what the grep proves.
- **L3 (low, process).** "Commands re-run at close" was inserted inside the doc-pass `## Verification`, above sections the header says are never edited. `doc-integrity` allows this, because the receipt is new on this branch. It was placed there because `receipt-per-issue` reads only `## Verification` for a fence.

**Governance front page** (`node .governance/law/run.mjs`, which reads the committed tree): 12 errors. For this receipt, two findings are measured against `HEAD`, where the fence and this verdict do not exist yet: "fence alone is not evidence" and "no PASS/REFUTED verdict". Both clear once this tree is committed. The remaining errors belong to the branch, not to #1046, and are listed in #1047's audit.

**Owed, and not the auditor's to close:**
- The gate profiles `pr` and `mobile-jvm`.
- `contracts/screens/agenda/` fixtures. **Landed after close (#1047 slice T3)**; see **Still owed** above.
- Android Agenda's home on a quiet emulator.
