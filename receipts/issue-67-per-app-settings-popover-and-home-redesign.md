# issue-67 — Per-app settings popover + Home page redesign

GitHub issue: [#67](https://github.com/srikanth235/centraid/issues/67)

## Checklist

- [x] Templates declare tweakable knobs in `app-knobs.json` (font / width / radius / color)
- [x] `build-manifest.mjs` embeds the declarations into `manifest.json`
- [x] Builder-harness scaffolds a default `app-knobs.json` for new templates
- [x] Runtime routes `app*` knobs dynamically (Color/Accent suffix → CSS var, else → data attr) — no `KNOWN_KEYS` change needed per knob
- [x] Desktop popover fetches the manifest + persists knob values via `appQuery`
- [x] Home app tile mirrors the template card (icon + name + desc) with a hairline-separated foot strip (last-edited time on the left, status pill anchored right)
- [x] App grid matches template grid sizing so widths align column-for-column
- [x] Empty state ("Your workspace is a blank canvas") with pointer cues at the hero prompt and the template strip
- [x] Sidebar Apps section always visible (placeholder when empty), per-row action uses 3-dots-vertical
- [x] Trailing status dot removed from sidebar rows
- [x] "n apps" meta removed from the section head
- [x] Toast adopts theme-aware surface tokens (glassy in dark, white in light) with accent-tinted check
- [x] Lucide `Check` path repaired (was two overlapping checkmarks) — toast + selected swatch now read cleanly
- [x] 3-dots buttons render the SVG centered in their 24×24 box (`inline-flex` + `line-height: 0` + `display: block`)
- [x] Template card uses theme-aware background so its border doesn't blend into the light-mode wall
- [x] Settings drawer: locked/disabled "Dark shade" slider removed; check glyph restored on active accent swatch
- [x] `scaffold.ts` kept under repo-hygiene's 500-line limit by extracting `DEFAULT_APP_CSS` to `scaffold-defaults.ts`

## What changed

**Templates declare tweakable knobs in `app-knobs.json` (font / width / radius / color).** Each curated template (hydrate, journal, todos) ships its own knob list — `appFont` (sans / serif / mono), `appWidth` (narrow / wide), `appRadius` (rounded / pill), and `appColor` (swatch palette). `packages/app-templates/src/types.ts` adds `AppKnob` / `AppKnobOption` / `AppKnobsManifest` types so consumers (the manifest builder and the desktop popover) share the same schema. Each template's `app.css` was extended to honor the knobs via `:root[data-app-font='…']` / `:root[data-app-width='…']` rules and `var(--app-color, var(--accent))` substitutions in the primary palette.

**`build-manifest.mjs` embeds the declarations into `manifest.json`.** The build script reads each template's `app-knobs.json` (when present) and attaches its `knobs` array to that template's manifest entry under `appKnobs`. Templates without a knobs file simply omit the field — the desktop popover treats absence as "no per-app knobs available". A regenerated `packages/app-templates/manifest.json` ships with hydrate, journal, and todos all carrying their knob declarations.

**Builder-harness scaffolds a default `app-knobs.json` for new templates.** `scaffoldProject` now writes a `DEFAULT_APP_KNOBS` constant alongside `index.html` / `app.css` / `app.js`, so any model that scaffolds via the harness inherits the same four standard knobs the curated templates have.

**Runtime routes `app*` knobs dynamically (Color/Accent suffix → CSS var, else → data attr) — no `KNOWN_KEYS` change needed per knob.** `packages/runtime-core/src/settings-merge.ts` no longer carries `app*` entries in `KNOWN_KEYS`. Instead, `isAppKnobKey` checks the prefix shape (`app[A-Z]…`), `camelTailToKebab` produces the target name, and the suffix decides routing: keys ending in `Color` or `Accent` become `--app-color` / `--app-accent` CSS variables, everything else becomes a `data-app-*` attribute. The settings-merge test suite covers `appFont` (data attr), `appColor` (CSS var), and `appAccent` (CSS var) routing.

**Desktop popover fetches the manifest + persists knob values via `appQuery`.** When the user opens an app's gear popover, `fetchAppKnobsManifest(gateway, appId)` pulls the knob list from the served `app-knobs.json`. The popover renders segmented controls for `segmented`-type knobs and swatches for `swatch`-type knobs. Selecting a value writes it to the per-app `__centraid_settings` table via `appQuery` (UPSERT) and pushes the change to the live iframe via `postMessage('centraid:settings', …)`. The push uses the same `Color`/`Accent` suffix routing as the runtime baker, so live updates mirror what `buildSettingsInject` would produce on reload.

**Home app tile mirrors the template card (icon + name + desc) with a hairline-separated foot strip (last-edited time on the left, status pill anchored right).** Identical structure for the top row — 32px icon + name + (optional) description — so the home page reads as one consistent grid family. Below that row, a hairline-separated foot strip shows the app's lifecycle: `relativeTime(updatedAt)` (or "Continue editing" for drafts) on the left, and the status pill anchored to the right edge via `margin-inline-start: auto` (more robust than `space-between` when the foot has only one child).

**App grid matches template grid sizing so widths align column-for-column.** `.cd-apps-grid` was switched from a capped `minmax(220px, 280px)` to `repeat(auto-fill, minmax(220px, 1fr))` — the exact same shape as `.cd-tmpl-grid`. Single app tiles still sit in track 1 (no stretching across the full row) because `auto-fill` keeps empty trailing tracks reserved instead of collapsing them.

**Empty state ("Your workspace is a blank canvas") with pointer cues at the hero prompt and the template strip.** When the user has no apps and no drafts, the "Your apps" section renders `cd-apps-empty` instead of the grid: a dashed-border card with a dot-grid background, a centered 48px gradient icon tile, the headline, and two pointer chips — `↑ Describe above` and `↓ Pick a template` — that physically aim at the hero prompt and the templates row. The card is locked at `height: 240px` with `justify-content: center` so an ancestor flex layout can't stretch it.

**Sidebar Apps section always visible (placeholder when empty), per-row action uses 3-dots-vertical.** Previously the section header was hidden when no apps existed. Now `buildSidebar` always emits the section, with a disabled `sbItem({ label: 'No apps yet' })` standing in when empty. The per-row action button switched from `Icon.MoreHoriz` to `Icon.MoreVert` (matches the design's vertical 3-dots affordance for list rows). The `MoreVert` icon was added to `@centraid/design-tokens`.

**Trailing status dot removed from sidebar rows.** Apps and drafts no longer pass `dotColor` to `sbItem`. The home tile and the section header already carry status information, and a colored dot at the trailing edge of every row added visual noise without earning its weight. The unused `statusDotColor` helper was deleted with it.

**"n apps" meta removed from the section head.** The "1 app · 2 drafts" indicator on the right edge of the section header was redundant with the visible tile count and read as a floating piece of chrome — gone.

**Toast adopts theme-aware surface tokens (glassy in dark, white in light) with accent-tinted check.** `.preview-toast` previously used `var(--ink)` for background and `var(--ink-inv)` for text, producing an inverted pill that clashed with the chrome on both themes. The new rule uses `var(--bg-elev)` + `var(--ink)`, with a dark-theme override that adds backdrop blur + saturate so the pill matches the glass aesthetic of floating panels elsewhere. The check glyph inside the toast picks up `var(--accent)`.

**Lucide `Check` path repaired (was two overlapping checkmarks) — toast + selected swatch now read cleanly.** The icon was defined as `M3 12l2 2 4-4M14 6l4 4-8 8-3-3` — two overlapping checkmarks rendered on top of each other. Replaced with the standard Lucide check `M5 12l5 5L20 7`. Affected surfaces: the success toast (`Updated "Hydrate"`), the active accent swatch in global Settings, and the active `appColor` swatch in the per-app popover; all three now show a clean single check.

**3-dots buttons render the SVG centered in their 24×24 box (`inline-flex` + `line-height: 0` + `display: block`).** `.cd-card-more` used `display: grid; place-items: center`, but the SVG inside defaulted to `display: inline`, which gave the grid cell extra line-box height for the inline baseline and visually nudged the icon upward. Switched to `display: inline-flex` + `line-height: 0` + `padding: 0` + an explicit `.cd-card-more svg { display: block }`, so the SVG's bounding box is the only thing flex centers against.

**Template card uses theme-aware background so its border doesn't blend into the light-mode wall.** The card defaulted to `background: color-mix(in srgb, var(--bg-elev) 60%, transparent)` with backdrop-blur, which works against the dark theme's gradient but vanishes against the light theme's near-white wall. Light mode now uses solid `var(--bg-elev)` + `1px var(--line)` + `var(--shadow-sm)` (same treatment as the app cards above); dark mode keeps the glassy variant. Hover adds a 1px translateY and a slightly bigger shadow.

**Settings drawer: locked/disabled "Dark shade" slider removed; check glyph restored on active accent swatch.** The "Dark shade" slider had been locked at 5 and rendered disabled for a while — removed it entirely along with its `makeSliderRow` helper and the `.cd-slider*` CSS block. The `bgL=5` value stays in prefs since the background gradient and the legacy `bgL` propagation depend on it; only the user-facing control is gone. With the underlying `Check` path fixed, the check glyph was restored on the active accent swatch (the white ring marks selection from a distance, the check confirms it close-up).

**`scaffold.ts` kept under repo-hygiene's 500-line limit by extracting `DEFAULT_APP_CSS` to `scaffold-defaults.ts`.** Adding `DEFAULT_APP_KNOBS` would have pushed `scaffold.ts` over the 500-line cap. The long `DEFAULT_APP_CSS` template literal (158 lines) and its header comment now live in `packages/builder-harness/src/scaffold-defaults.ts`, imported back into `scaffold.ts`. The scaffolding logic, validation, and other templates stay in `scaffold.ts` (381 lines).

## Out of scope

- A full app-knob editor in the **builder harness** UI. Scaffolded projects ship the default knobs, but editing them post-scaffold requires hand-editing `app-knobs.json` until the harness grows a UI surface for it.
- Per-app **theme override**. Theme stays a global setting — only aesthetic knobs (font, width, radius, color) are per-app. We considered surfacing theme in the popover earlier but pulled it back so every app honors the user's chosen workspace theme.
- A **migration path** for legacy `app*` keys that might have been baked into existing settings rows with the old static `KNOWN_KEYS` shape. The dynamic router accepts any `app*` key by convention, so the rename is non-breaking in practice; an explicit migration was not needed.
- Visual changes to the **builder** pane, the **chat** pane, or the **settings page** beyond the swatch/slider tweaks called out above.

## Verification

- `npm --workspace apps/desktop run typecheck` — clean
- `npm --workspace apps/desktop run build` — clean
- `npm --workspace packages/builder-harness run typecheck` — clean (after `DEFAULT_APP_CSS` extraction)
- `npm --workspace packages/runtime-core run test` — settings-merge test suite includes new `isAppKnobKey` / `appKnobTarget` routing cases
- Manual: cloned Hydrate from the home Templates row, opened the gear popover, flipped each knob (font / width / radius / color) and confirmed live update via `postMessage('centraid:settings', …)`, persistence to `__centraid_settings` via `appQuery`, and re-bake on reload via `buildSettingsInject`
- Manual: deleted all apps + drafts to confirm the home empty state renders the `cd-apps-empty` card and the sidebar shows the "No apps yet" placeholder
- Manual: toggled global theme to verify the toast adopts the theme's surface tokens on both dark and light
- Manual: hovered template cards and confirmed the 3-dots affordance sits visually centered in its hover focus box
