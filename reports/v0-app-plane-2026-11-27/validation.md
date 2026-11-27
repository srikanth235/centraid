# Validation

These receipts describe the remediation worktree. The schema packet separately pins its earlier immutable evidence commit. Commands that use Cargo were serialized with a shared filesystem lock. No full CI or gate-profile success is claimed.

| Command | Result | Receipt |
|---|---|---|
| `cargo test -p centraid-vault --no-fail-fast` | 1,082 passed, 0 failed, 2 ignored, 99 reported suites | [Vault](validation/vault.txt) |
| `cargo test -p centraid-core --no-fail-fast` | 288 passed, 0 failed, 18 reported suites | [Core](validation/core.txt) |
| `cargo test -p centraid-domain --no-fail-fast` | 132 passed, 0 failed, 7 reported suites | [Domain](validation/domain.txt) |
| `cargo test -p centraid-identity` | 32 passed, 0 failed | [Identity](validation/identity.txt) |
| `cargo test -p centraid-screens --no-fail-fast` | 628 passed, 0 failed, 48 reported suites | [Screens](validation/screens.txt) |
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
| Android API 24 ARM64 native Core build | Passed; Android floor retained | [Native build](validation/android-core-api24.txt) |
| Earlier Android debug APK assembly | Passed for the earlier Core; superseded by the shared foreground-routing fix. Replacement build pending | [APK assembly](validation/android-apk.txt), [artifact hashes](validation/android-artifact.json) |
| Local Android unit tests and goldens | 212 tests, 0 failures/errors, 2 opt-in captures skipped; this local run reused ignored full-screen captures and does not prove a clean checkout | [Android unit run](validation/android-unit.txt), [JUnit totals](validation/android-unit-summary.json), [reviewed golden updates](validation/android-goldens.txt) |
| Hosted Android verification at `53311bea8` | Tracked block goldens all matched. The suite failed on the missing `room_home` reference in ignored build output: 212 tests, 1 failure, 2 skips. The capture path predates this remediation; broader CI cleanup remains excluded | [Hosted Android failure and provenance](validation/android-ci.txt) |
| Final opt-in Android captures and secret-control regressions | Passed: 20 light and 20 dark review previews, two separate scrolling-layout previews, and both masked-control cases | [Capture run](validation/android-captures.txt), [layout fixture](glass-layout-fixture.json) |
| Glass contrast over extreme photo backgrounds | Two generated-resource tests passed; selected and inactive text remain at least 4.5:1 over black/white sources | [Contrast/capture receipt](validation/android-captures.txt) |
| Hosted iOS Swift/XCTest at `5c1b94498` | App/test compilation and 173 unit tests passed; UI suite failed with 18 failures, required PNG captures absent, unsigned iPhone build skipped | [Actual hosted iOS result](validation/ios-unit.txt) |
| iOS workflow validation | Actionlint 1.7.12 passed; the generic iPhone build runs after a successful Rust-core step, independently of simulator test outcome | [Workflow validation](validation/ios-workflow.txt) |
| `bun run docs:build` | Passed | [Docs build](validation/docs-build.txt) |
| `bun run docs:smoke` | Passed, 12 pages and internal links | [Docs smoke](validation/docs-smoke.txt) |

The two ignored Vault cases are an opt-in cache-cost measurement (`the_cost_of_a_cache_of_150000_words`) and an opt-in fixture writer (`write_the_vectors`).

The screen suite includes actual formatter export tests for eight non-Locker apps (ten choices including Health), staged vCard import review/confirm, ambiguous-date no-commit behavior, paged organizers with one Undo, and sealed Locker session/owner-result tests. The Domain suite includes the Year-3 fixture of 27,600 rows across all app read families. These assertions bound rows, pages and statements rather than elapsed time.

## Outstanding platform evidence

The earlier Android APK predates the shared Core foreground-routing fix and must be replaced before app navigation is reviewed. Its recorded hashes identify that earlier binary, not the current Rust worktree.

The Linux host has no Xcode/iOS SDK, simulator, connected Android phone, Android emulator acceleration, or connected iPhone. The hosted Mac compiled the Swift app/tests and passed 173 unit tests, then UI execution exposed the shared Core room-routing failure. Required Calendar grid, note editor, photo grid, and People/Money captures remain unverified, as do the unsigned iPhone app build and physical-device/share-extension checks. The [Mac handoff](ios-handoff.md) lists the commands and actual attempts.

Android previews are Compose/Robolectric renderings of actual Rust Room responses. They show layout and copy; they do not establish native permission, biometric, picker, clipboard, download, share/save, or GPU blur behavior on a phone. Device checks must include Locker relocking and late callback rejection, the original clipboard lease, per-store follow permissions, private staging cleanup, and floating controls while content scrolls behind them.

The assistant data-pin check is expected to fail because the owner excluded data regeneration and pinning. The failing line begins: “data v0.3 is marked stale (coverage), but the contract moved again since it was marked”. Its failure must not be read as a green gate or fixed by changing recorded hashes.
