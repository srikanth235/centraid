# issue-64 — Extract --bg-wall design token; lighten dark-theme main pane

GitHub issue: [#64](https://github.com/srikanth235/centraid/issues/64)

## Checklist

- [x] Lift the dark-theme wall gradient
- [x] Add bgWall token
- [x] Emit --bg-wall in css.ts
- [x] Canonical wall.css for template iframes
- [x] Shell refactor
- [x] Template refactor
- [x] Manifest regenerated

## What changed

### Lift the dark-theme wall gradient

The home main pane gradient ran `--bg-l - 2%` → `--bg-l - 6%` (16% → 12% lightness against a base of 18%), which read as a darker well beneath the sidebar at ~21.5%. Shifted to `--bg-l + 2%` → `--bg-l - 2%` (20% → 16%) so the pane sits at roughly the base bg level — distinct from the sidebar but no longer a recessed pit. The 4-percentage-point gradient span is preserved so the chrome titlebar still visually flows into the content below.

### Add bgWall token

[packages/design-tokens/themes.ts](../packages/design-tokens/themes.ts) gains a new `bgWall: string` field on the `Theme` interface. Dark = the lifted blue gradient anchored on `var(--bg-l)`. Light = flat `#FCFCFC` (matches the existing flat treatment for light-mode `.cd-main`). The dark `deviceWall` token's composite now ends in `var(--bg-wall)` instead of inlining the gradient again — single source of truth at the token layer.

### Emit --bg-wall in css.ts

[packages/design-tokens/css.ts](../packages/design-tokens/css.ts) adds `'--bg-wall': t.bgWall` to the `themeProps` emitter, slotted next to the other surface variables. The generator now ships `--bg-wall` on both `:root` (from light theme) and `[data-theme='dark']`.

### Canonical wall.css for template iframes

Template apps run as sandboxed iframes that can't consume the shell's token CSS — they need to work standalone (opened outside Electron in a browser). The existing pattern for shared template assets is file-level copy (see `theme-bridge.js`, which is identical across all three templates). Added [packages/design-tokens/wall.css](../packages/design-tokens/wall.css) as the canonical source with three branches: `[data-theme='dark']` (formula against `--bg-l`), `[data-theme='light']` (flat near-white), and a standalone `@media (prefers-color-scheme: dark) :root:not([data-theme])` fallback using the same formula. Mirrored verbatim into each template directory; the header comment instructs future editors to keep all four copies in sync. Each template's `index.html` links `wall.css` before `app.css`.

### Shell refactor

[apps/desktop/src/renderer/styles.css](../apps/desktop/src/renderer/styles.css) — `.cd-main` and `.builder` both collapse to `background: var(--bg-wall)`. The light-theme overrides for both selectors are removed since the token already handles light mode. The cool-cast-off block at `[data-theme='dark'][data-cool-cast='off']` now redefines `--bg-wall` once (as a greyscale variant) instead of overriding `--device-wall`; since `deviceWall` composes against `var(--bg-wall)`, the main panes and the device-wall composite neutralise together. This is a small behaviour improvement — the prior override only neutralised the device-wall, leaving the main panes blue-cast even when cool-cast was off.

### Template refactor

Each template's `app.css` — [journal](../packages/app-templates/journal/app.css), [hydrate](../packages/app-templates/hydrate/app.css), [todos](../packages/app-templates/todos/app.css) — drops the inline `--bg: linear-gradient(...)` and uses `--bg: var(--bg-wall)`. The standalone `@media (prefers-color-scheme: dark) :root:not([data-theme])` blocks now also set `--bg-l: 10%` so the formula in wall.css's matching media block resolves consistently — previously these blocks hardcoded HSL literals.

### Manifest regenerated

`bun run typecheck` triggers the template manifest rebuild via `bun run build:manifest`. The walk over each template dir picks up the new `wall.css` files automatically; `manifest.json` now lists 3 `wall.css` entries (one per template).

## Verification

- `bun run typecheck` — 14/14 packages green (design-tokens, desktop, mobile, app-templates, builder-harness, chat-harness, openclaw-plugin, runtime-core, plus the four typecheck-only configs).
- `bun run build:manifest` (run as part of `app-templates:build`) — picks up the new `wall.css` files; `manifest.json` lists 3 entries for `wall.css`.
- Final reference sweep: `grep -rn "hsl(222 13% calc(var(--bg-l) - 2%))\|hsl(222 14% calc(var(--bg-l) - 6%))\|hsl(222 13% 8%)\|hsl(222 14% 4%)"` returns nothing in source CSS / TS (only matches are in the four mirrored `wall.css` files using the new lifted gradient, which is the intended single source).
- The 4 `wall.css` files (1 canonical + 3 template copies) are byte-identical by construction (`cp` from the canonical).
- Manual smoke (planned for the PR reviewer): open the desktop app in dark mode, confirm the home main pane and builder canvas read as a lifted surface rather than a darker well beneath the sidebar.

## Out of scope

- The broader settings-injection / user-identity / per-app sqlite work tracked in [#63](https://github.com/srikanth235/centraid/issues/63). This PR is just the duplication cleanup at the token layer.
