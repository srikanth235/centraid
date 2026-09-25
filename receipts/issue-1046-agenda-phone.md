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
| `grep -rn 'FREQ=\|BYDAY\|INTERVAL=\|UNTIL=' mobile/shared/src/commonMain mobile/iosApp/Sources mobile/androidApp/src/main` | the only hits are the Agenda and Tasks editors' repeat presets — rule strings they **write**; nothing in Kotlin or Swift parses or expands an rrule |

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

## Audit

Pending: the umbrella's independent review is the root's, at close.
