# issue-32 — Model Settings as a page in the main panel

GitHub issue: [#32](https://github.com/srikanth235/centraid/issues/32)

## Checklist

- [x] `settings` added to renderer's `ShellRoute` union and routed via `applyRoute`
- [x] `openSettingsSheet()` replaced by `renderSettings()` / `renderSettingsAsync()` mounted via `Chrome.buildWindow`
- [x] Same four groups (Theme / Layout / App tiles / Gateway) and live-apply / explicit-save semantics preserved
- [x] Home sidebar `onSettings` and `window.Centraid.openSettings` (used by builder) both navigate to the new route
- [x] Sidebar highlights the Settings item when active via `activeId === 'settings'`
- [x] `.cd-window` layout chain fixed so tall main-column content scrolls inside `.cd-main-scroll`

## What changed

**`settings` added to renderer's `ShellRoute` union and routed via `applyRoute`.** The renderer's route stack already covered Home / App / Builder; Settings now joins the same union. `routeKey` distinguishes `'settings'` so `recordRoute` doesn't double-push, and `applyRoute` dispatches to `renderSettings()`. Back/forward (⌘[ / ⌘]) navigate to and from Settings the same way they do for the existing routes — settings is part of the nav history, not an overlay.

**`openSettingsSheet()` replaced by `renderSettings()` / `renderSettingsAsync()` mounted via `Chrome.buildWindow`.** The old function built a `drawer-backdrop` + `drawer-panel` and appended them to `document.body`. The new function follows the same pattern as `renderHomeAsync`: `clear()`, build a `main` div containing a `cd-main-scroll` column, append a width-constrained `page` wrapper, and mount through `Chrome.buildWindow` so the sidebar + titlebar come along for free. The page is constrained to `max-width: 720px` (inline style, since this is a one-off page wrapper and not a reusable component) so the drawer-row controls keep their visual rhythm inside the wider main panel.

**Same four groups (Theme / Layout / App tiles / Gateway) and live-apply / explicit-save semantics preserved.** All segmented controls, sliders, switches, swatches, and gateway inputs reuse the existing `makeSegmented` / `makeSliderRow` / `makeSwitch` / `makeSwatches` / `drawerGroup` / `drawerRow` / `drawerRowInline` helpers — only the chrome around them changed. Theme / Layout / App tiles still apply live through `setPrefs`; Gateway URL / token / projects dir still need an explicit Save (and offer a Test connection). The drawer's `close()` after Save is gone — the page stays mounted, the toast is the feedback.

**Home sidebar `onSettings` and `window.Centraid.openSettings` (used by builder) both navigate to the new route.** `buildHomeSidebar` now passes `renderSettings` directly as `onSettings` (previously `() => void openSettingsSheet()`). `window.Centraid.openSettings` — called by the builder's "Open Settings" buttons when the gateway is unreachable — also points at `renderSettings`, so builder → Settings unmounts the builder cleanly via `clear()` and mounts the page.

**Sidebar highlights the Settings item when active via `activeId === 'settings'`.** `chrome.ts:buildSidebar` already passed `activeId` through to Home and per-app items; the Settings item at the bottom now also reads `active: opts.activeId === 'settings'`, matching the pattern.

**`.cd-window` layout chain fixed so tall main-column content scrolls inside `.cd-main-scroll`.** Live DOM inspection on the Settings page showed `.cd-window` blowing past its 900px flex slot to 1580px because (a) it's a flex child of `#root` with default `min-height: auto`, and (b) its grid track was `1fr` which resolves as `minmax(auto, 1fr)`. When `.cd-main`'s content was tall, the row's `auto` minimum forced the row to fit content, `.cd-window` grew with it, and `.cd-main-scroll`'s `overflow-y: auto` had nothing to clip. Adding `min-height: 0` to `.cd-window` and switching the row to `minmax(0, 1fr)` lets the flex parent shrink it back into the slot and caps the row at 1fr regardless of content min-content. Home / App / Builder were already fitting in the slot, so they're unaffected; Settings — and any future tall page — now scrolls.

## Out of scope

- Restructuring the gateway form layout. The four groups still use the drawer-row column-stacked layout authored for the ~360px drawer; widening them to take advantage of the 720px page wrapper is follow-up work.
- New CSS primitives for "page header". The page-header `<h1>` + subtitle use inline styles for now — promoting them to `.cd-page-head` would only matter once a second page (e.g. Plugins, Automations) lands.
- Tile-treatment auto-refresh of Home. The drawer used to call `renderHome()` after changing `tileVariant` if Home was mounted; on the Settings page Home isn't mounted, so the pref persists and is picked up on next Home render.

## Verification

- `bun run typecheck` clean (`tsc -p tsconfig.json --noEmit`).
- `bun run format:check` clean on the touched files.
- Manual: from Home, click sidebar Settings → page renders inside `.cd-main-scroll`; sidebar Settings item highlights; ⌘[ goes back to Home; ⌘] returns to Settings.
- Manual: live-toggle Mode / Dark shade / Cool blue cast / Accent / Density / Cards / Sidebar visible / Tile treatment — all apply immediately and persist across navigation.
- Manual: edit Gateway URL + Save → toast "Settings saved"; the page stays open so the user can keep configuring.
- Manual: in the builder, trigger the "Open Settings" affordance → builder unmounts cleanly and the Settings page renders.
- Manual: DevTools confirmed `.cd-window` clientHeight = innerHeight after the CSS fix, and `.cd-main-scroll` clips at its parent's height so the wheel scrolls the page content.
