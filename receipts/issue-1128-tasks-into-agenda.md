# Receipt — Tasks folds into Agenda ([#1128](https://github.com/srikanth235/centraid/issues/1128))

<!-- governance:front-page start -->
**Law** · window door · range `f90f473c..6c7478fd` · law digest `2549cef4cd1f` → `2549cef4cd1f`

| Rule | Door | Verdict | Findings |
| --- | --- | --- | --- |
| `amendment-pairing` | hook | ✓ pass | 0 |
| `commit-message-format` | hook | ✓ pass | 0 |
| `constitution-coverage` | window | ✓ pass | 0 |
| `doc-integrity` | hook | ✓ pass | 0 |
| `doctrine-citation` | window | ✓ pass | 0 |
| `estate-separation` | hook | ✓ pass | 0 |
| `managed-tree-integrity` | hook | ✓ pass | 0 |
| `receipt-per-issue` | window | ✗ fail | 1 |
| `registry-completeness` | window | ✓ pass | 0 |
| `waiver-docket` | hook | ✓ pass | 0 |

### Findings

- `.governance/law/out/arrival.json:7026` **law/receipt-per-issue** (error) — receipts/issue-1130-tasks-today.md — missing a '## Audit' section. Mechanical checks record that outcome and verification text exist; they do not prove the receipt matches the diff or that a command ran.

law estate: 11 paths, CODEOWNERS in sync

### Registries

- rulings recorded: #882, #1097, #1128, #1130 in `docs/decisions.md`
- changelog entries: #1128, #1130
- no gates moved
- no waivers used
- proposal link unverified (offline)
- token cost: not recorded
<!-- governance:front-page end -->

Umbrella receipt for [#1128](https://github.com/srikanth235/centraid/issues/1128): one receipt, lanes under it, no child issues. The state this umbrella produces lives in [docs/decisions.md](../docs/decisions.md#tasks-folds-into-agenda-1128), [ARCHITECTURE.md](../ARCHITECTURE.md) and [mobile/README.md](../mobile/README.md); this file is the evidence. Worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)): a root agent planned (R-1128-1 to 9), six lanes built on sibling worktrees (D rust; S shell; A agenda core; E the add sheet; B iOS; C Android) and a close pass (Z) did the last fix, the rulings, this receipt, the doc pass and the gates. Base of the umbrella is `1c7624683` (#1130); the law's window range also covers that commit, so its two findings are inherited (see Verification).

## What changed

**Outcome.** Agenda is the one app for a member's days. The Tasks tile leaves Home, and `tasks` is a vault domain the member opens in Agenda, not an app. Agenda's band is Day · Schedule · Waiting · To-do · More. A dated task is a row in its day beside the events and checks off in place; today draws an Overdue group with Reschedule and the absence notice; To-do holds the Inbox, then the projects by area, with the add field Tasks had; More gains Anytime, Logbook, Reminders and Trash under a Tasks heading. The Plus on Day, Schedule and Waiting opens one add sheet with an Event | Task switch that opens on the kind last added (kept on the device); on To-do it opens the quick-add bar. Agenda's tile says the next event and how many tasks are due. Every former way into Tasks (a chat card, search, People, Send to Agenda, Home, the reminders import) opens the same task in Agenda. No `schedule.*` command, table, rung or core app query changed.

### Done when, reconciled against the issue

| Box | State | Evidence |
| --- | --- | --- |
| The Home grid has no Tasks tile, and Agenda's tile shows events and due tasks | Done | Lane S (`5a7e85cea`): `tasks` leaves `packages/design/src/apps.ts` and the springboard; `TileBody.Agenda` gains `due_count`, `due_label`, `due_title`; `HomeMachineSpec`, `HomeReadsSpec`, `ScreenQueryRuntimeSpec` (a denied tasks read keeps the tile). Fixtures `contracts/screens/home/*` rebuilt. |
| Day and Schedule draw events and dated tasks together, and a task checks off in place, on iOS and Android | Done in the shared machine and both views; iOS built, Android not compiled, neither walked in the receipt | `AgendaDatedTasksSpec`, `AgendaHomeSpec`; iOS `BUILD SUCCEEDED` (lane B); Android has no SDK here, so lane C's throwaway typecheck stands in. The simulator walk is the row `pending (root)` below. |
| To-do holds the Inbox and projects, and adding from it lands there | Done | `AgendaTodoSpec` (landing, Inbox first, projects by area, add lands in Inbox, the Plus opens the bar). |
| Every former entry into Tasks (Chat cards, search, People, Notes, Home, deep links) opens the same task in Agenda | Done | `AppRoutingSpec`, `ScreenOpeningsSpec`, `HomeSearchSpec` (a task hit groups under Agenda, row keeps `app_id` `tasks`, routes to `TasksDetail`), `AppHomesSpec`, `PhoneImportSpec`; `AppScreens.screenPrefixes` resolves `tasks.*` to Agenda on iOS (R-1128-B2). |
| No `schedule.*` command, table or spec changes; JVM specs move with their machines; Maestro flows cover Day, To-do and a task opened from search | Done; the flows passed on iOS, not run on Android | No file under `crates/vault`, `crates/apps` or `contracts/migrations` is in the diff (list below). `TasksSpec`'s 22 home cases were re-hosted on To-do, not deleted. `agenda-day.yaml`, `agenda-todo.yaml`, `agenda-task-from-search.yaml` passed `maestro check-syntax` and then ran; the root ran all three on a simulator after the band-id fix (Verification). |
| Rulings recorded in decisions.md with supersession pointers, and one receipt | Done | [`docs/decisions.md#tasks-folds-into-agenda-1128`](../docs/decisions.md#tasks-folds-into-agenda-1128): the owner's four answers, R-1128-1 to 9 and eighteen lane rulings, eight supersession rows and six owner questions. This is the one receipt. |

### Lanes and commits

| Lane | What it built | Commits |
| --- | --- | --- |
| D | `App::opens_in`: a task read says "Looking in Agenda"; the card app stays `tasks` | `d79d64000` |
| S | `AppHomes` (domain to the app it opens in), the catalogue without Tasks, Home's tile due line, chat scope menu, first launch, import opener | `3d1145dcd`, `5a7e85cea`, `2046faa0c` |
| A | The home contract (proto, copy), To-do, dated tasks as rows, routing; `tasks.home` and its machine deleted; `TasksRows`/`TaskOps` moved to `kit/tasks/` | `64b25c92a`, `c2da83e93`, `6aa1b5f98`, `8c80bb375` |
| E | The add sheet's Event \| Task switch, the device's kind memory | `37085ebe2`, `e10c85e90` |
| C | Android draws the five places and the task pages | `86ce4489f`, `2b0ec8426` |
| B | iOS draws the five places; three Maestro flows | `8490e6a36`, `04611ff5d` |
| Z | The Plus on Day says "Add"; the app band keeps its tab ids (iOS); the tile's count; Day's empty sentence; rulings; this receipt; the doc pass | `cb74d2fa1`, `b9026afa6`, `4a932eda1`, `47bbb9743`, `5795136c9`, `d3c3f2603`, `8af0aa29d`, `3e0ffbc48`, `a15344bdc` and this receipt's commit |

### Files changed (`git diff --name-status 1c7624683..HEAD`, at the commit before this receipt)

The twelve `.bin` fixtures beside `contracts/screens/agenda/*.textproto` (7) and `contracts/screens/home/*.textproto` (5) are rebuilt by `bun contracts/tools/build-screen-fixtures.ts` and omitted below.

```text
M  ARCHITECTURE.md
M  CHANGELOG.md
M  DESIGN.md
M  README.md
M  contracts/screens/agenda/day-one.textproto
M  contracts/screens/agenda/denied.textproto
M  contracts/screens/agenda/loading-first.textproto
M  contracts/screens/agenda/nothing-on-this-day.textproto
M  contracts/screens/agenda/read-refused.textproto
M  contracts/screens/agenda/search-no-match.textproto
M  contracts/screens/agenda/today-with-now-line.textproto
M  contracts/screens/home/content.textproto
M  contracts/screens/home/every-tile-unreadable.textproto
M  contracts/screens/home/first-run.textproto
M  contracts/screens/home/loading-first.textproto
M  contracts/screens/home/status-urgent.textproto
M  copy/agenda.json
M  copy/notes.json
M  copy/tasks.json
M  crates/api-proto/build.rs
M  crates/api-proto/proto/centraid/screen/v1/screen.proto
M  crates/assist/src/app.rs
M  crates/assist/src/native_turn/mod.rs
M  crates/core/tests/assist_native.rs
M  design/native-catalog.json
M  docs/decisions.md
M  docs/glossary.md
M  mobile/README.md
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/AppMark.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/Rooms.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/AgendaHomeScreen.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaEditorScreen.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaRoutes.kt
A  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/agenda/AgendaTodoPlace.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksDetailScreen.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksRoutes.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksScreens.kt
M  mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/tasks/TasksViews.kt
M  mobile/iosApp/Design/Catalog.swift
M  mobile/iosApp/Resources/Info.plist
M  mobile/iosApp/Sources/Agenda/AgendaEditorView.swift
M  mobile/iosApp/Sources/Agenda/AgendaScreens.swift
M  mobile/iosApp/Sources/AgendaHomeView.swift
M  mobile/iosApp/Sources/AppMark.swift
M  mobile/iosApp/Sources/Band.swift
M  mobile/iosApp/Sources/Chat/ChatPreview.swift
M  mobile/iosApp/Sources/Chat/ChatRouting.swift
M  mobile/iosApp/Sources/Chat/ChatView.swift
M  mobile/iosApp/Sources/FirstLaunchView.swift
M  mobile/iosApp/Sources/HomeView.swift
M  mobile/iosApp/Sources/Kit/ScreenRegistry.swift
M  mobile/iosApp/Sources/ShellModel.swift
M  mobile/iosApp/Sources/StateViews.swift
R  mobile/iosApp/Sources/Tasks/TasksScreens.swift -> mobile/iosApp/Sources/Tasks/TaskPages.swift
D  mobile/iosApp/Sources/Tasks/TasksHomeView.swift
M  mobile/iosApp/Sources/Tasks/TasksRowViews.swift
M  mobile/iosApp/project.yml
M  mobile/maestro/README.md
A  mobile/maestro/flows/agenda-day.yaml
A  mobile/maestro/flows/agenda-task-from-search.yaml
A  mobile/maestro/flows/agenda-todo.yaml
M  mobile/maestro/flows/home-search.yaml
M  mobile/maestro/flows/onboarding.yaml
M  mobile/maestro/flows/search-ask-apps.yaml
M  mobile/maestro/flows/search-containers.yaml
M  mobile/maestro/flows/search-correction.yaml
M  mobile/maestro/flows/selectors.md
M  mobile/shared/src/commonMain/kotlin/dev/centraid/design/Catalog.kt
A  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaAddKind.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaBridge.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEditorMachine.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaEditorReads.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaFold.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaHomeMachine.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaReads.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaRouting.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaScreenBridges.kt
A  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaTodo.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/agenda/AgendaWrites.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/notes/NotesRouting.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksBridge.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksCatchUpPage.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksDetail.kt
D  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksHome.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksList.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksProjectPage.kt
D  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksRouting.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/chat/ChatMachine.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/PhoneImport.kt
R  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksOps.kt -> mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/tasks/TasksOps.kt
R  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/tasks/TasksRows.kt -> mobile/shared/src/commonMain/kotlin/dev/centraid/shared/kit/tasks/TasksRows.kt
A  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/AppHomes.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/Navigation.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/RowRoutes.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/ScreenIds.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/ScreenOpening.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeAgendaTile.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeReads.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeRuntime.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSearch.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSession.kt
M  mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/SpringboardPolicy.kt
A  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaDatedTasksSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaEditorSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaEventSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaHomeSpec.kt
A  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AgendaTodoSpec.kt
A  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AppHomesSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AppReadsSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/AppRoutingSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ChatFlowSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ChatMachineSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ChatScopeSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeMachineSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeReadsSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HomeSearchSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/PhoneImportSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenFixtureSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenOpeningsSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ScreenQueryRuntimeSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ShellCommandsExistSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/ShellRoutingStatedOnceSpec.kt
M  mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/TasksSpec.kt
M  packages/design/src/apps.ts
```

## Verification

All gate runs are on this branch's head, from a cold `CARGO_TARGET_DIR` of their own (`~/.cache/centraid-target/1128-lane-z`), with `JAVA_HOME` at Homebrew's openjdk@21, each behind the shared heavy-build lock. The machine was loaded by other sessions throughout (load average 14 at the gate's start, 160 to 340 at times during it).

```sh
cargo xtask gate --profile mobile-jvm
```

Outcome: **every step passed; the verdict is a budget-only FAIL.** The profile's one step ran 1194.7 s against the 420 s budget on a cold tree under load, and its clean-tree check (`git diff --exit-code -- design copy mobile contracts/screens`) passed, so the gate regenerated nothing that was not committed. `:shared:jvmTest` and `:core:jvmTest` together ran 1450 tests, 0 failures, 0 errors, 0 skipped (from the XML results). The budget is not touched; the FAIL is the profile's measured cost on a loaded machine, not a failing check. #1130 recorded 217 s for this profile on a quiet one.

```sh
cd mobile && ./gradlew --no-daemon :shared:jvmTest --tests 'dev.centraid.shared.AgendaHomeSpec' --tests 'dev.centraid.shared.AgendaTodoSpec'
```

Outcome: pass (24 and 16 tests) for the Plus-label fix, 10 min 37 s at load 164 to 275.

```sh
cargo test -p centraid-api-proto && cargo test -p centraid-assist
```

Outcome: pass, 9 tests in api-proto and 185 in assist, 0 failed.

```sh
node .governance/law/run.mjs
```

Outcome: see the front page above. The window door's two findings that remain are #1130's, not this change's (Inherited red).

| Check | Result |
| --- | --- |
| The two timeouts lane E's merge saw (`AgendaHomeSpec` "the runtime serves the screen through AgendaReads, end to end" at 5.58 s against a 5 s limit; `ShellCommandsExistSpec` "the scan reaches every kind of place a command is written" at 873 s against 600 s) | Both **load**, not bugs: green in the gate run, the first in under a second, the second in 136 s |
| `AgendaHomeSpec`, `AgendaTodoSpec`, `AgendaDatedTasksSpec`, `HomeReadsSpec` | pass (24, 16, 12 and 28 tests) |
| iOS simulator (root) | Umbrella build `8af0aa29d` (`xcodebuild -sdk iphonesimulator`, arm64, debug core-ffi without llama): `BUILD SUCCEEDED`. On a dedicated simulator (iPhone 17 Pro, iOS 26.5, fresh keychain) under Maestro 2.6: `onboarding.yaml` PASS; `agenda-day.yaml` PASS (five band places, a dated task checked off in place with "Task done" and Undo, Schedule); `agenda-todo.yaml` PASS (To-do list, the Plus opens the quick-add bar, a task added to the Inbox and opened); `agenda-task-from-search.yaml` PASS (Home search to the Agenda group to the starter's detail). Before `b9026afa6` the day and to-do flows failed only on the band ids. By hand: no Tasks tile on Home, Agenda's tile read "1 due" with the first title, the add sheet's Event \| Task switch makes a task due on the opened day (a round box on Day), To-do shows the Inbox's two starters and "New project". The tile's new count and the empty-sentence fix were built into that binary and checked by specs only, not by eye |
| Android | **Not compiled, not run.** No SDK on these machines. Lane C's throwaway typecheck (zero errors in the touched files) and the close pass's two small view edits (`AgendaHomeScreen.kt`) are unverified beyond reading |
| Maestro on Android | Not run; blocked on `testTagsAsResourceId` (Q-1128-2) |
| `maestro check-syntax` on the three Agenda flows | OK (lane B) |

### Inherited red

Measured by running the same law over the base: `node .governance/law/run.mjs --range f90f473c..1c7624683` (the base, #1130's commit) reports two errors, both on `receipts/issue-1130-tasks-today.md`: no `## Audit` section, and `docs/decisions.md` carrying no line citing #1130. This change fixes the second (R-CHROME-1's marker now links #1130). **The first remains**: that receipt belongs to #1130 and its `## Audit` is an independent reviewer's to write; adding a verdict here would be this change grading another's work. No other red was inherited: lane E's two timeouts were load (above).

### Law, final

The front page above is the law's answer on the committed tree after this receipt landed: nine rules pass, and `receipt-per-issue` fails on `receipts/issue-1130-tasks-today.md` alone (the inherited finding). The earlier `doctrine-citation` warning for `packages/design/src/apps.ts` cleared once this receipt cited its domain.

## Decisions

The rulings are in [`docs/decisions.md#tasks-folds-into-agenda-1128`](../docs/decisions.md#tasks-folds-into-agenda-1128), each with its why; this receipt does not copy them. The owner's four answers are R-1128-Q1 to Q4; the root's are R-1128-1 to 9; the lanes' are R-1128-A1 to A8, D1, E2 to E5, S1, S5, S6, B1, B2, C1 and the close pass's Z1. Supersession markers were appended to R-CHROME-1, R-1046-3, R-ONBOARD-4, R-ONBOARD-5, R-ONBOARD-11, R-1097-19, R-1099-57 and the "Tasks' band while typing" row. The design-token domain (`packages/design/src/apps.ts`, the catalogue losing `tasks`) is settled by [`docs/decisions.md#typography-and-design-contracts`](../docs/decisions.md#typography-and-design-contracts); the change follows it (a catalogue entry is data the generators read, no token changed).

**Lane rulings kept in the lane receipts, not in decisions.md** (they bind one file and are written in its comments): A5 (More's Tasks places landed with the band), A9 (the To-do band icon `Todo`), A10 (denied and loading words), A11 (`AgendaBridge` constructors), A12 (search task hits are one group above the event days), E1 (kind memory key `agenda_add_kind`, no dot), E6, E8 (`apps.agenda` may not import `apps.tasks`), S2 to S4 (the tile's due line, now R-1128-8), B3 to B8 (selector ids and flow wording), C2 to C8 (Android landing, ids, the empty-To-do verb).

## Corrections to the plan

- **The Agenda/Tasks layering.** The plan had Agenda read Tasks' rows and ops from `apps.tasks`. `PerAppLayoutSpec` forbids one app naming another, so the shared code moved to `kit/tasks/` (R-1128-A1) and the spec stayed as it was.
- **The header Plus.** The plan gave every place of Agenda the Plus that adds an event. It differs per place (R-1128-A2), and after lane E's sheet the generic label is "Add" (R-1128-Z1, this pass).
- **Agenda's search and containers.** Lane S's `search-containers.yaml` assumed Agenda's search would find a project container. `AgendaHomeState` carries none; lane B dropped that half of the flow (R-1128-B7). Owner question Q-1128-1.
- **"Back reads Agenda" from a task opened in search.** On iOS a task's detail is an editor room (title field and Done), so "Agenda" is the back label of the list and project pages, not of the detail (R-1128-B3).
- **The pop-back reset.** Lane B found Home's route re-sent `Opened{day}` on every appearance and reset a member who had popped back from a task; fixed for every push (R-1128-B1).
- **A core read nobody consumes.** `agenda.upcoming`'s due-days leg outlived the shelf it fed (Q-1128-6); the fence kept this change out of the core.

## Owner hand-offs

1. **Run the flows on Android and on a device.** The three Agenda flows and `onboarding.yaml` passed on the iOS simulator (root); the other edited Home and search flows (`home-search`, `search-ask-apps`, `search-containers`, `search-correction`) were syntax-checked, not run.
2. **Compile Android.** `androidApp` is not built by the project's gate (no SDK on these machines). Lane C's evidence is a throwaway typecheck against the Compose classes, with zero errors in the touched files. A device walk of the arrival logic in `AgendaRoutes` (R-1128-C1) is owed.
3. **Q-1128-2**, Android `testTagsAsResourceId`: until it is set, Maestro `id:` selectors cannot see Compose tags on Android.
4. **Q-1128-1 to Q-1128-6** in `docs/decisions.md#tasks-folds-into-agenda-1128`.
5. **The combined PR.** This branch is one of four lines that land together (with #1127, #1129 and #1130) and a Notes Home tile change; the parent resolves the conflicts in `docs/decisions.md`, `CHANGELOG.md`, `HomeView.swift`, `HomeScreen.kt`, `SpringboardPolicy.kt` and `screen.proto`. The pre-existing `receipts/issue-1130-tasks-today.md` lacks the `## Audit` section the law asks of a receipt that a range adds (see Inherited red).
6. **An independent audit verdict.** The `## Audit` below is the close worker's re-check; the law asks for a reviewer who did not write the change.

## Audit

The close worker's own re-check of the claims this receipt makes, each against the tree. **This is not an independent review**: the author of the close pass cannot give one, and the root's verifier verdict is still owed (see Owner hand-offs).

1. **No vault, core app query or migration change.** `git diff --name-only 1c7624683..HEAD | rg 'crates/vault|crates/apps|contracts/migrations|crates/core/src|core/v1/'` printed nothing. **PASS.**
2. **The deleted thing is gone.** `rg -n "TasksHome|withTasksDestination|tasks\.home|TASKS_HOME|DueShelf|TasksBandTab" mobile crates` leaves only proto comments that name the reserved numbers (`due_open_days`, `shelf_label`, `DueShelfToggled`) and none in code. One stale comment in `ChatRouting.swift` was fixed. **PASS.**
3. **Nothing renumbered in `screen.proto`.** The removed fields are `reserved` (ten `reserved` lines added across the protos in the range). `buf breaking` is not part of the `mobile-jvm` profile and was not run here. **PASS on reading, not on the tool.**
4. **No copy key was orphaned.** A script compared each of `copy/agenda.json`, `copy/tasks.json` and `copy/notes.json` against its uses in `mobile`, `crates`, `contracts` and `packages` at the base and at the head: no key became unused. Keys already unused at the base (for example Agenda's `MONTH_*`, Tasks' `DAY_ONE_ACTION`, `TASK_ADDED`) are not this change's and were left. **PASS.**
5. **One core read is unconsumed.** `AgendaUpcoming.due` and `due_tasks_statement` are still answered and no shell reads them (Q-1128-6). **Found, not fixed** (the fence).
6. **Edits are described by the diff.** Every path in `git diff --name-status` above is named in a lane's receipt rows or in this pass's commits; the twelve `.bin` fixtures are generated from their `.textproto`. **PASS.**
7. **The Android edits of this pass are untested.** Removing the in-list empty block and the `centered` parameter from `AgendaHomeScreen.kt` was done by reading; no compiler saw it. **OPEN**, on the hand-off list.
