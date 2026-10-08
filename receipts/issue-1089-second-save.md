# Issue #1089 — a second Save after a committed write files the row again

## Checklist

- [x] A red-first spec for every create flow that goes through `WriteLaw`
- [x] The guard in the machines, not the specs
- [x] Comments that promised a dedup say what prevents the duplicate
- [ ] The album-choice sheets in PhotosGrid, PhotoLightbox and PhotoShelf (the shells already clear the name and disable Create when it is blank)

## What changed

The vault runs a write sent twice twice ([R-1088-12](../docs/decisions.md#one-assistant-plane-1088)), and five create flows let Save fire again after the first write committed or while it was in flight, with the screen still open.

- **Tally and Agenda editors** (add and edit): `can_save` is false once the write is committed.
- **People's add:** the committing settle runs on the edit lens, so a word typed while the add was in flight goes out as `edit_person` rather than a second `add_person`.
- **Collections' new album:** Create needs the sheet open and allows one create in flight (`create_key = 7` on `PhotosCollectionsState`, `invoke_key = 3` on its settle).
- **FaceReview's new person:** one create at a time (`creating_region = 9`).

Notes, notebooks, journal, the Locker editor, Tasks' quick add, Settle up and Docs folders were not affected. Each has a pin, because each drops its draft or carries a minted id on commit. A rule in `WriteLaw` was rejected: Agenda and Locker keys differ per attempt, and a "same key as last commit" rule would refuse a deliberate second notebook with the same name. `AgendaEditorMachine.skip()` also returns once the write is committed (`1aec832a7`); no spec covers that guard. Lane commits: `78950f536` carries the red specs for the Tally and Agenda editors, People and the Collections sheet, and the pins for the flows that were not affected (6 red); `1aec832a7` carries the fix and two more specs, FaceReview's and the Collections sheet's create in flight, which failed against the machines before the fix (`save/red2.log`).

## Verification

```
./gradlew -p mobile --offline :shared:jvmTest                # on 78950f536, whole :shared:jvmTest: "1274 tests completed, 6 failed", the six #1089 specs, e.g. "TallyScreensSpec[jvm] > a Save after the commit files nothing more: a committed expense ends its sitting (#1089)[jvm] FAILED" (save/red-78950f536.log, re-run after the first audit)
./gradlew -p mobile --offline :shared:jvmTest --tests …   # before 1aec832a7, its two new specs: "FaceReviewSpec[jvm] > a second Create while the first add_person is in flight makes no second person (#1089)[jvm] FAILED" (save/red2.log)
./gradlew -p mobile --offline :shared:jvmTest --tests …   # on 1aec832a7: BUILD SUCCESSFUL (save/green2.log)
PATH=$S/tools:$PATH cargo xtask gate --profile mobile-jvm  # PASS on the merged head 30c414b24 (250.9 s; no fixture drift)
```

## Audit

**REFUTED**

Audited 2026-10-08 by a reviewer who did not write the receipt, against `78950f536`, `1aec832a7` and the merge `43e2697f5`, the logs in the root agent's scratchpad (`save/red.log`, `save/red2.log`, `save/green2.log`, `final-gate-mjvm.log`) and `.governance/law/rules/receipt-per-issue.mjs`. The fixes that bring it to PASS are named in the bullets: the red count in `## Verification`, and the omissions in `## What changed`.

- **`## What changed` against the diff.** REFUTED on one omission; every claim it makes holds.
  - Held. `TallyEditorMachine.kt` adds `!committed` to `canSave`. `AgendaEditorMachine.kt` adds it to `canSave` and to `save()`. `PeopleEditorMachine.kt` settles an `add_person` commit on `EditLens`. `screen.proto` adds `PhotosCollectionsState.create_key = 7`, `PhotosCollectionsEvent.WriteSettled.invoke_key = 3` and `FaceReviewState.creating_region = 9`. `PhotosCollectionsMachine.kt` returns on `state.sheet != SHEET_NEW_ALBUM` and on a non-empty `create_key`.
  - The pins exist for every flow it calls unaffected: `NotesAppSpec` (notebooks, journal, editor), `LockerSpec`, `TasksSpec`, `TallyScreensSpec` (settle up) and `DocsSpec` (folder). The rejected `WriteLaw` rule is in the `Writes.kt` doc: "no key comparison in this law could do it".
  - Not named: `AgendaEditorMachine.skip()` now returns when the write is committed (`1aec832a7`, and the commit message says so). No spec covers it. Name it and add one, or say it is untested.
  - The intro says all five flows let Save fire "after the first write committed". FaceReview's guard (`creating_region`) is in-flight only. Say so.
  - `1aec832a7` is not "the fix" alone: it also carries `FaceReviewSpec.kt` (+19) and `PhotosCollectionsSpec.kt` (+20), the two specs `save/red2.log` shows red (`FaceReviewSpec.kt:334`, `PhotosCollectionsSpec.kt:534`; "66 tests completed, 2 failed"). "specs only" holds for `78950f536` itself.
- **Each `- [x]` against the diff.** PASS on all three, with the caveat on box 1.
  - Box 1. `78950f536` carries the red specs for the Tally and Agenda editors, People and the Collections sheet, and the pins for the flows that already end their sitting; FaceReview and the in-flight Collections create are red-first only in `red2.log`, as above.
  - Box 2. Every guard is in a `commonMain` machine; the only test files `1aec832a7` touches are the two specs above.
  - Box 3. The edits exist in `Writes.kt` (WriteLaw doc), `mobile/README.md` (the `WriteLaw` row), `AgendaWrites.kt`, `TallyBridges.kt`, `TallyEditorMachine.kt`, `TallySettleUpMachine.kt`, `AlbumChoice.kt` and `FaceReviewMachine.kt`. `## What changed` does not list them.
  - The open box is open in the diff. `AlbumChoiceSheet.kt` (Compose) clears `name = ""` on Create; I did not read the iOS sheets.
- **`## Verification` against a log.** REFUTED on the first line.
  - `save/red.log`: "258 tests completed, 7 failed". The seventh is "NotesAppSpec[jvm] > editor: words typed while the create is in flight are an edit of the note it made, never a second create (#1089)[jvm] FAILED … at NotesAppSpec.kt:796". The receipt says Notes was not affected, and the log cannot be of the committed spec: `NotesAppSpec.kt` and `apps/notes/` are byte-identical from `78950f536` to HEAD, and `final-gate-mjvm.log` is green. So the log is of an earlier draft of that spec (`red.log` finished 05:35:08; the commit is 05:35:30), not of the committed one. The other six failing lines are assertion lines of the committed specs: `AgendaEditorSpec.kt:147` and `:172`, `TallyScreensSpec.kt:482` and `:523`, `PeopleSpec.kt:684`, `PhotosCollectionsSpec.kt:511`. As committed, `78950f536` is red on six, not seven. Fix: re-run `:shared:jvmTest` on `78950f536`, quote that count in `## Verification` and replace "7 red" in `## What changed` (the commit message's "Seven" cannot be amended; say so).
  - The quoted "List should be empty but has 1 elements, first being: SubmitWrite(command=tally.add_expense …)" is in no retained log. The log has "TallyScreensSpec[jvm] > a Save after the commit files nothing more … FAILED" at `TallyScreensSpec.kt:482`, which is `.effects.shouldBeEmpty()`. Quote the logged line.
  - `save/green2.log`: "BUILD SUCCESSFUL in 2m 43s", written 05:43:57, ten seconds before `1aec832a7`. PASS.
  - `final-gate-mjvm.log`: "ok    mobile-jvm        250.9s  git diff --exit-code -- design copy mobile contracts/screens" and "gate mobile-jvm: PASS". The log does not name a commit; `git diff 30c414b24 HEAD` over `mobile`, `contracts`, `design` and the Rust crates is empty, so "merged head `30c414b24`" holds. PASS.
- **Governance form.** PASS. `## What changed` and `## Verification` are present, the receipt is not a stub, `## Verification` holds a fence and outcome words ("failed", "PASS"), and this section carries a verdict.

### Re-audit (2026-10-08)

**REFUTED**

One item is open, a wording one. The receipt's text above the first audit was re-read as it now stands; the first audit is unchanged.

- **Red count (`## Verification`, line 1).** Fixed. `save/red-78950f536.log`, a whole `:shared:jvmTest` in a detached worktree at `78950f536`: "1274 tests completed, 6 failed". The six are `AgendaEditorSpec.kt:147` and `:172`, `PeopleSpec.kt:684`, `PhotosCollectionsSpec.kt:511` and `TallyScreensSpec.kt:482` and `:523`, the lines the first audit named; `NotesAppSpec` does not fail, which confirms that audit's reading of the first log. `## What changed` now says "(6 red)" and the Verification line says "1274 tests completed, 6 failed".
- **The quoted assertion text.** Fixed. The line now quoted, "TallyScreensSpec[jvm] > a Save after the commit files nothing more: a committed expense ends its sitting (#1089)[jvm] FAILED", is in `red-78950f536.log`.
- **The Agenda Skip guard.** Fixed. `## What changed` now says "`AgendaEditorMachine.skip()` also returns once the write is committed (`1aec832a7`); no spec covers that guard", which is what the diff and the missing spec show.
- **The two specs inside `1aec832a7`.** Fixed. `## What changed` names FaceReview's and the Collections sheet's create-in-flight specs and cites `save/red2.log`, which holds "FaceReviewSpec[jvm] > a second Create while the first add_person is in flight makes no second person (#1089)[jvm] FAILED".
- **The intro sentence.** Not fixed. It still says all "five create flows let Save fire again after the first write committed". FaceReview's guard (`creating_region`) is in flight only, and People's is a word typed during the add. Add "or while it was in flight". This is the only open item; nothing else changes.
- **Governance form.** PASS, as before: `## What changed`, `## Verification` (fence, "failed", "PASS"), and a verdict.

#### Second re-audit (2026-10-08)

**PASS.** The intro (line 12) now reads "five create flows let Save fire again after the first write committed or while it was in flight, with the screen still open", which matches FaceReview's in-flight guard and People's typed-during-add; no item is open.
