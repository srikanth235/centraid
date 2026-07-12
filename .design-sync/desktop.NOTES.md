# design-sync notes — Centraid Desktop Shell

This is the **second** design system synced from this repo. The other is the
**Blueprint Kit** (`.design-sync/config.json` + `ds-src/`, project "Centraid
Blueprint Kit") — a vanilla `.kit-*` system for sandboxed blueprint apps. This
one is the **desktop host shell's React DOM primitives** (`Icon`, `Button`,
`Logo`, `AppCard`) — the real shipped components at
`apps/desktop/src/renderer/react/ui/`, emitting the renderer's `cd-*` classes,
styled by the desktop `styles.css`. Project: **Centraid Desktop Shell**
(`e6d9c37d-2ffa-4c5d-944f-bff021f338dc`).

## Commands (all flags point away from the Blueprint Kit's slots)

```sh
node .design-sync/desktop-src/build.mjs                 # cfg.buildCmd
node .ds-sync/package-build.mjs --config .design-sync/desktop.config.json \
  --node-modules ./node_modules --entry .design-sync/desktop-src/dist/index.js \
  --out ./ds-bundle-desktop
node .ds-sync/package-validate.mjs ./ds-bundle-desktop
node .ds-sync/package-capture.mjs  --out ./ds-bundle-desktop
```

- Config is `.design-sync/desktop.config.json` (NOT the canonical `config.json`
  — that's the Blueprint Kit's). Conventions header is `desktop.conventions.md`.
- `--node-modules` is the **repo root** `node_modules` (bun hoists `react`,
  `react-dom`, `@types/react`, `@centraid/design-tokens` there — the DS package
  has no own `node_modules`).
- `--out ./ds-bundle-desktop` (the Blueprint Kit uses `./ds-bundle`).

## The input build (`desktop-src/build.mjs`) — how it avoids drift

The real components are single-source in `apps/desktop`. Every build **copies
them fresh** (`Icon/Button/Logo/AppCard.tsx` + `KindBadge.tsx` + `StatusPill.tsx`
+ their `.module.css` + `cx.ts` + `tile-visual.ts` + the ambient
`css-modules.d.ts`) into `desktop-src/src/`, so there are no hand-maintained
twins to drift. Then it: regenerates `styles/tokens.css` from the built
`@centraid/design-tokens` (`toCss()`), copies the renderer `styles.css`
verbatim, reuses the Blueprint Kit's committed woff2 + `fonts.css`,
esbuild-bundles the entry (design-tokens **inlined from TS source**,
`react`/`react-dom` external so the converter binds them to `_vendor/`, `.css`
imports via esbuild's built-in `local-css` loader — see below), concatenates
`styles/bundle.css` = tokens + fonts + styles + the esbuild CSS-Modules output
(the `cssEntry`; **no CSS bridge needed** — `styles.css` is written directly
against design-tokens var names), and runs `tsc --emitDeclarationOnly` for the
`.d.ts` tree (needs the copied `css-modules.d.ts` to typecheck `import styles
from './X.module.css'`). `Gallery` (a demo composite in the real
`ui/index.ts`) is deliberately **excluded** from the curated DS entry.

**2026-07-12 fresh-reset finding**: since #340 ("real-app E2E pass"), `Button`
and `AppCard` moved their styling to co-located CSS Modules (`Button.module.css`,
`AppCard.module.css`) and `AppCard` grew two new sub-components (`KindBadge`,
`StatusPill`, each with their own `.module.css`) that `COMPONENT_FILES` didn't
know about — the build failed with `Could not resolve "./Button.module.css"`
etc. until they were added, esbuild's `loader: {'.css':'local-css'}` was wired
in, and the emitted `dist/index.css` was folded into `styles/bundle.css`.
**Re-sync risk, updated**: if `apps/desktop/src/renderer/react/ui/` gains
another CSS Module or sub-component, `COMPONENT_FILES` needs the matching
entry (both the `.tsx`/`.ts` and its `.module.css`) or the build throws
`Could not resolve`. `desktop.conventions.md` used to claim the shipped CSS
carries "`.cd-*` component rules" — that was already stale (the real app's
Vite config uses `generateScopedName: '[name]__[local]__[hash:base64:5]'`,
never a `cd-` prefix) and has been corrected to describe scoped/hashed class
names generically; don't reintroduce a literal class-name convention claim
here since it's an implementation detail the design agent never touches
directly.

## Shared `.design-sync/` tree — the two syncs coexist

`previews/`, `.cache/`, and `overrides/` are hardcoded to `.design-sync/`
regardless of `--config`, so both DSes share them. This is safe because the
component names don't collide (desktop = `Icon`/`Button`/`Logo`/`AppCard`;
Blueprint = `Ask*`/`Mention*`/`Message`/`Meter`/…). Two consequences:
- Running **either** build/capture prunes the **other's** local
  `.cache/review/*.grade.json`. Harmless — a DS's verified state is durable in
  its **uploaded** `_ds_sync.json`, not the local cache; a Blueprint re-sync
  fetches its own remote anchor and carries forward.
- `previews/<Name>.tsx` for both DSes live in one `previews/` dir without clash.

## Known render warns (checked against on re-sync — a warn NOT here is new)

- **`[RENDER_THIN]` on `Logo.html`** — benign SVG-only false positive. `Logo` is
  a pure `<svg>` mark with no text nodes, so the text-based thin heuristic can't
  measure it (same class of false positive as the Blueprint Kit's `LineChart`).
  Confirmed painting (violet/amber/cyan arcs + rose core) by screenshot.
- **`[TOKENS_MISSING]` `--border`, `--ink-1`, `--am-accent`, `--text-secondary`** —
  referenced elsewhere in the full 14.7k-line `styles.css`, **not** by the four
  shipped components. `--am-accent` is a per-app accent injected at runtime.
  Non-blocking and expected; do not chase.

## Re-sync risks (what can silently go stale)

- **Component paths**: `build.mjs` copies a fixed `COMPONENT_FILES` list from
  `apps/desktop/src/renderer/react/ui/`. If those files move/rename (or a new
  primitive is added and should ship), update `COMPONENT_FILES` and the curated
  `src/index.ts` barrel in `build.mjs`.
- **styles.css is copied verbatim**: token *value* changes flow through
  `tokens.css` automatically; new `cd-*` classes or new component markup appear
  only after a rebuild. A component whose DOM/classes change re-verifies fine
  (the component is the real source), but re-run the full build.
- **Fonts** are the Blueprint Kit's self-hosted subset (Geist 400/500/600,
  JetBrains Mono 400/500, Space Grotesk 500/600). The shell's marketing-alias
  700 weights fall back to 600 — acceptable for these primitives; add heavier
  woff2 to `ds-src/fonts/` + `fonts.css` if a 700-weight surface is ever synced.
- **No local Playwright**: validate found a system Chromium and ran the render
  check here. A machine without one needs the §4.1 install or `--no-render-check`.
