# Flow: Delete draft — disk + UI cleaned, persists across restart

## Goal
Deleting a draft via the tile context menu must (a) remove the project
directory from disk, (b) remove the draft tile from APPS, and (c) persist both
across an Electron restart. Exercises the full tile-menu → confirm-modal →
IPC delete chain.

The template the draft was cloned from stays in TEMPLATES the whole time —
templates are only consumed by *publish*, not clone. The flow asserts this
explicitly so the assumption doesn't drift.

## Setup
Fresh `userData` and `projectsDir`.

## Steps
1. Click the Hydrate template → wait for builder → Back to home.
2. Verify: 1 draft tile under APPS, Hydrate still under TEMPLATES, 1 project
   directory on disk.
3. Click the "More" button (`.tile-more-btn`) on the Hydrate draft.
4. Click "Delete draft" in the context menu.
5. Confirm in the modal.
6. Wait for the draft tile to disappear.
7. Verify: 0 drafts, 0 project dirs, Hydrate still under TEMPLATES.
8. Restart Electron.
9. Same verification as step 7.

## Expectations
- After step 2: clone state is correct (template stays, draft exists).
- After step 7: delete state is correct (draft gone, disk clean).
- After step 9: state persists across restart.

## Verdict
PASS if all three states hold. FAIL naming which invariant slipped.
