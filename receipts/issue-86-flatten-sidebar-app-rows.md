# issue-86 — Flatten sidebar app rows; move App/Cloud to the top bar

GitHub issue: [#86](https://github.com/srikanth235/centraid/issues/86)

Selecting an app in the desktop left sidebar previously expanded its row
into two child rows — **App** and **Cloud** (the §G2 behaviour landed in
[#82](https://github.com/srikanth235/centraid/issues/82)). Those
destinations duplicate the top bar's **Use / Build** switch, so the
expansion is dropped: selecting an app simply highlights its row and
shows the app view.

## Checklist

- [x] Sidebar — drop App/Cloud child expansion, highlight active row
- [x] Builder — add Cloud as a pane tab so its dashboard stays reachable
- [x] Fix pre-existing `gatewayDb` -> `automationDb` build break

## What changed

**Sidebar — drop App/Cloud child expansion, highlight active row.**
`chrome.ts buildSidebar` no longer calls `expandedApp()` for the app
matching `activeId` — that helper, the fisheye `dot` glyph, and the
`.cd-sb-app-expanded` / `.cd-sb-folder-children` CSS were removed. The
active app now renders as an ordinary `sbItem` with `active: true`. The
`ChromeBuildSidebarOpts` contract dropped `activeSurface` and
`onAppSurface` (both only fed the expansion); `app.ts buildHomeSidebar`
lost its `surface` descriptor field and `onAppSurface` handler
accordingly. App/Cloud destinations now live solely in the top bar's
existing Use/Build switch.

**Builder — add Cloud as a pane tab so its dashboard stays reachable.**
Because the builder's Cloud surface (deploy / status / activity
dashboard) was reachable *only* through the sidebar `Cloud` child,
removing the expansion would orphan it. `Cloud` is added to the
builder's `tabDefs` alongside Preview and Code, so it is reachable from
the right-pane tab pill. The builder's `buildSidebar` call dropped
`activeSurface: 'cloud'` and the `onAppSurface` handler.

**Fix pre-existing `gatewayDb` -> `automationDb` build break.** The
[#80](https://github.com/srikanth235/centraid/issues/80)/#81 automations
refactor renamed `gatewayDbPath` -> `automationDbPath` in
`OsSchedulerHostOptions` and `gatewayDb` -> `automationDb` in
`RuntimeOptions` / `RunAutomationLocalOptions`, but three desktop
callsites (`local-runtime.ts` x2, `ipc.ts`) were missed, leaving the
desktop package failing `tsc`. The desktop keeps gateway and automation
records in one SQLite file, so the fix is a pure rename to the new
property names.

## Out of scope

- Mobile renderer (desktop only).
- Any change to the Use/Build switch itself.

## Verification

- `tsc -p apps/desktop/tsconfig.json --noEmit` — clean (was 3 errors
  before the `automationDb` rename).
- `oxfmt` / `oxlint` on the changed files — clean.
- Visual verification in a running Electron window is pending — needs a
  manual `bun run dev` smoke test of the flattened sidebar and the new
  builder Cloud tab.
