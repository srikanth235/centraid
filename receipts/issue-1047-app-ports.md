# Receipt — the app ports and the shell kit ([#1047](https://github.com/srikanth235/centraid/issues/1047))

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it. The state this umbrella produced lives in [docs/decisions.md](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047), [mobile/README.md](../mobile/README.md#the-kit-the-app-queries-and-adding-an-app-screen), [ARCHITECTURE.md](../ARCHITECTURE.md), [crates/core/README.md](../crates/core/README.md#app-queries) and [docs/traps/byte-store-lock.md](../docs/traps/byte-store-lock.md); where this receipt and a doc disagree, the doc is current.

It ran in one working tree beside [#1046](https://github.com/srikanth235/centraid/issues/1046) (Agenda), whose wave 1 added the `app_query` request every port here reads through ([R-1046-1](../docs/decisions.md#agenda-on-the-phone-1046)). Agenda's own waves are in [`receipts/issue-1046-agenda-phone.md`](issue-1046-agenda-phone.md).

## Checklist

The issue's acceptance criteria, as they stand at the doc pass. The root's closing section re-judges each against the final simulator walk.

- [ ] The Tasks, People, Docs, Notes and Tally tiles, all-apps rows and first moves open their apps on iOS and Android — every app has a `tileRoute` (iOS) and an `opens(moveId)` (Android); the walk that proves each entry point is pending
- [x] Every screen listed in Scope renders from a core `app_query` answer; no Kotlin or Swift code joins tables — the trash screens of apps with no trash query read one table through the page door
- [x] Tally: Balances shows group nets; refresh replaces the list; money renders with the right exponent on both shells (`contracts/screens/money-render.json`, held by `MoneyRenderTests.swift` and `MoneyRenderTest.kt`)
- [ ] Notes: autosaves after 900 ms and saves on leave; never loses words being typed; derives an empty title from the first line; notebooks and albums no longer leak — **all done**; allows an empty body — the vault allows it, the editor still refuses a body cleared to nothing (owed)
- [x] Trash screens are restore-only where no destroy command exists, with no "Delete forever" copy
- [ ] The Activity and Needs-you tabs are gone — **not done**: ruled ([R-1047-P2](../docs/decisions.md#product-1047)), `BandPolicy.kt` still declares both. No sharing-era copy remains in the ported apps' copy; `copy/shared.json` still carries `SHARE_FAILED` and `SHARE_IS_A_COPY`
- [x] `AbiRoundTripSpec` reopens without hanging
- [ ] Docs updated; one receipt — this doc pass lands the docs; the closing section is the root's

## What changed

### Wave A — the core arms

Each app's typed answers (`crates/api-proto/proto/centraid/core/v1/{tasks,people,docs,notes,tally}.proto`) and its arms in `app_query.proto`'s range ([R-1047-Q1](../docs/decisions.md#reads-1047)), dispatched through `crates/core/src/app_query.rs` into `crates/core/src/app_query/<app>.rs`, with each app crate linked into `crates/core`. Kotlin round trips over JNA: `mobile/core/src/jvmTest/.../{Tasks,People,Docs,Notes,Tally}QueryRoundTripSpec.kt`. New app-crate modules: `crates/apps/tasks/src/{local,views}.rs`, `crates/apps/docs/src/{kind,phone}.rs`, `crates/apps/notes/src/{editor,local,shelves}.rs`, `crates/apps/people/src/phone.rs`, `crates/apps/tally/src/phone.rs`.

Crate defects fixed on the way: the Tasks board statements filter `deleted_at` (trashed tasks came back); `remind_before_min` is read; `organize-task` takes `tz`, not `recurrence_tz`. Home's Docs, Notes and Tasks tiles filter `deleted_at`. The People and Docs crate READMEs and manifests no longer describe share scopes over dropped tables.

### Waves K1–K4 — the KMP kit

`mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/`: `ReadContent`/`ContentLens`, `PagedList`, `BandLaw`, `SearchLaw`, `AutosaveLaw`, `WriteLaw`/`InvokeKeys`, `TrashSpec`/`TrashMachine`/`TrashReads`, `ScreenBridge`, `MoneyFold`, and `kit/time/{CivilDays,CivilWords}`. The runtime gained `ScreenEffect.Schedule` (a reducer has no clock, so debounce is an effect), the answered-cursor echo, the vault chosen when a write is **emitted** rather than when it runs (otherwise a flush on leave followed by a vault switch from Home could land in the other vault), and `HomeSession.strandedWrites`. The `// --- Kit ---` section of `screen.proto`. Copy split into one `design/copy/<App>Copy.kt` per app, each twinned with `copy/<app>.json` and checked by `KitTimeMoneyCopySpec`. Tally migrated onto `PagedList` and `BandLaw`; the Notes editor onto `AutosaveLaw`, which closed the v0-shell defects the Notes plan found — no autosave, a silent discard on leave, a cleared field reported as saved, a re-read replacing typing, every change event dropped because the core sends an empty key set.

### Wave K5 — the native kit and the registries

`mobile/iosApp/Sources/Kit/` and `mobile/androidApp/.../kit/` (read states with skeleton rows, the rooms, rows, sheets, the search field, the autosave line, the trash list, money). The registries — `Kit/ScreenRegistry.swift` with `AppRegistry.apps`, and `screens/AppRoutes.kt` with `MainActivity.routes` — so an app is one file and one line per shell ([R-1047-K2](../docs/decisions.md#the-kit-1047)). The Tally list and Notes editor views moved onto the kit (the old `Sources/NotesEditorView.swift` and `Sources/TallyListView.swift` are deleted). Android's money renderer honours the currency's exponent (`$42.50` had drawn as `$4,250`), survives a non-ISO code, and falls back to the device locale as iOS does; `contracts/screens/money-render.json` is the fixture both shells run.

### Wave C — the shared halves

For Tasks, People, Docs, Notes and Tally: an append-only `screen.proto` section, the machines, reads, writes and bridges under `apps/<app>/`, a `nav/Navigation.kt` block, the copy, and a spec — `TasksSpec` (30 cases), `PeopleSpec` (25), `DocsSpec` (26), `NotesAppSpec` (21), `TallyScreensSpec` (17) — with `AppReadsSpec` and `PerAppLayoutSpec` extended. Screen sets: `tasks.{home,list,project,detail,catch_up,trash}`; `people.{home,person,editor,trash}`; `docs.{drive,document,editor,trash}`; `notes.{library,notebooks,journal,history,link_targets,trash}` and the finished editor (create, the `[[` picker, send-to-Tasks, history); `tally.{home,group,friend,expense,editor,settle_up,recurring,spending,search,trash}`. Sharing-era features and copy were dropped ([R-1047-P1](../docs/decisions.md#product-1047)).

### Wave D — the native views

Every screen above drawn on the native kit on both shells: `Sources/{Tasks,People,Docs,Notes,Tally}/` (iOS) and `screens/{tasks,people,docs,notes,tally}/` (Android), each app registered with its one line. Intents routed by the shell: navigation pushes, and the OS for the ones cheap to route. A Notes library that hung on skeletons on iOS was found on the simulator and fixed in the shell: the destination switch's `.task` had no id, so an in-place stack swap never sent `Opened`; it is `.task(id: route)` now, guarded by a `NavigationAndMountSpec` case.

### `core_collection.kind`

Rung six (`contracts/migrations/006_collection_kind.sql`): a required, immutable `kind` (`notebook` | `album`), every writer and reader typed, each app's commands refusing the other's id, and existing vaults classified. Recorded as [R-COLL-1…4](../docs/decisions.md#notes-and-photos-a-collection-says-which-it-is-1029) and ONT-33 in [docs/vault-ontology.md](../docs/vault-ontology.md); proven by `crates/vault/tests/collection_kind.rs`.

### The ABI reopen hang

`AbiRoundTripSpec` hung in `centraid_open` on a reopen in the same process: a core dropped without closing its byte store left `blobs.db` locked, and iroh-blobs 0.103 turned the next open's error into a hang. `Handle`'s `Drop` now closes the store it owns (`crates/core/src/handle.rs`) and `ByteStore::open` refuses a held index by name (`crates/blobs/src/store.rs`). Tests: `crates/core-ffi/tests/reopen.rs`, `crates/blobs/tests/reopen.rs`. Trap: [docs/traps/byte-store-lock.md](../docs/traps/byte-store-lock.md), which also records the upstream residue (one parked thread per closed store; any other failed open still hangs).

### Core follow-up B

Gaps the wave C reports raised, closed in the core: `people.purge_person` and `schedule.purge_task`; `clear_effort` on `edit_task`; the raw repeat rule in the task answer (`TasksTask.rrule`, field 38); a local day on Notes, People and Docs rows (`*_local_day`); `TallyDashboard.base_exponent` and the rate suggestion's `from_exponent`; `tally.set_expense_memo` writing the memo the expense reads back; `core.merge_party` dropping the merged party's `people_profile` so two profiles no longer collide; and, for Agenda, the event commands' wall-clock-plus-`tz` shape, `agenda_event` by id and `location_name` (recorded in #1046's receipt).

### The doc pass

This section's own changes: `mobile/README.md` (the kit, the registries, app queries, the device clock, which build steps a change needs, the Android recipe's stale pairing line), `ARCHITECTURE.md` (what is on the phone, the two read paths, the kit, and the recognition section replaced by the fact that there is none), `crates/core/README.md` (every arm and its range, the handle's `Drop`, one role), `docs/glossary.md` (the phone-shell vocabulary; Needs you and recognition marked), `docs/decisions.md` (R-1046-1…9, R-1047-K1…K7, Q1–Q2, N1–N4, P1–P4, Q-1047-1…10, and five supersession pointers), `docs/mobile-offline.md` (a supersession banner; the durable-path and Locker paragraphs corrected), `docs/recognition-automations.md` and `docs/system-signals.md` (supersession banners), `DESIGN.md` (the worked pair citing the removed `OFFLINE_BANNER` key), `mobile/.gitignore` (`.kotlin/`), `CHANGELOG.md`, and both receipts.

## Decisions

Recorded in full at [docs/decisions.md — The app ports and the shell kit (#1047)](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047). The owner approved the issue's recommendations; the kit rulings are the root's.

| Id | Ruling |
| --- | --- |
| **R-1047-K1** | Views decide nothing, and the screen state is how that is enforced ([decisions](../docs/decisions.md#the-kit-1047), [#1047](https://github.com/srikanth235/centraid/issues/1047)). |
| **R-1047-K2** | One bridge shape; one file and one registry line per app per shell ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-K3** | The autosave law: 900 ms, flush on leave, one key per edit, changed fields only, last save on this phone wins, no replay ledger — #1015 D3 on the native shell ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-K4** | The money editor saves with an explicit Save; supersedes #1015 D3 for money ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-K5** | Trash is per app through `TrashSpec`; no destroy path means restore only; supersedes #1015 D1 in part ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-K6** | Docs has no destroy path yet; "Empty trash" says only that documents can no longer be restored ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-K7** | A save that fails after the member left is published for Home's status line ([decisions](../docs/decisions.md#the-kit-1047)). |
| **R-1047-Q1** | `app_query.proto`'s field ranges, one per app, the same number in both oneofs ([decisions](../docs/decisions.md#reads-1047)). |
| **R-1047-Q2** | A screen's declared tables are exactly what re-reads it ([decisions](../docs/decisions.md#reads-1047)). |
| **R-1047-N1** | An empty title is the first body line, at most 80 characters ([decisions](../docs/decisions.md#notes-1047)). |
| **R-1047-N2** | An empty body is allowed (`minLength: 0`) ([decisions](../docs/decisions.md#notes-1047)). |
| **R-1047-N3** | A body not on this phone is read-only; supersedes R-NOTES-2 of #1025 ([decisions](../docs/decisions.md#notes-1047)). |
| **R-1047-N4** | One Notes routing rule for tile, all-apps and first move, on both shells ([decisions](../docs/decisions.md#notes-1047)). |
| **R-1047-P1** | Sharing-era features are not ported ([decisions](../docs/decisions.md#product-1047)). |
| **R-1047-P2** | The Activity and Needs-you band tabs are removed ([decisions](../docs/decisions.md#product-1047)). |
| **R-1047-P3** | Tally opens on Balances, and Balances is each group's net ([decisions](../docs/decisions.md#product-1047)). |
| **R-1047-P4** | A date-only task reminder gets no time ([decisions](../docs/decisions.md#product-1047)). |

## Verification

Evidence from the slices' own runs; the logs are in the root's scratchpad, not the repository. No gate profile was run for this receipt ([Not run](#not-run-and-why)).

| Check | Outcome |
| --- | --- |
| `:shared:jvmTest` after K1–K4 | **683 tests, 1 failed** — the pre-existing `NativeAccessibilityLintSpec` failure. `TallyListReReadSpec` green without edits; `KitRuntimeSpec` green on three extra reruns (the emit-time vault pin, `Schedule` in both runtimes, a flush that outlives its bridge) |
| `:shared:jvmTest` after wave C | **837 tests, 1 failed** — the same failure; the two runs before it (830 / 3 failed, 837 / 2 failed) were fixed in the slices |
| `:androidApp:compileDebugKotlin`, `:shared:compileKotlinIosSimulatorArm64` after wave C | both BUILD SUCCESSFUL |
| `:shared:assembleCentraidSharedDebugXCFramework`, then `xcodebuild … -scheme Centraid build` | BUILD SUCCEEDED; the view waves walked their screens on the iOS 26 simulator over the seeded demo vault and screenshotted them |
| `:core:jvmTest` | BUILD SUCCESSFUL, `AbiRoundTripSpec` included — the reopen that hung now returns |
| `cargo test -p centraid-api-proto` | pass, in every slice that touched a proto |
| `cargo test` over the workspace, the last full run of the pass | **1,794 passed, 3 failed** — all three macOS-only, below. An earlier run (1,790 passed, 5 failed) also failed `the_leaf_carries_its_sentences_and_names_what_did_not_cross` and `every_writer_of_a_hash_column_is_declared_with_where_its_value_comes_from`; both are green in the last run |

### Known failures, and why

| Failure | Why it is not this umbrella's |
| --- | --- |
| `NativeAccessibilityLintSpec` — a null Compose `contentDescription` in `PhotoLightboxStage.kt` | Pre-existing: every slice reported it on `PhotoLightboxStage.kt`, a file neither umbrella changes, and the spec is unchanged. The runs after the native view waves are the root's to re-check for new Compose nulls |
| `crates/centraid` `a_system_install_refuses_an_instance_name_that_is_not_one` and `tests/gateway_install.rs` `a_system_install_with_a_bad_instance_name_refuses` | macOS only: `--system` is refused as "systemd, and this is macOS" before the instance name is checked. Green on Linux. The order is [Q-1047-5](../docs/decisions.md#open-questions-for-the-owner-1046-1047) |
| `crates/vault` `a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` | macOS only: the test opens `/dev/full`, a Linux device |

### Not run, and why

- **Android on an emulator.** `adb` hangs on the machine this ran on, so every Android screen is covered by `:androidApp:assembleDebug` and the JVM specs only. Android's Notebooks place opens with `LaunchedEffect(Unit)` (`NotesRoutes.kt`) where iOS needed `.task(id:)`; whether Android has the same in-place-swap defect is unverified.
- **The gate profiles** (`cargo xtask gate --profile pr`, `--profile mobile-jvm`), `cargo fmt --check` and `clippy -D warnings`. Owed at close. `clippy` reports 16 `large_enum_variant` in the generated `screen.proto` code, to be boxed in `crates/api-proto/build.rs`.
- **The per-app slices' specs in isolation after the core follow-up.** The round-trip specs for People, Docs, Notes and Tally have no run in a log this pass saw.

## Open items at the doc pass

**In progress when this section was written** — the root's closing section records how each ended:

- **The shared follow-up**: Tally's editor onto `base_exponent` and `from_exponent`, and the memo made editable; the Notes editor's empty-body refusal removed; Tasks' raw repeat rule and `clear_effort`; People's `occurred_local_day`; Notes' `*_local` days; `purgeCommand` set for People and Tasks now that `purge_person` and `purge_task` exist (both trashes are restore-only until then); `strandedWrites` wired into Home's status line on both shells.
- **Shared polish and view polish** on both shells.
- **The final simulator verification** of every screen and state on the seeded demo vault.

**Owed, not started** (from the view waves' gap reports):

- Band icon keys the catalogue does not have: Notes `note`, `folder`, `journal`; People `people`, `touch`; Tally `Chart`, `Export`. People's hue keys are short (`rose`) where the theme expects `cRose`; iOS works around it with a view-side lookup.
- The Docs stage cannot draw images, PDFs or video — `docs_document` answers no held file path. Docs' Add (upload, scan, a new text document) reaches no ingest or create command.
- Tally export: the `tally_export` arm exists and no screen reads it.
- Words the views still look up: several pushed-page back labels ("Back" where the parent should be named), Trash page titles, the search opener label, More titles on Notebooks and Journal. The kit has no disabled button, no verb slot on the status line, no tone on a row's trailing figure; `ConfirmSheet`'s container identifier swallows its children's on iOS.
- The kit text field reports no caret, so a Notes link and send-to-Tasks use the whole body. Send-to-Tasks has no Tasks quick-add-with-text entry to land on.
- Enum-by-string seams: Tally's split method and Notes' sort choices are keyed by strings where the event takes the enum; `clear_filter` generates `clearFilter_p` in Swift.
- The legacy `TallyListMachine`, `TallyReads`, `TallyBridge` and Android `TallyListScreen.kt` are unused by the new screens and go with their specs.
- `CentraidCopy` in `design/Copy.kt` is a forwarding shim; it goes once nothing reads it.
- Photos' face review still creates people with `core.add_party`, so they never reach the People roster; it should call `people.add_person`.
- Notes' notebooks "Unfiled" row shows no count on the demo vault; the demo vault has no Tasks project, so `tasks.project` was not seen on the simulator.
- `copy/shared.json` still carries the sharing-era `SHARE_FAILED` and `SHARE_IS_A_COPY`.
- R-1047-P2's removal of the Activity and Needs-you tabs ([decisions](../docs/decisions.md#product-1047)).

**Owner decisions pending** — each with options and a recommendation in [docs/decisions.md](../docs/decisions.md#open-questions-for-the-owner-1046-1047):

| Question | Where |
| --- | --- |
| Locker's unlock model; Locker is not on the phone until it is ruled | Q-1047-1 |
| Photos' face surfaces, which read tables nothing writes | Q-1047-2 |
| The phone's document destroyer — a purge sweep, or a destroy command on the `media.purge_asset` path, which reverses the 2026-09-10 "the sweep is the only destroyer" ruling | Q-1047-3 |
| A schema trigger holding collection entry kinds ([R-COLL-4](../docs/decisions.md#notes-and-photos-a-collection-says-which-it-is-1029)) | Q-1047-4 |
| `gateway install --system` on macOS: the platform refusal before the instance-name check | Q-1047-5 |
| People search beyond names; the Docs window cap; a journal-entry command; wikilinks into `core.link`; Tasks priority order | Q-1047-6…10 |

## Files

As of the doc pass, and including the shared hot spots #1046 also edited; #1046's own files are listed in [its receipt](issue-1046-agenda-phone.md#files). The root regenerates this list against the commit. Not listed: the untracked `build/` directory at the repository root, which is an Xcode derived-data folder a view slice wrote (`build/dd-notesfix`) and should be deleted or ignored before the commit.

**The doc pass:** `ARCHITECTURE.md`, `CHANGELOG.md`, `DESIGN.md`, `crates/core/README.md`, `docs/decisions.md`, `docs/glossary.md`, `docs/mobile-offline.md`, `docs/recognition-automations.md`, `docs/system-signals.md`, `mobile/.gitignore`, `mobile/README.md`, `receipts/issue-1046-agenda-phone.md`, `receipts/issue-1047-app-ports.md`.

**The rest:**

- the repository root
  - `Cargo.lock` — changed
  - `QUALITY.md` — changed
- `contracts/migrations/`
  - `contracts/migrations/006_collection_kind.sql` — new
- `contracts/schema/`
  - `contracts/schema/vault-ddl.sql` — changed
- `contracts/screens/`
  - `contracts/screens/money-render.json` — new
  - `contracts/screens/notes/draft-dirty.bin` — changed
  - `contracts/screens/notes/draft-dirty.textproto` — changed
  - `contracts/screens/notes/save-refused.bin` — changed
  - `contracts/screens/notes/save-refused.textproto` — changed
- `copy/`
  - `copy/docs.json` — changed
  - `copy/notes.json` — changed
  - `copy/people.json` — changed
  - `copy/shared.json` — changed
  - `copy/tally.json` — changed
  - `copy/tasks.json` — changed
- `crates/api-proto/`
  - `crates/api-proto/build.rs` — changed
- `crates/api-proto/proto/centraid/`
  - `crates/api-proto/proto/centraid/core/v1/docs.proto` — new
  - `crates/api-proto/proto/centraid/core/v1/envelope.proto` — changed
  - `crates/api-proto/proto/centraid/core/v1/error.proto` — changed
  - `crates/api-proto/proto/centraid/core/v1/notes.proto` — new
  - `crates/api-proto/proto/centraid/core/v1/people.proto` — new
  - `crates/api-proto/proto/centraid/core/v1/query.proto` — changed
  - `crates/api-proto/proto/centraid/core/v1/tally.proto` — new
  - `crates/api-proto/proto/centraid/core/v1/tasks.proto` — new
  - `crates/api-proto/proto/centraid/screen/v1/screen.proto` — changed
- `crates/api-proto/tests/`
  - `crates/api-proto/tests/roundtrip.rs` — changed
- `crates/apps/docs/`
  - `crates/apps/docs/Cargo.toml` — changed
  - `crates/apps/docs/README.md` — changed
  - `crates/apps/docs/manifest.json` — changed
- `crates/apps/docs/src/`
  - `crates/apps/docs/src/kind.rs` — new
  - `crates/apps/docs/src/lib.rs` — changed
  - `crates/apps/docs/src/manifest.rs` — changed
  - `crates/apps/docs/src/phone.rs` — new
  - `crates/apps/docs/src/queries.rs` — changed
- `crates/apps/docs/tests/`
  - `crates/apps/docs/tests/parity.rs` — changed
  - `crates/apps/docs/tests/phone.rs` — new
- `crates/apps/kit/src/`
  - `crates/apps/kit/src/contract_vault.rs` — changed
  - `crates/apps/kit/src/denial.rs` — new
  - `crates/apps/kit/src/fixtures.rs` — changed
  - `crates/apps/kit/src/lib.rs` — changed
- `crates/apps/locker/src/`
  - `crates/apps/locker/src/lib.rs` — changed
- `crates/apps/locker/tests/`
  - `crates/apps/locker/tests/parity.rs` — changed
- `crates/apps/notes/`
  - `crates/apps/notes/Cargo.toml` — changed
  - `crates/apps/notes/README.md` — changed
  - `crates/apps/notes/manifest.json` — changed
- `crates/apps/notes/src/`
  - `crates/apps/notes/src/editor.rs` — new
  - `crates/apps/notes/src/lib.rs` — changed
  - `crates/apps/notes/src/local.rs` — new
  - `crates/apps/notes/src/manifest.rs` — changed
  - `crates/apps/notes/src/queries.rs` — changed
  - `crates/apps/notes/src/shelves.rs` — new
- `crates/apps/notes/tests/`
  - `crates/apps/notes/tests/parity.rs` — changed
  - `crates/apps/notes/tests/phone.rs` — new
- `crates/apps/people/`
  - `crates/apps/people/README.md` — changed
  - `crates/apps/people/manifest.json` — changed
- `crates/apps/people/src/`
  - `crates/apps/people/src/commands.rs` — changed
  - `crates/apps/people/src/dashboard.rs` — changed
  - `crates/apps/people/src/lib.rs` — changed
  - `crates/apps/people/src/manifest.rs` — changed
  - `crates/apps/people/src/phone.rs` — new
- `crates/apps/people/tests/`
  - `crates/apps/people/tests/copy.rs` — changed
  - `crates/apps/people/tests/parity.rs` — changed
  - `crates/apps/people/tests/three_state.rs` — changed
- `crates/apps/photos/src/`
  - `crates/apps/photos/src/lib.rs` — changed
  - `crates/apps/photos/src/queries.rs` — changed
- `crates/apps/photos/tests/`
  - `crates/apps/photos/tests/parity.rs` — changed
- `crates/apps/tally/`
  - `crates/apps/tally/README.md` — changed
- `crates/apps/tally/src/`
  - `crates/apps/tally/src/lib.rs` — changed
  - `crates/apps/tally/src/phone.rs` — new
  - `crates/apps/tally/src/queries.rs` — changed
  - `crates/apps/tally/src/views.rs` — changed
- `crates/apps/tasks/`
  - `crates/apps/tasks/Cargo.toml` — changed
  - `crates/apps/tasks/README.md` — changed
  - `crates/apps/tasks/manifest.json` — changed
- `crates/apps/tasks/src/`
  - `crates/apps/tasks/src/commands.rs` — changed
  - `crates/apps/tasks/src/lib.rs` — changed
  - `crates/apps/tasks/src/local.rs` — new
  - `crates/apps/tasks/src/manifest.rs` — changed
  - `crates/apps/tasks/src/queries.rs` — changed
  - `crates/apps/tasks/src/views.rs` — new
- `crates/blobs/`
  - `crates/blobs/src/door.rs` — changed
  - `crates/blobs/src/store.rs` — changed
  - `crates/blobs/tests/reopen.rs` — new
- `crates/centraid/`
  - `crates/centraid/src/bin/seed-demo-vault.rs` — changed
  - `crates/centraid/tests/seed_demo_vault.rs` — changed
- `crates/core-ffi/`
  - `crates/core-ffi/CONTRACT.md` — changed
  - `crates/core-ffi/src/bin/spike-fixture.rs` — changed
  - `crates/core-ffi/tests/contract.rs` — changed
  - `crates/core-ffi/tests/reopen.rs` — new
  - `crates/core-ffi/tests/spike.rs` — changed
- `crates/core/`
  - `crates/core/Cargo.toml` — changed
  - `crates/core/src/api.rs` — changed
  - `crates/core/src/app_query/docs.rs` — new
  - `crates/core/src/app_query/docs_tests.rs` — new
  - `crates/core/src/app_query/notes.rs` — new
  - `crates/core/src/app_query/people.rs` — new
  - `crates/core/src/app_query/tally.rs` — new
  - `crates/core/src/app_query/tally_tests.rs` — new
  - `crates/core/src/app_query/tasks.rs` — new
  - `crates/core/src/app_query/tasks_tests.rs` — new
  - `crates/core/src/error.rs` — changed
  - `crates/core/src/handle.rs` — changed
  - `crates/core/src/lib.rs` — changed
  - `crates/core/src/originals.rs` — changed
  - `crates/core/tests/call_budget.rs` — changed
- `crates/vault/`
  - `crates/vault/src/bootstrap.rs` — changed
  - `crates/vault/src/commands/core.rs` — changed
  - `crates/vault/src/commands/knowledge.rs` — changed
  - `crates/vault/src/commands/media.rs` — changed
  - `crates/vault/src/commands/mod.rs` — changed
  - `crates/vault/src/commands/people.rs` — changed
  - `crates/vault/src/commands/schedule.rs` — changed
  - `crates/vault/src/commands/tally.rs` — changed
  - `crates/vault/src/migrations.rs` — changed
  - `crates/vault/src/originals.rs` — changed
  - `crates/vault/src/time/zone.rs` — changed
  - `crates/vault/tests/baseline.rs` — changed
  - `crates/vault/tests/collection_kind.rs` — new
  - `crates/vault/tests/commands.rs` — changed
  - `crates/vault/tests/docs_commands.rs` — changed
  - `crates/vault/tests/knowledge_commands.rs` — changed
  - `crates/vault/tests/one_hash.rs` — changed
  - `crates/vault/tests/originals.rs` — changed
  - `crates/vault/tests/people_commands.rs` — changed
  - `crates/vault/tests/schedule_commands.rs` — changed
- `docs/traps/`
  - `docs/traps/README.md` — changed
  - `docs/traps/byte-store-lock.md` — new
- `docs/`
  - `docs/vault-ontology.md` — changed
- `mobile/androidApp/src/main/`
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` — changed
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/KitWords.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/ReadState.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Rooms.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Rows.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/SearchField.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Sheets.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/TrashListScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/AppRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/NotesEditorScreen.kt` — changed
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/TallyListScreen.kt` — changed
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/docs/DocsRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/docs/DocsScreens.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/notes/NotesLibraryScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/notes/NotesPlacesScreens.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/notes/NotesRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/people/PeopleEditorScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/people/PeopleHomeScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/people/PeoplePersonScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/people/PeopleRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/photos/PhotosRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyParts.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tally/TallyScreens.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksDetailScreen.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksRoutes.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksScreens.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksViews.kt` — new
  - `mobile/androidApp/src/main/kotlin/dev/centraid/android/theme/Theme.kt` — changed
- `mobile/androidApp/src/test/`
  - `mobile/androidApp/src/test/kotlin/dev/centraid/android/theme/MoneyRenderTest.kt` — new
- `mobile/core/src/jvmTest/`
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/DocsQueryRoundTripSpec.kt` — new
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/NotesQueryRoundTripSpec.kt` — new
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/PeopleQueryRoundTripSpec.kt` — new
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/TallyQueryRoundTripSpec.kt` — new
  - `mobile/core/src/jvmTest/kotlin/dev/centraid/core/TasksQueryRoundTripSpec.kt` — new
- `mobile/iosApp/Sources/`
  - `mobile/iosApp/Sources/CentraidApp.swift` — changed
  - `mobile/iosApp/Sources/DuplicateReviewView.swift` — changed
  - `mobile/iosApp/Sources/DuplicatesView.swift` — changed
  - `mobile/iosApp/Sources/FaceReviewView.swift` — changed
  - `mobile/iosApp/Sources/HomeView.swift` — changed
  - `mobile/iosApp/Sources/NotesEditorView.swift` — deleted
  - `mobile/iosApp/Sources/PhotoCells.swift` — changed
  - `mobile/iosApp/Sources/PhotoEditorView.swift` — changed
  - `mobile/iosApp/Sources/PhotoLightboxView.swift` — changed
  - `mobile/iosApp/Sources/PhotoPickerView.swift` — changed
  - `mobile/iosApp/Sources/PhotoShelfView.swift` — changed
  - `mobile/iosApp/Sources/PhotosCollectionsView.swift` — changed
  - `mobile/iosApp/Sources/PhotosMemoriesView.swift` — changed
  - `mobile/iosApp/Sources/PhotosPeopleView.swift` — changed
  - `mobile/iosApp/Sources/PhotosSearchView.swift` — changed
  - `mobile/iosApp/Sources/PlacesView.swift` — changed
  - `mobile/iosApp/Sources/ShellModel.swift` — changed
  - `mobile/iosApp/Sources/StateViews.swift` — changed
  - `mobile/iosApp/Sources/TallyListView.swift` — deleted
- `mobile/iosApp/Sources/Docs/`
  - `mobile/iosApp/Sources/Docs/DocsDocumentView.swift` — new
  - `mobile/iosApp/Sources/Docs/DocsDriveView.swift` — new
  - `mobile/iosApp/Sources/Docs/DocsParts.swift` — new
  - `mobile/iosApp/Sources/Docs/DocsScreens.swift` — new
- `mobile/iosApp/Sources/Kit/`
  - `mobile/iosApp/Sources/Kit/AutosaveStatus.swift` — new
  - `mobile/iosApp/Sources/Kit/CentraidSearchField.swift` — new
  - `mobile/iosApp/Sources/Kit/Money.swift` — new
  - `mobile/iosApp/Sources/Kit/ReadStates.swift` — new
  - `mobile/iosApp/Sources/Kit/Rooms.swift` — new
  - `mobile/iosApp/Sources/Kit/Rows.swift` — new
  - `mobile/iosApp/Sources/Kit/ScreenContent.swift` — new
  - `mobile/iosApp/Sources/Kit/ScreenRegistry.swift` — new
  - `mobile/iosApp/Sources/Kit/Sheets.swift` — new
  - `mobile/iosApp/Sources/Kit/TrashListView.swift` — new
- `mobile/iosApp/Sources/Notes/`
  - `mobile/iosApp/Sources/Notes/NotesEditorView.swift` — new
  - `mobile/iosApp/Sources/Notes/NotesLibraryView.swift` — new
  - `mobile/iosApp/Sources/Notes/NotesPlacesViews.swift` — new
  - `mobile/iosApp/Sources/Notes/NotesScreens.swift` — new
- `mobile/iosApp/Sources/People/`
  - `mobile/iosApp/Sources/People/PeopleEditorView.swift` — new
  - `mobile/iosApp/Sources/People/PeopleHomeView.swift` — new
  - `mobile/iosApp/Sources/People/PeoplePersonView.swift` — new
  - `mobile/iosApp/Sources/People/PeopleScreens.swift` — new
- `mobile/iosApp/Sources/Tally/`
  - `mobile/iosApp/Sources/Tally/TallyDetailViews.swift` — new
  - `mobile/iosApp/Sources/Tally/TallyEditorView.swift` — new
  - `mobile/iosApp/Sources/Tally/TallyHomeView.swift` — new
  - `mobile/iosApp/Sources/Tally/TallyLensViews.swift` — new
  - `mobile/iosApp/Sources/Tally/TallyParts.swift` — new
  - `mobile/iosApp/Sources/Tally/TallyScreens.swift` — new
- `mobile/iosApp/Sources/Tasks/`
  - `mobile/iosApp/Sources/Tasks/TasksDetailView.swift` — new
  - `mobile/iosApp/Sources/Tasks/TasksHomeView.swift` — new
  - `mobile/iosApp/Sources/Tasks/TasksPagesView.swift` — new
  - `mobile/iosApp/Sources/Tasks/TasksRowViews.swift` — new
  - `mobile/iosApp/Sources/Tasks/TasksScreens.swift` — new
- `mobile/iosApp/Tests/`
  - `mobile/iosApp/Tests/MoneyRenderTests.swift` — new
- `mobile/shared/src/commonMain/`
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/DocsCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/LockerCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/NotesCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/PeopleCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/PhotosCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/SharedCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/TallyCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/TasksCopy.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsBridges.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsDocumentMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsDriveMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsDriveReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsEditorMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsFold.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsLaws.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsTrash.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/docs/DocsWrites.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesBridge.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesEditorMachine.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesFold.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesHistory.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesJournal.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesLibraryBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesLibraryMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesLibraryReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesLinkPicker.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesNotebooks.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesPlaces.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesReads.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesTrash.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleEditorBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleEditorMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleEditorReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleHomeBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleHomeMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleHomeReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeoplePersonBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeoplePersonMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeoplePersonReads.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleTrash.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/people/PeopleWords.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/AlbumChoice.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotoEditorMachine.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotoLightboxBridge.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotosCollectionsReads.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/PhotosSearchReads.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyBridge.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyBridges.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyEditorMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyExpenseMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyFold.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyFriendMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyGroupMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyHomeMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyLenses.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyListMachine.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyQuery.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallyReads.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallySettleUpMachine.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tally/TallySplit.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksCatchUpPage.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksDetail.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksHome.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksList.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksOps.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksProjectPage.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksRows.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksTrash.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/Autosave.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/Band.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/MoneyFold.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/PagedList.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/ReadContent.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/ScreenBridge.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/Search.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/Trash.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/Writes.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/time/CivilDays.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/time/CivilWords.kt` — new
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/Navigation.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/ScreenMachine.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeReads.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeRuntime.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSession.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/Shelf.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/Instants.kt` — changed
  - `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenRuntime.kt` — changed
- `mobile/shared/src/jvmTest/`
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AppReadsSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ChangeStreamSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/DocsSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeReadsSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeSwitchSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/KitLawsSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/KitRuntimeSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/KitTimeMoneyCopySpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NativeThemeSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NavigationAndMountSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/NotesAppSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PeopleSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PerAppLayoutSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PhotosCollectionsSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenMachineSpec.kt` — changed
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TallyListReReadSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TallyPageOrderSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TallyScreensSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TasksSpec.kt` — new
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/WriteRunnerSpec.kt` — changed

## Audit

Pending: the umbrella's independent review is the root's, at close.
