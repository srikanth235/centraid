# issue-29 — Port Tweaks panel

GitHub issue: [#29](https://github.com/srikanth235/centraid/issues/29)

## Checklist

- [x] AppearancePrefs gains `bgL`, `coolBlueCast`, `accent`, `cardVariant`
- [x] `applyPrefs` writes `--bg-l`, `--accent` / `--accent-light` / `--accent-deep`, `data-cards`, `data-cool-cast`
- [x] Settings sheet split into Theme / Layout / App tiles groups
- [x] Dark shade slider drives `--bg-l` live (10–35%)
- [x] Cool blue cast switch flips the dark ramp's hue/saturation
- [x] Accent swatch picker (blue · violet · teal · ochre · rose)
- [x] Cards segmented (Flat · Outlined · Elevated) overrides `.cd-app-card` / `.cd-tmpl-card`
- [x] Sidebar visible switch reuses the existing `prefs.sidebarOpen` + `currentSetSidebarOpen` plumbing
- [x] New CSS primitives: `.cd-slider`, `.cd-switch`, `.cd-swatch(es)`, `.drawer-row-inline`

## What changed

**AppearancePrefs gains `bgL`, `coolBlueCast`, `accent`, `cardVariant`.** `app.ts` extends the `AppearancePrefs` interface with four new fields and adds matching defaults in `DEFAULT_PREFS` (`bgL: 18`, `coolBlueCast: true`, `accent: 'blue'`, `cardVariant: 'outlined'`). An `ACCENT_PALETTE` table maps the five accent keys to `{ accent, light, deep }` hex triples — blue keeps the existing Electric Blue `#4950F6`, the other four pull from the palette (`violet #7C5BD9`, `teal #2EA098`, `ochre #B47B3F`, `rose #E55772`) with hand-tuned `light` / `deep` variants.

**`applyPrefs` writes `--bg-l`, `--accent` / `--accent-light` / `--accent-deep`, `data-cards`, `data-cool-cast`.** The function previously only set `data-theme` and `data-density`. It now also sets `data-cards` (drives the card-variant overrides) and `data-cool-cast` (drives the neutral-grey override block) on `<html>`, plus inline `style.setProperty` calls for `--bg-l` and the three accent variables. Stays a single source of truth — every pref change goes through `setPrefs` → `applyPrefs`.

**Settings sheet split into Theme / Layout / App tiles groups.** `openSettingsSheet` now builds three appearance groups matching the design's THEME / LAYOUT sections plus our existing App tiles. The drawer panel title stays "Settings" because Gateway settings still live in the same sheet — but the appearance section now mirrors Tweaks 1:1.

**Dark shade slider drives `--bg-l` live (10–35%).** New `makeSliderRow` helper builds a `<div class="cd-slider-head">` (label + readout) plus a `<input type="range" class="cd-slider">`. `oninput` updates the numeric readout and pushes the value through `setPrefs` so all four dark surfaces (`bg`, `bgApp`, `bgElev`, `bgSunken`, `sidebarBg`, `deviceWall`) retune in real time.

**Cool blue cast switch flips the dark ramp's hue/saturation.** New `makeSwitch` helper produces a `role="switch"` button with a `cd-switch-thumb` span that translates 18px on toggle. When `data-cool-cast='off'` is on `<html>`, a CSS block in `styles.css` re-emits the same four dark surfaces with `hsl(0 0% ...)` so the `--bg-l` anchor still drives them — only hue/saturation change.

**Accent swatch picker (blue · violet · teal · ochre · rose).** New `makeSwatches` helper renders a `role="radiogroup"` with five `cd-swatch` buttons, each painted with its `accent` colour and carrying a 14px `Icon.Check` glyph that fades in via `[data-active='true']`. Selection writes `prefs.accent`, and `applyPrefs` re-derives `--accent` / `--accent-light` / `--accent-deep` from `ACCENT_PALETTE`.

**Cards segmented (Flat · Outlined · Elevated) overrides `.cd-app-card` / `.cd-tmpl-card`.** The existing `.cd-app-card` style is the Outlined default. `[data-cards='flat']` strips the border + frosted backdrop down to a plain `var(--bg-elev)` tile; `[data-cards='elevated']` drops the border and adds `var(--shadow-md)` for depth. The same rules apply to template cards so the home grid stays consistent.

**Sidebar visible switch reuses the existing `prefs.sidebarOpen` + `currentSetSidebarOpen` plumbing.** The Tweaks switch calls `setPrefs({ sidebarOpen: v })` and then `currentSetSidebarOpen(v)` so the active shell's animated grid flips immediately — no rebuild needed. Same wiring the toolbar's sidebar-toggle button uses.

**New CSS primitives: `.cd-slider`, `.cd-switch`, `.cd-swatch(es)`, `.drawer-row-inline`.** Added after the existing `.seg` block in `styles.css`. The slider uses `appearance: none` with custom `::-webkit-slider-thumb` + `::-moz-range-thumb`. The switch is a 40×22 pill with a 18×18 thumb that translates on `[data-on='true']` and the track flips to `var(--success)` for the on state (matches the design's green pill). Swatches are a 5-column grid with 44px-tall buttons, a 1.5px transparent border that turns `var(--ink)` when active, and an opacity-fading check glyph. `.drawer-row-inline` switches the row from column-stacked to row-flex with the label on the left and control on the right (used by both switches).

## Out of scope

- Persisting prefs across machines / accounts. Same `appearance` Store key as before — local only.
- A live preview "tile" in the panel showing how cards look. The grid below the panel already updates in real time, which is the design's intent.
- Re-styling other surfaces (chat pane, builder topbar, modals) to react to `data-cards`. Cards-attr currently only retones home cards + templates per design scope.
- Light-theme variants of the Cool blue cast override. Light theme has no blue cast to begin with; the attribute is a no-op there.

## Verification

- `bun run typecheck` clean across all 10 packages.
- `bun run build` clean — desktop's `tsc` + preload bundle + asset copy succeed.
- Manual: open Settings, drag the Dark shade slider 10→35; the whole dark ramp retunes live and the readout follows.
- Manual: toggle Cool blue cast off; surfaces lose the blue tint while the slider's lightness anchor still works.
- Manual: click each of the five accent swatches; the active state moves, FAB/sparkle/CTAs repaint to the new hue immediately.
- Manual: flip Cards between Flat/Outlined/Elevated; the home grid's app cards + template cards reflect the change without reload.
- Manual: flip Sidebar visible; the shell collapses/expands matching the toolbar toggle.
- Follow-up: CI's repo-wide `oxfmt --check` flagged the cool-cast `--device-wall` fallback in `styles.css`; reformatted (long `linear-gradient(...)` wrapped to multi-line) in a follow-up commit. Same commit also fixes a `scripts/lint-staged.sh` bug — oxfmt errored with "Expected at least one target file" when only `.md` files were staged; added `--no-error-on-unmatched-pattern` so the hook no-ops cleanly.
