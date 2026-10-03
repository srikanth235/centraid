# Receipt — backups from first principles ([#1080](https://github.com/srikanth235/centraid/issues/1080))

One receipt for the umbrella. Each lane appends a section; the state it produces lives in [docs/decisions.md](../docs/decisions.md) and the docs the umbrella's doc pass touches, and where the two disagree the doc is what is current.

## Wave 3 — the native shells (lane E)

The iOS background mover, the processing windows, the Android jobs, the Backup screen and Home's backup line, on both shells. **Nothing here has been compiled**: there is no Xcode and no Android SDK in the container that wrote it, so every claim that needs one is a device hand-off row in [v1-handoffs.md §8](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080) with the command that proves it. Built in parallel with lanes C and D against the seam contract the root fixed on 2026-10-03 (its §1–§4, amendments A1–A9); the umbrella's proto commit (`f9791e17`) is merged in, and lane D's Kotlin seam and `screen.proto`'s Backup block are not yet, so every name this lane needed beyond the contract is listed below as an assumption.

### What landed

**Slice 1 — the iOS mover and the windows** (`32b0533d`):

| File | Change |
| --- | --- |
| `mobile/iosApp/Sources/BackgroundUploads.swift` | new: the one background `URLSession` (`dev.centraid.uploads`) behind `BackgroundUploads`; exact-DER pinning per task's gateway; the ordered settle road to `UploadEvents` with relaunch hold and completion-handler cap; `UploadPins`; `ForegroundGrace` (the `beginBackgroundTask` wrapper) |
| `mobile/iosApp/Sources/AppDelegate.swift` | new: `handleEventsForBackgroundURLSession` and the launch-time reconnect |
| `mobile/iosApp/Sources/BackgroundPasses.swift` | processing request on power and network; `resubmitAll()` at every background entry; resubmit after each pass; cold-launch wait for the pass; `setTaskCompleted` exactly once |
| `mobile/iosApp/Sources/CentraidApp.swift` | the delegate adaptor, `ShellModel.shared`, `.background` arms the windows |
| `mobile/iosApp/Sources/ShellModel.swift` | `static let shared`; graced foreground passes; `wentToBackground()`; the mover's seam in one place (`wireUploads`, `refreshUploadPins`) |
| `mobile/iosApp/Sources/VaultFileProtection.swift` | the R-1029-8 table: vault, store, ledger, spool and the pins file named |
| `mobile/iosApp/project.yml`, `mobile/iosApp/Resources/Info.plist` | `NSBonjourServices: [_centraid-gateway._tcp]`; the local-network sentence says the phone finds the laptop too |
| `mobile/iosApp/Tests/BackgroundUploadTests.swift` | new: 13 XCTests over the pure half, each law with its negative case |

**Slice 2 — the Android jobs** (`aa94e868`):

| File | Change |
| --- | --- |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/ProcessSession.kt` | new: one `HomeSession` per process, counted, acquired and released on one thread in order |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/BackupNow.kt` | new: the user-initiated job (API 34+), the `dataSync` foreground service (below 34), their notification, and the pass body they share |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/CentraidApplication.kt` | installs the worker body and the backlog hook |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` | holds the process session for the composition's life; the first pass launched, not awaited |
| `mobile/androidApp/src/main/AndroidManifest.xml` | `ACCESS_MEDIA_LOCATION`, `RUN_USER_INITIATED_JOBS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`; the two services |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotoAccessRemedy.kt` | the photo request carries `ACCESS_MEDIA_LOCATION` from Android 10 |

**Slice 3 — the screens** (`fe2729ae`, `7afffede`, `00ac3ee8`):

| File | Change |
| --- | --- |
| `mobile/iosApp/Sources/BackupViews.swift` | new: `BackupScreenModel`, `BackupEvents`, `BackupLineView`, `BackupView` (idle timer while "Back up now" runs) |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/backup/BackupScreens.kt` | new: the same model and events, `BackupLineRow`, `BackupSheets` (notification grant at the tap, the job, the battery remedy) |
| `mobile/iosApp/Sources/HomeView.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt` | the backup line under the lockup |
| `mobile/iosApp/Sources/ShellModel.swift`, `mobile/iosApp/Sources/CentraidApp.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` | the Backup sheet, its bridge, "Add a gateway" handing over to `pair.laptop`, a grace held while "Back up now" runs, pins refreshed when the gateways change |
| `mobile/iosApp/Sources/PhotosMoreSheet.swift`, `mobile/iosApp/Sources/StateViews.swift`, `mobile/iosApp/Sources/BackupStatus.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotosGridScreen.kt` | the camera-roll import sheets lose the transport row and stop speaking of a backup |
| `mobile/iosApp/Sources/VaultHeader.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/VaultHeader.kt` | the lockup's comment points at the backup line that now exists |
| `mobile/maestro/flows/selectors.md` | the Backup screen's ids, one string on both shells |

**Slice 4 — the measurement** (`ac6cd258`): `mobile/maestro/ios-transfer-experiment.md` deleted; `mobile/maestro/backup-measurement.md` new; `mobile/maestro/README.md` points at it.

**Registry**: this section; `docs/decisions.md` (R-1080-E1…E10 and two supersessions); `docs/release/v1-handoffs.md` (§8, rows 8.1–8.15; row 7.1 marked superseded).

### Rulings spent

#1080 rulings 1 (the pin), 2 (the OS carries the bytes on iOS), 6 (media from where it lives — the location grant) and 7 (acknowledgement is the PUT's success, the ledger a cache that `reconcile` repairs); [R-1029-8](../docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) (every vault-derived path out of OS backup — the sweep's table names the ledger, the spool, the store and the pins file); [R-1020-20](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020) (no simulator number is promoted — the measurement names a reference device); D-1025-S7-72 and S7-75 (the prompt is real; a limited grant keeps "Select more photos").

### Decisions this lane made

Each is recorded in [docs/decisions.md](../docs/decisions.md#the-native-shells-backup-half-1080) with its reason.

| Id | Decision |
| --- | --- |
| **R-1080-E1** | OS-moved uploads never cross a metered link: a part carries no media kind ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 2's session cannot keep "a video never on cellular" per part). Deviates from the brief's "`allowsCellularAccess` from the rule". |
| **R-1080-E2** | One background session, `dev.centraid.uploads`, not discretionary ([#1080](https://github.com/srikanth235/centraid/issues/1080)); iOS makes background-started transfers discretionary itself. |
| **R-1080-E3** | The pin is exact DER equality per task's gateway, kept in `Documents/.centraid-upload-pins.plist` for a cold relaunch ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 1, A6). |
| **R-1080-E4** | One `ShellModel` per process on iOS; a window waits up to 20 s for the pass ([#1080](https://github.com/srikanth235/centraid/issues/1080)). |
| **R-1080-E5** | The processing window asks for power and a network and is re-armed at every background entry and after every pass ([#1080](https://github.com/srikanth235/centraid/issues/1080)); supersedes #1029 W18-1's "a network, not a charger". |
| **R-1080-E6** | One `HomeSession` per Android process, counted and ordered ([#1080](https://github.com/srikanth235/centraid/issues/1080); R-1020-24), with its stated rotation cost. |
| **R-1080-E7** | "Back up now" on Android: user-initiated job from 34, `dataSync` service below, 30 minutes, any network ([#1080](https://github.com/srikanth235/centraid/issues/1080)). |
| **R-1080-E8** | Forgetting a gateway asks no confirmation ([#1080](https://github.com/srikanth235/centraid/issues/1080) A5). |
| **R-1080-E9** | The Backup screen's rule control is the existing transfer rule; "include videos" negates into `exclude_videos` in the machine ([#1080](https://github.com/srikanth235/centraid/issues/1080) A3). |
| **R-1080-E10** | A settle's error is a code, never a sentence ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 7). |

### What this lane assumed beyond the seam contract

The contract names the interfaces; it does not name how the two sides are handed to each other, and lane D's Backup block was not yet written. Each assumption sits in one place per platform so reconciling it is one edit.

| # | Assumed | Where it is read |
| --- | --- | --- |
| E-A1 | `HomeBridge.installUploads(uploads: BackgroundUploads): UploadEvents` — the shell hands Kotlin its mover and takes the core's sink, before the core opens | `ShellModel.wireUploads` |
| E-A2 | `HomeBridge.uploadPins(onPins: (List<UploadPin>) -> Unit)` with `UploadPin(gateway, certDer, addrs)`, answered only with the core's `pins` answer (a refusal does not call back with an empty list, which would wipe the kept pins) | `ShellModel.refreshUploadPins` |
| E-A3 | `UploadEvents.settled(name, httpStatus, error, gatewayId, vaultId)` — the contract's signature with A6's vault | `CoreUploadSink` |
| E-A4 | `SyncPass.installBacklog((Boolean) -> Unit)` in `androidMain`, the hook `BackgroundTasks.backlog(start)` reaches the job through | `CentraidApplication.onCreate` |
| E-A5 | `screen.proto`'s Backup block carries words as well as §3's data: `BackupScreenState.{title, add_destination_label, forget_label, rule_label, include_videos_label, back_up_now_label, progress, battery_sentence, battery_label}`, `BackupLine.sentence`, `BackupWaitingRow.sentence`, `BackupDestinationRow.{gateway_id, label, detail}`, and events `BackUpNow`, `SetIncludeVideos{include}`, `ForgetDestination{gateway_id}`, `Dismissed` | `BackupScreenModel` / `BackupEvents` (both shells), `BackupLineView`, `BackupLineRow` |
| E-A6 | `BackupBridge` in `dev.centraid.shared.sync`, shaped like every kit bridge: `attach`, `observe`/`states`, `open`, `send`/`forward` | `ShellModel`, `BackupSheets` |
| E-A7 | `HomeState.backup_line: BackupLine` | `HomeView`, `HomeScreen` |
| E-A8 | `HomeBridge.drain(deadlineMs:onDone:)` and `ShelfDrain.run(deadlineMs)` keep their signatures, the rule, link and power read inside from `PowerAndLink`; every iOS pass ends with `reconcile` → `handoff` → `enqueue`, the background-entry pass included, so what it sealed is carried while suspended | `BackgroundPasses`, `ShellModel.wentToBackground`, `BackupNow.run`, `CentraidApplication` |

### Found, not this lane's

1. **`NavigationAndMountSpec` "no gateway id names anything under mobile/" fails on the contract's own names.** Its regex `\bgatewayId\b|\bgatewayHex\b|\bgateway_id\b` flags four lines of this lane (`BackgroundUploads.swift:529` `part.gateway_id`, `:644` `gatewayId:`, `BackupScreens.kt:113` and `:144` `gateway_id`), and lane D's `UploadEvents` declaration trips it too. Its subject is D-1025-S5-2's mount key; #1080 ruling 8 brings gateway ids back as destination ids. Lane D owns the spec; narrowing it to the mount is theirs.
2. **`BackgroundPassLawSpec` "the URLSession seam stays retired" passes for the wrong reason.** It scans for the Objective-C spellings (`NSURLSessionUploadTask`, `backgroundSessionConfigurationWithIdentifier`) and this lane's Swift spells `URLSessionConfiguration.background(withIdentifier:)`. #1080 ruling 2 inverts its subject; it should become a positive assertion (one `background(withIdentifier:`, `sessionSendsLaunchEvents`, `SecCertificateCopyData`, `handleEventsForBackgroundURLSession`). Lane D's file.
3. **The deleted experiment is still named** by `crates/xtask/src/gate.rs` (the `ios-transfer-experiment` device lane, its evidence path and messages, and a test asserting the name), `.github/workflows/gate-nightly.yml:193`, `crates/xtask/README.md:49`, `TESTING.md:122,126`, `docs/toolchain.md:165`, `docs/mobile-offline.md:218`, `docs/decisions.md:1384,1580`, `mobile/README.md:186` and `contracts/handoff/E/device-lane-bodies.md` — `grep -rn "ios-transfer" --include=*.md --include=*.yml --include=*.rs .`. The lane should read `receipts/experiments/backup/` and the protocol `backup-measurement.md`; lane C owns `gate.rs`, lane F the docs.
4. **`DrainCopy.POSTURE_SENTENCE` and `FORCE_QUIT_SENTENCE`** (`mobile/shared/.../sync/DrainPass.kt:222-238`) say Centraid "does not upload while the app is closed"; on iOS it now does. Lane D's copy.
5. **`mobile/README.md`** still says pairing has "no Bonjour" (`:333`) and lists the experiment in its hand-off table (`:186`). Lane D's and lane F's sections.

### Device hand-offs

Rows 8.1–8.15 of [v1-handoffs.md](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080), each with its command, its evidence and its destination: the iOS compile and the 13 `BackgroundUploadTests` (8.1); a part handed off while suspended lands and the next batch chains (8.2); the pin refusing another certificate (8.3); the processing window on both paths (8.4); a foreground part finished under the grace (8.5); the idle timer (8.6); the local-network prompt and the Bonjour type (8.7); the Android compile and lint (8.8); the periodic worker with no activity (8.9); the user-initiated job (8.10); the foreground service below 34 (8.11); EXIF location surviving the read (8.12); rotation during a background pass (8.13); the battery remedy (8.14); and the three backup claims of `backup-measurement.md` (8.15).

### Verification

| Command | Result |
| --- | --- |
| `./mobile/gradlew -p mobile :shared:jvmTest` | 1028 tests, 1 failed: `NavigationAndMountSpec` on the four contract lines in "Found" 1. Every other spec green, `BackgroundIdentifierSpec`, `NativeAccessibilityLintSpec`, `PartyHueWheelSpec` and Konsist's `CommonMainIsPlatformFreeSpec`/`PerAppLayoutSpec` among them. The first run, before any change, failed resolving `junit-jupiter-api` with HTTP 429 from Maven Central and is not a baseline. |
| `bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format`, then the drift diff over `design copy mobile contracts/screens` (the `mobile-jvm` profile's drift check) | exit 0; the tree clean |
| `:core:jvmTest` | not run: it needs the core's cdylib built by cargo, and this lane changed nothing under `mobile/core` |
| `project.yml` against `Resources/Info.plist`, by a script that loads both | 11 source keys, all present and equal; 8 XcodeGen defaults; 0 mismatches; keys sorted. The same script refuses a copy with `NSBonjourServices` changed (exit 1). |
| `grep -rn "background(withIdentifier" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:344` |
| `grep -rn "beginBackgroundTask" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:674`, `ForegroundGrace` |
| `grep -n "ACCESS_MEDIA_LOCATION\|RUN_USER_INITIATED_JOBS\|FOREGROUND_SERVICE_DATA_SYNC\|POST_NOTIFICATIONS" mobile/androidApp/src/main/AndroidManifest.xml` | all four `uses-permission` lines (35, 56, 58, 59) |
| `oxfmt --check mobile/iosApp/project.yml` | formatted |
| the manifest parsed as XML, every comment checked for `--` | parses; none |
| the commit hooks on every commit | green: `format-check`, `lint-check`, `law` (6 rules), `commit-message-format`, `estate-separation` |
