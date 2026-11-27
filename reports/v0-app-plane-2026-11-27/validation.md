# Local validation

These receipts describe the remediation worktree. The schema packet separately pins its earlier immutable evidence commit. Commands that use Cargo were serialized with a shared filesystem lock. No full CI or gate-profile success is claimed.

| Command | Result | Receipt |
|---|---|---|
| `cargo test -p centraid-vault --no-fail-fast` | 1,082 passed, 0 failed, 2 ignored, 99 reported suites | [Vault](validation/vault.txt) |
| `cargo test -p centraid-core --no-fail-fast` | 288 passed, 0 failed, 18 reported suites | [Core](validation/core.txt) |
| `cargo test -p centraid-domain --no-fail-fast` | 132 passed, 0 failed, 7 reported suites | [Domain](validation/domain.txt) |
| `cargo test -p centraid-identity` | 32 passed, 0 failed | [Identity](validation/identity.txt) |
| `cargo test -p centraid-screens --no-fail-fast` | 623 passed, 0 failed, 44 reported suites | [Screens](validation/screens.txt) |
| Current Money and Room artifact checks after final test extensions | Money 7/7, artifact capture 1/1; hand-entered restore/Undo and two-transaction categorization/Undo asserted | [Money](validation/money-current.txt), [Room capture](validation/room-fixture-capture.txt) |
| Final Locker/editor checks | Locker 1/1, form blocks 2/2, field state 9/9, format and Clippy passed | [Locker](validation/locker-current.txt), [Locker Clippy](validation/locker-clippy.txt) |
| `cargo fmt --all -- --check` and Clippy on the affected Rust crates and all targets with `-D warnings` | Passed | [Format and Clippy](validation/fmt-clippy.txt) |
| `cargo test -p xtask native_parity` | 25 passed, 0 failed | [Parity tests](validation/native-parity.txt) |
| `cargo xtask rules` | All other listed rules clean; data-pin failed and remains excluded by the owner | [Full rules output](validation/rules.txt) |
| `cargo xtask doc-links` | 0 findings | [Documentation links](validation/doc-links.txt) |
| `cargo xtask design --check` | Passed | [Generated design](validation/design.txt) |
| `cargo build -p centraid-core-ffi` then `gradle -p mobile :core:jvmTest --no-daemon` | 40 passed, 0 failures/errors/skips across 10 suites; real JNA/ABI path | [Native library](validation/jvm-native-library.txt), [JVM tests](validation/jvm-tests.txt) |
| Android API 24 ARM64 native Core build | Passed; Android floor retained | [Native build](validation/android-core-api24.txt) |
| Android debug APK assembly | Passed; arm64-only packaging, API 24 native floor, matching embedded Core SHA, JDK time desugaring present | [APK assembly](validation/android-apk.txt), [artifact hashes](validation/android-artifact.json) |
| Android unit tests | 210 tests, 0 failures/errors, 2 opt-in captures skipped in the default suite; capture was run separately | [Android unit run](validation/android-unit.txt), [JUnit totals](validation/android-unit-summary.json) |
| Final opt-in Android captures and secret-control regressions | Passed: 20 light and 20 dark review previews, two separate scrolling-layout previews, and both masked-control cases | [Capture run](validation/android-captures.txt), [layout fixture](glass-layout-fixture.json) |
| `bun run docs:build` | Passed | [Docs build](validation/docs-build.txt) |
| `bun run docs:smoke` | Passed, 12 pages and internal links | [Docs smoke](validation/docs-smoke.txt) |

The two ignored Vault cases are an opt-in cache-cost measurement (`the_cost_of_a_cache_of_150000_words`) and an opt-in fixture writer (`write_the_vectors`).

The screen suite includes actual formatter export tests for eight non-Locker apps (ten choices including Health), staged vCard import review/confirm, ambiguous-date no-commit behavior, paged organizers with one Undo, and sealed Locker session/owner-result tests. The Domain suite includes the Year-3 fixture of 27,600 rows across all app read families. These assertions bound rows, pages and statements rather than elapsed time.

## Outstanding platform evidence

The Linux host has no Xcode/iOS SDK, simulator, connected Android phone, Android emulator acceleration, or connected iPhone. Swift source inspection and syntax parsing are not SDK typechecking. The [Mac handoff](ios-handoff.md) lists the required commands. Calendar grid, note editor, photo grid, share extension, and People/Money iOS simulator captures and physical-device checks are still owed.

Android previews are Compose/Robolectric renderings of actual Rust Room responses. They show layout and copy; they do not establish native permission, biometric, picker, clipboard, download, share/save, or GPU blur behavior on a phone. Device checks must include Locker relocking and late callback rejection, the original clipboard lease, per-store follow permissions, private staging cleanup, and floating controls while content scrolls behind them.

The assistant data-pin check is expected to fail because the owner excluded data regeneration and pinning. The failing line begins: “data v0.3 is marked stale (coverage), but the contract moved again since it was marked”. Its failure must not be read as a green gate or fixed by changing recorded hashes.
