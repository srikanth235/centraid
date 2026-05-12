# Flow: Settings theme persists across restart

## Goal
Switching theme in Settings writes to `centraid.v1.appearance` in localStorage
(persisted by Chromium under `userData/Local Storage/leveldb/`). A full Electron
restart should keep the app in the chosen theme. This exercises a different
persistence path than the on-disk drafts flow.

## Setup
Fresh `userData`. The home defaults to `html[data-theme="light"]` because no
`centraid.v1.appearance` entry exists yet.

## Steps
1. Confirm `html[data-theme="light"]` on fresh launch.
2. Click the Settings button (top-right).
3. In the Appearance group, click "Dark" in the theme segmented control.
4. Confirm `html[data-theme="dark"]` immediately (no save button).
5. Close the drawer (click the backdrop).
6. Restart Electron via `ctx.restart()` — same `userData`.
7. Confirm `html[data-theme="dark"]` after reconnect.

## Expectations
- After step 4: `<html data-theme="dark">`.
- After step 7: same — dark persisted via localStorage in `userData`.

## Verdict
PASS if both expectations hold; otherwise FAIL naming the theme that was
actually rendered.
