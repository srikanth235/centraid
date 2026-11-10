# Fix verification — iOS exploratory audit

Status: all 21 original reproductions verified in the simulator; final automated gate results pending. The original [audit report](REPORT.md) remains the historical record.

## Build and environment

- Same existing Demo vault on iPhone 17 Pro `c1173-review`, iOS 26.5, Xcode 27.1; base commit `d8daadc46` plus the working-tree fixes.
- Rust simulator core rebuilt with llama; Swift protobuf output and Xcode project regenerated. Native iOS tests passed: 73 tests, 0 failures, including the final app linked to the rebuilt Rust core.
- Light baseline, dark workout contrast, and the same two text-size increments used in the audit. Settings appearance remains System; simulator appearance and text size restored to light/baseline.
- Screenshots and accessibility observations are under `fix-evidence/`. Each screenshot has a matching `.txt` observation. Transition snapshots were re-observed before drawing conclusions.
- All work uses Demo data. No live-vault edits, outbound communications, recovery-key reveals, permission grants or permanent purges.

## Reproduction results

| ID | Fix | Simulator observation | Evidence |
| --- | --- | --- | --- |
| QA-01 | Reminders More title | The sheet is titled More. | [Screenshot](fix-evidence/qa-01-reminders-more.png) · [AX](fix-evidence/qa-01-reminders-more.txt) |
| QA-02 | Search scope copy | Calendar says Search events and returns Dentist — cleaning, excluding the reminder; Reminders says Search reminders and lists. | [Screenshot](fix-evidence/qa-02-calendar-search-label.png) · [AX](fix-evidence/qa-02-calendar-search-label.txt) |
| QA-03 | Today count duplication | Only Tuesday 10 November · 9 to do appears above the sections. | [Screenshot](fix-evidence/qa-03-reminders-today.png) · [AX](fix-evidence/qa-03-reminders-today.txt) |
| QA-04 | Duplicate photo status | Favorite → Info → bottom shows Added to Favorites once above the action bar. Favorite restored off (7 favorites). | [Screenshot](fix-evidence/qa-04-photos-single-status.png) · [AX](fix-evidence/qa-04-photos-single-status.txt) |
| QA-05 | Overlapping Places pins | Separated area groups; the 12-place menu exposes every entry, scrolls to the last and opens its one-photo shelf. Every original route is retained. | [Screenshot](fix-evidence/qa-05-last-group-place-opened.png) · [AX](fix-evidence/qa-05-last-group-place-opened.txt) |
| QA-06 | Cash-flow amount labels | In, Out and Net headers align with the three amounts. Each accessibility row includes all three labelled amounts. | [Screenshot](fix-evidence/qa-06-cashflow-labels.png) · [AX](fix-evidence/qa-06-cashflow-labels.txt) |
| QA-07 | Invisible workout type | Run icon and word are legible on the tint in light and dark appearance. | [Screenshot](fix-evidence/qa-07-health-workout-dark.png) · [AX](fix-evidence/qa-07-health-workout-dark.txt) |
| QA-08 | Workout week semantics | Nov 5, 7 and 8 workouts now appear under November, outside the current Monday-start week, matching Calendar. | [Screenshot](fix-evidence/qa-08-health-calendar-week.png) · [AX](fix-evidence/qa-08-health-calendar-week.txt) |
| QA-09 | Birthday reminders switch | Jake’s birthday says Reminder on, with no off button. Tapping the former bell area cannot turn it off. Legacy off commands are refused. | [Screenshot](fix-evidence/qa-09-birthday-always-on.png) · [AX](fix-evidence/qa-09-birthday-always-on.txt) |
| QA-10 | Empty channel Save | Empty channel Save is disabled; a supplied email enables it. The draft was cancelled. | [Screenshot](fix-evidence/qa-10-channel-valid-enabled.png) · [AX](fix-evidence/qa-10-channel-valid-enabled.txt) |
| QA-11 | False Locker lock cause | Unlock → iOS Home → Centraid relocks immediately. Wall says Locks after 5 minutes idle, stating policy prospectively. | [Screenshot](fix-evidence/qa-11-locker-background-policy.png) · [AX](fix-evidence/qa-11-locker-background-policy.txt) |
| QA-12 | Generic installed app icon | SpringBoard shows the colored Centraid mark after the rebuild/install. Icon layer groups now have distinct names. | [Screenshot](fix-evidence/qa-12-springboard-icon.png) |
| QA-13 | Hidden Journal Save and requirements | Mood (required) and Entry (required) are visible. Save remains visible and disabled until both have values, then saves successfully. | [Screenshot](fix-evidence/qa-13-journal-valid-enabled.png) · [AX](fix-evidence/qa-13-journal-valid-enabled.txt) |
| QA-14 | Fabricated Journal timestamp | Existing Calm and newly saved QA steady entries show their day group with no invented 12:00 time. | [Screenshot](fix-evidence/qa-14-journal-saved-no-time.png) · [AX](fix-evidence/qa-14-journal-saved-no-time.txt) |
| QA-15 | Slow, erroneous offered document lookup | The exact offered Find the QA travel checklist returns Found 1 document and one correct card. Observed within ~1.8 s initially and ~1.2 s on the final rebuilt core, including screenshot/AX capture. Document body, 40 bytes and 4 versions unchanged. | [Screenshot](fix-evidence/qa-15-16-chat-found-document.png) · [AX](fix-evidence/qa-15-16-chat-found-document.txt) |
| QA-16 | UTC Chat card timestamp | Chat card reads Today · 15:04, matching Docs Added Tue 10 November 15:04 in Asia/Kolkata. | [Screenshot](fix-evidence/qa-15-16-document-after.png) · [AX](fix-evidence/qa-15-16-document-after.txt) |
| QA-17 | False recovery-key custody claim | Settings and Backup both say the recovery key is only on this phone. No key was revealed or custody setting changed. | [Screenshot](fix-evidence/qa-17-settings-key-custody.png) · [AX](fix-evidence/qa-17-settings-key-custody.txt) |
| QA-18 | Import Done obscured | Imported the six-row fixture into Demo Visa. Done is fully visible above Imported 6 rows and returns to Money when tapped. The [first failed retest](fix-evidence/qa-18-first-retest-still-clipped.png) is retained as evidence. | [Screenshot](fix-evidence/qa-18-import-done-visible.png) · [AX](fix-evidence/qa-18-import-done-visible.txt) |
| QA-19 | Calendar larger-text layout | At two Increase Text Size increments, 20:00 stays on one line, Week headings separate weekday/date, Year uses two spaced columns. Baseline restored with two decreases. | [Screenshot](fix-evidence/qa-19-calendar-year-large.png) · [AX](fix-evidence/qa-19-calendar-year-large.txt) |
| QA-20 | Photos search loses destination | Collections → Search Tahoe → Close returns to Collections with its selected tab. | [Screenshot](fix-evidence/qa-20-search-returns-collections.png) · [AX](fix-evidence/qa-20-search-returns-collections.txt) |
| QA-21 | Home falsely says no events today | After today’s 3 events ended, Home says No more events today; accessibility describes the future count as 9 upcoming events. | [Screenshot](fix-evidence/qa-21-home.png) · [AX](fix-evidence/qa-21-home.txt) |

Additional views: [Calendar hour labels](fix-evidence/qa-19-calendar-hours-large.png), [Week headings](fix-evidence/qa-19-calendar-week-large.png), [Places map](fix-evidence/qa-05-places-separated-map.png), [group menu bottom](fix-evidence/qa-05-places-group-bottom.png), [empty channel](fix-evidence/qa-10-channel-empty-disabled.png), [Journal requirements](fix-evidence/qa-13-journal-empty-requirements.png), [Journal Entry without Mood](fix-evidence/qa-13-journal-entry-only.png), [Backup custody](fix-evidence/qa-17-backup-key-custody.png), [document before lookup](fix-evidence/qa-15-16-document-before.png).

## Implementation and automated checks

- Shared behavior, copy, dates, enabled flags and routes are implemented in Rust. Additive protobuf fields carry cash-flow labels and grouped map pins to both shells. No ABI entry point changed.
- Birthday reads always honor the always-on product rule, and the compatibility command refuses off. No database schema migration is needed.
- Exact, unique literal Find requests use two ordinary read tools, without model decoding or writes. Ambiguous requests keep the model path. Internal failsoft diagnostics no longer become member-facing copy or unrelated cards.
- Note/document card creation times use the member’s zone and the native tools’ existing minute precision.
- Swift fixes cover photo status duplication, disabled channel Save, persistent Journal Save, larger text, workout contrast and the import completion footer. Android renderers consume the new shared fields.
- Light mockups updated; dark boards, icon resources and other generated outputs emitted by `cargo xtask design`. No ratchet, lint or budget was loosened; no duration assertion was added.
- `cargo xtask gate --profile mobile-jvm`: PASS on the final core; 43 JVM tests, 0 failures. Native iOS: 73 tests, 0 failures.
- Full PR gate results are being finalized. The final local run passed every non-test lane, then exposed a machine-date-dependent Calendar fixture. A weekly sample event occupied the test’s supposedly empty Wednesday. The grid fixture now has a fixed scenario anchor; all 24 Calendar grid tests pass with the original assertions intact. Initial sandbox failures were localhost/cache access restrictions; the unrestricted rerun passed restore drills, dependency audit, TypeScript checks, rules, protobuf compatibility, release build, design and fault-door. The full suite also exposed a creation-time precision mismatch, corrected without changing the check. See [local gate before the fixture correction](checks/pr-gate-before-fixture.txt), [Calendar grid tests](checks/calendar-grid.txt), [JVM gate](checks/mobile-jvm.txt) and [iOS tests](checks/ios-tests.txt).

Commands used for the final iOS build (repository root, then `mobile/iosApp/`):

```sh
IPHONEOS_DEPLOYMENT_TARGET=$(cat mobile/ios-deployment-target) mobile/scripts/ios-core.sh aarch64-apple-ios-sim
# From mobile/iosApp; Xcode project/protobuf generation was also run after contract changes.
xcodebuild -project Centraid.xcodeproj -scheme Centraid \
  -destination 'platform=iOS Simulator,id=962E6778-0074-4510-BD6B-C157956EDF29' \
  -derivedDataPath /tmp/centraid-ios-boot-derived test
```

## Disk cleanup

At the owner’s request, removed rebuildable Rust incremental caches under `target/debug/incremental` and `target/aarch64-apple-ios-sim/debug/incremental`. Source, simulator data, built app, test evidence and dependency caches were preserved. Free space rose from 5.1 GiB to 35 GiB immediately after cleanup; macOS later reported 96 GiB available. Subsequent builds use some of that space.

## Test data and limits

The verification added a Demo Journal entry `QA steady` (`01a1c512-a101-7bf1-93a7-08abd30e47ec`) and imported the six-row sample `statement.csv` into each of Demo Rainy day and Demo Visa (12 fixture rows total). Photo Favorite was restored off; channel draft cancelled; Locker left locked. The QA document stayed at four versions.

This confirms these 21 bounded reproductions, not every possible app state. Simulator responsiveness is not physical-device performance evidence. Android compile/device verification requires an Android SDK/runtime; neither is configured on this Mac. Android shell compilation was not run: from `mobile/`, `./gradlew -Pcentraid.android=true :androidApp:assembleDebug` requires an installed SDK and `ANDROID_HOME`. No physical iOS device was used.
