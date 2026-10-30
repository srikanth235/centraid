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
