# Issue #1130 — Tasks' Today asks once and reads finished

## What changed

- **One way to add (R-CHROME-1 amended).** `TasksQuickAdd.drawn` (field 7) says the bar is drawn; `TasksHomeEvent.QuickAddOpened` (28) opens it from the header's Plus with the keyboard, and `QuickAddClosed` (29) closes it when the keyboard leaves an empty field, so typed words are never thrown away. `lands_label` is the field's placeholder ("Add to Today"), and Add shows once there is text. Notes' "Send to Tasks" opens it seeded; a pushed project page, which has no Plus, keeps it drawn (`TasksProjectPage`). Opening search or moving to another place puts the bar away with its words.
- **Rows.** "Move to project" (was "File") is a long press — a context menu on iOS, `combinedClickable` on Android — and a row accessibility action, not a visible button. Root tasks get a round `KitCheckBox(round:)`, as do Home's Tasks-tile marks on both shells; subtasks stay square. The due date moves to the second line, the box aligns to the margin and first line, and `KitHairline(inset:)` insets the rule to the text.
- **Places.** The chrome title names the place (`placeTitle`); the board's count label is empty. Today's empty state offers "Open Inbox" (`copy/tasks.json` `OPEN_INBOX`) when the Inbox has tasks, and acting on it moves there.
- **Starters (R-ONBOARD-5 amended).** `crates/core/src/starters.rs` writes the starter tasks undated, so a new vault no longer opens on overdue work. `FoundRequest.tz` had no other reader and is removed (`reserved 4; reserved "tz";`), with its callers in `VaultRoster`, `Shelf`, `api.rs`, `example.rs` and three test literals.
- **Copy:** "Reschedule" (catch-up), "Move to project", "Add to", "Open Inbox".
- **Decisions:** R-CHROME-1 and R-ONBOARD-5 amended, R-ONBOARD-4's Agenda-marks sentence and the "Tasks' band while typing" row updated in `docs/decisions.md`.

## Verification

Run on a tree of `f90f473ca` plus this change alone (the Notes tile work that shares this worktree is not in it).

```sh
cargo fmt --all --check
```

Outcome: pass, exit 0.

```sh
cargo test --locked -p centraid-core -p centraid-core-ffi
```

Outcome: pass, 23 suites, 443 tests, 0 failed.

```sh
cargo xtask gate --profile mobile-jvm
```

Outcome: pass (217 s of the 420 s budget), with `JAVA_HOME` set to Homebrew's openjdk@21. The Android target is off without an SDK.

New `TasksSpec` cases: the Plus opens and an empty blur closes the bar; Send-to-Tasks arrives open with its words; Open Inbox shows and moves when the Inbox has tasks; each place's chrome title.

iOS: built for the simulator (`xcodegen` with `CENTRAID_IOS_DEPLOYMENT_TARGET`, `ARCHS=arm64`) and checked by hand on Today — the Plus opening the bar on the keyboard, the placeholder, round boxes and the date under the title. That build was of the parent worktree, which also held the uncommitted Notes Home tile; the iOS views in this change are the same files.

**Not verified:** the Android edits are not compiled (no Android SDK in this environment), the same hand-off as #1124.

## Decisions

- The bar's state is a flag on the screen (`drawn`), decided in the shared machine, not view state, so both shells and the specs see one answer. The name is not `open` because Wire renames that Kotlin keyword to `open_`.
- Closing on blur only when the field is empty was chosen over closing always: a member who taps away mid-sentence keeps their words.
