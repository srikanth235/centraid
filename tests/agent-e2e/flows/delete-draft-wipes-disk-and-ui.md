# Flow: Delete draft — disk + UI cleaned, persists across restart

> **⚠️ Stale premise — verify before running.** This flow's setup ("Click
> the Hydrate template → wait for builder → Back to home") describes app
> templates cloning into a draft. Commit `4397329` ("'Use template' installs
> app templates directly as published apps") removed that stage:
> `installAppTemplate`
> (`apps/desktop/src/renderer/react/shell/routes/templatesData.ts`) now
> installs directly onto Home, never a `__draft`. Drafts still exist as a
> concept in the shell (`DraftAppMeta`, `data-draft="true"`) — likely
> reachable only via the chat/builder app-creation path now, not template
> cloning — so this flow's delete-draft mechanics may still be valid once
> re-pointed at a real draft source. Needs a live-rig rewrite before reuse.

## Goal
Deleting a draft via the tile context menu must (a) remove the app
directory from disk, (b) remove the draft tile from APPS, and (c) persist both
across an Electron restart. Exercises the full tile-menu → confirm-modal →
IPC delete chain.

The template the draft was cloned from stays in TEMPLATES the whole time —
templates are only consumed by *publish*, not clone. The flow asserts this
explicitly so the assumption doesn't drift.

## Setup
Fresh `userData` and `appsDir`.

## Steps
1. Click the Hydrate template → wait for builder → Back to home.
2. Verify: 1 draft tile under APPS, Hydrate still under TEMPLATES, 1 app
   directory on disk.
3. Click the "More" button (`.tile-more-btn`) on the Hydrate draft.
4. Click "Delete draft" in the context menu.
5. Confirm in the modal.
6. Wait for the draft tile to disappear.
7. Verify: 0 drafts, 0 app dirs, Hydrate still under TEMPLATES.
8. Restart Electron.
9. Same verification as step 7.

## Expectations
- After step 2: clone state is correct (template stays, draft exists).
- After step 7: delete state is correct (draft gone, disk clean).
- After step 9: state persists across restart.

## Verdict
PASS if all three states hold. FAIL naming which invariant slipped.
