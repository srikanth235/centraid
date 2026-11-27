# Validation

These receipts describe the remediation worktree. The schema packet separately pins its earlier immutable evidence commit. Commands that use Cargo were serialized with a shared filesystem lock. No full PR/CI gate success is claimed. The narrow mobile-JVM profile is recorded separately.

| Command | Result | Receipt |
|---|---|---|
| `cargo test -p centraid-vault --no-fail-fast` | 1,082 passed, 0 failed, 2 ignored, 99 reported suites | [Vault](validation/vault.txt) |
| `cargo test -p centraid-core --no-fail-fast` | 288 passed, 0 failed, 18 reported suites | [Core](validation/core.txt) |
| `cargo test -p centraid-domain --no-fail-fast` | 132 passed, 0 failed, 7 reported suites | [Domain](validation/domain.txt) |
| `cargo test -p centraid-identity` | 32 passed, 0 failed | [Identity](validation/identity.txt) |
| `cargo test -p centraid-screens --no-fail-fast` | 629 passed, 0 failed, 48 reported suites | [Screens](validation/screens.txt) |
| Foreground-vault routing and lifecycle regressions | Navigation/search 1/1, late Follow replies 1/1, Locker switches/background 2/2, draft/room identity reset 1/1; included in the full Screens count | [Follow](validation/front-shelf-follow.txt), [Locker](validation/front-shelf-locker.txt), [drafts](validation/front-shelf-drafts.txt), [Clippy](validation/front-shelf-clippy.txt) |
| Android global owner cancel and clipboard-clear routing | 5 targeted tests passed; controls bypass a suspended store reader and send no replies to retired rooms | [Android controls](validation/android-vault-controls.txt) |
| Current Money and Room artifact checks after final test extensions | Money 7/7, artifact capture 1/1; hand-entered restore/Undo and two-transaction categorization/Undo asserted | [Money](validation/money-current.txt), [Room capture](validation/room-fixture-capture.txt) |
| Final Locker/editor checks | Locker 1/1, form blocks 2/2, field state 9/9, format and Clippy passed | [Locker](validation/locker-current.txt), [Locker Clippy](validation/locker-clippy.txt) |
| `cargo fmt --all -- --check` and Clippy on the affected Rust crates and all targets with `-D warnings` | Passed | [Format and Clippy](validation/fmt-clippy.txt) |
| `cargo test -p xtask native_parity` | 25 passed, 0 failed | [Parity tests](validation/native-parity.txt) |
| `cargo xtask rules` | All other listed rules clean; data-pin failed and remains excluded by the owner | [Full rules output](validation/rules.txt) |
| `cargo xtask doc-links` | 0 findings | [Documentation links](validation/doc-links.txt) |
| `cargo xtask design --check` | Passed | [Generated design](validation/design.txt) |
| `cargo build -p centraid-core-ffi` then `gradle -p mobile :core:jvmTest --no-daemon` | 40 passed, 0 failures/errors/skips across 10 suites; real JNA/ABI path | [Native library](validation/jvm-native-library.txt), [JVM tests](validation/jvm-tests.txt) |
| `cargo xtask gate --profile mobile-jvm` after the Photos ref fix | Passed: rebuilt host FFI, JVM task and generated design drift check | [Mobile-JVM gate](validation/mobile-jvm-gate.txt) |
| Android API 24 ARM64 native Core build | Passed; Android floor retained | [Native build](validation/android-core-api24.txt) |
| Android debug APK artifact at `096e04cb` | Passed: API 24 arm64, matching embedded Core hash, same prior signing certificate, ZIP alignment verified. App artifact source is `096e04cb`; embedded Core remains the verified build from `50510fd0b` | [APK assembly](validation/android-apk.txt), [artifact hashes](validation/android-artifact.json) |
| Local Android unit tests and goldens | 212 tests, 0 failures/errors, 2 opt-in captures skipped; this local run reused ignored full-screen captures and does not prove a clean checkout | [Android unit run](validation/android-unit.txt), [JUnit totals](validation/android-unit-summary.json), [reviewed golden updates](validation/android-goldens.txt) |
| Hosted Android verification at `50510fd0b` | Tracked block goldens matched and both new global-control cases passed. The suite still failed on the pre-existing missing `room_home` reference: 214 tests, 1 failure, 2 skips. Broader CI cleanup remains excluded | [Current hosted result](validation/android-ci-current.txt), [failure provenance](validation/android-ci.txt) |
| Final opt-in Android captures and secret-control regressions | Passed: 20 light and 20 dark review previews, two separate scrolling-layout previews, and both masked-control cases | [Capture run](validation/android-captures.txt), [layout fixture](glass-layout-fixture.json) |
| Glass contrast over extreme photo backgrounds | Two generated-resource tests passed; selected and inactive text remain at least 4.5:1 over black/white sources | [Contrast/capture receipt](validation/android-captures.txt) |
| Photos image content resolution | Android Kotlin compile passed; Robolectric `RoomClientPhotoContentTest` 5/5. Focused Rust ContentUrls integration, formatting and Clippy passed; full Screens rerun pending. Existing embeddable Store images may resolve; OS-library-only previews remain placeholders | [Android photo resolver](validation/android-photo-content.txt) |
| Android Net tone rendering | Robolectric row golden 1/1 and chart goldens 3/3 passed; row uses a positive amount for the Net semantic tone | [Net tone verification](validation/android-net-tone.txt) |
| Photos owner-ref and native layout source checks | Screens 629/629, fmt/Clippy and the mobile-JVM gate passed; only excluded DATA-PIN remains. New iOS SDK run pending | [Current source checks](validation/photo-source-checks.txt) |
| Hosted iOS at `096e04cb` | Both Rust targets, 174 unit tests, and unsigned iPhone app build passed. UI suite failed with 55 failures; three focus-order tests passed and ten screenshots were verified from the review artifact | [Actual hosted iOS result](validation/ios-unit.txt) |
| iOS accessibility repairs | Included in the SDK run; UI failures remain (contrast, Dynamic Type, clipping, one element-description issue, Backup tab hittability) | [Repair scope and limits](validation/ios-ui-repairs.txt) |
| iOS workflow validation | The unsigned generic iPhone build ran and passed after UI failure. Current actionlint 1.7.12 and `bash -n` passed; ShellCheck was not run | [Workflow validation](validation/ios-workflow.txt) |
| Full PR gate at `096e04cb` | Failed: excluded model/data/export tests, DATA-PIN, protocol enum naming and a shell warning in the added iPhone step; the shell warning is fixed locally for the next push | [Exact failures and scope](validation/gate-current.txt) |
| `bun run docs:build` | Passed | [Docs build](validation/docs-build.txt) |
| `bun run docs:smoke` | Passed, 12 pages and internal links | [Docs smoke](validation/docs-smoke.txt) |

The two ignored Vault cases are an opt-in cache-cost measurement (`the_cost_of_a_cache_of_150000_words`) and an opt-in fixture writer (`write_the_vectors`).

The screen suite includes actual formatter export tests for eight non-Locker apps (ten choices including Health), staged vCard import review/confirm, ambiguous-date no-commit behavior, paged organizers with one Undo, and sealed Locker session/owner-result tests. The Domain suite includes the Year-3 fixture of 27,600 rows across all app read families. These assertions bound rows, pages and statements rather than elapsed time.

## Outstanding platform evidence

The Android APK app artifact is from `096e04cb`; its embedded Core is the verified build from `50510fd0b` with foreground-routing and vault-switch fixes. The artifact receipt identifies the unique download filename, current SHA256 and matching prior signing certificate. The new Photos `ContentUrls` source requires a matching Core/native rebuild, so this 096 artifact remains the current downloadable APK until that replacement is built; no physical Android run is claimed.

The Linux host has no Xcode/iOS SDK, simulator, connected Android phone, Android emulator acceleration, or connected iPhone. Hosted iOS run `46071464163` passed both Rust targets, 174 unit tests and the unsigned iPhone build, but the UI suite failed with 55 failures. Its ten screenshot PNGs were downloaded from the small review artifact and verified; the Calendar capture is an hourly grid, Notes is a blank new editor and the source-096 Photos capture shows placeholders rather than thumbnails. The later Photos ContentUrls code is not included in this run and awaits a matching Core/native rebuild and iOS SDK verification. Screenshot and artifact limits are documented in [the iOS receipt](validation/ios-unit.txt). Physical-device/share-extension checks remain unverified. The [Mac handoff](ios-handoff.md) lists the commands and actual attempts.

Android previews are Compose/Robolectric renderings of actual Rust Room responses. They show layout and copy; they do not establish native permission, biometric, picker, clipboard, download, share/save, or GPU blur behavior on a phone. Device checks must include Locker relocking and late callback rejection, the original clipboard lease, per-store follow permissions, private staging cleanup, and floating controls while content scrolls behind them.

The assistant data-pin check is expected to fail because the owner excluded data regeneration and pinning. The failing line begins: “data v0.3 is marked stale (coverage), but the contract moved again since it was marked”. Its failure must not be read as a green gate or fixed by changing recorded hashes.
