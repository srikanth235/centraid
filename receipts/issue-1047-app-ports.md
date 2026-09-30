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


## Close

Appended at the close pass on 2026-09-29. The sections above are left as the doc pass wrote them. Everything below happened after `0a20e33a6`, the commit that landed the doc pass. When this was written it was an uncommitted working tree that included two staged deletions. The owner widened the umbrella twice on the way: on 2026-09-25 Locker came in (D-5), and on 2026-09-29 the 24-word enrollment and pairing came in. Where this section and a state doc disagree, the doc is current.

### Checklist, reconciled

- [ ] **The Tasks, People, Docs, Notes and Tally tiles, all-apps rows and first moves open their apps on iOS and Android.** Every entry point routes in code. On iOS, the first moves "Save a secret", Docs and Tally were dead taps, fixed in L2; the iOS walks opened every app from Home. The Android emulator walks never got past Home and Locker because the host was overloaded (L3, E3). **The box waits for the [final walk](#final-walk).**
- [x] **Every screen renders from a core `app_query` answer, with no join in Kotlin or Swift.** Locker's four arms (60–63) and its session (`Request.locker = 21`) follow the same rule.
- [x] **Tally.** This held at the doc pass. Export is now a file the core renders ([R-1047-Q5](../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)), drawn on both shells.
- [x] **Notes.** A body cleared to nothing now saves. `NotesEditorMachine`'s refusal covers only a new note with no title and no first line (R-1047-N2).
- [x] **Trash screens are restore-only where no destroy command exists.** Docs gained its destroyer under [D-1](../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047): "Delete forever" and "Empty trash" destroy, on Photos' path.
- [x] **The Activity and Needs-you tabs are gone.** `BandPolicy.PLACES` no longer declares them. `copy/shared.json` no longer carries `SHARE_FAILED` or `SHARE_IS_A_COPY`.
- [x] `AbiRoundTripSpec` reopens without hanging.
- [x] **Docs updated; one receipt.** That is this section, the docs listed under [the close's own changes](#the-close-c1), and #1046's [close](issue-1046-agenda-phone.md#close).

### What landed after the doc pass

The slices ran as sub-agents under the root, at most two at a time.

**The reports for the first six slices are gone.** R1, S1, V1, S2, S3 and V2 were the core, shared and view follow-ups before Locker, and their scratchpad was wiped on 2026-09-28. What they built is recorded as rulings: [D-1…D-5 and R-1047-Q3…Q6](../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047).
- A day the phone draws is the core's, in the device's zone.
- The Docs stage draws a file the core hands out.
- Tally's export is a CSV the core renders.
- A repeating search hit names the occurrence it opens.
- Docs destroys on Photos' path.
- The Linux-only install tests.
- Agenda reads `core.place`.
- Locker's biometric unlock model.

**Locker on the phone** ([D-5](../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047), [R-1047-L1…L9](../docs/decisions.md#locker-on-the-phone-1047-d-5)):

| Slice | What landed |
| --- | --- |
| L1 — core and shared | `locker.proto` and arms 60–63. The session (`Request.locker = 21`): unlock, idle and relock, sealing before the vault sees a secret, and a reveal receipted before it decrypts. `crates/apps/locker/src/phone.rs` exposes a sealed cell only as its presence. The shared `apps/locker` has the lock machine, the gate, home, item, editor, generator and trash, with 241 copy keys. It also fixed a `page.rs` bug found on the way: `<cell> IS NOT NULL AS name` came back as a string literal. |
| S4 — state gaps | The views' last hand-spelled words moved into state: <br>• Notes link-picker local days, the history back label, and the journal's own compose sheet (`people.add_journal_entry`). <br>• Docs purge on a trashed document, the ingest status line (one text action, never clears itself), and the filed document pushed from any screen. <br>• The Tally export sheets and `export_range`. <br>• Home tiles' `accessibility_label`, `open_label` and People's `more_label`. |
| L2 — iOS views | The Locker screens and the lock seam (`LAContext .deviceOwnerAuthentication`; `backgrounded()` on `.background` only), and the clipboard seam (local-only, expiring). <br>Docs ingest from the root: the importer, VisionKit scan to one PDF, and the filed-document push. The Docs stage draws images, PDFs and media. <br>`TallyExportView`. The Locker tile drawn from state. <br>The dead first moves routed. <br>`NSFaceIDUsageDescription` and `NSCameraUsageDescription`. |
| L3 — Android views | The Locker screens. `BiometricPrompt` with `BIOMETRIC_STRONG or DEVICE_CREDENTIAL` (WEAK on API 28–29), guarded against the credential activity's own stop. The clipboard marked sensitive and cleared only if it is still ours. <br>`MainActivity` is a `FragmentActivity`. `androidx.biometric` added. <br>Home and Band literals moved to `HomeWords`. The People discs fixed. Agenda's shelf a11y, and Notes' search-snippet highlights. <br>Docs Scan's refusal path. |
| F1 — fix-up | The item page no longer flashes a failure before `Opened`. It is red-first: `LockerSpec` "an item does not read before it is opened" fails without the fix. <br>The iOS switcher mask moved to `.background`, so it no longer blacks out the Face ID prompt. <br>Camera-denied and restricted sentences for Scan. <br>Home and Band copy. <br>**The passphrase wrap was deleted** from `crates/core/src/locker/{session,unlock}.rs`, with the `aes-gcm`, `argon2`, `base64` and `rand` dependencies of `crates/core`, and `argon2` from the workspace. |
| R2 — `K` from the seed | `K` is `seed / vault'(i) / locker'` (`LOCKER_INDEX = 3`), derived at open into the keyring. Nothing is on disk, and a restore reopens sealed secrets ([D-6/D-7/D-8](../docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)). `lockerKeyHex` is pinned in `contracts/crypto/identity-vectors.json`. The random-mint path was deleted. |
| W1 | `LockerLockState.lock_label` removed; field 9 and its name are reserved (D-8). The Android `keys/` backup excludes are gone. `seed-demo-vault` seeds five Locker items under the public all-`abandon` words. The four `PhotoLightboxStage.kt` lint errors were fixed in code. |
| W2 | Every keyed open passes the seed and the vault's own index. The index is device-only, with a high-water mark, and never guessed. `CoreConfiguration.toString` redacts. A core without keys draws "Locker needs your 24 words" and raises no prompt. The debug-only demo seed path is `demo-vault.sh` → `DevSeed`. |
| F2 | `NotesQueryRoundTripSpec` was stale: it sent no `tz`, and the core is right to refuse that. The spec now states the zone. |
| D1 | **The multi-seat custody plane was deleted** ([R-1047-D1](../docs/decisions.md#the-multi-seat-locker-custody-plane-deleted-1047)): `keystore.rs`, `member_key.rs`, `locker.rotate_key`, and the `scrypt` and `anyhow` dependencies. `member_key_gate.rs` was re-homed as `locker_plaintext_gate.rs`. |
| D2 | **The `sealed:v1:` layer and the access plane's reveal judgement were deleted** ([R-1047-D2](../docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)). `custody/seal.rs` and `contracts/custody/recovery-kit.json` are removed, with **both deletions staged in the index**. Rung seven, `007_locker_key_one_generation.sql`, leaves at most one Locker generation. |
| D3 | **The extension-fill plane was deleted** ([R-1047-D3](../docs/decisions.md#the-extension-fill-plane-deleted-1047)): `core::locker::{fill,unlock}`, the autofill queries, the origin matcher, `psl`, `contracts/origin-matching-v1.json` and `docs/security/locker-origin-matching.md`. Q-1047-13 was answered (b): `derived_on`/`unseals_on` are no longer answered. Seat, gateway and rotation prose was rewritten across Locker, access and doctor. |
| D4 | [R-1047-D4/D5/D6](../docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047): <br>• `online_only` is deleted everywhere, and `ERROR_CODE_ONLINE_ONLY` (44) is reserved. <br>• Rung eight, `008_locker_no_match_policy.sql`, drops the match policy. <br>• TOTP on the phone uses RFC 6238 with the workspace's new `sha1`, and each code is receipted. <br>• Watchtower (weak/reused) is deleted. <br>• The Locker editor conceals its secure fields before it closes, against iOS "Save Password?". |
| F3 | The core refuses to reveal `otp_seed` (`SEED_NOT_SHOWN`) before the session and before any receipt. iOS Review draws an item that sits in two sections. `crates/apps/people/tests/copy.rs` was updated to Locker's phone-only copy, and a sweep over every leaf was added. |

**The 24 words and pairing** ([R-1047-E1…E13](../docs/decisions.md#the-24-words-on-the-phone-1047-e1), [R-1047-R1…R4](../docs/decisions.md#a-restore-that-holds-1047-r3)):

| Slice | What landed |
| --- | --- |
| E1 — core and shared | `PhraseRequest` (`Request.phrase = 22`): mint, check and seed in Rust. The shell has no word list. <br>`Enrollment` runs mint → show once → confirm three → store and settle the seed → found keyed. <br>The machines `words.make` and `words.enter` (restore and re-key). The core mints the device secret. `CorePairDoor`. <br>The binding decodes the error body on `BAD_ARGUMENT`, and `OPEN_REFUSED` names the real candidates. `copy/words.json` and `WordsCopy.kt` were added. |
| E2 — iOS words views | `WordsViews.swift`: the numbered grid and the confirm fields. `WordField` has no edit menu, paste, drag or learning. `WordsShield` draws the content in a secure text field's canvas and covers it on capture or inactivity. The make and restore sheets are at the root. The Locker wall's "Enter your 24 words". |
| E3 — Android words views | `screens/words/`: `FLAG_SECURE` on the activity **and** the sheet's dialog window. No text toolbar or clipboard. `NO_PERSONALIZED_LEARNING`, `NO_SUGGESTIONS` and `VISIBLE_PASSWORD`. `NoAutofill` on the words sheet and the Locker editor. |
| E4 — core and shared | [Q-1047-17/18/19](../docs/decisions.md#the-24-words-on-the-phone-1047-e1) answered: <br>• One directory per vault. <br>• A restore takes the words or the seed. <br>• The words are kept device-only for `words.show`. <br>The crash window between the core's found and the shell's record is closed. <br>`pair.laptop` redeems the invite before it claims the lease, and the shelf reopens so the keyring carries the device secret. <br>~~`centraid-gateway invite` prints its endpoint in groups of eight.~~ Superseded by [D-9](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047) (X1): `invite` prints no endpoint to compare, and the member compares the safety number `serve` prints once the admit lands. There is an end-to-end pair test against a real gateway. |
| E5 — iOS custody views and the full loop | A typed pair refusal: `GatewayRefused` → `UNAUTHORIZED` (R-1047-E13), and `PairResult`. `PairLaptopEvent.Opened.camera`. <br>`WordsShowView` behind `LAContext`. `PairLaptopView` with an AVFoundation QR scanner. The More sheet's two rows. The word-cell focus-steal fix. <br>**The full loop on the simulator against a real `centraid-gateway`:** make → words → pair by paste (the endpoint matched, the comparison [D-9](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047) has since replaced with the safety number) → drain landed → uninstall, keychain reset → restore from typed words. |
| E6 — Android custody views | The words.show owner check (`BiometricPrompt`). `PairLaptopScreen`. A CameraX + ZXing `PairScanner`. The More sheet's two rows. `CAMERA` in the manifest, with Docs Scan now asking at tap ([R-1047-E14](../docs/decisions.md#the-24-words-on-the-phone-1047-e1)). |
| R3 — a restore that holds (concurrent with the close) | The running census is moved only by the commit guard. A restore probes the head, verifies, and claims the lease last. One carrier for the index scan. A typed restore refusal ([R-1047-R1…R4](../docs/decisions.md#a-restore-that-holds-1047-r3)). It is aimed at both walk-found defects: E5's walk B, where a vault that ever opened Locker could not be restored, and the lease taken before verifying. R3 was still running when this section was written, so its own report is the evidence, and the [final walk](#final-walk) re-runs walk B. The trap is [docs/traps/census-around-the-guard.md](../docs/traps/census-around-the-guard.md). |

**The owner's rulings of 2026-09-29 and the last leftovers** ([D-9…D-11](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047), [R-1047-X2](../docs/decisions.md#the-notices-table-dropped-1047)):

| Slice | What landed |
| --- | --- |
| X1 — the three rulings | **D-9:** one `centraid_identity::pairing_safety_number` on both sides; `PairLaptopState.safety_number = 14` (`fingerprint` 7 reserved), an empty number refused; `serve` prints `safety` on each admit and for every paired vault at start, `invites` under each redeemed invite, `invite` a hint and no grouped endpoint; the drain-wire pair test asserts the laptop's rendering equals the phone's. **D-10:** `LockerLockState.secure = 12`, set exactly in UNLOCKED; Android `SecureWindow` as a counted hold in `LockerRoutes`; iOS `LockerShield` over home, item and editor. **D-11:** `PairLaptopState.words_label = 15`, `WordsTapped = 8`, routed to words.enter's re-key on both shells. Glossary, `time/` doc cites and the pairing docs corrected. |
| X2 — the shield's gaps and the notices table | **iOS capture shield:** the kit's `TrashListView(secure:)` draws its list and its confirm in `WordsShield`, keeping its toolbar outside the canvas; the item's memo and confirm sheets are shielded, each stating the new kit `SheetPresentation` again outside the canvas; an item page draws no navigation-bar title while `secure` (its shielded header carries it); `LockerCaptureCover` is deleted. Seen on a throwaway iPhone 17 Pro simulator: the framebuffer shows each layout intact and the sheets at their detents, and Maestro's XCTest screenshots leave the item, memo, trash and trash confirm blank. **Rung nine** (`009_no_notices.sql`) drops `notifications_notice`, which a mechanical sweep found nothing reads or writes (ONT-36); `vault-ddl.sql` regenerated, the head is 9. |
| F4 — the walk's hand-offs | **B1:** a shared `TypedText` (`shared/kit/TypedText.kt`, red-first `TypedTextSpec`) tells a field's typing from the machine's echoes; Android `rememberEditorText` keeps the reload gate and adds the echo guard (every `EditableFieldRow`), `rememberFollowedText` serves the kit search, Agenda search and Tasks quick add, and iOS `MachineTextField` and the Docs labels draft ask it too. **Plurals:** People's roster and Touch lines take `PeopleWords.people(n)` ("1 person"), `CADENCE_EVERY_ONE`, Words' `RESTORED_LINE_ONE`. **Locker's clipboard** ([R-1047-F4-1](../docs/decisions.md#lockers-clipboard-and-its-row-chip-1047-f4)): `LockerLockState.clipboard_clear = 13`, bumped on Lock, clears only Locker's own copy on both shells; the wall's Leaving fact reworded; Android's `LockerSeam.clear` no longer wipes a copy with no mark. **Android's capture hold** is route-owned and applied from the bridge's Main-thread callback. The unreachable-restore sentence names `centraid-gateway`; "on this phone" for a never-paired vault; no "Saved" on an empty new note or person (`AutosaveLens.stored`); a Locker row's subtitle is the core's only for login, identity and Wi-Fi; the Android Locker wall has a band with Home and pushed pages a back to Locker; `PushedPage(backSpoken)` so Tally's and Locker's editors say "Cancel"; `centraid-gateway invites` prints the redeemed time in the laptop's zone; iOS `platformServices()` is one per process. Monograms stay the type chip ([R-1047-F4-2](../docs/decisions.md#lockers-clipboard-and-its-row-chip-1047-f4)). |
| F5 — the re-walk's three | **Notes' derived title** (red-first, `NotesAppSpec` "a title derived from the body stays derived after the re-read"): `NotesEditorMachine.keepDerived` keeps the draft's title empty, draft and baseline, when the draft's title is blank and the re-read's title is the body's first line; a name from elsewhere is adopted, and a fresh open still draws the stored title, so both shells draw one thing and iOS reopen is unchanged. A pin alone after the re-read sends no title. **The re-key's door** (red-first, `WordsEntrySpec` "a re-key explains itself in its door's words"): `WordsEntryState.Origin` (`origin = 16`, `Opened.origin = 2`), `WordsEntryBridge.openRekeyForPairing()` from both shells' pair.laptop `WordsTapped`, and `WordsCopy.REKEY_PAIR_BODY` / `REKEYED_PAIR_BODY` with their `copy/words.json` twins; Locker's wall and an unnamed door keep Locker's sentence, a restore ignores the origin. **The iOS Home band's Vault tab:** reproduced on a throwaway simulator: two taps on Vault change nothing, More opens its sheet. It is not an iOS defect: place `data` has no destination on either shell (`HomeView.swift` and `HomeScreen.kt` route `more` only), so it is left for the owner. |
| F6 — the audit's restore, key and record findings | **M1** (red-first, `drain_wire.rs::a_restore_that_refuses_one_vault_claims_none`: two vaults, the second damaged; it failed with "the refused restore moved vault 0's lease off the old phone"): `phone::restore` checks every vault before it claims any, and a refusal removes every staged file and directory. A claim that fails after another landed answers the claimed vaults — adopted, with the device secret — and names the rest in `RestoreResponse.unclaimed` (`UnclaimedVault`, field 4). Nothing is dropped. **L1** (red-first, conformance `lease/a-restore-claim-at-a-moved-head-is-refused-and-moves-nothing` failed against an unconditional stub): `POST …/lease` takes `{"head"}` (`Gateway::claim_lease_at_head`, `GatewayClient::claim_lease_at_head`). A moved head is refused `GATEWAY_HEAD_CONFLICT` with the lease unmoved; the phone re-reads, re-checks and re-claims, up to three times. A test seam, `restore::run_observed`, drives the window. **Found on the way:** a restored phone's first drain never landed — no `head.json` and a fresh spool generation, so the laptop answered a head conflict and the drain said `UNREACHABLE`. Adoption now writes the restored head and seeds the spool cursor, and a third phone restores what the restored phone drained. **L7:** both refused-restore tests assert that the new phone's directory is empty. **L5:** after unlock, seal, reveal and relock, every file under the vault directory is scanned for `K`'s raw bytes and hex; a planted file falsifies it. **L6:** `LiveKey` zeroes the copy `open_key` hands out. **L2, L4, L8** and #1046's **L1, L2:** `vault-ontology.md`, `QUALITY.md` (moved to Resolved), this receipt's front-page line, the `zone_of` string and #1046's rrule wording. **Governance:** #1025's and #1029's receipts gain `## What changed`, `## Verification` and a retroactive `## Audit`. #1029's audit finds 34 of 80 cited hashes that do not resolve. Ruling [R-1047-R5](../docs/decisions.md#a-restore-that-holds-1047-r3). **Owed:** neither shell draws `unclaimed` (`QUALITY.md`). **Verified:** `cargo test` for core, vault, centraid, api-proto, core-ffi and gateway-* gave 888 passed, 1 failed (`disk_full.rs:160`, macOS) and 2 ignored. `drain_wire` passed 11/11. `clippy -D warnings`, `cargo fmt --check` and `bun run format:check` exit 0. `cargo xtask rules` passed all four. `run.mjs --front-page` reads the committed tree and still reports 12 errors. The receipt-section errors among them pass the rule's own parser (`extractReceiptSection`) on the working tree, so they clear on commit. |
| F7 — the compromised flag and the band's Vault | **The compromised flag** ([R-1047-F7](../docs/decisions.md#the-compromised-flag-and-the-default-band-1047-f7), audit L3): the item editor's **Mark as compromised** toggle row on both shells (`LockerEditorData` fields 12–14, `LockerEditorEvent.CompromisedToggled` 11, `LockerCopy.COMPROMISED_*` with their `copy/locker.json` twins). The editor sends `compromised` only when it changed. `locker.edit_item` clears the flag on a rotation unless the write states it. The manifest's `add-item` and `edit-item` inputs name it. `locker.proto`'s Review comment and Review's reason no longer claim an import. Red-first: `locker_commands.rs::the_member_flags_a_compromised_item_and_a_rotation_clears_it` and `LockerSpec` "the member marks a leaked item compromised…" (red against the unfixed rule and the unsent flag), plus `locker_tests.rs::a_flagged_item_is_listed_for_review_until_its_password_changes` end to end through the core. **The band's Vault** ([R-1047-F7b](../docs/decisions.md#the-compromised-flag-and-the-default-band-1047-f7), F5's finding): `data` is no longer pinned by default (`CatalogSpec` "the default band pins no place with nothing behind it", red against the old pin), and `docs/system-signals.md` states the defaults as they are. |
| F8 — the vaults that stayed | F6's owed item ([R-1047-R5](../docs/decisions.md#a-restore-that-holds-1047-r3) addendum, `QUALITY.md` moved to Resolved). Red-first: `WordsEntrySpec` "a vault that stayed with the other phone is named, numbered with the ones that came back, and offers no retry" and `WordsShelfSpec` "the restore door carries every vault's path and index…" failed against the unmapped door and the silent DONE (`scratchpad/f8-red.log`); `EnrollmentSpec` "a restore that left a vault with the old phone holds only what it claimed…" guards that the shelf is never handed an unclaimed vault. `CoreRestoreDoor` maps `RestoreResponse.unclaimed` into `RestoreAnswer.unclaimed` (`UnclaimedVaultAt`: index and vault id; the core's `reason` is a support log and is not carried). words.enter's DONE draws `WordsEntryState.stayed` (field 17), one `WordsCopy.RESTORED_STAYED` sentence per vault, numbered with the `restored` lines in one sequence by derivation index, under `RESTORED_SOME_TITLE` with `RESTORED_STAYED_BODY` (twinned in `copy/words.json`); iOS `StayedLine` and Android `StayedLine` draw it behind a `seam` rule. **No retry control:** `RestoreRequest` names no index, and a second restore on this phone would discard and lay the claimed vaults down again under an open session with a new device secret; a per-index restore is a new Open item in `QUALITY.md`. **Verified:** `cargo build -p centraid-core-ffi` (host and `aarch64-apple-ios-sim`); `:core:jvmTest`, `:shared:jvmTest`, `:androidApp:assembleDebug` and `:androidApp:lintDebug` green; the simulator-only XCFramework, regenerated Swift protos and `xcodebuild build` for an iPhone 17 Pro simulator succeeded; `cargo fmt --all --check` and `cargo xtask rules` clean, `drain_wire` 11/11; `bun run format:check` exit 0. Not walked on a simulator: a partial claim needs a laptop that drops between two claims. |

### The close (C1)

- **Kotlin warnings #1047 introduced, removed in code, with no suppressions:**
  - 37 unnecessary `!!`: `LockerSpec` 9, `DocsSpec` 17, `NotesAppSpec` 8, `KitLawsSpec` 2 and `TallyExportSpec` 1.
  - An unnecessary safe call in `PeopleEditorMachine.kt`.
  - Redundant `toInt()` calls on fields that are already `Int` in `TallyGroupMachine.kt`, `TallyHomeMachine.kt`, `TallyLenses.kt` and Android's `theme/Theme.kt`.
  - The warnings older than #1047 are left (see [Owed](#owed-and-deferred)).
- **The `copy/*.json` headers now say what is true.** All ten named `contracts/tools/export-copy.ts` as their generator, but that emitter left in #1020 wave 6 and the files are hand-maintained. Each now carries a `$comment` that names its Kotlin twin and `KitTimeMoneyCopySpec`. No reader parses the header: the spec reads only `"strings"`, and `centraid_design::copy` reads `serde_json::Value` fields.
- **A simulator-only XCFramework.** `-Pcentraid.iosSimulatorOnly=true` puts only the `iosSimulatorArm64` slice in `CentraidShared.xcframework` (`mobile/shared/build.gradle.kts`). Without it, the assemble task links all three slices and fails on a machine that has built only `aarch64-apple-ios-sim`. E5 and D4 hit that failure and worked around it with a hand-run `xcodebuild -create-xcframework`.
- **State docs:**
  - `mobile/README.md`: the More-sheet rows, the scanners and their dependencies, `CAMERA` and Docs Scan, and the simulator-only build.
  - `SECURITY.md`: the capture, clipboard and keyboard row, and the owner-check row.
  - `ARCHITECTURE.md`: what exists on the phone.
  - `docs/enrollment.md` (§6 rewritten to the laptop invite), `docs/glossary.md`, `docs/dev-environment.md` and `docs/release/v1-handoffs.md` (1.4b, 7.3, new 1.7).
  - `docs/decisions.md`: R-1047-E14.
  - `CHANGELOG.md`.

### Decisions

Recorded in full in [docs/decisions.md](../docs/decisions.md#the-app-ports-and-the-shell-kit-1047); this table is the index.

| Ids | Where |
| --- | --- |
| **D-1…D-5**, **R-1047-Q3…Q6** — the owner's rulings of 2026-09-25 and the core half beside them | [decisions](../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047), [#1047](https://github.com/srikanth235/centraid/issues/1047) |
| **R-1047-L1…L9** — Locker on the phone | [decisions](../docs/decisions.md#locker-on-the-phone-1047-d-5) |
| **D-6…D-8** — `K` from the seed; the presence gate; Lock in the More sheet (owner, 2026-09-28) | [decisions](../docs/decisions.md#the-owners-rulings-of-2026-09-28-1047) |
| **R-1047-D1…D3** — the custody plane, `sealed:v1:` and the fill plane, deleted | [D1](../docs/decisions.md#the-multi-seat-locker-custody-plane-deleted-1047), [D2](../docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047), [D3](../docs/decisions.md#the-extension-fill-plane-deleted-1047) |
| **R-1047-D4…D6** — `online_only`, match policy, TOTP and Watchtower (owner, 2026-09-29) | [decisions](../docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047) |
| **R-1047-E1…E14** — the 24 words, pairing, the Android camera | [decisions](../docs/decisions.md#the-24-words-on-the-phone-1047-e1) |
| **R-1047-R1…R4** — a restore that holds | [decisions](../docs/decisions.md#a-restore-that-holds-1047-r3) |

**The owner's rulings in this stretch** (finish plan, 2026-09-25/28/29; each is recorded at the anchor above):

- **2026-09-25:** Go with the recommendations on Q-1047-1…5. That gave D-1…D-5, and Locker comes into this umbrella.
- **2026-09-28:**
  - Q-1047-11: derive `K` from the seed (D-6).
  - Q-1047-12: keep the presence gate (D-7).
  - Lock is a More-sheet row, not an app-bar verb (D-8).
- **2026-09-29:**
  - Build the 24-word enrollment and the pairing screen inside #1047.
  - Q-1047-17: one directory per vault.
  - Q-1047-18: a restore accepts a stored seed.
  - Q-1047-19: **keep the words** on the phone so settings can show them. The owner chose this against the recommendation of "shown once".
  - Q-1047-14/15/16: yes to all.

### Verification at close

These are the slices' own runs, as each reported them, and the close's own. Logs are in the root's scratchpad, not the repository.

| Check | Outcome |
| --- | --- |
| `:shared:jvmTest`, full, JDK 21 (`JAVA_HOME=…openjdk@21`, `-Dorg.gradle.java.installations.paths`) | **The close: 977 tests, 0 failures, 0 errors**, after the warning fixes. <br>Along the way: 903 (F1, W1), 917 (W2, F2), 948 (E1), 968 (E4), 975 (E5, E6). |
| `:core:jvmTest` after `cargo build -p centraid-core-ffi` | **31/31** (F2). **33, 0 failed**, including `PhraseRoundTripSpec` (E1). BUILD SUCCESSFUL (D4, F3). |
| `:androidApp:assembleDebug :androidApp:lintDebug -Pcentraid.android=true` | BUILD SUCCESSFUL, **lint 0 errors, 27 warnings**, all older than this umbrella (E3, E6). Lint was 4 errors before W1. <br>The close ran `:androidApp:compileDebugKotlin`: BUILD SUCCESSFUL. |
| iOS: `cargo build -p centraid-core-ffi --target aarch64-apple-ios-sim` → XCFramework → `protoc` → `xcodegen generate` → `xcodebuild` on the iOS 26.4 simulator | **BUILD SUCCEEDED; `xcodebuild test` TEST SUCCEEDED, 61 tests, 0 failures** (L2, E2, E5). The only warnings are two older `Sendable` warnings in `ShellModel.swift`. |
| `cargo test` over core, core-ffi, vault, identity, api-proto, the seven app crates, centraid, gateway client and server | green except `vault/tests/disk_full.rs` (below) (L1, R2, D1–D4, F3, E1, E4, E5). <br>Examples: `seed_demo_vault` 6/6 (W1), `drain_wire` 5 passed with the pair and refused-pair end-to-end tests (E5), and `locker_plaintext_gate` 3 passed (D1). |
| The close: `./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true -Pcentraid.iosSimulatorOnly=true :shared:assembleCentraidSharedDebugXCFramework`, on a tree with no `target/aarch64-apple-ios` archive | BUILD SUCCESSFUL in 5 m 27 s. Only `linkDebugFrameworkIosSimulatorArm64` ran, and the XCFramework holds `ios-arm64-simulator`. Without the property, the dry-run graph links all three slices. |
| The close: `cargo test -p centraid-apps-people --test copy` and `-p centraid-design` (the Rust readers of `copy/*.json`) after the header change | 4 passed, and 3 + 4 + 5 passed; every `copy/*.json` still parses |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 (D3, D4) |
| `cargo fmt --all --check` | clean (every slice) |
| `cargo xtask rules` | **all four ok** after the close's fixes. `sql-confinement` had two findings: #1046's `crates/apps/agenda/tests/detail.rs` (see [its close](issue-1046-agenda-phone.md#verification-at-close)), and R3's own `crates/centraid/tests/drain_wire.rs`, whose restore test counted the Bank item with a `SELECT` literal. That count now reads Locker's `items_statement` shelf through `TestDoor`. `drain_wire`: 7 passed. |
| Full loop on the iOS simulator with a real `centraid-gateway serve` (E5) | **PASS for a demo-seed vault:** restored 109 rows, keyed, Locker revealed after the restore. <br>**FAIL for a vault made on the phone** (census vs `locker_key`). R3 fixed it (R-1047-R1); the [final walk](#final-walk) re-runs it. |
| TOTP on a private simulator (D4) | `003 098` with 26 s left; recomputed on the host as RFC 6238 over the demo seed, it matched. The code rolls and follows once. |

**Demonstrated red:**
- F1: `LockerSpec` "an item does not read before it is opened" failed without the fix.
- F2: `NotesQueryRoundTripSpec` failed 2/3 before, and was green after.
- E3: with only `NO_SUGGESTIONS`, Gboard still showed its strip; `VISIBLE_PASSWORD` fixed it (seen on the emulator).
- **D4's iOS "Save Password?" fix has no demonstrated red.** Its red variant also showed no prompt on a fresh simulator. E5 later saved Locker logins twice on 27BA36FC with no prompt.

**Known failures:**

| Failure | Why |
| --- | --- |
| `crates/vault` `a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` (`tests/disk_full.rs:160`) | macOS only: the test opens `/dev/full`, a Linux device |

**Not run, and why:**
- **The gate profiles.** `mobile-jvm` ends in `git diff --exit-code -- design copy mobile contracts/screens`, which fails on any uncommitted tree whatever the tests say (F2). The PR push owns them.
- ~~**The receipt front page.** `node .governance/law/run.mjs --front-page` needs `@eslint/json`, which is not installed in this tree.~~ Corrected (audit L8, F6): `@eslint/json` is installed and the front page runs on this tree; the audit ran it, and so did F6. It reads the committed tree, so its findings about this receipt clear only on commit.
- **The iOS capture shield** cannot be observed from the simulator (`simctl io screenshot` reads the framebuffer).
- **The Android emulator walks** stopped under host load of 16–43. The final walk owns them.

**The commit body's doc-integrity waiver.** The frozen `## Resolved` line in `QUALITY.md` for the expression-index entry differs from the merge base because committed `e22829a41` ("chore: sweep v0-tree leftovers") deleted `docs/traps/expression-index-spelling.md` and unlinked it; restoring the line verbatim would add a dead link. The commit body carries:

```
governance: allow-doc-integrity QUALITY.md the Resolved #922 expression-index entry's link was unlinked by e22829a41, which deleted docs/traps/expression-index-spelling.md with the v0 replica tree; the verbatim line would be a dead link
```

### Owed and deferred

**Needs a device or the final walk:**
- **A physical-device screenshot and screen recording of the iOS words screens**, to verify the capture shield and the app-switcher cover. Tracked in [v1-handoffs](../docs/release/v1-handoffs.md) 1.7.
- **Android, on a quiet machine:**
  - Locker item, reveal, copy, Review, Generate, Search and Trash.
  - `words.show`.
  - Pair by paste and by scan.
  - Docs Scan's permission prompt.
  - E6's thirteen-step checklist.
- **The Google Password Manager save prompt against the Locker editor**, on a real device that has saved passwords (E3).
- **`RESTORE_HELD`.** It needs an unsettled synchronised seed, which the host cannot stage (E5, E6).
- **The re-key success path.** It needs a phone that holds an index but no seed (E2, E3).

**Owner questions — answered 2026-09-29** ([D-9, D-10, D-11](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047), implemented by X1 and X2):
- **What a member compares after pairing** — the 60-digit safety number, on the phone's PAIRED phase and on `centraid-gateway serve` once the admit lands; a hex endpoint id is never it (D-9, W15-D5 stands; R-1047-E12's grouped-endpoint comparison is superseded).
- **`FLAG_SECURE` on Locker's screens (L3)** — wider than recommended: every Locker page while the Locker is unlocked, driven by the gate's `LockerLockState.secure` (D-10).
- **A "NEEDS_WORDS → Enter your 24 words" door on the pair screen (E6)** — `PairLaptopState.words_label` and `PairLaptopEvent.WordsTapped`, as recommended (D-11).

**Code, left for a sweep and not this umbrella:**
- Much of `crates/apps/locker` beyond `phone.rs` has no production caller: `queries.rs`'s folds, `commands.rs`'s `Invocation`/`Commands`, `totp`'s unused half and `sidecars` (D3). **Landed after close (T2)**: deleted, and `tests/parity.rs` compares v0's answers with the phone's loaders ([R-1047-T2-7](../docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)).
- Dependencies in `crates/centraid/Cargo.toml` that no source uses (D3).
- `crates/core/src/stage.rs` cites a deleted file.
- Seat and desktop prose in `gateway-server/src/serve.rs` and `xtask/src/{rules,gate}.rs` (D3).
- `crates/identity/src/ticket.rs:22` still says the Locker key "reaches a seat" (D3).
- `crates/apps/locker/manifest.json` still has v0 descriptions (D3). **Landed after close (T2).**

**Locker features not on the phone yet (L1):** **Landed after close (T2)** ([R-1047-T2-1…6](../docs/decisions.md#lockers-follow-ups-on-the-phone-1047-t2)):
- Editing and revealing custom sealed fields and passkeys — custom fields added, edited, removed and revealed from the item page, sealed by the core against their own id; a passkey shown, renamed and removed, its key refused `KEY_NOT_SHOWN`.
- Access history — one item's receipts on its page (reveals, copies, codes). The whole-Locker route with unlocks is [Q-1047-21](../docs/decisions.md#open-questions-for-the-owner-1046-1047).
- Import and export — plaintext CSV (1Password dialect) or Locker JSON after the confirm and a fresh owner check, to the OS save sheet only; import from a password-manager CSV or Locker JSON with the handoff's verdicts, sealed in. Whether the export carries one-time-code seeds is [Q-1047-20](../docs/decisions.md#open-questions-for-the-owner-1046-1047).
- Walked on a throwaway iOS simulator over the demo vault (which now seeds a sealed and a plain custom field and a passkey login): a field revealed and its receipt listed live, a sealed field added, the passkey page, a CSV and a JSON export written through the save sheet into the Files provider only, and both read back as plans (CSV: 3 new · 2 fill · 1 held; JSON: 6 held). Android was built and linted, not walked (no emulator); it joins the Android walk above.

**Cosmetic:**
- When 24 words are typed as one run into cell 1 on iOS, that cell keeps showing the run (E5). **Landed after close (T3).**
- The Tally tile has no body by design (L2).

**Gateway:** `centraid-gateway invite`, run while `serve` is up, prints a ticket with no direct addresses (E5). Pairing still worked through relay or discovery.

**Residual, which no field can refuse:** Gboard's clipboard chip commits text through the input method (E3).

**Older than #1047, and left:** Kotlin warnings in `HomeMachineSpec`, `ScreenFixtureSpec`, `DuplicatesSpec`, `AbiRoundTripSpec`, `PhotoShelfMachine`, `HomeBridge` and Android's `kit/Band.kt`, and the deprecated `EncryptedSharedPreferences`. **Landed after close (T3).**

**Landed after close, by slice T1** (items above and QUALITY.md's two #1047 entries):
- **Per-vault restore** ([R-1047-R6](../docs/decisions.md#a-restore-that-holds-1047-r3)): `RestoreRequest.indices`; a restore never touches a vault this phone already holds; the retry mints a device secret for the vaults it answers (the shell keeps one per vault); words.enter's DONE offers "Try again" (`retry_label`, `Retry`, `Enrollment.restoreStayed`, `WordsCopy.RESTORED_STAYED_RETRY` and `RESTORE_STAYED_STILL`), drawn on `WordsViews.swift` and `WordsScreens.kt`. Held by `drain_wire.rs::a_vault_that_stayed_comes_back_on_its_own_while_the_adopted_one_stays_open`, `WordsEntrySpec`, `EnrollmentSpec`, `WordsShelfSpec`.
- **`RESTORE_HELD` reached no core.** `CoreRestoreDoor.restoreSeed` decoded the 64-byte seed with the 32-byte endpoint decoder, so it answered UNREACHABLE without asking; `hexToBytes` takes the length now (`WordsShelfSpec`). The device walk above still stands.
- **`knowledge.edit_note` takes an empty title**, and Notes sends a cleared name empty when the body has no first line (`knowledge_commands.rs::a_note_title_may_be_cleared_by_an_edit`, the Notes manifest test, `NotesAppSpec`).
- **Dependencies no source uses**, swept workspace-wide by a `use`/`::` scan and confirmed by `cargo check -p <crate> --all-targets` per crate: `crates/centraid` (apps-tally, protocol, flate2, prost, serde, thiserror, tracing, url, and the dev `core-ffi` and duplicate `api-proto`/`prost`; apps-kit, apps-locker and base64 moved to dev), `blobs` (api-proto, protocol, tracing), `core` (rusqlite), `media` (aes-gcm; base64 to dev), `identity` (subtle; dev serde), `gateway-server` (base64), `gateway-client` (dev gateway-server, rand, tempfile), `protocol` (tokio and every dev-dependency), `people`/`photos`/`tally` (serde), and the workspace entries `fs4`, `rand_chacha`, `turmoil`, `subtle`, `agent-client-protocol`.
- **Stale prose**: `stage.rs` no longer cites the deleted native-host file; `serve.rs`, `xtask/src/{rules,gate}.rs` and `identity/src/ticket.rs` say the phone is the vault and the laptop runs `centraid-gateway`.
- **`invite` beside a running `serve`**: the ticket carried no address because `invite` cannot bind the endpoint `serve` holds, so a `local_only` laptop's code was undialable. `serve` writes its endpoint's relay and direct addresses to `dial-hints.json` on bind and on every change; `invite` puts them on the ticket, and says so when there are none (`serve::tests::a_bound_endpoint_publishes_its_direct_addresses_for_invite`).

**Landed after close, by slice T3** (the items marked above, and #1046's Agenda fixtures):
- **Kotlin warnings.** Every warning older than #1047 in `:core`, `:shared` and `:androidApp` is fixed in code, with no suppression: `!!` on receivers the compiler already knows are non-null in `HomeMachineSpec`, `ScreenFixtureSpec`, `DuplicatesSpec`, `AbiRoundTripSpec`, `PendingWriteSpec`, `ScreenMachineSpec` and `TasksSpec`; a `?.` on a non-null shelf in `PhotoShelfMachine`; `HomeBridge`'s private `encode()` extension, shadowed by Wire's member, deleted; a redundant `.toInt()` in `kit/Band.kt` and `PhotosCollectionsScreen`; an always-true `original != null` in `PhotoLightboxStage`; `GlobalScope` in `AbiContractSpec` replaced by its own `CoroutineScope`; an always-true `is` check in `NavigationAndMountSpec` replaced by an assertion on the reason; and kotlin-reflect put on `:shared`'s jvmTest classpath for the two specs that call `sealedSubclasses` and `KClass.members`. What is left: `RestoreRequest.kt:250`, which is generated by Wire, and three `!!` in `LockerTransferSpec`, a Locker slice's file that was in flight.
- **`EncryptedSharedPreferences` replaced** ([R-1047-T3](../docs/decisions.md#androids-device-only-store-without-encryptedsharedpreferences-1047)). `AndroidSecureStore` seals each value with AES-256-GCM, bound to its name, and stores it under an HMAC-SHA256 of the name. Both keys are Android Keystore keys of its own. `androidx.security:security-crypto` is gone from the catalog and the build. `SealedEntriesTest` (`:androidApp` unit tests, 6 cases) drives the sealing on the JVM with software keys.
- **Agenda's screen fixtures** (#1046's owed item): 14 fixtures in `contracts/screens/agenda{,-event,-editor}/`, 11 laws in `ScreenFixtureSpec` and the same 11 in the iOS `ScreenFixtureTests`, and `apps.agenda` in `PerAppLayoutSpec`. The manifest lists 77 fixtures.
- **words.enter on iOS.** `WordField` treated the machine's kept word as a stale echo, because the member had typed that word on the way to the space, so the cell kept showing the whole run. A cell now adopts the machine's value whenever its own text is a run whose first word, split as `WordsEntry.spread` splits it, is that value (`WordField.keptWord`, `WordFieldTests`). Paste stays disabled. This is proved by the unit test and not yet on a simulator.

Verification (T3, 2026-09-29, JDK 21): `:shared:jvmTest` **1028 tests, 0 failures**; `:core:jvmTest` **33, 0 failures**; `:androidApp:assembleDebug`, `:androidApp:lintDebug` (0 errors; 27 warnings, none in a touched file) and `:androidApp:testDebugUnitTest` (8, 0 failures), all with `-Pcentraid.android=true`; `:shared:assembleCentraidSharedDebugXCFramework -Pcentraid.iosSimulatorOnly=true`; `xcodebuild … test` on the iOS 26.4 iPhone 17 simulator **TEST SUCCEEDED, 75 tests, 0 failures**; `bun run format:check` clean.

**The doc pass's "owed, not started" list, re-checked at close.** Done in the tree:
- the band icon keys;
- the Docs stage and Add;
- Tally export;
- the enum-by-string seams (`clear_filter`);
- the legacy Tally list;
- the `CentraidCopy` shim;
- Photos' face review creating people through People;
- the sharing-era copy;
- R-1047-P2.

The final walk re-judges what is left: back labels, the kit's disabled button, the caret, and Notes' Unfiled count.

### Files

At close the tree holds 303 changed, 11 deleted (two of them staged) and 48 untracked paths against `0a20e33a6`. The root regenerates the full list against the commit, as the doc pass did. These are the new trees and files:

- **Contracts:** `contracts/migrations/007_locker_key_one_generation.sql`, `008_locker_no_match_policy.sql` and `009_no_notices.sql`, and `copy/words.json`.
- **Rust:**
  - `crates/api-proto/.../core/v1/locker.proto`
  - `crates/apps/locker/src/phone.rs`
  - `crates/apps/tally/src/export_file.rs`
  - `crates/core/src/app_query/{locker,locker_tests}.rs`
  - `crates/core/src/locker/phone.rs`
  - `crates/core/src/phone/phrase.rs`
  - `crates/vault/tests/locker_plaintext_gate.rs`
- **Mobile:**
  - `mobile/shared/.../apps/locker/`
  - `mobile/shared/.../custody/{DevSeed,Enrollment,PairLaptop,PhraseDoor,VaultWords,WordsEntry,WordsShow}.kt`
  - `WordsCopy.kt`, `HomeWords.kt`, `HomeTileWords.kt`, `KitWords.kt`, `DocsIngest{,Bridge}.kt`, `TallyExport.kt`
  - their specs
  - `mobile/iosApp/Sources/{Locker/,WordsViews.swift,PairLaptopView.swift,Docs/DocsIngestRoot.swift,Tally/TallyExportView.swift}`
  - `mobile/androidApp/.../screens/{locker/,words/}`, `kit/NoAutofill.kt`, `screens/docs/DocsIngestFiles.kt`, `res/xml/docs_scans.xml`
  - `mobile/core/.../PhraseRoundTripSpec.kt`
- **Docs:** `docs/traps/census-around-the-guard.md`

**Deleted:**
- `crates/vault/src/custody/{keystore,member_key,seal}.rs`
- `crates/core/src/locker/{fill,unlock}.rs`
- `crates/apps/locker/src/{origin,watchtower}.rs`
- `contracts/custody/recovery-kit.json`
- `contracts/origin-matching-v1.json`
- `docs/security/locker-origin-matching.md`
- `crates/vault/tests/member_key_gate.rs`, which was re-homed

## Final walk

The walk ran on 2026-09-29, on iOS sim 27BA36FC and Android AVD `centraid` (API 35), against a real `centraid-gateway serve`. Both shells were built fresh from the tree after X1 (the safety number, the Locker shield, the NEEDS_WORDS door) and X2 (rung 9). The evidence is the walk report in the orchestration scratchpad, with `walk-ios-*` and `walk-android-*` screenshots.

**The full loop passes on both shells.** A vault made on the phone opened Locker and saved a login with an RFC 6238 secret. Then: pair by paste → drain lands → uninstall (and `simctl keychain reset` on iOS) → restore from the 24 typed words plus the laptop's endpoint → "Your vaults are back". Every app's item came back. Locker is keyed: it unlocks (Face ID on iOS, PIN on Android), Reveal decrypts the password, and Show code matches a host-computed TOTP. This is E5's walk B, which failed before R3.

| Area | iOS | Android |
| --- | --- | --- |
| Make → words → confirm (a wrong word refused) | PASS | PASS; words and confirm are FLAG_SECURE (screencap black) |
| First moves: Task, Note, Agenda event, Docs text document, Tally expense, People contact | PASS | PASS after fix 1. Notes and Docs bodies lose letters under a slow round trip (B1, handed off) |
| Every app's home, from the demo vault | PASS, no breakage | Not re-run (the walk's own vault opened every app) |
| Locker | PASS: unlock, save a login with a TOTP, reveal, show code, copy, relock on background | PASS after fix 3: PIN unlock, the same steps, and SECURE while unlocked and cleared on relock (D-10) |
| `words.show` | PASS: the ask, then Face ID, then the words; a failed check says so; dismissed on background | PASS: PIN; 2 SECURE windows; dismissed on HOME |
| Pair | PASS: the safety number equals `serve`'s `safety` line and `invites`; a restarted `serve` reprints it (D-9) | PASS: the safety number is equal; Scan asks for CAMERA and opens the scanner (after fix 2) |
| Pair refusals: a spent code, a garbled code | PASS | PASS |
| Refused restore (gateway stopped): the unreachable sentence | PASS | Blocked: the emulator degraded under host load |
| Docs Scan permission | — | PASS after fix 2: the dialog, and the denied sentence |

**Fixed in the walk (builds re-run and re-walked):**
1. Android's Tasks quick add followed every machine echo, so late echoes moved letters. It now adopts only values it did not send (`TasksViews.kt`).
2. Android crashed on its first runtime-permission ask (Docs Scan, pairing's Scan) with "Can only use lower 16 bits for requestCode". Biometric 1.1.0 pulled fragment 1.2.5, and `androidx.fragment` is now pinned to 1.8.9.
3. Android crashed while typing in the Locker editor (`TooManyRequestsException`). `platformServices()` built a new `AndroidNetworkStatus` per call, and each registered a network callback. It is now one instance per process (`PlatformServices.android.kt`).
4. The Home footer said "1 things" on both shells.

**Handed to the root:**
- B1: the kit's `rememberEditorText` reloads on the autosave baseline and eats keystrokes typed during a save (Notes, Docs).
- "1 people" comes from shared copy.
- The wall's "copies are cleared" on leaving is true only at expiry, on both shells.
- The unreachable-restore sentence says "Open Centraid on it".
- Android's capture state outlives the relock until the next foreground.
- iOS `platformServices()` also builds per call.

**Not walked:**
- `RESTORE_HELD`, which cannot be staged.
- The pair NEEDS_WORDS door (D-11) on either shell.
- Android's unreachable restore.

The remaining Android steps were blocked when host load of 130–226 (concurrent cargo tests and a second simulator) ANR'd system_server twice. That was after two cold boots. The app's main thread was idle each time.

### The re-walk (RW), after F4

Ran 2026-09-29 on the tree after F4, one device at a time: the Rust sim slice, a sim-only XCFramework (link forced), protoc and xcodegen, `xcodebuild` (BUILD SUCCEEDED), then `android-core.sh` and `assembleDebug`, Gradle stopped before the emulator booted. The demo vaults (`demo-vault.sh`) carried the Locker and plural checks; a keychain reset (iOS) or the vaults pushed without the seed (Android) staged an unkeyed vault for the NEEDS_WORDS door. Screens are `rw-ios-*` and `rw-android-*` in the orchestration scratchpad. **Nothing needed fixing.**

| Check | iOS | Android |
| --- | --- | --- |
| Typing across a save (B1) | PASS, exact: note body, person name, Tasks quick add, and the Docs labels and Locker memo sheets (type, erase to empty, type again) | PASS, exact at full `adb input` speed across saves: note body, person name, Docs text body, Tasks quick add, Agenda and Locker search; closing Agenda's search clears the term. On a degraded emulator (below) every field, quick add included, dropped letters alike, so those runs judge the input path, not B1 |
| Plurals | "1 person · 0 to reconnect · 0 starred", Touch "1 person · 0 overdue" | The same, and the Home tile "Open People, 1 person" |
| Locker's clipboard ([R-1047-F4-1](../docs/decisions.md#lockers-clipboard-and-its-row-chip-1047-f4)) | Lock clears Locker's copy; a later copy from elsewhere survives Lock; after HOME the copy stays until its 30 s, then is gone | The same three, read back by pasting into Tasks' quick add |
| "on this phone" on a never-paired vault; no "Saved" on an empty new note or person, "Saved" after the first save | PASS | PASS |
| Locker rows: "Secure note", "Card" (not doubled); the wall's Leaving fact | PASS | PASS |
| Android Locker wall band with Home; a relocked pushed item offers "‹ Locker" | — (already so) | PASS |
| Android capture hold ([D-10](../docs/decisions.md#the-owners-rulings-of-2026-09-29-1047)) | — | SECURE while open (screencap black), with the More sheet 2 windows; Lock drops it at once (screencap drawn); back from HOME the first frame is not black. While the app is stopped `dumpsys` still lists the flag — a stopped window does not relayout — which only blacks the recents thumbnail |
| TalkBack: Tally add-expense and Locker editor back | — | "Cancel" on both |
| Unreachable restore, gateway stopped | "…Check that centraid-gateway is running on it, or type the address it printed." | The same sentence, after about 10 s |
| Pair NEEDS_WORDS door (D-11) | "Your words come first" + **Enter your 24 words** → words.enter's re-key, no blank sheet between; the all-`abandon` words then answer NoneToKey with "Restore from my laptop" | The same door and swap (the re-key sheet screencaps black: FLAG_SECURE) |

**Seen, not changed (for the owner):**
- Android's Notes title field takes the derived title after the first save (a CLEAN reload of what the vault stored), so a later edit to the body's first line no longer renames the note. iOS seeds its fields on appear and shows it only on reopen. The machine's comment says the draft keeps its empty title; the reload is what brings the derived one back.
- The re-key sheet reached from pairing still explains itself in Locker's words ("Locker's secrets open with a key from your 24 words").
- The emulator: the debug build ANRs on cold start (the routes' lazy init on the main thread, interpreted) and, on a 2 GB AVD under host load, repeatedly on sheet transitions until system_server itself stopped answering. A cold boot with `-memory 4096` cleared it; the app's main thread was idle in its looper each time it was sampled.
- `RESTORE_HELD` is still not stageable.

**Emulator restored:** animations 1/1/1, stay-on 0, the device PIN cleared and lock-screen-disabled back to `true`, CAMERA not granted, no `androidApp/src/main/assets`, emulator stopped. The simulator was shut down before the emulator booted.

## Audit

**Verdict: PASS**, with one medium finding (M1) that needs a fix or an owner ruling before release, and the low findings below. Every sampled claim holds as written. M1 is a defect beside a claim, not a refutation of one.

The independent auditor ran this on 2026-09-29 against the uncommitted close tree. The auditor did not write this work and changed no product code. The in-flight F5 files (the Notes editor state, WordsCopy and words.enter, the iOS Home band) were not judged.

**Commands the auditor re-ran:**

| Check | Outcome |
| --- | --- |
| `cargo test --workspace --no-fail-fast` | 1,753 passed, **1 failed** (`vault/tests/disk_full.rs:160`, macOS `/dev/full`, as recorded), 7 ignored |
| `cargo test -p centraid-vault --test locker_plaintext_gate --test locker_commands --test collection_kind` | 3, 20 and 8 passed |
| `cargo test -p centraid-vault` | `running_census` 5, `ladder_ddl` 3 and `baseline` 6 passed |
| `cargo test -p centraid-identity` | pass, `identity_vectors` (`lockerKeyHex`) included |
| `cargo test -p centraid-core --lib` | 145 passed, every `app_query::locker_tests` case included |
| `cargo test -p centraid --test drain_wire` | 7/7, including `a_refused_restore_leaves_the_lease_where_it_was` and `a_vault_that_used_locker_restores_from_its_words_and_its_secret_reveals` |
| `:shared:jvmTest` (JDK 21) | **993 tests, 0 failures, 0 errors** |
| `cargo xtask rules` | ok: all four rules |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all --check` | exit 0 |
| `bun run format:check` | exit 0, 528 files |

**Claims sampled (22), each checked against the code:**

1. **Every SECURITY.md ENFORCED-BY-TEST row #1047 added names a test that exists.** Each of the 20 names was found by grep in the file its row cites. Every Rust one runs green above, and the Kotlin specs are in the 993. **Holds.**
2. **The laptop cannot produce Locker plaintext.** `locker_plaintext_gate.rs` plants five secrets and searches the paged door, seven command answers, the snapshot (compressed and inflated), the sealed **and opened** base ranges, and `vault.db` with its WAL and SHM. It asserts `lk1:` was served, so the search is not vacuous, and it has a falsification that fires with the key. **Holds.**
3. **`K` comes from the seed.** It is derived as `seed / vault'(i) / locker'` with `LOCKER_INDEX = 3` (`crates/identity/src/derive.rs:84`, `:318`), and `lockerKeyHex` is pinned for indices 0, 1 and 4. **Holds.**
4. **A restore round trip reopens sealed secrets.** `a_restore_from_the_same_words_reopens_sealed_secrets` copies only `vault.db` and its WAL to a fresh directory. It reopens under the same words, and another person's words get `DID_NOT_OPEN`. `drain_wire` proves the same end to end through a real gateway. **Holds.**
5. **A reveal is receipted before it decrypts.** `reveal()` refuses `otp_seed` first, then locked, not sealed and empty, then runs `locker.reveal_receipt` with `?`, and only then calls `decrypt_under_locker_key` (`crates/core/src/locker/phone.rs:232–265`). `totp()` keeps the same order (`:330–339`). **Holds.**
6. **Lease ordering.** `one_vault` probes `head`, runs `lay_down` (integrity and census, `discard` on any refusal), and only then calls `claim_lease` at `epoch + 1` (`crates/core/src/phone/restore.rs:264–308`). The docs agree: `docs/gateway.md:18` and `docs/recovery/backup-restore.md:35`. **Holds.** See M1 and L1.
7. **The census fix.** `Vault::locker_generation` inserts inside `self.commit` and re-reads under the lock (`crates/vault/src/custody/locker_key.rs:324`). **Holds.**
8. **The `OR REPLACE` rule.** A grep for `OR REPLACE` and `REPLACE INTO` over `crates/`, `contracts/schema` and `contracts/migrations` finds only comments and the test that pins SQLite's behaviour. The source scan `no_vault_writer_resolves_a_conflict_by_replace` passes. **Holds.**
9. **Writes around the guard.** A grep for raw `connection().execute` in `crates/vault/src` outside a `tx` found only migrations, `PRAGMA`s and test code. **Holds.**
10. **Rungs 7–9.** Each is on `LADDER` (`migrations.rs:111`, `:119`, `:127`). `ladder_ddl` re-renders the DDL and diffs it. `vault-ddl.sql` has `locker_key_one_generation`, and no `notifications_notice`, match policy or `retired_at`. It holds 185 `CREATE TABLE` and 17 virtual tables, which matches `docs/vault-ontology.md:36`. **Holds.**
11. **`notifications_notice` has no reader or writer.** A grep outside the baseline, rung 9, the v0 corpora and the ladder tests finds none. **Holds.**
12. **The words are never logged, and are kept only where claimed.** A grep for `println`, `Log.`, `NSLog`, `print(` and `tracing` in `custody/`, the words and Locker views, `phone/phrase.rs` and `locker/phone.rs` finds none. `rememberWords` writes `LOCAL_WORDS` to `secureStore`, which is `…ThisDeviceOnly` on iOS; on Android every domain is excluded from both backup transports. The `toString`s are redacted and asserted in `VaultWordsSpec:173`, `WordsEntrySpec:246`, `WordsShowSpec:69` and `KeyedOpenSpec:347`. **Holds.**
13. **iOS `words.show` fails closed.** It sends `verifyFailed` on any failed `evaluatePolicy`, including a phone with no passcode (`WordsViews.swift:435`). **Holds.**
14. **`online_only` is gone.** Its only survivors are the reserved `44` and its reserved name (`error.proto:110–111`) and a history comment in `CameraRoll.kt`. **Holds.**
15. **Proto reservations.** `LockerLockState` reserves 9 and `lock_label`, and has `secure = 12` and `clipboard_clear = 13`. `PairLaptopState` reserves 7 and `fingerprint`, and has `safety_number = 14` and `words_label = 15`. `PairLaptopEvent.WordsTapped` is 8. **Holds.**
16. **Removed dependencies.** `argon2`, `psl` and `scrypt` are absent from `Cargo.toml` and `Cargo.lock`. `aes-gcm`, `argon2`, `base64` and `rand` are absent from `crates/core`, and `scrypt` and `anyhow` from `crates/vault`. **Holds.**
17. **Band tabs and sharing copy.** `BandPolicy.PLACES` has no Needs you or Activity entry, and no `SHARE_FAILED` or `SHARE_IS_A_COPY` is left anywhere. **Holds.**
18. **Copy headers.** Each of the ten `copy/*.json` files carries one `$comment`. `KitTimeMoneyCopySpec` checks exactly ten `*Copy.kt` twins. **Holds.**
19. **`-Pcentraid.iosSimulatorOnly`** is at `mobile/shared/build.gradle.kts:77`. **Holds.**
20. **Docs' destroyer.** `core.purge_document` and `core.empty_document_trash` are wired from `DocsTrash.kt`. **Holds.**
21. **The notes body may be empty.** `NotesEditorMachine` refuses only a new note with no title and no first line (`:390`). `knowledge.*_note`'s `body_text` is `minLength: 0`. **Holds.**
22. **Owed-list closures.** No `CentraidCopy`, legacy Tally list files or Photos `core.add_party` writer is left. **Holds.**

**Mechanical sweeps (CLAUDE.md):**
- **CHECK values against their writers, on the Locker tables.** The phone writes all 15 `locker_item.type` values. `locker_item_field.kind` matches the `set_field` enum. `locker_item.compromised` has no writer on the phone (L3).
- **FK delete rules.** `address`, `alias`, `field` and `passkey` → `locker_item` are all `ON DELETE CASCADE`, and `item`, `address` and `field` → `core_entity` are `CASCADE`. They are consistent. `locker_key` has no referrer, as rung seven says.
- **Deleted paths cited as current state.** One was found (L2). Every other hit is in a receipt, a CHANGELOG entry, or a superseded row in `docs/decisions.md`.

**Findings, by severity:**

- **M1 (medium) — a multi-vault restore can orphan a vault it already claimed.** `restore::run` walks the indices and propagates any `one_vault` error with `?` (`crates/core/src/phone/restore.rs:156`).
  - Take a member with vaults at indices 0 and 1, where index 1's generation fails its checks. The restore lays down index 0, checks it and **claims its lease**, and then returns an error.
  - The `RestoreResponse` and the freshly minted `device_secret` are dropped. The old phone is frozen `VAULT_MOVED` on vault 0, and the new phone has an unadopted `vault.db` it cannot drain.
  - A retry repeats this for as long as index 1 is bad.
  - SECURITY.md's R3 row is literally true, because vault 0 passed. What it is meant to guarantee — a failed restore leaves the member where they were — does not hold. No test covers more than one index.
  - Options: (a) verify every index before claiming any; (b) answer the vaults that succeeded, plus a per-index refusal; (c) record it as a documented non-claim. **Recommend (a).**
- **L1 (low) — a race in the claim can move the lease with nothing restored.** If the head moved between the probe and the claim, the phone already holds the lease when it lays down the new head (`restore.rs:314–322`). If that head fails its checks, the lease has moved, the file is discarded and the old phone is frozen. The R-1047-R2 prose describes the happy path of this branch only.
- **L2 (low, state doc).** `docs/vault-ontology.md:32` still names `contracts/custody/recovery-kit.json` as a current format fixture. It was deleted (staged) in D2, and the same doc's `:90` says so.
- **L3 (low, sweep).** `locker_item.compromised` has no writer on the phone: there is no import and no toggle. Only `seed-demo-vault` and the tests set it. Review's "compromised" section and `locker.proto:221` ("flagged … by hand or by an import") describe writers that do not exist. This is a question for the owner: drop the column and the section, or add the toggle.
- **L4 (low, stale state).** The Open section of `QUALITY.md:6` still says `tally.set_expense_memo` writes `kind`/`body` and fails. Core follow-up B fixed it: `crates/vault/src/commands/tally.rs:2710` writes `body_text`.
- **L5 (low, weak evidence).** SECURITY.md's "no `K` written to disk" rests on `!dir.join("keys").exists()` (`locker_tests.rs:478`, `:497`). That checks one path name, not the directory's bytes for the derived key.
- **L6 (low).** `open_key` copies `K` into a plain `Vec<u8>` on every reveal, code and seal (`crates/core/src/locker/phone.rs:205–210`), and the copy is never zeroed. "A relock zeroes the session's copy" is true only of the session. The keyring holds `K` anyway, which the doc states, so this adds no exposure.
- **L7 (low, test gap).** `a_refused_restore_leaves_the_lease_where_it_was` does not assert that no file is left under `new/`, which R-1047-R2 claims.
- **L8 (low, stale receipt line).** "Not run: the receipt front page … needs `@eslint/json`, which is not installed": it is installed, and the front page ran (below).
- **Info.** The headers of rungs 7 and 8 still say "`LADDER` … ends here". They are frozen by the ladder's own rule.
- **Info.** The v0 descriptions in `crates/apps/locker/manifest.json` (Watchtower, "in the browser") are already in Owed.

**Governance front page** (`node .governance/law/run.mjs`, which reads the committed tree): 12 errors and 1 warning.
- **Clears on commit of this tree:** `receipt-per-issue` "fence alone" and "no verdict" for this receipt and #1046's. They are measured at `HEAD`, where neither the fence nor this section exists.
- **The planned commit-body waiver:** `doc-integrity` on the `## Resolved` line in `QUALITY.md`. The close records the waiver text.
- **Need action before the PR's aggregate is green:**
  - `commit-message-format` on `0a20e33a6`: its subject ends `(#1046, #1047)`, not `(#N)`. It needs a single-issue squash subject or a waiver.
  - `estate-separation` on `d049f19bd` (#1029 Photos, `scripts/ci/gate-classes.json` beside the territory).
  - `receipt-per-issue` on `receipts/issue-1025-sync-model.md` and `receipts/issue-1029-phone-is-the-vault.md` (missing sections). These are not this umbrella's, but they ride in the same branch range.

**Still owed** (the receipt already names them): the gate profiles, the first unticked checklist box (Android app homes on a quiet emulator), `RESTORE_HELD`, the re-key success path, and a device check of the iOS capture shield.
