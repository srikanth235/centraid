# issue-342 — Desktop: Relaunch-to-update pill in the sidebar

GitHub issue: [#342](https://github.com/srikanth235/centraid/issues/342)

The desktop shell runs unpackaged (`electron .` over the built `dist/`), so a
new build landing on disk while the app is open went unnoticed — the running
process keeps executing stale code. This adds the Claude-Code-style
"Relaunch to update" pill: main watches the built bundles, the sidebar shows
the pill when a newer build settles on disk, and clicking it relaunches the
app into the new code.

## Checklist

- [x] Commit 1 — desktop: relaunch-to-update pill backed by a dist watcher

## What changed

Commit 1 — desktop: relaunch-to-update pill backed by a dist watcher

- `src/main/update-check.ts` (new): electron-free detection core. Fingerprints
  a fixed watched set (one output per build step: `main.js`, `preload.cjs`,
  `renderer/index.html`, `renderer/styles.css`, `renderer/react-boot.js`) as
  mtime+size; `UpdatePoller` announces `update-available` exactly once, when a
  print differing from the launch baseline holds for two consecutive ticks
  (a multi-second build settling, not mid-write).
- `src/main/update-watcher.ts` (new): wiring. 10s unref'd poll over
  `<appPath>/dist`, `UPDATE_AVAILABLE` broadcast to all windows with the
  on-disk `package.json` version (what a relaunch loads); `getUpdateStatus()`
  snapshot for late-mounting windows; `relaunchToUpdate()` =
  `app.relaunch()` + `app.exit(0)`. Packaged builds can later swap the
  detection for electron-updater behind this same IPC surface.
- `src/main/ipc.ts`: `UPDATE_STATUS` / `UPDATE_RELAUNCH` invoke channels +
  handlers; `src/main.ts`: `startUpdateWatcher()` after ready.
- `src/preload.ts` + `src/renderer/centraid-api.d.ts`: bridge surface —
  `getUpdateStatus` / `relaunchToUpdate` / `onUpdateAvailable` (typed optional
  so partial test mocks stay valid).
- `src/renderer/react/shell/useUpdateStatus.ts` (new): snapshot-on-mount +
  broadcast subscription; non-null means "show the pill".
- `src/renderer/react/shell/Sidebar.tsx` + `chrome.module.css`: the pill —
  a raised card pinned above Settings (brand `Logo`, "Relaunch to update",
  mono version line, trailing arrow) rendered only when `updateVersion` +
  `onRelaunchToUpdate` are set; `App.tsx` wires the hook to the props.

## Verification

- `apps/desktop`: `npm test` — 73 files / 451 tests pass (28 new across
  `update-check.test.ts`, `useUpdateStatus.test.tsx`, and 3 new Sidebar
  cases: hidden by default, version + click handler, position above
  Settings).
- `npm run typecheck` (both tsconfig.test + tsconfig.react) clean;
  `npm run build` clean; changed files `oxfmt`-clean; `oxlint` errors in the
  package are pre-existing (BuilderPreview iframe-sandbox, DiscoverRoute
  no-unused-expressions) and untouched.
- Live E2E against the REAL app (new `tests/e2e-live/verify-13-relaunch-to-update.mjs`):
  fresh launch shows no pill → touching `dist/renderer/styles.css` (what any
  rebuild does) makes the pill appear within the poll window reading
  "Relaunch to update v0.1.0" (screenshot read: logo + title + mono version +
  arrow, pinned above Settings, dark theme correct) → click exits the running
  instance and a relaunched successor process appears (verified by pid,
  then killed for cleanup). PASS.
