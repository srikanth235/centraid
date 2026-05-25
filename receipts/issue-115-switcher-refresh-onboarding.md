# issue-115 — Refine gateway switcher + first-run onboarding + v0 cleanup

GitHub issue: [#115](https://github.com/srikanth235/centraid/issues/115)

Polish pass on top of #111/#112/#113. Three threads land together because
they share renderer files heavily (app.ts, styles.css, types.d.ts):

1. Switcher UI is refreshed end-to-end — flat profile list with a
   Notion-style per-row `⋯` menu, footer "Add profile" CTA, ⌘1…⌘9
   keyboard shortcuts, atmospheric popover. The v1 chip-strip / leading
   check column / LOCAL/REMOTE pills are gone.
2. Token-rotation IPC closes the last remote-gateway CRUD gap — the
   `updateGatewayToken` store function from #109 was never wired through
   to the renderer; it is now.
3. First-run onboarding gates the renderer on a new
   `settings.onboardingCompletedAt` flag. On a fresh install the user
   names + picks a color for their primordial local profile before home
   ever paints. The "My computer" default label is gone — the
   auto-created profile carries no `displayName` on disk until
   onboarding writes it.

Plus v0 BC-cleanup per the user's instruction "this is v0, please note
it down in memory and also remove backwards compatibility code if any".

## Checklist

- [x] New `gateways:update-token` IPC + preload bridge + renderer API decl
- [x] Switcher: flat profile list (no LOCAL/REMOTE sections)
- [x] Switcher: per-row `⋯` inline-expands into vertical action menu
- [x] Switcher: active-state ring on avatar, kill leading-check column
- [x] Switcher: footer "Add profile" CTA → kind chooser → typed form
- [x] Switcher: filter input at ≥4 profiles
- [x] Switcher: atmospheric popover (inset top highlight + layered shadow)
- [x] Sidebar head row simplified to `[avatar] Name ▾`
- [x] Keyboard: ⌘1…⌘9 jump to Nth profile (suppressed in inputs)
- [x] Keyboard: ↑/↓ + Enter + `/` inside popover
- [x] `settings.onboardingCompletedAt` field on `PersistedSettings` + `DesktopSettings`
- [x] `ensureLocalGateway` no longer pre-names the primordial profile
- [x] New `apps/desktop/src/renderer/onboarding.ts` welcome view
- [x] Renderer gates first render on `onboardingCompletedAt`
- [x] v0 BC removal: legacy theme-bridge postMessage, `colors` alias, `usr_` fallbacks, icon-color migration sweep

## What changed

### New `gateways:update-token` IPC + preload bridge + renderer API decl

`apps/desktop/src/main/ipc.ts` — new `GATEWAYS_UPDATE_TOKEN` channel +
handler. Plaintext crosses the bridge exactly once (mirroring
`gateways:add`) and goes to keychain via `updateGatewayToken` from the
gateway-store. When the rotated profile is the active one, the
HTTP-client auth caches drop and `GATEWAY_CHANGED` re-broadcasts so the
next IPC sees the new bearer.

`apps/desktop/src/preload.ts` — `GATEWAYS_UPDATE_TOKEN` channel +
`updateGatewayToken` bridge method.

`apps/desktop/src/renderer/centraid-api.d.ts` — `updateGatewayToken`
typed on the `CentraidApi` interface; doc covers the "plaintext once,
empty string clears, no-op for local" semantics.

### Switcher: flat profile list (no LOCAL/REMOTE sections)

`apps/desktop/src/renderer/chrome.ts` — the popover's body builder no
longer groups by `kind`. Profiles render in a single list ordered
local-first then remote-by-createdAt, matching `listGateways`'s sort.
The two `LOCAL` / `REMOTE` mono-caps section headers (and their per-
section `+` buttons) are gone. Kind moves to a muted secondary line
per row (`Local · Default workspace`, `Remote · gateway.example.com`)
where it doesn't compete with the top-line displayName.

### Switcher: per-row `⋯` inline-expands into vertical action menu

`chrome.ts` `renderRowActions` builds a vertical `.cd-gw-pop-actionmenu`
that replaces v2's horizontal chip strip. Items: Rename · Change color ·
Rotate token (remote only) · Remove. A hairline `.cd-gw-pop-actionmenu-rule`
separates safe and destructive actions (macOS context-menu convention).
Rename inflates an input inside the menu's `subbox`; Change color
inflates the 8-swatch picker with commit-on-click; Rotate token takes
over the popover with a back-chevron header so the user isn't typing
a bearer in the same visual frame as the other rows.

A left rail (`.cd-gw-pop-actionblock::before`) drops from the parent
row's avatar centerline through the menu so the expansion reads as a
continuation of the row, not a floating affordance.

### Switcher: active-state ring on avatar, kill leading-check column

`chrome.ts` row no longer renders a leading `.cd-gw-pop-check` cell.
Active state is carried by the avatar itself: `.cd-gw-pop-avatar-wrap`
is a 28px circle around the 24px avatar disc, with `inset box-shadow:
0 0 0 2px var(--accent)` on `[data-active='true']`. The 2px wrap
gutter prevents the ring from clashing with same-colored avatar fills.
Active rows also wear bolder `.cd-gw-pop-name` and a faint
accent-tinted row background.

### Switcher: footer "Add profile" CTA → kind chooser → typed form

`chrome.ts` `renderFooterAddCta` emits a single full-width row with a
dashed-circle icon plate that solidifies + fills accent on hover.
Click → `renderChooseKind` (Local workspace | Remote gateway tile pair)
→ `renderAddLocal` or `renderAddRemote`. Replaces v1's pair of
section-header `+` buttons that pushed the list down with inline forms.

### Switcher: filter input at ≥4 profiles

`chrome.ts` `renderList` conditionally emits a `.cd-gw-pop-filter`
input above the list when `profiles.length >= SWITCHER_FILTER_MIN`
(currently 4). Filters case-insensitively against `displayName`,
`label`, `url`. Arrow-down from the input lands on the first row;
Esc in a non-empty filter clears it before closing.

### Switcher: atmospheric popover (inset top highlight + layered shadow)

`styles.css` `.cd-gw-pop` grows `border-radius: 12px`, `0.5px` border
mixed with `--ink`, and a layered shadow stack: `inset 0 1px 0` for
the lit upper edge + three outer shadows tuned for the dark renderer.
Replaces v2's flat dark rectangle look. Backdrop is unchanged but the
popover now reads as a "floating polished surface."

### Sidebar head row simplified to `[avatar] Name ▾`

`chrome.ts` `buildSidebar` no longer appends the `kindPill`
(`.cd-sb-gw-kind`) or the geometric kind glyph next to the chevron.
Row content: 20px avatar + `displayName` label + small chevron. Kind
metadata lives only in the popover's secondary line per row. `styles.css`
drops `.cd-sb-gw-mark` and `.cd-sb-gw-kind` rules entirely.

### Keyboard: ⌘1…⌘9 jump to Nth profile (suppressed in inputs)

`apps/desktop/src/renderer/app.ts` global `keydown` handler grows a
`⌘1…⌘9` branch (no shift, no alt) that fetches `listGateways()` and
calls `setActiveGateway` for the Nth profile in the sorted list.
Suppressed when the focused element is an `<input>`, `<textarea>`, or
`contenteditable` so ⌘1 in a text field doesn't punt the user out of
their workspace. `⌘⇧G` (switcher open) is unchanged. The `.cd-gw-pop-numhint`
chip on each row in the popover surfaces the binding visually.

### Keyboard: ↑/↓ + Enter + `/` inside popover

`chrome.ts` per-row `keydown` handler implements `ArrowDown` /
`ArrowUp` row-focus traversal (with `ArrowUp` from the first row
landing on the filter input when present) and `/` to focus the
filter. `Enter` activates the focused row through the native button
behavior (rows are `<button>` elements). Esc collapses any open
sub-view first, then closes the popover.

### `settings.onboardingCompletedAt` field on `PersistedSettings` + `DesktopSettings`

`apps/desktop/src/main/settings.ts` — both interfaces grow
`onboardingCompletedAt?: string` (ISO timestamp). Threaded through
`narrow()` (preserves the field on read), `resolveEffective()` (passes
it through to the effective form), and `saveSettings()` (allows
patching it). Absent on a fresh install — the renderer reads this as
the gate for showing onboarding instead of home. Once written it's
permanent.

`apps/desktop/src/renderer/centraid-api.d.ts` — mirrors the field on
`CentraidSettings`.

### `ensureLocalGateway` no longer pre-names the primordial profile

`apps/desktop/src/main/gateway-store.ts` — `DEFAULT_LOCAL_LABEL`
changes from the presumptuous `'My computer'` to a neutral `'Local'`.
More importantly, `ensureLocalGateway` writes the profile **without
a `displayName` field** — the field is absent on disk until
onboarding sets it via `updateProfileMetadata`. `readProfile`'s
read-time default (`displayName ??= label`) handles the gap so
callers always see a populated string, but the on-disk absence is
the v0 invariant the onboarding flow keys on (indirectly via
`settings.onboardingCompletedAt`).

### New `apps/desktop/src/renderer/onboarding.ts` welcome view

New IIFE module exposed on `window.Onboarding` with a single
`mount({ root, onComplete })` API. Fullscreen welcome view:

- Atmospheric dark stage with a radial gradient base and an
  accent-tinted soft blob (`--onb-accent`) that recolors live with
  the user's swatch pick.
- 88px avatar preview with a pulsing glow ring + live-updated
  initials.
- Display-name input (autocapitalize words, 60-char limit, focused
  on mount).
- 8-swatch color picker (matches `gateway-store.AVATAR_PALETTE`).
- Primary "Enter Centraid →" CTA in the accent color with a lit
  inner highlight, disabled until name is non-empty.
- Hero typography: Space Grotesk italic for "at home" in the
  headline, JetBrains Mono for the `CENTRAID` eyebrow.
- Inline error surface (no global toast layer at this boot stage).

`apps/desktop/src/renderer/index.html` — `onboarding.js` script tag
between `app-chat.js` and `app.js`.

`apps/desktop/src/renderer/types.d.ts` — new `Window.Onboarding`
interface declaring the `mount({ root, onComplete })` shape.

`apps/desktop/src/renderer/styles.css` — full onboarding block
(`.cd-onb-view`, `.cd-onb-stage-bg`, `.cd-onb-stage-glow`,
`.cd-onb-card`, `.cd-onb-eyebrow`, `.cd-onb-title`, `.cd-onb-sub`,
`.cd-onb-avatar*`, `.cd-onb-form`, `.cd-onb-input`,
`.cd-onb-swatches`, `.cd-onb-cta`, `.cd-onb-error`) with entrance
animations + pulse + hover lift + focus ring keyed to
`--onb-accent`.

### Renderer gates first render on `onboardingCompletedAt`

`apps/desktop/src/renderer/app.ts` boot path now reads
`getSettings()` before the first render. When
`settings.onboardingCompletedAt` is absent it calls
`window.Onboarding.mount({ root, onComplete })` and returns early —
home is never painted in that boot. On submit the `onComplete`
callback writes the user's name + color via
`updateProfileMetadata({ id: 'local', displayName, avatarColor })`,
flips `onboardingCompletedAt` via
`saveSettings({ onboardingCompletedAt: new Date().toISOString() })`,
then runs the normal sequence (`refreshRuntimeMode` + `renderHome`).

### v0 BC removal: legacy theme-bridge postMessage, `colors` alias, `usr_` fallbacks, icon-color migration sweep

Centraid is pre-release. Memory note saved at
`~/.claude/projects/-Users-srikanth-gitspace-centraid/memory/centraid-v0-status.md`
so future sessions don't reintroduce migrations.

Removed in this commit:

- **`broadcastSettingsToFrames` legacy theme-bridge postMessage** —
  used to send a duplicate `centraid:theme` payload "for any old
  `theme-bridge.js` still in the wild." No published apps exist
  outside this session; single canonical `centraid:settings` payload
  now.
- **`CentraidTokens.colors` alias** in `preload.ts` and `types.d.ts`
  — zero call sites in the renderer (mobile app keeps importing
  `colors` directly from `@centraid/design-tokens`, unaffected).
- **`'usr_' + Math.random()` fallback id** in `addUserApp` —
  `projectId` is now required; the builder only fires `onAddToHome`
  after a successful publish, at which point the project id is
  always set.
- **"Legacy `usr_` apps" stub branch** in `mountUserApp` —
  `projectId` is now required; the function only handles the
  centraid-app iframe path. ~40 lines of dead code removed.
- **Idempotent icon-color migration sweep** on boot — was rewriting
  `userApps` from localStorage to enforce the canonical icon→hue
  contract and backfilling `updatedAt`/`createdAt`. In v0 every
  entry is created with these fields set.
- **BC-flavored comments** in `settings.ts` `narrow()` ("users
  upgrading from a pre-#109 build") and `gateway-store.ts`
  `readProfile` ("v0 doesn't migrate older profile.json files"). The
  read-time defaults stay — they're necessary for the
  pre-onboarding primordial-local case, not for migration.

## Out of scope

- Onboarding step for connecting a remote gateway. v0 onboarding only
  personalizes the local profile; remote gateways are added later from
  the switcher's footer CTA. Keeps the first-run decision space
  minimal.
- Skip / "use defaults" affordance on the onboarding view. The choice
  is a 5-second action and the resulting profile is what every other
  surface reads off — making it skippable would mean the sidebar
  could land on an empty avatar disc.
- Per-app shortcuts (⌘1…⌘9 currently switches profiles, not opens
  apps). Centraid's "primary thing to switch" is the profile; apps
  live one level down. Reconsider if the app-list shortcut pattern
  emerges from user feedback.
- Inline onboarding within an existing-user upgrade flow. v0 means
  every user is a first-run user; anyone with prior data sees
  onboarding once on next launch (acceptable migration cost).
- Token rotation UX in the renderer Settings panel (only available
  via the switcher's per-row `⋯` menu). Settings panel is its own
  surface and a future-cycle thing.

## Verification

- `bun run typecheck` (turbo across all 16 packages) → all pass.
- `bun run format:check` → all 354 files formatted correctly.
- No tests reference the removed symbols (`'My computer'`,
  `CentraidTokens.colors`, `'usr_'` fallback) — grep clean.
- Manually walked the switcher's interaction states: rest, hover,
  focus, expanded `⋯`, rename inline, change-color inline (commits
  on click), rotate-token sub-view, footer add → chooseKind →
  addLocal/addRemote forms, filter input visible at 4+ profiles.
- Manually walked the onboarding flow: empty name disables CTA,
  swatch click updates avatar + headline italic + glow + CTA color
  in lockstep, Enter submits, error surface inflates if
  `updateProfileMetadata` throws.
