# Native CI evidence — PR #1201

## Latest published checkpoint

Revision `d12fedf55fb8e7f49704aeb3087184933002ef12`, [workflow run 43950960662](https://github.com/srikanth235/centraid/actions/runs/43950960662): the workspace nextest/doctest lane and every other gate lane passed except `doc-links`. iOS passed with 121 XCTest tests and zero failures, including the real simulator Rust core and app build. Android's Kotlin compilation and selected `BackupCheckControlsTest` invocation passed from cache; these do not establish packaging or emulator behavior. Engine, dependency review and PR title passed.

The sole gate finding was the report's relative Markdown link to an ignored local JNI binary. Root downloaded artifact `14275993136`, verified SHA-256 `21ad31dfaa0979235f10388f7faf0df671cdbce02a376e29d3766ce396b21006`, and reviewed the one-line correction: retain the artifact path, size and hash as code rather than a repository link. Root independently reran guarded `xtask doc-links`: zero findings across 160 Markdown files, 613 relative links and 63 anchors. That correction and the owner-requested app/docs visual redesign are currently local; this is not a final-head CI pass.

## Earlier published checkpoint

Revision reviewed: `7d22a64fe2241cc84b59c3a283630f1a96d462dd` (workflow run `43927000790`). The following historical evidence is bound to that revision.

- **Workspace gate summary:** 6,843 tests run, 6,842 passed, 1 failed, 13 skipped. The single failure was the stale Docs Drive expectation described below; the other gate lanes (`iOS`, `Android`, `engine`, `dependency-review`, `pr-title`) passed. The CI artifact used for this summary was SHA-256 verified by root (`a0dbee49c5da7bcd9dcf66a3734155fb0d7b568627ba84a69e72bc6768b57351`).

- **iOS: success.** The simulator Rust core build ran `mobile/scripts/ios-core.sh aarch64-apple-ios-sim`, with `--features llama`; the log shows 25 `centraid-*` crates compiled and a completed dev profile. `CARGO_INCREMENTAL=0`. The Swift 6 app XCTest run reports 121 tests, 0 failures. HealthSeeder's simulator build reports `BUILD SUCCEEDED`. The job uploaded `ios-verification` (including logs and `.xcresult`).
- **Android: success.** `:androidApp:compileDebugKotlin` succeeded (11 actionable tasks: 3 executed, 8 cached). The shared-fixture invocation selected `dev.centraid.android.kit.BackupCheckControlsTest`; its `testDebugUnitTest` task succeeded (33 actionable tasks: 11 executed, 12 cached, 10 up-to-date). Both selected tasks report `FROM-CACHE` in their task output. This CI job type-checks Kotlin only; it does not package native libraries or run an emulator.
- **Other checks at review:** `engine`, `dependency-review`, and `pr-title` succeeded. `gate` ultimately failed on the single obsolete Docs Drive assertion; this report does not claim that workflow passed.

Evidence: [workflow run 43927000790](https://github.com/srikanth235/centraid/actions/runs/43927000790), iOS job `133509001765`, Android job `133509002334`. Logs were read through the connected GitHub integration.

## Focused Docs Drive correction

The workflow's sole failure was `centraid-screens::docs_drive::trash_asks_first_says_it_can_be_restored_and_dismissing_writes_nothing` (old assertion at `docs_drive.rs:546`: expected a confirm). The current behavior already moves a row to Trash immediately with Undo; the stale test was corrected to assert the row-menu action, no confirm, the exact Undo status, dismissal as a no-op, and the `trashed` state from the existing document-history loader before/after Undo. The same ID, title and body are asserted after Undo. The product ruling now distinguishes reversible Trash/restore Undo from confirmations for permanent deletion and Empty trash.

- Guarded command `cargo test -p centraid-screens --test docs_drive`: first attempt was 30 passed / 1 failed. That failure was in the new oracle: it incorrectly expected the History load to omit a trashed document. `crates/apps/docs/src/queries.rs` deliberately loads the entity without a deleted-row filter and its fold maps `deleted_at` to `trashed`; the Docs Drive shelf excludes it separately. The test now asserts that actual contract.
- Guarded rerun of the same command: 31 passed, 0 failed, 0 ignored; test binary reported 138.27s (reported by Cargo, not an asserted budget). Guard final snapshot: 37.9 GiB free, 9.7 GiB task artifacts.
- Guarded command `rustfmt --edition 2024 --check crates/screens/tests/docs_drive.rs`: passed.
- The first guarded workspace `cargo fmt --check` reported cross-slice formatting in C2's `crates/xtask/src/design_icon.rs` (lines 284, 644, 913, 921 and 931); no diff was reported in the owned test file. C2 formatted that file, then the combined tree passed guarded `cargo fmt --all -- --check`. Workspace formatting is resolved.
- Private logs: `/private/tmp/centraid-1201-ci-evidence/docs-drive-focused.log` (first oracle failure), `docs-drive-focused-rerun.log` (31/31 pass), `fmt-check.log` (workspace formatting diffs) and `docs-drive-rustfmt.log` (owned file formatting pass). These contain command/build output only, no fixture secrets.

## JVM binding correction

The guarded `cargo xtask gate --profile mobile-jvm` initially ran 45 tests and failed one stale unknown-status assertion: `-6` is now the committed `CENTRAID_VAULT_DAMAGED` code. The committed-header/enum equality check already passed. The test now exercises `Int.MIN_VALUE` and `Int.MAX_VALUE`, asserts both are absent from the header and enum, and verifies each remains `UnknownStatus` through the binding. No runtime status handling or header changed.

The complete guarded mobile JVM rerun passed: 15 suites, 45 tests, 0 failures, errors or skips, including generated-design drift checking. Root read the gate output and independently parsed the JUnit XML. Before/after evidence is preserved under `/private/tmp/centraid-1201-mobile-jvm-before/` and `/private/tmp/centraid-1201-mobile-jvm-after.log`.

## Review checkpoint before publishing the docs batch

Root also ran guarded workspace formatting, scoped all-target xtask Clippy, all 27 structural rules (0 pending), and `bun run check` successfully. Docs generator/icon/ontology/bundle evidence is in `docs-rebuild.md`; matching native builds and simulator/emulator screen evidence are in `native-verification.md`. The earlier interrupted full local gate is not a pass. The PR's checks and umbrella issue record the subsequent CI result for the exact published head.
