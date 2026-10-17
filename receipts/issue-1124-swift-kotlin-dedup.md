# #1124 — The owner's rulings of 2026-10-15/16, and Swift and Kotlin stated once

PR [#1124](https://github.com/srikanth235/centraid/pull/1124) carries five commits: the iOS Money screens, the reinstall onboarding fix, the owner's rulings of 2026-10-15/16, the Swift↔Kotlin de-duplication wave and the per-app routing facades. Rulings are recorded in [`docs/decisions.md`](../docs/decisions.md) under "The owner's rulings of 2026-10-15" and "Ruled on 2026-10-16"; the backup work is under [#1080](https://github.com/srikanth235/centraid/issues/1080), the vault under [#1029](https://github.com/srikanth235/centraid/issues/1029), and the PR-gate edits (`scripts/ci/configure-sonarcloud.mjs`, the emitters step) were made under [`docs/decisions.md#the-pr-gate-loop-892`](../docs/decisions.md#the-pr-gate-loop-892) ([#892](https://github.com/srikanth235/centraid/issues/892)).

## What changed

- **Money (iOS).** The Money screens drawn to the prototype.
- **Onboarding.** A reinstall's first vault asks nothing; the nativetools tests seed once.
- **The rulings (2026-10-15/16).**
  - Vault: one baseline migration (`001_baseline.sql`) with the `command` schema renames; the access-device tables and Tally residue dropped; Notes `[[wikilinks]]` compile to references.
  - `Request::Page` reads only `PAGE_TABLES`. Its `where` predicate is held to the same list by an SQLite authorizer (`Vault::keyset_page_reading_only`).
  - Backup (#1080): refusals stop the pass; takeover by an older copy is refused; deleted files stay while a kept snapshot names them, and superseded snapshot parts are collected at once; iOS re-finds a gateway that moved address.
  - DESIGN.md rewritten mobile-first, with one button vocabulary and width rule, and Dynamic Type on both shells.
  - Photos' face surfaces removed from every layer, as ruled ("Faces in Rust", Q-1047-2): `crates/apps/photos/src/faces.rs` and its queries, the face-review and Photos People machines, bridges and reads, their `contracts/screens/photos-*` fixtures and both shells' views.
  - An edited photograph's camera original is kept as a second `media_asset` with `source_asset_id` lineage (A20).
  - Locker's manifest drops its four unused act scopes (37 to 33), with a kit check that a manifest's acts and scopes agree.
  - New app-query arms for Docs, Locker, People and Notes in `crates/core/src/app_query/` and `crates/apps/*`.
  - The gateway advertises itself over Bonjour/dns-sd (`crates/gateway/src/server/bonjour.rs`), which is what iOS's re-find browses for.
  - Gate tooling: `cargo xtask doc-links` checks every in-repo link and anchor, and `crates/xtask/src/select.rs` narrows the `local` profile's tests to the crates a change touches and their dependents (hand-off 6.5).
  - Privacy and terms pages rewritten for the phone-is-the-vault product (`scripts/docs-site/src/content/{privacy,terms}.html`), unpublished, with `TODO(owner)` notes.
  - `docs/harnesses.md` and `docs/recognition-automations.md` deleted: both described planes that no longer exist.
- **Swift and Kotlin stated once.**
  - Copy is generated from `copy/<app>.json` by `:shared:generateCopy`; the checked-in Kotlin twins and `CustodyCopy` are gone. About 260 sentences both shells typed moved into copy, with one `CappedCount` phrase.
  - The dead SPM host build is removed: `Package.swift`, every `#if canImport(CentraidShared)` fallback, and the Swift copy wrappers.
  - Shared now states: the Photos library layout, justified rows, memories sketch and places plot; the lightbox text; `MediaFormat`; `WriteState.refusal`; `ScreenIds`, `RowRoutes`, `ScreenOpenings`; and every app's routing (`TasksRouting` and the per-app facades).
  - Drift fixed: backup names its one Ink action (`ink_action`; Android drew two); the chat scope list includes money; Money decisions are keyed, not compared against copy text; byte size rounds half up as Rust does; the restore screen scans the pairing QR.
  - Build-time generation: Swift protos by an Xcode pre-build phase; the emitters gate fails on untracked emitted files; every shared command id is checked against the Rust registry; Gradle test inputs cover the Rust sources specs read.
- **User-visible changes.** Lightbox dates read "3 February 2026 23:30" (shared formatting, not device locale); iOS byte sizes change at exact ties; the Places plot inset is 32 on both shells; the slideshow line reads "{n} of {total}, {s} seconds a photo"; the home header reads "Moved to your other phone" / "On this phone".

## Verification

Run on the merged tree (all five commits) before the push, except where noted:

```
./gradlew :shared:jvmTest :core:jvmTest → 1391 shared + 36 core passed, 0 failed (includes AppRoutingSpec)
xcodebuild … test (iPhone 17 simulator, protos regenerated from an empty Sources/Generated) → 114 passed, 0 failed
cargo test -p xtask                    → 116 + 2 passed
cargo nextest run -p centraid-assist   → 184 passed
cargo clippy, cargo fmt --check, cargo xtask rules, bun run lint:copy, cargo xtask doc-links → clean
cargo nextest run --workspace          → 3185 passed, 6 skipped (on ff72d4cc3; the routing commit adds only 8 lines to `screen.proto`, covered by `cargo test -p centraid-api-proto` → 7 + 2 passed on the merged tree)
```

Simulator walk: Tasks and Catch up; Photos library; a lightbox and its info sheet; Backup; restore's Scan QR code through the photo picker (the square read into the code field); Notes, Money, People, Agenda and Docs routes. Not walked: Locker (passcode prompt) and Docs folders.

Not verified: Android. No SDK was on the machine, so every `mobile/androidApp/` edit is unverified until CI's Android lane runs. The `lane-release-mobile.yml` change (`xcodebuild … test` in place of the dead `swift test`) was read, not run.

## Audit

- **What changed is true of the diff: PASS.** Every bullet resolves: `keyset_page_reading_only` and `PAGE_TABLES` at `crates/core/src/api.rs:118-229`; `001_baseline.sql` is the only rung (plus the `999_fails.sql` fixture); `generateCopy` at `mobile/shared/build.gradle.kts:295` and no `CustodyCopy` anywhere; `CappedCount`, `MediaFormat` (half up), `ScreenIds`, `RowRoutes`, `ScreenOpening`, `TasksRouting` and the Notes, Money and People routing files exist in `commonMain`; `mobile/iosApp/Package.swift` is deleted and no code carries `canImport(CentraidShared)`; `ink_action` at `BackupScreen.kt:186`; `generate-swift-protos.sh` is `preGenCommand` plus a pre-build phase in `project.yml`; the untracked check is `crates/xtask/src/gate.rs:472-490`; the new bullets hold too (`faces.rs`, `docs/harnesses.md` and `docs/recognition-automations.md` absent; `crates/gateway/src/server/bonjour.rs`; `select.rs` builds a dependents map at line 287; `act_scope_disagreements` in `crates/apps/kit/src/manifest.rs` and the Locker scope count 37 to 33 in `crates/apps/locker/src/manifest.rs:176`; privacy.html opens "DRAFT FOR THE OWNER'S REVIEW").
- **Nothing material missing from the receipt: PASS.** Against the 595-file `git diff --stat origin/main..HEAD`, the previously missing items (faces removal, doc-links and `select.rs`, privacy and terms, Locker scopes, Bonjour, deleted docs, A20, new query arms) are now named; I found no large unmentioned change.
- **Verification records outcomes and is honest: PASS.** Each command has a count or "clean", the nextest figure is dated to `ff72d4cc3` with the reason it still holds, and the Android lane and `lane-release-mobile.yml` are stated as not verified. Corroborated from artefacts: `mobile/shared/build/test-results/jvmTest` holds 94 XMLs, 1391 tests, 0 failures, 0 skipped, all dated 17 Oct 12:26 (after the 12:16 routing commit) and including `AppRoutingSpec`; `mobile/core` holds 36 tests, 0 failures (dated 00:28, which the receipt does not claim to be fresher); the `Test-Centraid-2026.10.17_12-20-28` xcresult reads 114 passed, 0 failed, 0 skipped. On the record only: nextest 3185, xtask 116 + 2, assist 184, api-proto 7 + 2, clippy, fmt, rules, lint:copy and doc-links.
- **Citations resolve: PASS.** `docs/decisions.md` has "The PR gate loop (#892)" at line 554, "The owner's rulings of 2026-10-15" at line 2820 and "Ruled on 2026-10-16" at line 2870; "Faces in Rust", Q-1047-2 and the hand-off 6.5 supersession are in those tables.

Overall: PASS
