# Release QA, 2026-11-17

Release candidate: main `99cc70d8f` (#1195), detached checkout. Plan: [PLAN.md](../release-test-plan-2026-11-17/PLAN.md). Rules: [LANE-RULES.md](LANE-RULES.md). Ledgers: [ios/COVERAGE.md](ios/COVERAGE.md), [android/COVERAGE.md](android/COVERAGE.md).

## Verdict: no-go

Four defects block release on their own: Android loses its gateway pairing on every process death; record Trash still asks first in Reminders, People and Docs; the note menu has no Move to trash; Android "Export everything" fails to save. The `mobile-jvm` gate also fails.

## Coverage

| Lane                               | PASS | FAIL | BLOCKED | NA  | UNRUN |
| ---------------------------------- | ---- | ---- | ------- | --- | ----- |
| iOS 26.5 simulator (iPhone 17 Pro) | 82   | 25   | 10      | 10  | 2     |
| Android 35 emulator (google_apis)  | 46   | 21   | 0       | 3   | 35    |

A PASS means a device capture or UI tree shows it. Counts include repeated rows for the same defect (B4 appears under its own id and under each app's J3 trash case).

## Gates

| Command | Result |
| --- | --- |
| `cargo xtask gate --profile pr` | PASS in CI on #1195 head `2374afc2a` (same tree as `99cc70d8f`), with iOS and Android jobs |
| `cargo xtask gate --profile mobile-jvm` (JDK 21) | **FAIL**: 45 tests, 1 failed. `AbiContractSpec` "an undefined status code is its own failure" asserts code -6 is undefined, but #1193 made -6 `VAULT_DAMAGED`. The test is stale; it must pick a code the header does not define, not be loosened. |
| `cargo xtask gate --profile release` | **Not run to completion.** `fmt` and `clippy` passed; it was stopped when free disk fell from 54 to 19 GiB (owner's disk rule). Needs a machine with about 60 GiB free. `artifact-identity` and `prebuilt-core-required` are unproven. |

## Release blockers

| # | Defect | Platforms | Evidence |
| --- | --- | --- | --- |
| 1 | After the app process dies, Backup says "Your backup device doesn't know this phone. Pair it again." while the gateway still holds the token. Also right after Restore. Backups stop until re-paired. The same screen says "All 901 KB … is backed up" and shows the warning twice. Seen with the emulator Keystore only, not yet tried on a device. | Android (iOS once, after a Face ID enrolment change) | android/j6-after-kill.jpg |
| 2 | Record Trash opens a confirm sheet instead of trashing at once with Undo (blocker B4 from the 11-12 audit). | Both: Reminders, People, Docs | ios/evidence/B4-_.jpg, android/b4-_.jpg |
| 3 | The note actions menu lacks Move to trash, against `NoteMenu` and `AndroidNoteMenu`. (The missing Earlier versions on unedited notes is correct per owner ruling 3.) | Both | android/j3-notes-menu.jpg |
| 4 | "Export everything" fails: "Failed to save document", 0-byte file. | Android | android/j7-export-everything.jpg |
| 5 | `mobile-jvm` gate fails (stale test, see above). | Shared | target/xtask/mobile-jvm |

## Other defects

Shared:

- Day-one Home is not drawn: a fresh vault opens on the content springboard because the starter note counts as content (J1-empty-home). Starter reminders exist although Reminders has an import (J1-starter-rows). New boards are approved (below).
- Calendar at the largest text size clips and overlaps (B3).
- Earlier-version preview shows UTC (09:00) for a 14:30 IST task (B5).
- Reminders lacks the board's Logbook tile and adds a Projects heading (D-reminders).

iOS:

- Search then Ask: two back controls; after Back the search field sits under the keyboard. Same layout in Calendar search with no match (B2, J4-search-ask-back).
- The assistant answered "Nothing found." to every prompt after the 563 MB download. Likely the simulator; unproven until a device run (J4-assistant).
- Notes link picker footer says "Locker items link by name" while Locker is never linkable.
- People at AX5 breaks "reconnect" mid-word.
- Home Money tile says "spent in November" where HomeWidgets says "left".
- Calendar lacks the Today pill and event time and place (D-calendar).
- Photos lacks the Library, Collections and More band, and its access copy differs from PermissionPhotos (D-photos-dark).

Android:

- The recovery-key prompt never appears after the first backup, because Android shows the 24 words at creation. iOS follows the board. Needs a ruling.
- Typing in Notes and People search hung the app (ANR) twice (J2-notes, J2-people), and Docs Move to trash hung it once. Notes and People search were not retested. Check them on a release build.
- With the phone set to 24-hour time, Calendar and Reminders still show "2:00 PM"; in 12-hour mode the Calendar axis shows "14:00".
- "Notifications are off" stays in the reminder editor after Allow, until the app restarts.
- People avatar initials clip at font scale 2.0.
- The exact-alarm grant is never asked at the moment of need; Backup shows a lateness note instead.

## Owner rulings (2026-11-18)

1. A reminder with a time alerts at that time by default. "Early reminder" only adds earlier alerts. Today the default "None" never alerts, on both platforms, so this is a defect.
2. The 24 words are asked for after the first backup, on both platforms, as the `RecoveryKeyPrompt` board shows. Android showing them at creation is a defect.
3. Earlier versions appears only once a record has been edited ("edited since" in `rulings/connect-find.md`). An unedited note or workout without it is correct, so blocker 3 now covers only the missing Move to trash in the note menu.
4. A timed reminder with no early alert still alerts, so it counts in the Reminders "reminders" smart list and its count.

Housekeeping: the Android lane pointed AVD `Centraid_API_35` at the installed `android-35/google_apis` image. The backup of its original `config.ini` lived in the session scratchpad, which was cleared at 21:49, so it is probably gone. The AVD was wiped with the owner's approval.

## Passed, highlights

- iOS backup, loss and recovery end to end. This covered:
  - pairing with a matching safety number;
  - "backed up" shown only after the gateway acknowledged;
  - offline status and catch-up;
  - restore from the 24 words behind Face ID, with rows, trash and 14 of 14 originals byte-exact;
  - the superseded phone refusing writes;
  - a blind gateway, with 0 marker hits across 18 MB.
- Android restore, byte-exact originals, a blind gateway, and notification Done and Undo after process death.
- iOS cold notification Done, which fixes the 11-12 failure.
- Exports are byte-identical across two runs and valid, behind a fresh owner check. "Export everything" works on iOS: 4.1 MB, with a "Left out" list.
- Locker:
  - the owner check comes before any item;
  - sealed values are absent from search;
  - relock wipes revealed values;
  - Locker is never offered by the Link and Attach pickers.
- Direct Trash with Undo works in Notes, Calendar, Money, Photos and Health.
- In-app search on iOS, proven by row counts.
- Design matches the boards for Home (structure), Notes, Money, People, Docs and Health.

## Not run, and what it needs

- **Physical-device runs:**
  - biometrics;
  - notification Undo after process death on iOS (actions open only from the banner on the simulator);
  - the assistant;
  - overnight delivery;
  - reference performance.
- **Android:** 35 cases, all listed in its ledger:
  - J2 for Calendar, Docs, Photos, Money and Health;
  - arrived line and Link/Attach per app;
  - Earlier versions for five apps;
  - seven per-app exports;
  - alert cancel on edit.
- **iOS cases blocked by simulator setup:**
  - Settings repair, alert cancel and 12/24-hour (notifications denied, and re-enabling them is a system setting);
  - Docs and Notes imports (no files in the simulator's Files app).
- **Scale:** the 90,000-photo vault was not built on this disk.
- **Gates:** the full `release` gate.

## Design work done during QA (uncommitted)

- **Day-zero boards:** worktree `.claude/worktrees/agent-a699455f9662ebda0`. Home now has one widget layout from day zero to full. The work adds:
  - a first open for each app;
  - Locker's two steps;
  - a refused-permission state;
  - Backup before pairing;
  - a single day-two backup mention.

  The ruling is updated in `product/rulings/home.md`.

- **Website home page:** worktree `.claude/worktrees/agent-a402ade52371f14f5`. The page is redrawn from scratch around the four quarters. The city part is removed and the old ring logo is removed everywhere it was live. Every check there passes.
