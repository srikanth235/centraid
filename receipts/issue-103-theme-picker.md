# issue-103 — VSCode-style named theme presets

GitHub issue: [#103](https://github.com/srikanth235/centraid/issues/103)

Landed across two commits: the design-tokens registry split + new presets, then the desktop renderer picker UI + iframe-kind propagation.

## Checklist

- [x] 12 theme presets shipped
- [x] CSS generator iterates the registry
- [x] Desktop theme picker
- [x] Iframe theme propagation switched to kind

## What changed

**12 theme presets shipped (`packages/design-tokens/themes/`).** Centraid Light/Dark (unchanged defaults) plus Notion Light/Dark, Airtable Light/Dark, GitHub Light/Dark, Solarized Light/Dark, Nord, and Monokai. Each preset is a full `Theme` literal — surfaces, ink ramp, hairlines, shadows, sidebar chrome, accent ramp, deviceWall crosshatch. Colors taken from each tool's canonical palette: Notion's warm beige sidebar `#f7f6f3` over `#37352f` ink with the `#2383e2` link blue; Airtable's `#166ee1` primary CTA blue over `#1d1f25` ink; GitHub's Primer palette; Solarized's base03/base3 surfaces with `#268bd2` accent; Nord's polar-night ramp with `#88c0d0` frost accent; Monokai's `#272822` over the canonical pink `#f92672`.

**Registry split into one file per family.** The previous single `themes.ts` was 618 lines once all 12 were inline — past the 500-line `repo-hygiene` ceiling. Split into `themes/_shared.ts` (interface + shared constants), one file per family (centraid, notion, airtable, github, solarized, nord, monokai), and a `themes/index.ts` barrel that builds the registry + `THEME_PRESETS` ordered list. Existing `from './themes'` import paths resolve unchanged through the directory's index.

**Theme interface gains `kind: 'light' | 'dark'`.** Used by:
- the desktop picker, to render a "LIGHT" / "DARK" badge on each card and (later) group presets visually;
- iframe propagation, so when the shell is in Monokai the embedded app receives `data-theme='dark'` (template CSS only ships `[data-theme='dark'|'light']` blocks);
- the cool-blue-cast switch hint copy, which now notes the toggle only affects Centraid Dark.

**CSS generator iterates the registry (`packages/design-tokens/css.ts`).** Previously emitted two hard-coded blocks (`[data-theme='light']`, `[data-theme='dark']`); now walks `Object.keys(themes)` so adding a preset never requires editing the generator.

**Desktop theme picker (`apps/desktop/src/renderer/app.ts`).** Replaces the Auto/Light/Dark segmented control in Appearance settings with a `makeThemePicker` grid. Each card paints a three-stripe mini-preview (page bg, elevated surface bar, accent dot) from that theme's own tokens so the swatch reads correctly even when the active shell theme differs. Dark themes anchored on `--bg-l` get a literal hsl() fallback for the preview since `var(--bg-l)` doesn't resolve outside the document scope. A separate "Match system" link button resolves `prefers-color-scheme` to Centraid Light/Dark — a one-shot trigger, no new persisted state. The picker exposes a `_refresh()` method on the element so external `setPrefs` calls (Match-system) update the active highlight without rebuilding the DOM.

**Iframe theme propagation switched to kind (`apps/desktop/src/renderer/app.ts`, `apps/desktop/src/renderer/builder.ts`).** A new `iframeThemeKind()` helper resolves the shell's named theme to `'light' | 'dark'` via `window.CentraidTokens.themes[prefs.theme].kind`. `buildIframeSettings`, the `centraid:theme` postMessage, and the builder preview iframe URL all use this resolved kind. Reason: user-app template CSS (`packages/app-templates/*/app.css`) keys on `[data-theme='dark']` / `[data-theme='light']`. Sending `data-theme='monokai'` to those iframes would fall back to the unstyled `:root` and break their hand-rolled overrides. Apps stay in their own light/dark palette; only the Centraid shell wears the named theme.

**Picker + link-button styles (`apps/desktop/src/renderer/styles.css`).** Added `.cd-theme-picker` (auto-fill 150px-min grid), `.cd-theme-card` (active card wears a 1.5px accent border), `.cd-theme-card-preview` / `-bar` / `-dot` (the 56px mini-preview), and a `.cd-link-btn` (text-only accent button used for Match-system).

**Preload bridge + types (`apps/desktop/src/preload.ts`, `apps/desktop/src/renderer/types.d.ts`).** `CentraidTokens.themePresets` exposes the ordered list to the renderer. `ThemeName` in the renderer is now `keyof typeof window.CentraidTokens.themes` — auto-widens whenever a new preset lands in the design-tokens package.

## Compat notes

- **Mobile** imports `themes.light` directly; that key is unchanged, so RN sees identical surfaces/ink.
- **Gateway settings** (`packages/runtime-core/src/settings-merge.ts`) coerces `theme` via `asString` — no allowlist, so any new preset name round-trips through user-prefs without a schema change.
- **Older published user apps** ship a frozen `tokens.css` snapshot from the time of build. They'll only have CSS blocks for the themes that existed then. The kind-fallback in iframe propagation means they still get a usable light/dark surface even if the shell is in a new preset.

## Verification

- `bun run typecheck` — pass (12 packages)
- `bun run check` (oxfmt + oxlint) — pass
- `bun run test` — pass
- `bun run build` — pass; `dist/css.js → toCss()` emits 12 `[data-theme=...]` blocks
- Generated CSS sanity-checked via `bun -e "import('./packages/design-tokens/dist/index.js').then(m => m.toCss())"` — all 12 blocks present, ordered as defined in the registry

## Out of scope

- Mobile theme switching (mobile still hard-codes `themes.light`)
- Auto-switching themes on system `prefers-color-scheme` change (Match system is a one-shot)
- Per-theme accent locking (user's accent override still applies on top of any theme — by design, since the accent picker is independent UX)
- App-template CSS keyed on a `[data-theme-kind='dark']` selector so user apps can adopt the full named theme (deferred — current behavior is apps stay in their own light/dark palette)
