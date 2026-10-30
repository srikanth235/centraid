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
- `cargo xtask rules` → 16 rules, all `ok`, including `ok native-shell-parity — 251 file(s) scanned, clean (4531 item(s) in 23 proto file(s), 202 in the register)`.
- `cargo clippy -p xtask --all-targets -- -D warnings` → clean. `cargo fmt --all -- --check` → clean.
- `cargo xtask gate --profile local` (own `CARGO_TARGET_DIR`, cold, after the last umbrella merge incl. lanes A, B, D, E) → `gate local: PASS`: fmt 5.2s, clippy 1.9s (541.7s on the first cold run), test 1014.5s, restore-drill 29.6s, rules 1.7s (16 applied, 0 pending), doc-links 1.0s, ledgers 0.0s; TOTAL 1054.0s of the 3200s cold ceiling.
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

## Lane E — Android: the unit tests iOS has and Android lacked

**What changed** (Android only; no Swift, Rust or proto edits):

- `mobile/androidApp/src/test/kotlin/dev/centraid/android/screens/chat/ChatMarkdownTest.kt` (new, 8 tests).
- `mobile/androidApp/src/test/kotlin/dev/centraid/android/kit/SleepNightsTest.kt` (new, 7 tests) and `mobile/androidApp/src/test/kotlin/dev/centraid/android/kit/ExerciseNamesTest.kt` (new, 1 test). `SleepNights` and `ExerciseNames` were already pure; no production edit.
- `mobile/androidApp/src/test/kotlin/dev/centraid/android/backup/LibraryDeletionTest.kt` (new, 8 tests).
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/LibraryDeletion.kt` (new): the smallest extraction. `LibraryRefs` (`of`/`row`: the one spelling of `image:<_ID>` / `video:<_ID>`, as iOS's `LibraryRefs`) and `LibraryDeletion` (`target`, `unchanged`, `deletedHashes`, `answer`, `failed`): the deleter's three rules lifted out of the `ContentResolver` code, unchanged.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/MediaStoreDeleter.kt`: calls the above; its KDoc points at them; the private `IMAGE_REF`/`VIDEO_REF` copies are gone.
- `mobile/androidApp/src/main/kotlin/dev/centraid/android/session/LibraryRoll.kt`: mints refs with `LibraryRefs.of` and reads them with `LibraryRefs.row`, so the walker and the deleter share one spelling (its private constants are gone).

**Per-case table** (iOS case → Android):

| iOS test | Android |
| --- | --- |
| `ChatMarkdownTests.testBoldItalicAndCodeLoseTheirMarkers` | ported: `boldItalicAndCodeLoseTheirMarkers` (+ `theMarkersBecomeStyleAndNotCharacters`, the weight/slant/mono each marker becomes) |
| `testBulletsAndNumbersBecomeItems` | ported: `bulletsAndNumbersBecomeItems` (also `2)` numbers as `2.`) |
| `testAStarThatOpensBoldIsNotAListItem` | ported: `aStarThatOpensBoldIsNotAListItem` |
| `testHeadingsKeepTheirWordsAndDropTheHash` | ported: `headingsKeepTheirWordsAndDropTheHash` (+ the strong weight) |
| `testALinkKeepsItsWordsAndIsNotTappable` | ported: `aLinkKeepsItsWordsAndIsNotTappable` (no link or string annotation) |
| `testAnUnclosedMarkerWhileStreamingShowsNoAsterisks` | ported: `anUnclosedMarkerWhileStreamingShowsNoAsterisks`; its `withoutMarkers` half has no Android counterpart: that is iOS's fallback when `AttributedString(markdown:)` refuses, and Android has no parser to refuse |
| `testTheSpokenTextHasNoMarkers` | ported: `theSpokenTextHasNoMarkers` |
| `HealthSleepMergeTests.testOverlappingSourcesAreOneRun` | ported: `SleepNightsTest.overlappingSourcesAreOneNight` |
| `testAGapAwakeIsTwoRunsAndUnsortedInputIsSorted` | ported: `aGapAwakeIsTwoRunsAndUnsortedSpansAreSortedAndAnEmptyOneCountsForNothing` (asleep is the union, so 200 + 100 = 300, not two returned runs) |
| `testKindNamesFallBackToOther` (in the same iOS file) | ported: `ExerciseNamesTest` (known type is the constant's name, unknown is `EXERCISE_TYPE_OTHER_WORKOUT`) |
| (Android's own rule, no iOS case) | `SleepNightsTest`: a night counts on the day its last session ends; touching sessions are two nights; unsorted sessions fold alike; an awake-only night is none |
| `LibraryDeletionTests.testAPhotoTheCoreOfferedMayGo` | ported: `anImageTheCoreOfferedNamesItsRowInTheImageCollection` (the row is the rule on Android; bare id and video too) |
| `testAnEditedAssetGoesOnlyWhenTheGatewayHasTheVersionTheLibraryHoldsNow` | ported to Android's one witness: `aRowGoesOnlyWhileItIsTheSizeThatWasBackedUp` (the store's `SIZE` equals the backed-up size; changed or unanswered is kept). MediaStore has no `modificationDate` revision refs |
| `testTheLatestOfSeveralRenditionsIsTheOneThatCounts` | no Android counterpart: a MediaStore row has one resource and no renditions |
| `testAnEditRevertedGoesOnTheCamerasOwnRowOnly` | no Android counterpart: no `#camera` original row; an edit in place changes the row's size (the size case above) |
| `testALivePhotoGoesOnlyWithItsMovie` | no Android counterpart: no Live Photo pairing (motion photos pass through as one original) |
| `testAMovieRowAloneNeverDeletesItsAsset` | no direct counterpart (no pair); its Android shape is a ref that names the other collection being skipped: `theCollectionIsTheMediaTypesAndARefNamingTheOtherOneIsSkipped`, `aRefThatNamesNoRowNamesNone` |
| `testARefNamesItsAssetItsPartAndItsVersion` | ported to Android's grammar: `aRefNamesItsCollectionAndItsRow` (no part or version suffix exists) |
| `testTheVersionIsSpelledTheWayTheWalkerSpellsIt` | ported: `aRefIsSpelledTheWayTheWalkerSpellsIt` (`LibraryRoll` mints with `LibraryRefs.of`; round trip) |
| `testAYesIsDeletedANoIsDeclinedAndAnythingElseFails` | ported: `aYesIsDeletedANoIsDeclinedAndAnythingElseFails` and `onlyRowsTheStoreNoLongerAnswersForAreReportedDeletedInTheOrderAsked` (rule 3's "reported is what was removed") |

**Brief corrected**: the lane brief listed "kind names fall back" under `LibraryDeletionTests`; it is in `HealthSleepMergeTests.swift` (`HealthKitReader.kind`). `SleepNights` is at `HealthConnectReader.kt:445`, not 441. The base had 38 Android tests once lanes A and B landed, not 32. The brief named `MediaStoreDeleterTest.kt`; the subject of the test is the extracted `LibraryDeletion`, so it is `LibraryDeletionTest.kt`, as iOS's is.

**Verification**

- The Android check (`compileDebugKotlin testDebugUnitTest`, through `flock /tmp/centraid-gradle.lock`) → BUILD SUCCESSFUL; 62 tests, 0 failures, 0 errors (38 before this lane + 24 new). Per class: `ChatMarkdownTest` 8, `SleepNightsTest` 7, `ExerciseNamesTest` 1, `LibraryDeletionTest` 8; the other nine classes unchanged (6, 2, 5, 10, 3, 2, 6, 2, 2).
- `cargo xtask rules` (own `CARGO_TARGET_DIR`) → 15 rules, all `ok` (incl. `native-accessibility`, `health-connect-read-only`, `walker-platform-law`).

**Unverified**: no device; the dialog, the real `ContentResolver` queries and the deletion itself remain the device hand-offs (`docs/release/v1-handoffs.md` 8.20). Nothing in Swift was touched.

**Falsification**

1. *The extraction changed nothing.* Throwaway `ThrowawayDifferentialTest` (deleted, not committed) held the verbatim pre-extraction `MediaStoreDeleter.uriOf` and `LibraryRoll.uriOf` logic and compared it with `LibraryDeletion.target` / `LibraryRefs.row` over 14 refs (empty, bare id, negative, prefix-only, doubled prefixes, `#r` suffix, overflow) times 6 media types → 84 pairs, all equal.
2. *Each new test fails when its subject is broken.* `ChatMarkdown`: bullet marker changed to `-` and link regex keeping the address → `bulletsAndNumbersBecomeItems` and `aLinkKeepsItsWordsAndIsNotTappable` failed (2 of 8). `SleepNights`: the day taken from the earliest end and touching sessions merged → my first tests did NOT catch it (BUILD SUCCESSFUL under the break), so I replaced two tests with ones where a night spans midnight and where touching sessions end on different days; rerun → both failed (2 of 7), restored → green. `LibraryDeletion`: dropped the image-prefix/video-type check, treated a missing size as unchanged, inverted the gone filter → three tests failed (3 of 8). All breaks reverted; the tree matches the commits.

## Lane Ci — iOS: the reads SwiftUI did not make yet

Six register rows closed, all Swift, none compiled (no Xcode here). Each commit deletes the rows it closes, so the `native-shell-parity` ratchet held at every commit: 202 rows at the start, 196 now, and no "Lane C" gap remains.

**What changed**

- `mobile/iosApp/Sources/AgendaHomeView.swift`: `eventCountLabel(_:)` reads the data arm's `AgendaHomeData.event_count_label`; `AgendaToolbarView` takes it as `eventCountText` and draws `monthLabel · eventCountText` (middle dot, empty parts dropped) in the month's own type role. The parameter is not called `eventCount`: that spelling would count as a read of `AgendaHomeData.event_count`, a lane F row nobody reads.
- `mobile/iosApp/Sources/ScreenStore.swift`: `@Published shielded: Set<UInt64>`; `perform` answers `Effect.screenshot_shield` by inserting or removing the instance and answering `done` (it was `failed("not performed by this shell")`); a closed screen is dropped from the set. `popToRoot(tab:)` sends `NavPopToRoot`.
- `mobile/iosApp/Sources/RustScreenHost.swift`: `RustScreenView.body` is now `WordsShield(secure: store.shielded.contains(instance)) { screen }`, the old switch being `screen`; the eight `onHome:` sites call `shell.popToRoot()`.
- `mobile/iosApp/Sources/PhotosLibraryView.swift`: two `.accessibilityAction(named:)` on the scrub thumb, Rust's next and previous labels, calling `step(true)` and `step(false)`; the adjustable action stays.
- `mobile/iosApp/Sources/WordsViews.swift`: `WordsShowView.body` draws `BarePaper()` while `state.checkNow`, else the old body (renamed `shown`).
- `mobile/iosApp/Sources/ShellModel.swift`: `popToRoot()` empties `path` and sends `NavPopToRoot` for the home tab.
- `crates/xtask/src/native_parity_register.rs`: the six rows leave; the now-empty "Lane C" comment goes with them.

**The brief's premise for `pop_to_root` was off.** Compose's only sender is the apps' Home control (`RustRoot.popToRoot`, reached through `onHome = toHome`), not a re-tap on the selected tab. On iOS every page is on the home tab's path and the band is drawn only at its root, so a re-tap has nothing to pop; the Home control is the one real parity site. `path.removeAll()` still runs (SwiftUI's stack is what is drawn, and `rustPopped` still reports `NavPopped` for the lowest entry and releases its claim), then `NavPopToRoot` follows. The two overlap harmlessly: `NavPopped` for an instance already gone returns early, and `PopToRoot` splits off nothing from a stack of one. The proto comment on `NavPopToRoot` ("a second tap on the selected tab") is wrong about who sends it; it is `screens.proto`, not mine to edit here.

**Verification**

- `cargo xtask rules` (own `CARGO_TARGET_DIR`) → 16 rules `ok`, `native-shell-parity` clean with 196 register rows (202 at the start).
- `cargo test -p xtask` → 154 + 2 passed, 0 failed.
- The disk filled (0 bytes free, shared by the lanes) while I tried to build `centraid-screens` tests; I cleared my own incremental dir and did not retry.

**Unverified: every Swift line above. Simulator checks (owner hand-off)**

1. Agenda, Day place with events: the bar under the title reads `May 2026 · 3 events` (the same line on Android); with none, the month alone.
2. Shield: no screen emits `ScreenshotShield` today. Check by compiling a build where a debug screen asks for it: the screenshot is blank, the cover shows while recording, and the screen keeps its scroll position when the shield goes off. Also check that a plain screen is unchanged by the always-on `WordsShield` wrapper: scroll, keyboard, sheets, and any screen using `GeometryReader` or `safeArea`.
3. Photos library, VoiceOver on the scrub thumb: the rotor lists the two named actions, each moves one month; swipe up and down still adjusts.
4. Settings, Backup, More, then "Show recovery key": nothing but the page colour shows while the owner check is up; the words appear after it passes; a failed check shows ASK.
5. Open an app page two or three deep, tap Home: the stack empties to Home and a second open of the same app gets a fresh screen (no stale instance); no Rust error in the log.

**Rust and proto gaps**: none found for these fields. Outside the lane: the `NavPopToRoot` proto comment above.

**Falsification**

1. *Each of the six reads is what the rule sees, not a name collision.* I renamed all six spellings (`home.eventCountLabelX`, the `.screenshotShieldX(let` arm, `.popToRootX(pop)` and its two receivers, `data.scrubNextLabelX`, `data.scrubPreviousLabelX`, `state.checkNowX`) in place and ran the rule. It failed with exactly six findings, one per row, each "only Compose reads it". Restored with `git checkout`, rule green. This check also found a real collision earlier in the lane: my first label `eventCount:` read `AgendaHomeData.event_count`, so I renamed it.
2. *`NavPopped` and `NavPopToRoot` are safe in either order.* The check I wanted was a throwaway runtime test (push two pages, send both events in both orders, expect depth 1 and each instance closed once); it did not run because the disk filled. The evidence is `crates/screens/src/runtime.rs` (`N::Popped` returns early when the instance is gone or at index 0; `N::PopToRoot` calls `split_off(1)`, which on a stack of length 1 is empty). This claim is read, not run.
