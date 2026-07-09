# Desktop renderer CSS conventions

Status: **primary migration complete** (issue #325, Phase 4). Every React
screen's private styles have been carved out of the monolithic global
`src/renderer/styles.css` into co-located, scoped CSS Modules; what remains in
`styles.css` is the legitimate shared / vanilla-host layer (see layer 2). The
file went from ~14,788 lines to ~9,800. This doc is the north star for that
model and, more importantly, for **all new work** — new screens author a
co-located `*.module.css`, never grow the monolith.

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

## What was migrated, and what stays global (and why)

Every screen's **private** classes now live in a co-located module:

- `RunViewScreen`, `AutomationViewScreen`, `AutomationsOverviewScreen`,
  `AutomationTemplatesScreen` — the `cd-au-*` per-screen sub-families.
- `HomeScreen` (hero/composer/shelf/apps-grid), `DiscoverScreen` (`cd-disc-*`
  gallery), `AssistantScreen` (chat shell), `AppSettingsPanel`
  (`cd-app-settings-*`/`cd-app-order-*`), `SettingsAppearanceScreen`
  (`cd-theme-*`), `PhoneScreen`, `ImportScreen`, `VaultScreen` (shared
  `styles/vault.module.css`), `OnboardingScreen`, `PaletteScreen`,
  `InsightsScreen`.

What **legitimately stays** in the global `styles.css` layer — do **not** try to
scope these, it will desync from the vanilla emitter or a cross-boundary rule:

- **Vanilla-emitted families.** `cd-prof-*` (`profiles.ts`), `cd-app-card*` /
  `cd-status*` (`app-cards.ts`, and the shared `ui/AppCard` primitive),
  `cd-au-btn*/-status*/-glyph/-loading/-crumb*/-actions/-chip*/-drawer*/-ov-row*`
  and `cd-au-trigbadge*` (`app-automations-ui.ts` injects them into React hosts),
  and the `cd-asst-rich/-chart/-stat/-table*` rich-answer HTML
  (`app-assistant.ts`, injected via `dangerouslySetInnerHTML`). These are the
  shared layer *by definition* — a class a `.ts` and a `.tsx` both name cannot be
  hashed on one side only.
- **Window/shell chrome.** `cd-tl-*` (builder titlebar), `cd-sb-*`/`cd-sidebar`,
  `cd-window*`, `cd-tb-*`, `cd-brand*`, `cd-tooltip` — vanilla host surfaces.
- **Genuinely cross-screen chrome** used by ≥2 React screens as plain strings:
  `cd-app-settings-note/-section`, `cd-swatch/-swatches`, `cd-disc-seg*`,
  `cd-link-btn`, `cd-page-empty*`, and the shared keyframes (`cd-pulse`,
  `cd-spin`, …). Reuse is via the plain global class (or a `ui/` component), not
  by copying rules.

The next real reduction of `styles.css` comes only from **retiring the vanilla
host surfaces themselves** (sidebar, titlebar, cards, profiles, rich-answer
renderer) — a React-conversion of those hosts, out of scope for a CSS refactor.

### The `:global()` escape hatch, in practice

When a component-rooted rule reaches a kept global class
(`.cd-app-settings-pane .cd-swatch`, `.cd-apps-grid .cd-app-card-wrap`), the rule
moves into the component's module with the foreign class wrapped:
`.settingsPane :global(.cd-swatch)`, `.appsGrid :global(.cd-app-card-wrap)`. The
rule of thumb the carve used: a rule moves iff its selector is **rooted** at an
in-scope class (the component owns the contextual style); a rule rooted at a
foreign/vanilla class is left in the global layer (that surface owns it).

### Shared keyframes + CSS Modules

Vite scopes `animation-name` references inside a module *even when the keyframe
is defined globally*. So any module that animates with a shared keyframe
(`cd-pulse`/`cd-spin`) carries a **local copy** of that `@keyframes` block; Vite
scopes the local def and the ref to the same generated name, so they align. The
global copy stays in `styles.css` for the vanilla + other consumers.

## Serving + design-sync

Component modules are bundled by Vite into `dist/renderer/react-boot.css`, linked
blocking in `index.html` ahead of the module scripts (grows as screens migrate;
no FOUC).

The claude.ai/design desktop-shell sync (`.design-sync/desktop-src/`) ships only
the four **`ui/` primitives** (`Icon`/`Button`/`Logo`/`AppCard`) plus
`styles.css`. Those primitives render **global** classes (`cd-btn*`,
`cd-app-card*`, `cd-status`, `cd-disc-badge`) that are co-emitted by vanilla and
therefore stay in `styles.css` — so the design bundle remains complete with
`styles.css` alone. **No `react-boot.css` re-plumb is needed** (the module CSS is
for the app's own screens, which the design bundle does not ship). The only
follow-up is an optional content refresh — re-uploading the (now smaller)
`styles.css` so the design bundle reflects the dead-rule cleanup — a
`/design-sync` step run interactively (it needs OAuth).
