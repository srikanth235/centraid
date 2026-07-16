# Desktop renderer CSS conventions

The renderer is written as if it started life as a React app: every visual
belongs to a component, every component's styles are scoped, and every design
value is a token. There are **no global component classes** — the old
`styles.css` monolith (14,788 lines at its peak) is gone; what remains of it
is a ~60-line reset.

## The three layers

1. **Tokens — `@centraid/design-tokens`.** The single cross-platform design
   contract, shared with mobile. `toCss()` generates every CSS custom
   property the renderer uses and `theme-vars.ts` injects it at boot:
   colors per theme, the **typography scale** (`--t-*` font shorthands +
   `--font-sans/-display/-mono` stacks, from `typography.ts`), density
   spacing, radii, shadows, palette, the shared **library-tile sizing**
   (`--lib-*`, from `library.ts`), and theme knobs like the dark cool-cast
   override. **Never** hard-code a hex, px-radius, or font stack a token
   covers — add or edit tokens in the package's TS, not in CSS.

2. **Global base — `styles.css`.** Reset + base element defaults +
   scrollbar + `#root`. Frozen and tiny. It defines **zero** classes; if
   you're adding a class selector here, you're in the wrong file.

3. **Component modules — `*.module.css`, co-located.** Each component/screen
   owns a `Foo.module.css` next to `Foo.tsx`, scoped by Vite CSS Modules
   (`vite.config.ts` → readable `[name]__[local]__[hash]`). Author local
   names in `camelCase` (`.stageBg`, `.rowLabel`); reference them as
   `styles.stageBg`. Cross-screen looks live either as a **shared component
   in `react/ui/`** (preferred) or a **shared module in `react/styles/`**
   that every consumer imports.

## The primitives (`react/ui/`)

Reuse = components, not class strings:

- **`Button` / `IconButton`** (`Button.tsx` + `Button.module.css`) — the one
  button system. Roots: `btn` (page scale, solid-ink default) and `chrome`
  (26px titlebar scale); variants `primary`/`soft`/`ghost`; `sm` compact
  size; `icon` for the 36px icon-only square. Imperative DOM builders
  (confirm/prompt/toast) import the same module and compose with `cx`.
- **`AppCard`** + `AppCard.module.css` — the library tile family (card,
  head, icon plate, foot, hover actions toolbar, star flag) **including the
  rows layout**, keyed on the hosting grid's `data-layout='rows'`. Home and
  Discover compose richer tiles from this same module, so the tile is one
  implementation on every page.
- **`StatusPill`** — the uppercase-mono `● live / new / draft` pill.
- **`KindBadge`** — the APP / AUTOMATION classifier chip (carries its own
  rows-layout fixed-width rule via `--lib-row-badge-w`).
- **`Icon`, `Logo`, `cx`, `tile-visual`** — as before.

## The chrome (`react/shell/chrome.module.css`)

The whole window-chrome family — `.window` grid, split titlebar
(`tlSide`/`tlMain`), toolbar buttons + tooltip + ⌘-kbd (`TbBtn` in
`ShellFrame.tsx`), and the sidebar item family — lives in **one shared
module** imported by `ShellFrame.tsx` and `Sidebar.tsx`. The family is
densely cross-combinated (collapsing the sidebar hides `tlSide` and reveals
the main-pane traffic-light spacer), and a single module keeps every
combinator inside one scope. Screens never reference chrome classes
directly; they get chrome affordances via the `TbBtn` component and
`ShellFrame`'s titlebar slots.

## Rules that keep it clean

1. **No component reaches into another's internals.** If surface A must
   restyle element B rendered from a shared module, pass B an
   **additional A-local class** at render time
   (`cx(chatCss.scroll, styles.panelScroll)`) and write the override on
   `.panelScroll` — never a `:global(...)` escape and never a descendant
   selector across a module boundary. `:global` is reserved for
   **attribute** hooks that are part of a deliberate contract
   (`:global([data-layout='rows'])`, `:global([data-cards='flat'])`,
   `:global([data-hue='…'])`, `[data-theme]`).
2. **State is a data-attribute, not a class string.** `data-open="true"`,
   `data-active`, `data-hidden` — not `cx(styles.pop, 'open')`. Bare string
   classes in `className` are always a bug now: nothing global styles them.
3. **Keyframes are per-module.** Vite scopes `animation-name` references, so
   a module that animates carries its own `@keyframes` copy, even if another
   module has an identical one.
4. **String-builder `.ts` files follow the same rules.** `styles.x` types as
   `string | undefined` under `noUncheckedIndexedAccess`, so a bare direct
   assignment needs `?? ''` (`cx(...)` already returns `string`).
5. **Parameterize emitted HTML.** Helpers that emit class names in HTML
   strings take a class map from the caller (see `tokenize()` in
   `renderer/format.ts` — `BuilderCode` passes its module locals).

## Tests

Vitest's `classNameStrategy: 'non-scoped'` (in `vitest.config.ts`) makes
`styles.fooBar === 'fooBar'`, so tests select the **local** name
(`.fooBar`) or, better, a semantic hook (`[aria-label="…"]`,
`[data-testid]`). Never assert on a scoped/hashed name.

## Verify before committing

`bun run typecheck` (both graphs) + `bun run test` + `bun run build` +
`oxlint src/renderer/react` in `apps/desktop`. Then an integrity pass:
no new `:global(.class)` escapes (attribute escapes above excepted), and no
bare hyphenated string literals in `className` positions. There is no
live-Electron visual check in CI.

**`bun run lint:css`** (`scripts/lint-css-classes.mjs`) automates the worst
half of that pass: a `className={styles.foo}` whose module has no `.foo`
rule. This is the one frontend bug every other gate passes —
`typecheck` sees a permissive index signature, not a union of the rules that
exist; `test` passes because `classNameStrategy: 'non-scoped'` makes
`styles.foo === 'foo'`, so a test selecting `.foo` still matches with no rule
behind it; `build` doesn't care. The element just renders unstyled. This was
eyeballed for a long time and ten of them accumulated anyway, so it is a
script now. It checks referenced-but-undefined only — the reverse direction
(defined-but-unreferenced) is legitimately noisy, since descendant-only
rules, `[data-*]` hooks, and the `:global` contracts above all look unused to
a grep.

When it fires, the fix is a judgement call, not a template: write the rule if
the styling was genuinely intended, or drop the reference if the layout
already comes from the parent. Dropping is always visually a no-op —
`className={undefined}` and no `className` render identically — so a dead
reference is a *lie about intent*, not a broken pixel. Inventing a rule to
"fix" it changes the render.

## Serving + design-sync

Component modules bundle to `dist/renderer/react-boot.css`, linked blocking
in `index.html` ahead of the module scripts (no FOUC). `styles.css` (the
reset) is copied verbatim by `build:assets`. The `.design-sync/` bundles are
snapshots for claude.ai/design and do **not** constrain this codebase; they
are refreshed by their own interactive sync flow.
