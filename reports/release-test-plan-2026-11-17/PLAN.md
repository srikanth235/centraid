# Release test plan

Status: in progress, 2026-11-17. Release candidate: main `99cc70d8f` (#1195, which landed the #1185 audit fixes). PR #1195's CI passed the `pr` gate, iOS and Android on `2374afc2a`, whose tree is identical to `99cc70d8f`. Builds on the earlier audits: ios-promises (2026-11-12, not committed), android-promises (2026-11-12, not committed), [mobile-audit](../mobile-audit-2026-11-13/README.md). This plan does not repeat their evidence. It says what must be re-proved on the release candidate and what blocks release.

## 1. Where we start

- iOS ledger: 82 narrow passes, 3 failed, 8 N/A, 96 unrun (189 cases). Android: shared-fix parity passed, but on the earlier branch.
- All device evidence predates the merge with main's storage and recovery work (#1193). **None of it is fresh evidence for the release candidate.**
- No full `local` or `pr` gate pass is recorded for the combined snapshot. Only `clippy`, `rules` and `design` were run on it.

## 2. Exit criteria (go / no-go)

Release only when all hold, on one frozen commit:

1. `cargo xtask gate --profile release` is PASS (includes `pr`, `artifact-identity`, `prebuilt-core-required`).
2. Every case in the journey matrix (section 6) is PASS on iOS and Android, in light and dark, or has an owner-signed N/A.
3. The blocker list (section 9) is closed or has an owner ruling.
4. The restore-from-24-words and backup journeys pass end to end on a clean device with a real gateway.
5. Nothing is reported verified that was not run. Unrun layers are named (section 10).

## 3. Phase 0: freeze and baseline

1. Merge or rebase onto current main. Freeze the commit; every artifact records its SHA.
2. Rebuild the Rust core for each platform (`mobile/scripts/ios-core.sh`, `mobile/scripts/android-core.sh`). Check the archive mtime or `nm`, since the app links a stale archive silently.
3. Record bundle identity: installed iOS bundle files and Android APK plus embedded core bytes match the built artifact.
4. Fresh disposable simulators and AVDs, distinct UDIDs, private state dirs. Demo vault only; never a live vault copy.

## 4. Phase 1: automated gates (no device)

Run in this order and paste each result line:

| Command | Proves |
| --- | --- |
| `cargo xtask gate --profile pr` | fmt, clippy, full workspace tests, rules, buf, deny, ts-static, design drift, lockfile, prompt-injection |
| `cargo xtask rules` | the promises register: which app keeps which promise, what is missing |
| `cargo xtask gate --profile mobile-jvm` (JDK 21) | real ABI round trip, emitted-artifact drift |
| `bun run check` and `bun run lint:product` | TypeScript, copy, native-controls, journey ledger |
| `cargo xtask design --check` | generated light, dark and native files match mockups |
| Android `./gradlew -Pcentraid.android=true :androidApp:testDebugUnitTest` (from `mobile/`) | Android JVM and shell tests |
| iOS `xcodebuild ... test` (from `mobile/iosApp/`) | Swift suite on the simulator |
| `cargo xtask gate --profile release` | adds artifact-identity and prebuilt-core-required |

Exit: all green. A `SKIP` is not a pass.

## 5. Phase 2: design conformance

Source of truth: `design/mockups/*.dc.html` plus `design/tokens.toml`. Compare structure, words, states and colour, not pixels.

For each screen with a board, on each platform and in both themes:

- Same sections, order and controls as the board. Same selector ids on both platforms (`mobile/maestro/flows/selectors.md`).
- Words match the generated kit words; copy check passes (calm, concrete, no exception strings, no exclamation).
- Every app's hue and the Home tile colours are correct; contrast holds in light and dark.
- All six states drawn: loading, empty, failed, refused, partial, not checked.
- Android is Material 3 Expressive and iOS is Liquid Glass; parity is behaviour, not pixels.

Where app and board disagree, the board wins. Log mismatches as defects, not as board edits.

## 6. Phase 3: journey matrix

Each journey runs on iOS and Android, light and dark, on a fresh vault unless noted. Source of each expectation is the `product` skill's promises and rulings.

### J1. First launch

- Create a vault; the 24 words show once on a secure screen and can be read again later.
- No account, sign-in, sample rows or "See an example". Empty Home teaches or offers a one-tap import.
- No unrelated permission prompts at onboarding. Each permission is asked at the moment of need; a refusal reads the same on both platforms and the app keeps working.

### J2. The nine apps, daily use

For each app: populated and fresh states, create, edit, search it, open from Home and return.

| App | Must work | Must not |
| --- | --- | --- |
| Calendar | Day, Week, Month, List, Year; repeating events; "this and following"; invites; reminders shown on their day and ticked there | write a task; a Cancel that runs unconfirmed |
| Reminders | Today, Scheduled, All, Flagged, Completed, lists; quick add; Catch up; Overdue on Today | touch an event |
| Notes | autosave; blank title shows first line; `[[` links; notebooks via Notebooks; body not on this phone is read-only | silently overwrite unseen text |
| People | add, relatives from both sides, birthday on its day with no reminder; vCard import as merge proposals; export | silent merge; show a Locker item under "In your vault" |
| Docs | folders as labels; version history; Delete forever and Empty trash really destroy; text, CSV, Markdown and video preview | alter bytes on export |
| Photos | browse; place named by the ladder; hand-tag a person; share as an OS copy | print a bare coordinate as a name; any face feature |
| Money | import statements; only category and name editable; Trash a line and restore it exactly; recurring charges detected; ambiguous date asks | stored balances; guess a date order |
| Health | Today versus own typical range; "Nothing yet today" instead of 0; trash a workout | targets, 0 for no data |
| Locker | owner check to open; reveal only on check; relock wipes values; sealed values absent from search, links and Ask; Earlier versions masked with Reveal | any read while locked; recently-used shelf |

### J3. Promises, every app (the uniform set)

For each of the 19 promises in `product/promises.md`, run it in every app that owes it. `cargo xtask rules` gives the grid.

- Change safely: Trash, Restore, Delete forever, Empty trash; Undo from the status line or confirm first; Earlier versions with Restore; stale-save warning.
- Arrive: detail screen shows how the item arrived in one quiet line.
- Connect and Attach: link through the one picker (never to a Locker item); attach a file or photo (never to a Locker item).
- Find: every typed field is searchable; sealed values are not.
- Take out: per-app export to an open format; "Export everything"; share as an OS copy; plaintext exports ask a fresh owner check.
- How much: units follow the member's one choice.
- When: one timeline, repeats from one engine.

### J4. Find and ask

- Home search covers every app; Locker found by plain fields only; result opens behind the wall.
- Search and Ask return paths land back on Home (known defect, section 9).
- Assistant: a question about the vault; a write behind a confirm card; a secret request ends in a Reveal card with owner check; the secret is never stored in the chat and is dropped on relock or leaving chat.

### J5. Being told

- Permission asked at need; refusal and Settings repair.
- Timed alert while the app is backgrounded; tap opens the same record.
- Done, Snooze, Tomorrow and Undo from the notification; cold-process handling; cancellation when the item is changed or deleted; time-zone and 12/24-hour reconciliation.
- Same rule on iOS and Android. Widgets and shortcuts are the same set.

### J6. Backup, loss and recovery (highest risk)

1. Pair a real `centraid-gateway` over pinned HTTPS.
2. Add markers and original bytes in every app; Home shows "backed up" only after the gateway acknowledges.
3. Offline and retry: break the connection, status says "not yet", never an invented all-clear; it catches up after.
4. Lose the phone: fresh device, enter the 24 words, everything returns (rows, originals, history, trash). Original retrieval is byte-exact.
5. The superseded source refuses writes.
6. Gateway is blind: nothing readable on the gateway side.
7. Owner check asked before restore.

### J7. Leaving: export

- Per-app export and "Export everything" through the OS save sheet. Archives validate, re-import cleanly, and a second export is byte-identical. BOM and CRLF preserved.

## 7. Platform and appearance matrix

| Axis | Values |
| --- | --- |
| OS | iOS 26 (simulator, small and large iPhone incl. SE-size), Android latest plus one older supported API |
| Appearance | system light, system dark; switch live while on a screen |
| Text size | default and largest accessibility size |
| Locale | 12/24-hour, a non-default time zone, units metric and imperial |
| Connectivity | online, offline, flaky |
| State | fresh vault, populated demo vault, restored vault |

Run the full matrix for J1, J3 and J6. Run a representative cut (Home plus two apps) for the rest.

## 8. Scale and quality

Year-three vault: 90,000 photographs, 18,000 statement lines, on a mid-range phone, offline.

- Bound by counts, not seconds (project rule): keyset pages, statement counts, row counts. Print timings, never assert on them.
- Home, search, Photos grid, Money list, backup catch-up stay usable; memory does not grow without bound; no ANR or hang.
- Physical reference-device numbers are a release-cadence spend decision (section 10).

Accessibility, all apps: screen-reader labels and order, touch targets, contrast in both themes, largest text without clipped or overlapping content, reduced motion, keyboard and switch access where the platform has it.

## 9. Known blockers to re-test first

From the open-issues ledger. Each is retested natively, not by shared test or build.

1. iOS cold notification Done leaves no receipt; Undo after process death has no native proof.
2. Search/Ask return: duplicate back chrome; closing Search leaves results and keyboard without Home.
3. Calendar clips and overlaps at the largest text size.
4. Record Trash confirmations that violate the direct-Trash-with-Undo rule: Reminders detail, People person, Docs drive and document.
5. Reminders history preview shows 09:00 where the zone-correct time is 14:30 IST.
6. Reminders unchecked-control contrast (token fix pending native retest).
7. iOS source to fresh-target recovery chain, cold Snooze and Tomorrow, remaining app share and export cases, broad accessibility.
8. Locker guarded export (stopped before execution last time).
9. The 96 unrun cases in `COVERAGE.md`.

## 10. What no simulator or emulator can prove

State these as unverified unless run:

- Real biometrics and secure lock screen; physical audio; overnight and background delivery of notifications and backup windows.
- Reference-device performance and macrobenchmarks (`cargo xtask gate --profile nightly` needs `CENTRAID_DEVICE_RUNNER=1` and a named device; iOS needs `CENTRAID_REFERENCE_DEVICE`).
- Real Apple Health and Health Connect data (the simulator store is empty; use the debug seeder and a physical device for realism).
- App Store and Play review, signing, TestFlight and internal-track install. Cover with a release-candidate install on at least one physical iPhone and one physical Android.

## 11. Execution

- Two lanes in parallel at most (iOS, Android), each with one UI actor, distinct UDIDs and Maestro ports (MCP fixes the iOS control port at 22087; use the CLI with explicit ports for the second lane).
- Sub-agents run on Sonnet, no more than two heavy agents at once. Check free disk before each build, and clean build targets after.
- Run the committed Maestro flows first (`mobile/maestro/flows`, `MAESTRO_VERSION=2.6.1`; Android needs a temporary copy with `appId: dev.centraid`), then manual and exploratory passes for everything the flows do not cover.
- Order: Phase 0, then Phase 1, then J6 (riskiest) and the section 9 blockers, then J1 to J5 and J7, then section 7 to 8.
- Fixes found go back through the project loop: mockup first, then Rust, then both shells, then regenerate, then rerun the affected cases. No lint, test, budget or allowlist is loosened to get green.

## 12. Reporting

- A coverage ledger (`coverage.json` plus `COVERAGE.md`): per case PASS, FAIL, N/A or UNRUN, with build SHA, platform, theme and evidence path.
- Each defect: steps, expected (promise or board), actual, screenshot, platform.
- Final report states commands run with result lines, layers not run with the exact command and device they need, and a go or no-go against section 2.
- Keep recovery words and pairing material out of tracked reports. Exclude raw demo-seed logs that print the demo mnemonic. Curate evidence; do not stage the whole raw tree (hundreds of MB).
