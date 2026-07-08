# design-sync notes — Centraid Blueprint Kit

## What this design system is (read first)

Centraid ships **no React component library**. The product UI is a **vanilla-JS + CSS kit** (`packages/blueprints/kit/kit.js` + `kit.css`, a `.kit-*` class system) plus a **token package** (`@centraid/design-tokens`, TS objects → CSS vars via `toCss()`). Claude Design consumes React components, so this sync **authors React wrappers** over the kit — a dedicated design-sync input package at `.design-sync/ds-src/`.

- `.design-sync/ds-src/` is a self-contained mini React package (NOT in the turbo workspace, no governance surface). Each component in `src/components/*.tsx` renders the kit's **exact** `.kit-*` DOM/classes so the shipped `kit.css` styles it identically. **Fidelity rule:** if you change a wrapper's markup/classes, cross-check it against the kit's real output (kit.js builders + kit.css selectors) — a drift here renders wrong in every design the agent builds.
- `buildCmd` = `node .design-sync/ds-src/build.mjs`. It (1) regenerates `styles/tokens.css` from the built `@centraid/design-tokens`, (2) copies `packages/blueprints/kit/kit.css` verbatim, (3) concatenates `tokens.css + fonts.css + bridge.css + kit.css` into `styles/bundle.css` (the `cssEntry`), (4) `tsc`-compiles the wrappers to `dist/` (js + .d.ts). **`@centraid/design-tokens` and `kit.css` must be built/present first** — run `turbo build` (or at least build design-tokens) if `packages/design-tokens/dist/` is stale.
- Converter invocation (from repo root):
  ```
  node .ds-sync/package-build.mjs --config .design-sync/config.json \
    --node-modules .design-sync/ds-src/node_modules \
    --entry .design-sync/ds-src/dist/index.js --out ./ds-bundle
  ```
  `--node-modules` points at `ds-src/node_modules` (where react resolves); `--entry` at the built dist (the package isn't self-installed).

## The CSS bridge (important)

`kit.css` reads **app-level** vars (`--surface`, `--text`, `--muted`, `--accent`, `--radius`, `--mono`, …) that the blueprint apps define per-app. `@centraid/design-tokens` emits **different** names (`--bg`, `--ink`, `--accent`, `--line`, `--r-*`, `--d-*`). `styles/bridge.css` maps the former onto the latter (`--surface: var(--bg-elev)`, `--text: var(--ink)`, `--radius: var(--r-lg)`, `--accent-soft: color-mix(...)`, `--warn: var(--c-amber)`, brand font families). **Without the bridge, every component renders unstyled.** If a new kit component reads a var the bridge doesn't map, add it to `bridge.css`.

## Fonts

Brand families **Geist / JetBrains Mono / Space Grotesk** are self-hosted woff2 (latin subset, OFL) in `ds-src/fonts/`, wired via `styles/fonts.css` (committed). They're OSS variable fonts, so per-weight files may be byte-identical — expected, not an error. If `[FONT_MISSING]` ever fires, re-fetch from Google Fonts CSS2 API into `ds-src/fonts/` and update `fonts.css`.

## Component set

17 **presentational** wrappers. The kit's live-network controllers were deliberately **excluded** (they can't render statically): the Ask SSE driver, `MentionField`, the vault-fetching mention popover behavior, and the reference network helpers. `MentionPopover` and `AskPanel` are shipped as **static shells** of those surfaces.

## Preview gotchas (fold-in from wave learnings)

- **Prop-gated buttons**: `AskApplied` (Undo), `AskPropose` (Approve/Edit/Discard) only render a button when its handler prop is present — pass `() => {}` in previews or the buttons vanish.
- **MentionPopover** root `.kit-mention-pop` is `position: fixed`. Its preview passes `style={{ position: 'static' }}` (the component exposes a `style` passthrough) so it renders in flow inside the card. Keep that in any re-authored preview.
- Grade JSON keys must equal the preview's export names exactly (capture prints the expected keys).

## Known render warns

- **AskTyping** is intentionally tiny (a three-dot indicator, no props). A `[RENDER_THIN]` / "variants identical" style warn on it is expected — grade good if the three dots render; do not pad it.
- **LineChart** trips `[RENDER_THIN]` ("mounts have no text and paint nothing"). Benign false positive: a line chart is pure SVG (path + area + dot) with **no text nodes**, so the text-based thin heuristic can't measure it. Confirmed by screenshot — it paints two teal line/area charts. (BarChart has tick-label text and does not trip it.) Grade good; do not rework.

## Re-sync risks (what can silently go stale)

- **Wrapper drift**: `ds-src/src/components/*.tsx` are hand-written to mirror the kit. If `kit.js`/`kit.css` change their DOM or class names, the wrappers won't auto-update — re-diff against the kit. `kit.css` itself is copied fresh every build, so pure-style changes flow through automatically; DOM/class changes do not.
- **Token names**: the bridge hard-codes `@centraid/design-tokens` var names (`--bg-elev`, `--ink`, `--r-lg`, `--c-amber`). If the tokens package renames vars, the bridge breaks silently (components render half-styled). Re-check `bridge.css` against `packages/design-tokens/src/css.ts` after any tokens change.
- **Excluded controllers**: if the product later wants the live Ask/Mention behaviors in the DS, they'd need a different (non-static) treatment — they're not here by design.
- **Fonts**: self-hosted copies won't track upstream font updates; fine for a brand pin.
