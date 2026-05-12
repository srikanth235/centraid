# Flow: Clone template, save, reopen

## Goal
Cloning a built-in template should create a draft project on disk. The draft must
still appear on home after a full Electron restart (drafts hydrate from
`projectsDir` at startup — not from localStorage).

## Setup
Fresh `userData` and `projectsDir` (the harness does this). Gateway URL points at
an unreachable port, so the "user apps" (published) section will be empty and only
on-disk drafts will appear under APPS.

## Steps
1. From home, confirm a "Hydrate" tile exists under the **TEMPLATES** section.
2. Click that Hydrate template tile.
3. Wait for the builder to open. (The clone happens before the builder opens —
   the project dir is already written to `projectsDir` at this point.)
4. Exit the builder back to home (Back button / Escape / whatever the builder
   exposes — read the renderer if needed).
5. Verify a tile named "Hydrate" appears under **APPS** with the **DRAFT** badge.
   There may already be other draft tiles seeded by earlier sessions — what
   matters is that a Hydrate draft now exists.
6. **Restart Electron** via the harness (`node lib/harness.mjs restart <runId>`).
   The `userData`/`projectsDir` are preserved; only the main process is replaced.
7. After restart, reconnect to the new `cdpUrl` and verify the Hydrate draft
   tile still appears on home.

## Expectations
- After step 5: APPS grid contains a tile with name "Hydrate" and `data-draft="true"`.
- After step 7: same tile is present.
- A `projectsDir` subdirectory was created with an `app.json` that names "Hydrate".

## Screenshots (save under `runs/<runId>/screenshots/`)
- `01-home-before.png` — home with TEMPLATES section visible
- `02-builder-open.png` — builder after clicking template
- `03-home-with-draft.png` — back at home, Hydrate draft tile present
- `04-after-restart.png` — home after Electron restart, draft still there

## Verdict
Write `runs/<runId>/verdict.md`:
- **PASS** if both expectations hold and the on-disk `app.json` was created.
- **FAIL** otherwise — name the failing expectation and reference the screenshot
  that shows the failure.
