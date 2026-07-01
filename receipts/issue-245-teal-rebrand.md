# Issue #245 — rebrand to teal identity: brand token + logo/app-icon replacement

GitHub issue: [#245](https://github.com/srikanth235/centraid/issues/245)

The identity was a mix of an electric-blue accent (`#4950F6`) and a
multi-color "C-mark" (violet/amber/cyan/rose) across the app icons. This
replaces both with a single teal identity — brand teal `#3EC8B4`, a white
orbit mark on a teal tile (WhatsApp-style flat icon) — integrated into the
design tokens first, then applied through every logo/icon asset and the
runtime accent.

## Checklist

- [x] Added a dedicated BRAND teal token and a --brand CSS variable
- [x] Retuned the Centraid light and dark accent ramp to teal
- [x] Repointed the desktop teal accent swatch to the brand ramp and made it the default
- [x] Replaced the logo, favicon, app icons, splash, and docs OG card with the white-on-teal mark
- [x] Regenerated every raster export from the new SVGs
- [x] Hardened the design-tokens build against a stale dist shadowing bug
- [x] Removed stale exploration artifacts
- [x] Verified typecheck, token output, and rendered assets

## What changed

**Added a dedicated BRAND teal token and a --brand CSS variable.** In the
design tokens (the source of truth, changed first): `themes/shared.ts` gains
`BRAND = '#3EC8B4'`, `css.ts` emits a theme-independent `--brand` var, and
`index.ts` / `themes/index.ts` export `BRAND` (plus a `brand` alias). The
brand hex is the single value every logo/icon SVG hardcodes.

**Retuned the Centraid light and dark accent ramp to teal.** `shared.ts` sets
`ACCENT = BRAND` and derives the ramp (`ACCENT_LIGHT #62D6C6`, `ACCENT_DEEP
#2AA593`, `ACCENT_MIDNIGHT #12645A`; the violet sub-accent is unchanged). Only
Centraid's own light/dark themes read these shared constants — the emulation
presets (Notion, GitHub, Airtable, Solarized, Nord, Monokai) define their own
accents inline and are untouched. `palette.teal #2EA098` (the app-icon tint
hue) is kept as-is.

**Repointed the desktop teal accent swatch to the brand ramp and made it the
default.** The desktop renderer overrides `--accent` at runtime from a
user-selectable swatch, so the token change alone would not show. The `teal`
swatch in `app-shell-context.ts` now carries the brand ramp (matching the token
exactly), `DEFAULT_PREFS.accent` is `'teal'` (`app.ts`), and the settings
picker lists Teal first (`app-settings.ts`). `blue` (Electric) stays an option.
Mobile inherits via `colors.accent`; `apps/mobile/app.json`'s adaptive + splash
`backgroundColor` are set to `#3EC8B4`.

**Replaced the logo, favicon, app icons, splash, and docs OG card with the
white-on-teal mark.** The mark is a white orbit ring + 3 satellites + hub on a
brand-teal tile (subtle top→bottom gradient). Applied to `assets/logo.svg`,
`docs/assets/centraid-mark.svg`, `assets/app-icon{,-mac,-adaptive-fg}.svg`,
`assets/splash.svg`, and `scripts/docs-site/og-card.svg` (blues → teal + new
mark).

**Regenerated every raster export from the new SVGs** with `@resvg/resvg-js`
(already a dep) + macOS `iconutil`: `icon.png`, `icon-512.png`,
`icon-mac-1024.png`, `adaptive-icon.png`, `splash.png`, `icon.icns`, `icon.ico`,
and `apps/desktop/icon.png` (the desktop runtime window icon, a copy of the mac
squircle).

**Hardened the design-tokens build against a stale dist shadowing bug.**
`packages/design-tokens`'s `build` is now `rm -rf dist && tsc` — a leftover flat
`dist/themes.js` from the pre-`themes/`-folder refactor was shadowing the
`dist/themes/` directory and silently serving old token values through
`require("./themes")`.

**Removed stale exploration artifacts** — ten `*-proposed*` / `*-comparison*` /
`*-single-*` files under `assets/`, none referenced anywhere shipped.

## Decisions

- **Full rebrand, not logo-only.** The accent flips from electric blue to teal
  app-wide (FAB, CTAs, focus rings), per the chosen scope.
- **The teal accent swatch was repointed to the brand ramp**, deliberately
  diverging it from `palette.teal #2EA098`. The picker swatches are curated
  accent hexes, not bound to the app-icon palette; the swatch and the token
  default now paint identically.
- **White-on-teal (WhatsApp-style) tiles** chosen over the initial
  teal-mark-on-dark-bezel treatment for contrast and brand punch.
- **The docs OG card was recolored** though it was not in the original asset
  list — it embeds the mark + brand color, so leaving it blue would clash with
  the new teal favicon/header.
- **Committed the rebrand alone out of a mixed stash.** The working tree had
  been stashed into `stash@{0}`, which bundled this rebrand with an unrelated
  full deletion of the `.governance/` tree and edits to `docs/index.mdx` /
  `packages/blueprints/manifest.json` / the docs-site build scripts. Only the
  rebrand files were extracted (`git checkout stash@{0} -- …`); the rest stays
  in the stash.

## Out of scope

- The emulation theme presets keep their own brand accents (Notion blue, etc.).
- The `.governance/` tree deletions and the `docs/index.mdx` /
  `blueprints/manifest.json` / `scripts/docs-site/{assets,build}.mjs` edits
  bundled in the same stash are left in `stash@{0}` for separate handling.

## Verification

Verified typecheck, token output, and rendered assets.

```sh
# design-tokens: cold build produces no stale shadow file, teal resolves
(cd packages/design-tokens && npm run build)
test ! -e packages/design-tokens/dist/themes.js && echo "no stale flat themes.js"
node -e "const t=require('./packages/design-tokens/dist/index.js'); const c=t.toCss(); \
  console.log(c.match(/--accent: (#\w+)/)[1], c.match(/--brand: ([^;]+)/)[1], t.BRAND)"
# → #3EC8B4 #3EC8B4 #3EC8B4

# typecheck
(cd packages/design-tokens && npx tsc -p tsconfig.json --noEmit)   # OK
(cd apps/desktop && npx tsc -p tsconfig.json --noEmit)             # exit 0
```

The app icon, mac squircle icon, wordmark lockup (on white), favicon badge, and
docs OG card were rendered via resvg and visually confirmed. All SVGs parse
under resvg's strict XML (fixed an illegal `--` inside two comments).
