# Desktop renderer CSS conventions

Status: **in progress** — the renderer is migrating off the monolithic global
`src/renderer/styles.css` (issue #325, Phase 4) toward co-located, scoped CSS
Modules. This doc is the north star for that migration and for all new work.

## The four layers

1. **Tokens — `@centraid/design-tokens`.** CSS custom properties (`var(--accent)`,
   `var(--ink)`, `var(--line)`, `var(--font-mono)`, radii, spacing). The single
   cross-platform contract, shared with mobile. **Never** hard-code a hex,
   px-radius, or font stack a token already covers.

2. **Global base — `styles.css`.** Reset, `:root` token wiring, base element
   defaults, and the genuinely app-global / vanilla-host surfaces (window chrome,
   the builder `cd-tl-*` titlebar, the sandboxed-app iframe host, kit). This file
   is **frozen and shrinking**: it is not where new component styles go. As
   screens migrate, their private rules leave; what remains is the shared/global
   layer. (It is still served as a blocking `<link>` and copied verbatim by the
   claude.ai/design sync.)

3. **Component/screen modules — `*.module.css`, co-located.** Each screen/
   component owns a `Foo.module.css` next to `Foo.tsx`. Classes are scoped by
   Vite CSS Modules (`vite.config.ts` → readable `[name]__[local]__[hash]`).
   Author local names in `camelCase` (`.stageBg`, `.rowLabel`); reference them
   `styles.stageBg`. This is where essentially all new styling goes.

4. **Reuse = components, not shared classes.** Do **not** reach for a shared
   global class to reuse a look — share a React component (`<Button>`, `<Icon>`,
   `<AppCard>` in `react/ui/`). A class shared across screens is a smell; promote
   it to a component or a shared module (see below).

## The one rule that keeps it clean

**No component reaches into another's internals.** The old monolith is full of
cross-surface combinators like `.cd-tl-main .cd-btn` (a vanilla titlebar styling
a React button). Don't add new ones. If surface A must affect element B, pass a
prop or a `data-*` attribute that B owns — never a descendant selector across the
boundary. (Existing cross-boundary combinators are why some classes must stay
global during the migration; see "shared/entangled" below.)

## How to migrate a screen (the proven recipe)

Onboarding, Palette, and Insights are worked examples (commits on `main`).

1. **Classify the screen's classes.** A class is **private** iff it is used only
   by that one `.tsx` and no vanilla `.ts`, and no CSS rule mixes it with a class
   owned elsewhere. Everything else is **shared** and stays global.
   - Helper: `node <scratch>/clean.mjs` reports `shared=[…]` and
     `foreignCombo=[…]` per screen (accounts for cross-`.tsx` and vanilla usage).
2. **Lift the private rules** out of `styles.css` into `Foo.module.css`, renaming
   `.cd-foo-bar` → `.bar` (camelCase). Keyframes move too — Vite scopes them and
   rewrites the `animation:` references automatically.
3. **Rewrite the `.tsx`:** `className="cd-foo-bar"` → `className={styles.bar}`;
   multi-class → `className={cx(styles.a, styles.b)}`; a **shared** class stays a
   plain string, so a mixed element is `cx(styles.priv, 'cd-shared')`.
4. **Shared class touched by a combinator** you're keeping (e.g.
   `.cd-app-settings-pane .cd-swatch`): in the module write
   `.pane :global(.cd-swatch) { … }` — the `:global()` escape hatch keeps the
   shared class un-scoped.
5. **Tests:** class-based selectors use the **local** name (`.bar`); Vitest's
   `classNameStrategy: 'non-scoped'` (in `vitest.config.ts`) makes
   `styles.bar === 'bar'`, so `.bar` selectors and `toContain('bar')` both match.
6. **Verify:** `bun run typecheck` (both graphs) + `bun run --filter
   @centraid/desktop test` + `bun run build`. Commit one screen (or a small
   batch) at a time.

There is a mechanical extractor at `<scratch>/mod.mjs` for the common cases; it
prints leftover `cd-*` refs (dynamic/unstyled classes) for manual review — always
eyeball the diff, since there is no live-Electron visual check in CI.

## Shared families (the larger remaining work)

Some class families are shared across many screens and should become **shared
modules** (one `*.module.css` imported by every consumer — same import → same
scoped name), or better, **extracted components**:

- `cd-au-*` — automations (Templates, View, Overview, RunView, Discover, Home).
- `cd-app-card*` / `cd-status*` / `cd-disc-*` — app cards + discover.
- `cd-vault-*` / `cd-app-settings-*` — Import / Vault / Phone / app-settings.
- Generic primitives: `cd-btn`, `cd-icon-btn`, `cd-chip`, `cd-kbd`, `cd-switch`,
  `cd-eyebrow`, `cd-page-empty*`, `cd-main-scroll`.

Until those are consolidated, their classes stay in the global layer and screens
reference them as plain strings. Note that many are also emitted by the still-
vanilla host route modules (`app-*.ts`) — those cannot be scoped until the host
surface itself is React (out of scope here).

## Serving + design-sync

Component modules are bundled by Vite into `dist/renderer/react-boot.css`, linked
blocking in `index.html` ahead of the module scripts. The claude.ai/design
desktop-shell sync (`.design-sync/desktop-src/`) still ships `styles.css`
verbatim; once the `ui/` primitives (`Button`/`AppCard`/…) move to modules, that
build must be re-plumbed to also ship `react-boot.css`, and the design bundle
reset + re-uploaded (a `/design-sync` step run interactively — it needs OAuth).
