# issue-139 — Replace gateway switcher with a multi-profile "spaces" switcher

GitHub issue: [#139](https://github.com/srikanth235/centraid/issues/139)

Re-skins the sidebar-head switcher from #111/#113/#115 into a multi-profile
**"spaces"** switcher, mirroring a reference design. A profile is a separate
space with its own home grid of apps; switching re-scopes the grid. Profiles
remain backed by the existing **gateway** backend (a profile *is* a gateway):
`name ↔ displayName`, `color ↔ avatarColor`, switch ↔ `setActiveGateway`. The
per-profile `icon` and `description` (no backend field) persist client-side
via `window.Store`, keyed by gateway id.

Implemented idiomatically for the vanilla-TS renderer (IIFE modules on
`window.*`), **not** the prototype's `window.*` Babel/React pattern. The old
`openGatewaySwitcher` popover and its `cd-gw-*` styles are deleted.

## Checklist

- [x] New `@centraid/design-tokens` glyphs
- [x] New `window.Profiles` presentation layer
- [x] `chrome.ts`: generic `headSlot`, gateway switcher removed
- [x] `app.ts`: profile controller wiring
- [x] Fix: deleting a profile from Settings stacked two shells

## What changed

### New `@centraid/design-tokens` glyphs

`packages/design-tokens/icons.ts` — added User, Users, SwitchVert, Home,
Book, Music, Gym, Calendar, Camera path data to `ICON_DATA`. Because
`IconName = keyof typeof ICON_DATA`, these auto-extend the typed icon union
used by the switcher avatars and the Settings nav. (Landed as its own commit.)

### New `window.Profiles` presentation layer

`apps/desktop/src/renderer/profiles.ts` (new) — pure presentation, no IPC.
Owns `PROFILE_COLORS` / `PROFILE_ICONS`, a local `el()` helper, `glyph()`,
client-side meta persistence (`metaFor` / `saveMeta` / `forgetMeta` via the
`profiles.meta` Store key), `avatar()` (uses `tokens.tileFinish` gradient +
icon glyph), `trapFocus` (Esc + Tab trap), and the surface builders:
`buildSwitcherHeader`, `openDropdown`, `openModal` (add/edit with live
preview, save gated on non-empty name), `openDeleteDialog`, `toast`, and
`buildManageBody` for the Settings page. Exposed as `window.Profiles`;
`types.d.ts` declares the `ProfilesApi` + `ProfileView` shapes.

`apps/desktop/src/renderer/index.html` — `profiles.js` script tag after
`chrome.js`, before `builder.js`.

### `chrome.ts`: generic `headSlot`, gateway switcher removed

`apps/desktop/src/renderer/chrome.ts` — the sidebar builder's gateway head
block is replaced with a generic `headSlot?: HTMLElement` (appended above the
divider). Deleted: `profileAvatar` / `profileInitials`, the entire
`openGatewaySwitcher` popover, the gateway fields on `ChromeBuildSidebarOpts`,
and the `openGatewaySwitcher` export. `types.d.ts` drops the matching gateway
switcher types from `ChromeApi`.

### `app.ts`: profile controller wiring

`apps/desktop/src/renderer/app.ts` — `buildHomeSidebar` passes
`headSlot: buildProfileSwitcherHead()`. New controller functions:
`toProfileView`, `buildProfileSwitcherHead`, `openProfileSwitcher`,
`switchProfile`, `openProfileModal`, `commitProfile` (`addLocalGateway` then
`setActiveGateway` to auto-activate a new profile, or `updateProfileMetadata`;
`saveMeta` for icon/blurb), `requestDeleteProfile`, `confirmDeleteProfile`
(`removeGateway` + `forgetMeta`). Settings grows a `profiles` page under a new
**Account** group; `⌘⇧G` opens the switcher.

### Fix: deleting a profile from Settings stacked two shells

Two compounding causes. (1) `removeGateway` in `main` **always** broadcasts
`GATEWAY_CHANGED` (the list changed, caches must drop), which fired
`onGatewayChanged` → re-render Home, while `confirmDeleteProfile` *also* called
`reRenderShellForRoute()` → re-render Settings. (2) Every page render is
`clear()` (empties root now) → `await` (data fetch) → `root.append(shell)`
(later); two concurrent renders both clear early and both append late, stacking
two full shells.

Fixes:

- **Render-generation guard** (`renderSeq`, bumped in `clear()`): each async
  render captures the seq after clearing and skips its append if a newer
  render has started. Applied to `renderHomeAsync`, `renderSettingsAsync`,
  `renderDiscoverAsync`, and `mountShellPage`. Also retroactively guards the
  latent onboarding double-`renderHome`.
- **`confirmDeleteProfile`** no longer re-renders itself — the broadcast
  handler is the single owner of post-delete refresh, so no second concurrent
  render.
- **`onGatewayChanged`** compares the active id before/after `refreshRuntimeMode`:
  it re-scopes to Home only when the *active* space flipped (a switch, or
  deleting the active profile and falling back to local); otherwise it
  refreshes the current route in place so a non-active delete from Settings
  updates the manage list without yanking the user off the page. A new
  `lastSettingsPage` (set by `showSettingsPage`) lets that in-place refresh
  restore the Profiles page rather than snapping back to Appearance.

`apps/desktop/src/renderer/styles.css` — removed the `cd-gw-*` rules; added
the `cd-prof-*` blocks (head, dropdown, overlays, modal, fields, dialog,
toast, manage cards) plus `cd-pop` / `cd-fade` keyframes.

## Out of scope

- Server-side persistence of profile `icon` / `description`. The gateway
  backend has no field for either, so both live in `window.Store` keyed by
  gateway id. A backend field is a future-cycle thing.
- Reordering profiles. The list keeps `listGateways`'s local-first,
  remote-by-createdAt order.
- A distinct in-memory profile model separate from gateways. Per the
  resolved scope, a profile *is* a gateway; this is UI + client-side meta only.

## Verification

- `bun run --filter '@centraid/desktop' typecheck` → pass.
- `bunx oxlint apps/desktop/src/renderer/app.ts` → 0 warnings / 0 errors.
- `bun run --filter '@centraid/desktop' build` → pass; `dist/renderer` synced.
- Electron boots clean (only the harmless SQLite `ExperimentalWarning`).
- Manually walked the switcher: head row, dropdown (hover/focus edit-icon
  alignment, active check), add modal (live preview, save gating), edit modal,
  delete dialog (last-profile block, active fallback), toast, and the Settings
  → Account → Profiles manage page.
- Repro for the stacking bug: delete a non-active profile from Settings →
  Profiles — stays on the Profiles page, card removed, no stacked UI; delete
  the active profile — falls back and lands on Home cleanly.
