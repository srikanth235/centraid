# Notification outbox file-store fix and proof

## Verified source path

- iOS registers `NotificationDelegate` at app launch; `didReceive` copies the OS request identifier and action identifier, then `NotificationHandoff` runs the async answer on MainActor and completes the OS callback after it returns (`mobile/iosApp/Sources/Notifications.swift`). The verb is decoded from its numeric action identifier; tap maps to `.open`.
- `Notifications.answered` appends a new press identity to `NotificationOutbox` before touching `ShellModel.shared`, waits for `BackgroundPasses.installed`, then submits `ShellFact.notificationAnswered`. A matching performed schedule removes the press; startup calls `Notifications.drain` after a successful store start (`ShellModel.attach`).
- `BackgroundPasses.start` publishes a store only after `ScreenStore.start()` succeeds. That starts the core runtime and obtains its first snapshot. The notification service queues cold facts until its device-only `SecretBatch` receipt has been read and the foreground vault is mounted (`crates/screens/src/agenda/notify/service.rs`).
- Rust keys writes by `(verb, notification id, press_id)`; successful, non-repeating task writes persist a receipt before advertising Undo. Receipt metadata (no task words) binds vault/task, original ten-minute expiry, history sequence and stable Undo invocation key (`crates/screens/src/agenda/notify/{answer,receipt,service}.rs`). Undo intent is durably saved before the guarded history inverse; receipt clearing must be acknowledged before the answer becomes terminal.
- Notification permission is reconciled by Rust on foreground lifecycle even when the task set is unchanged. iOS `schedule` requests only when `askPermission` is true; Android foreground reconciliation is described in `mobile/README.md`.

## Evidence matrix

| Claim | Evidence | State |
| --- | --- | --- |
| Cold callback waits for a successfully snapshotted store | `NotificationReadinessTests.testColdStoreIsPublishedOnlyAfterOneSuccessfulSnapshot`, `testFailedSnapshotDoesNotPublishColdStore` | Scripted Swift unit tests exist; not run in this audit. They do not launch the OS callback or app process. |
| Only the exact `(id, verb, press_id)` performed schedule releases callback | `NotificationReadinessTests.testOnlyExactPerformedAnswerCompletesCallback` and concurrent callback test | Scripted performer/core tests exist; not run here. |
| Delegate completes on main after a suspension | `NotificationHandoffTests.testBackgroundResponseCompletesOnceOnMainAfterSuspendingAnswer` | Harness test exists; not run here. |
| Outbox file persistence and failure handling | New `NotificationOutboxTests` ran on isolated iOS 26.5 simulator | **4 passed**; see execution details below. |
| Receipt survives restart, protects history and uses original expiry | Rust source includes bounded receipt/guard logic; targeted existing test names not fully enumerated in this pass | Source inspected only; no tests run in this audit. |
| Pre-patch enqueue failure returns a dispatchable press | Baseline XcodeGen project built `git show HEAD:mobile/iosApp/Sources/NotificationOutbox.swift` and ran `LegacyOutboxFailureTests.testEnqueueDoesNotProduceDispatchablePressWhenPersistenceFails` against a directory at the real app-support outbox path | **Behavioral fail-before reproduced:** old caller returned a press after failed write; test failed at `XCTAssertFalse(dispatchable)`. Result bundle: `/private/tmp/centraid-1200-outbox-proof/baseline/Baseline.xcresult`. |
| OS cold-process action succeeds on iOS | The isolated simulator exercised file-store tests, not an OS notification callback into the full app. `mobile/README.md` still lists the #1188 cold-action check. | **Unverified device evidence**, not a proven OS failure. |
| Permission changes rearm without reminder edits | Rust lifecycle handler and foreground reconciliation source | Source inspected only; OS Settings grant/denial handoff not exercised. |

## Historical durability defect (pre-patch `d13169855`)

The pre-patch `NotificationOutbox.add` returned a fresh `Press` regardless of whether it reached disk. `mutate` ignored write failure; `write` ignored directory, encode, atomic-write, and backup-exclusion errors. `read` mapped both missing and unreadable/malformed files to `[]`. A cold action could therefore reach Rust without a durable retry identity, and a failed read could erase the apparent outbox. That API could not distinguish durable enqueue from failure. This defect was separate from the unverified OS cold-launch symptom.

## Current implementation and proof

Implemented the test-first shape in `NotificationOutboxTests.swift`: Foundation-backed disposable files cover successful reopen with identical identity, corrupt+excluded state preservation, successful selective removal, and injected atomic-replacement failures after a valid read/write setup for both add and remove. Missing is distinguished by the actual `Data(contentsOf:)` no-such-file error; other read failures surface. `NotificationOutbox.Store` reports typed failures; existing files must decode and carry backup exclusion and file protection. A press is returned only after atomic write, complete file protection, backup exclusion and post-replacement metadata verification. The replacement seam only forces replacement failure in tests; byte writes, encoding, corruption, metadata, reads and reopens use Foundation. The live queue remains untouched until the protected/excluded sibling file is ready. `Notifications.answered` does not dispatch after enqueue failure. Drain reports safe failure tags and leaves presses pending when read/removal fails. No IDs, words or error descriptions enter diagnostics.

`swiftc -parse` and standalone iOS Simulator SDK typecheck passed. For Foundation behavior, a disposable XcodeGen project used the exact worktree `NotificationOutbox.swift` as framework module `CentraidApp` and exact `NotificationOutboxTests.swift` as its XCTest target. Command: `xcodebuild -project OutboxProof.xcodeproj -scheme OutboxProof -destination 'platform=iOS Simulator,id=91CB5866-690D-4D4F-999F-AEDE53AB727F' -derivedDataPath /private/tmp/centraid-1200-outbox-proof/current/DerivedData -resultBundlePath /private/tmp/centraid-1200-outbox-proof/current/OutboxTests4.xcresult test`. Result: **4 passed, 0 failed** on newly created iPhone 17e / iOS 26.5 simulator UDID `91CB5866-690D-4D4F-999F-AEDE53AB727F`; framework bundle `dev.centraid.outboxproof.CentraidApp`, test bundle `dev.centraid.outboxproof.tests`. The success test observed backup exclusion `true` and file protection `.completeUntilFirstUserAuthentication` after replacement. Result bundle/logs are under `/private/tmp/centraid-1200-outbox-proof/current/OutboxTests4.xcresult`. The same simulator ran the baseline target `dev.centraid.outboxbaseline.tests` hosted by `dev.centraid.outboxbaseline.runner`; it was deleted after both suites completed. Temporary test fixture directories remove themselves in `deinit`. This proves file-store logic only; it does not prove app integration or OS cold-process behavior. The full app test command remains `xcodegen generate` followed by `xcodebuild -project Centraid.xcodeproj -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` from `mobile/iosApp/` with generated Swift protobuf/core prerequisites. The #1188 device check remains outstanding.

## Reviewed artifact identities

Root independently read both result bundles: the current suite has four passes and no failures; the baseline has one assertion failure, "failed persistence must not yield a press to dispatch". The source and framework SHA-256 values are:

| Input | SHA-256 |
| --- | --- |
| `mobile/iosApp/Sources/NotificationOutbox.swift` | `7540ec7448183a74b7a6578ddbf329684ff3db49f852f6004cb4a0216052415a` |
| `mobile/iosApp/Tests/NotificationOutboxTests.swift` | `497d55cc5f0289f69fe905c956ccc63c1536fb03d082e8da261bb3ba94ddff52` |
| Isolated `CentraidApp.framework/CentraidApp` binary under the result's DerivedData | `6d23e2ea43a616d945115c7558ecb6e55e744999334ec4a9af0e682033780075` |

The framework contains the outbox implementation only, with no Rust core or full application. Its passing tests establish this file-store slice, not the remaining notification journey.
