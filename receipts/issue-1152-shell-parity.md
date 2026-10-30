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
