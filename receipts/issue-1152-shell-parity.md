# Issue #1152 — the Android and iOS shells at parity

## Lane A — Android: the first-launch deck, and three fields Android ignored

**What changed**

- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/words/FirstLaunchScreen.kt` — rewritten: the deck of three raised-paper slips from `HomeFirstLaunch.slides` (title, sentence, a picture each: the house of Home's roster, a question and its answer, the `net` rule from the phone to a sealed copy), `next_label` / `skip_label` / `make_label` / `restore_label` as the controls, Next and swipe left/right on the whole band, Skip to the last slip and gone there, reduced motion snaps. Tags are iOS's: `first-launch`, `first-launch-skip`, `first-launch-primary`, `first-launch-secondary`, `first-launch-house|assistant|backup`. `gate.body` is no longer drawn (iOS does not draw it either).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/ReducedMotion.kt` — new: the reduced-motion reading that was private to the lightbox, shared.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/photos/PhotosLightboxScreen.kt` — uses the shared reading; draws `words.opening` (`small` / `onStageSoft`) in place of `StageSpinner` over an empty stage. `StageSpinner` stays (the fetching line and the editor use it).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotoShelfScreen.kt` — `NameSheet` takes `canSubmit` and computes nothing; `RenameSheet` passes its own blank guard (see Rust gap below).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotosCollectionsScreen.kt` — the new-album sheet passes `collections.new_album_can_submit`.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt` — `SwitcherAction` takes `spoken`; the make row passes `sheet.make_spoken`.
- `docs/decisions.md` — R-1129-18 no longer says Android draws the marks above a sentence.

**Verification**

- `flock /tmp/centraid-gradle.lock ./gradlew --no-daemon -Pkotlin.compiler.execution.strategy=in-process -Pcentraid.android=true :androidApp:compileDebugKotlin :androidApp:testDebugUnitTest` (in `mobile/`) → BUILD SUCCESSFUL; 32 tests, 0 failures, 0 errors.
- `cargo xtask rules` (own `CARGO_TARGET_DIR`) → exit 0, every rule `ok`, incl. `native-accessibility` (231 files) and `first-launch-asks-nothing` (2 files).
- `grep -c "slides\|next_label\|skip_label" FirstLaunchScreen.kt` → 4; `grep -n "words.opening"` in the lightbox → 1 hit; `grep -n "make_spoken"` in `HomeScreen.kt` → 1 code hit (plus the KDoc); `grep -n "isNotBlank" PhotoShelfScreen.kt` → 1 hit, in `RenameSheet` only (no `ready` left in `NameSheet`).
- `first-launch.yaml` read step by step against the deck (no emulator): see the lane report.

**Unverified**: no emulator or Compose UI test ran; the deck's look, gestures and TalkBack order are read, not observed. No Swift touched.

**Rust gap**: `PhotosRenameSheet` and `PhotosPlaceNameSheet` carry no can-save flag, so the shelf and place rename sheets still guard a blank name in the view (as iOS's shelf does).

**Falsification**

1. *The gate types no app-id list and asks for nothing.* Throwaway: appended `private val typed = listOf("agenda", "locker")` to `FirstLaunchScreen.kt` and ran `cargo xtask rules` → `first-launch-asks-nothing` FAILED naming `"agenda"`, so the rule reads this file and the deck's single typed ids (`AppMark(appId = "agenda")`, `"locker"`, as iOS's scenes) are not a list. Reverted; the file is byte-identical to the commit.
2. *The deck's words are Rust's and the flow's strings are on the slips.* Read `crates/screens/src/shell/home.rs` `first_launch()` and `strings/home.rs`: slide 1's title is `first_launch_assistant_title` = "An assistant on this phone", the last primary is `make_label` = "Get started", Skip is `skip_label`; `crates/screens/tests/shell_home.rs` asserts three slides and non-empty next/skip. Result: the strings the flow asserts are carried by the fields the deck draws. Not run on a device.

## Lane B — Android: Money's home drawn as iOS draws it

**What changed** (Android only; no Swift, Rust or proto edits):

- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyGeometry.kt` (new): the pure arithmetic — a bar's height from basis points (clamped to the scale, never shorter than its stub), newest-first month order, the chart's one spoken label, a category line's three figures (a dash where there is no plan), the Needs row's joined amounts.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyTable.kt` (new): `MoneyFigureColumns`, `MoneyFigureCard`, `MoneyCategoryHeader`, `MoneyCategoryRow`, `MoneyColumnFigure`, `MoneyNeedsRow`, `FitText` (an amount shrinks before it clips), `MoneyHairline`, `moneyRadius`.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyChart.kt` (new): `MoneyCashflowChart` (one semantics node), `MoneyLegend`, `MoneyMonthRow`.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyParts.kt`: the hero's sentence shares a baseline with its figure; Planned/Left lay across the page.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/money/MoneyScreens.kt`: Spending draws `planned_label`/`spent_label`/`left_label` heads over three-figure lines and In/Out/Net on a plate; Activity's needs row is tappable and sends `category_picked` with `needs_key`; Cashflow draws chart, legend (`in_label`, `out_label`, `partial_label`) and months newest first.
- `mobile/androidApp/src/test/kotlin/dev/centraid/android/screens/money/MoneyGeometryTest.kt` (new): six JVM tests of the above.
- Test tags: `money-category-<id>` kept; `money-needs-category` (iOS's identifier); `money-month-<month>` kept.

**Verification**

- The Android check (`compileDebugKotlin testDebugUnitTest`, through `flock /tmp/centraid-gradle.lock`) → BUILD SUCCESSFUL; 38 tests, 0 failures, 0 errors (32 at base + 6 new).
- `cargo xtask rules` (own `CARGO_TARGET_DIR`) → 15 rules, all `ok` (incl. `native-accessibility`, `first-launch-asks-nothing`).
- `grep -n "planned_label\|left_label\|needs_key\|partial_label\|in_bp\|out_bp" mobile/androidApp/src/main/kotlin` → all six referenced in code (MoneyScreens.kt, MoneyChart.kt), not only KDoc.

**Unverified**: no device or emulator run; the look (baseline alignment of the hero, bar heights at font scale, `FitText` step sizes, the partial outline at 1.5dp) is by construction, not seen. No Maestro flow selects the new tags yet. The commits for slices 1-2 were not each built alone; the tree was built green at slice 3 and at the final head.

**Falsification**

1. Claim: the bar arithmetic and the newest-first order are pinned by the test, not merely written. Check: temporarily removed the `coerceIn(0, BASIS)` clamp and made `newestFirst` return its input unchanged, ran `MoneyGeometryTest`. Result: red as it should be — `aBarOutsideTheScaleIsClampedAndNeverVanishes` and `theMonthTableRunsNewestFirstAndTheChartIsLeftAlone` failed (2 of 6); change reverted with `git checkout`, tree clean.
2. Claim: the shell scales the chart by Rust's basis points and sends Rust's key, deciding nothing. Check: `grep -n "maxOf\|.max()\|maxBy" MoneyChart.kt MoneyTable.kt` → no hits (the only `maxOf` is the 2dp stub floor in `MoneyGeometry`); the only `category_picked` built from the Needs row takes `activity.needs_key`, no literal. Result: holds.

## Lane R — the `native-shell-parity` rule

**What changed**

- `crates/xtask/src/native_parity.rs` (new) — the rule: a hand-rolled `.proto` parser over `*_screens.proto` + `screens.proto` (every field, oneof arms in, enum values / `reserved` / `option` out, nested messages as `Outer.Inner.field`), a comment cutter for Kotlin and Swift (line, block and nested block comments, KDoc; string and char literals kept whole so `"*/*"` and `'"'` open nothing and `"\(x.label)"` stays code), the Kotlin readers (`.name`, `name =`, Wire's `name_`; `val name =` is a local) and the Swift readers (`recv.camel`, `camel:` but not `let camel:`, SwiftProtobuf's `_p`, `ID`/`URL`, a bare `.camel` only for a oneof arm), and the ratchet's four verdicts.
- `crates/xtask/src/native_parity_register.rs` (new) — the register, 202 rows over 4531 items, generated from the census and classified by reading the shell code.
- `crates/xtask/src/native_parity_tests.rs` (new) — 20 fixtures.
- `crates/xtask/src/native_rules.rs`, `crates/xtask/src/main.rs` — `native_shell_parity` joins `native_rules::all`; the two modules are declared.
- `crates/xtask/README.md` — a row in the rules table. `mobile/README.md` — the paragraph under "The shells, and what they hold".

**The register at close** (the umbrella branch with lanes A, B and D merged in): 202 rows. Gap C 5 · Platform Android 18 · Platform iOS 11 · Gap F 168 (140 read by neither, 17 only SwiftUI reads, 11 only Compose reads). Lane F is: 13 runtime-originated (the proto says no shell sends or draws them: `ScreenEvent.timer_fired` …, `RollReported.*`), 128 read by neither, 16 name collisions (the hit is another symbol; each has a comment saying which) and 11 one-sided gaps nobody owns yet (each with a comment).

**The ratchet, as it ran.** The register was first seeded from the census at the base, with lane A's five, lane B's six and lane D's eight rows in it; after merging `claude/zealous-dijkstra-dgi6qr` the rule said, for each of the nineteen: `both shells read it now; delete its register entry (a closed gap leaves the register)` (`MoneyCategoryTable.planned_label`, `.left_label`, `MoneyActivityData.needs_key`, `MoneyCashflowSeries.partial_label`, `MoneyCashflowMonth.in_bp`, `.out_bp`, `PhotosCollections.new_album_can_submit`, `PhotosLightboxWords.opening`, `HomeVaultSheet.make_spoken`, `HomeFirstLaunch.slides`, `.next_label`; lane D's `Effect.browse_gateways`, `EffectResult.gateways_sighted`, `BrowseGateways.window_ms`, `.repeat_ms`, `GatewaySighting.service_name`, `.txt`, `.addresses`, `GatewaysSighted.sightings`) and they were deleted. With lanes A and B merged and the eleven rows put back as a throwaway: `FAIL native-shell-parity — 11 finding(s) in 247 file(s) scanned (4531 item(s) in 23 proto file(s), 222 in the register)`; with lane D merged, the eight rows above failed the same way. One more row left with them by accident of the matching: `LockerWallEvent.lock` (a name collision, registered as read by SwiftUI's `NSLock` only) turned symmetric when lane D's Kotlin spelled an unrelated `.lock`; the field is still read by neither shell, and the rule can no longer say so.

**Verification**

- `cargo test -p xtask` → 154 passed + 2 passed, 0 failed (20 are the new fixtures).
- `cargo xtask rules` → 16 rules, all `ok`, including `ok native-shell-parity — 250 file(s) scanned, clean (4531 item(s) in 23 proto file(s), 202 in the register)`.
- `cargo clippy -p xtask --all-targets -- -D warnings` → clean. `cargo fmt --all -- --check` → clean.
- Red-first, throwaway (not committed): in `MoneyScreens.kt` renamed the two Android reads `spending.in_out_net` to `spending.in_out_nets`; `cargo xtask rules` →
  `FAIL native-shell-parity — 1 finding(s) in 247 file(s) scanned (4531 item(s) in 23 proto file(s), 211 in the register)` / `MoneySpendingData.in_out_net: only SwiftUI reads it (Kotlin `in_out_net`, Swift `inOutNet`); read it in the other shell, or register it in native_parity_register.rs`. Reverted; the rule is `ok` again.
- Cross-check: an independent Python census of the same 4531 items (written for the classification, not committed) agreed with the rule on all but one row (`BackupLine.total`, where Python counted an unrelated Swift `total`); the register was made to the rule's verdict.

**Unverified**: no Swift edited, none compiled; SwiftProtobuf's naming is mirrored from the corpus (`photoID`, `openURL`, `effectID`, `hasValue_p`) not from the generator, which is absent here (`Sources/Generated/` is gitignored). The Kotlin side is by Wire's snake_case as the Android code spells it. The classification of each row is by reading, not by running a shell.

**Limits the rule has, stated in its docs**: the match is by FIELD NAME, not message, so a hit can be another symbol (`landed =` in a photo grid, `NSSortDescriptor(ascending:)`, an `NSLock`'s `.lock`) and a Kotlin call that passes a field positionally (`SheetOpened(which)`) never spells it. Each such row is in lane F with a comment naming the collision; they leave the register when the field is consumed or deleted.

**Falsification**

1. *Claim: a comment never counts as a read.* Check: `PhotoCells.kt` names `PhotoTile.fetch_percent` in KDoc; if comments counted, the rule would see Android reading it and fail the register's `F / Both` row for it. `cargo xtask rules` is `ok` with that row in; and the fixture `a_name_in_a_comment_is_not_a_read` puts every field in line, block, nested-block and KDoc comments and sees all five unread. Result: holds.
2. *Claim: a bare Swift `.name` is not a read of a plain field, only of a oneof arm.* Check: `AgendaCalendarChoice.hidden` is hit by SwiftUI's `.scrollContentBackground(.hidden)` and `.toolbar(.hidden, …)` in the corpus; with the receiver requirement it is read by neither (register: `F / Both`) and the rule is green; the first prototype of the census, without the requirement, listed it as read by SwiftUI only, which is the false one-sided row this guards against. Fixture `a_bare_member_reads_a_oneof_arm_and_nothing_else` pins both halves. Result: holds.
## Lane D — Android: browse the LAN for gateways (`BrowseGateways`)

**What changed**

- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/GatewayBrowse.kt` — new: the browse's pure rules (`claimsGateway`, `spelling`, `txtOf`), the two platform seams (`ServiceFinder`, `AddressResolver`), `GatewayBrowseRun` (one window: resolve what is seen, drop what claims no `gw`, merge one instance across interfaces and answers, end at the clock or on a failed finder) and `OneAtATime` (pre-Android-14 resolves run one at a time).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/NsdBrowse.kt` — new: `NsdServiceFinder` (`discoverServices`, a `MulticastLock` held from `start` to `stop`) and `NsdAddressResolver` (`registerServiceInfoCallback` from API 34, a serialised `resolveService` below).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/GatewayBrowsing.kt` — new: the effect's life, one browse per screen instance, a window answered as `GatewaysSighted` every `repeat_ms` under the one effect id.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/ShellEffects.kt` — performs `browse_gateways`; stops the browses of instances that left `Screens.views`.
- `mobile/androidApp/src/main/AndroidManifest.xml` — `CHANGE_WIFI_MULTICAST_STATE`.
- `mobile/androidApp/build.gradle.kts`, `mobile/androidApp/gradle.lockfile` — `kotlinx-coroutines-test` on the unit-test classpath (virtual time); two lock entries, written with `--write-locks`.
- `mobile/androidApp/src/test/kotlin/dev/centraid/android/session/GatewayBrowseTest.kt` (17 tests), `GatewayBrowsingTest.kt` (7 tests) — new.
- `mobile/README.md` (two "does not browse yet" sentences, the Android file list, the hand-off row), `docs/release/v1-handoffs.md` (row 8.7), `SECURITY.md`, `docs/gateway.md`, `docs/recovery/pairing.md`, `docs/decisions.md` (the Q-1080-D3 row) — "Android does not browse yet" rewritten to current state.

**Verification**

- `flock /tmp/centraid-gradle.lock ./gradlew --no-daemon -Pkotlin.compiler.execution.strategy=in-process -Pcentraid.android=true :androidApp:compileDebugKotlin :androidApp:testDebugUnitTest` (in `mobile/`) → BUILD SUCCESSFUL; 56 tests, 0 failures (32 at base, 17 `GatewayBrowseTest`, 7 `GatewayBrowsingTest`).
- `cargo xtask rules` (own `CARGO_TARGET_DIR`) → exit 0, 15 rules `ok`, incl. `no-listening-socket` (816 files), `native-accessibility` (236) and `first-launch-asks-nothing`.
- `cargo xtask doc-links` → 0 findings over 111 files.
- `grep -rn "browse_gateways\|gateways_sighted" mobile/androidApp/src/main/kotlin` → 3 code hits; `grep -c CHANGE_WIFI_MULTICAST_STATE` in the manifest → one line; `grep "does not browse yet" mobile/README.md` → nothing.

**Unverified**: `NsdManager` on a device or emulator (the discovery, the resolve on API 33 and 34, the multicast lock, the listener's behaviour when a stop races its start) — the real-network check is row 8.7 of the hand-offs. The `ShellEffects` wiring (the views collector, the `instance !in views` guard) is read, not run: `GatewayBrowsingTest` proves `retain` ends a closed screen's browse, nothing runs `ShellEffects`. No Swift touched; the pure `FoundService`-with-handle design differs from iOS's only where the platform forces it (below).

**Differences from iOS, forced by the platform**: a discovered `NsdServiceInfo` carries no TXT record, so Android resolves first and drops a result with no `gw` afterwards (iOS drops it before it connects). There is no host-is-a-name case (`NsdServiceInfo` gives literals), so iOS's `testANameIsNeverAnAddress` becomes the port-bound test. A screen's close is not signalled to the shell on Android as it is on iOS (`ScreenUpdate.closed` is consumed inside `Screens.apply`); it is read off `Screens.views`.

**Falsification**

1. *A result whose TXT carries no `gw` is never reported.* Throwaway: `claimsGateway` made `true` → `onlyARecordWithAGatewayIdIsWorthReporting` and `aResultWithNoGatewayIdIsNeverReported` failed; reverted.
2. *A closed screen's browse ends, and only its.* Throwaway: `GatewayBrowsing.retain`'s `closed.forEach(::stop)` commented out → `aClosedScreenEndsItsBrowseAndOnlyItsBrowse` failed (3 failures of 56 in all); reverted, 56 green.
