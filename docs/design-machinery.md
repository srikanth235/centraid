# Design machinery

Inventory and ownership map for the visual system across desktop, PWA, blueprint apps, and Expo. The binding visual rules live in [DESIGN.md](../DESIGN.md); this document describes how those rules reach each renderer without becoming four design systems.

## One pipeline

| Stage | Owner | Responsibility |
| --- | --- | --- |
| Product grammar | `DESIGN.md` | Binding values, roles, surface rules, and component behavior |
| Typed registry | `packages/design/src` | Theme ramps, semantic roles, type, spacing, radii, density, motion, icons, app identity, and recipe inventory |
| Shell lowering | `toCss()` | CSS custom properties for the shared React shell used by desktop and PWA |
| Blueprint lowering | `toBlueprintCss()` | CSS custom properties for the system apps' scoped surfaces (`:where(.centraid-inline-scope)`) — scoping, not sandboxing: since #799 an app is shell code in the shell's own document |
| Native lowering | `toNativeTheme()` | Concrete React Native values with no CSS parsing or runtime override layer |
| Native adapter | `apps/mobile/src/kit/theme/native.ts` | Expo font-family names and `em` tracking converted to React Native points |
| Public-site lowering | `scripts/site-tokens.mjs` | The SHELL lowering plus the bundled `@font-face` block and the app mark, emitted into a committed `centraid-tokens.css` for `centraid.dev` and `centraid.dev/docs/`. Not a fourth lowering — it re-serves `toCss()` verbatim and adds only a page-scale layer (reading measure, section rhythm, the one sanctioned display step) that composes from tokens above it |
| Headless block layer | `packages/design/src/blocks` (`@centraid/design/blocks`) | The block vocabulary's logic with no renderer in it, shared by every kit |
| Components | `packages/client/src/react/ui`, `packages/design/src/elements`, `apps/mobile/src/kit` | Renderer-specific primitives that consume roles; they do not own token values |
| Enforcement | design contract tests, consumer lint, type/target floors, gallery | Proves the registry, lowerings, and consumers remain aligned |

The direction is one-way:

`DESIGN.md → packages/design registry → one lowering per renderer → components → screens`

A screen must not generate a token, a component must not invent a scale, and a lowering must not keep a second editable registry.

## Values lower per renderer; composition is per rendering technology

Two different rules, often confused:

- **VALUES: one lowering per renderer.** A colour, a rung, a radius, a duration is emitted once for each syntax — `toCss()`, `toBlueprintCss()`, `toNativeTheme()` — from the one registry. This is the pipeline above and it does not change.
- **COMPOSITION: one implementation per RENDERING TECHNOLOGY.** A block (section, rows, panel, chips, note, empty, doc table, grid, bars, distribution, skeleton) is markup plus a stylesheet, and markup is technology-bound: a DOM node and a React Native view are genuinely different things. So React DOM has one implementation and React Native has another — but _desktop and PWA do not get one each_, and _the shell and a blueprint app do not get one each_, because those are the same technology.
- **LOGIC: shared across all of them.** Underneath both implementations sits the headless block layer, `@centraid/design/blocks` — the stacked-column arithmetic, the day fold that turns a rollup into columns (and the axis mark it names them by), the distribution's ordering and share arithmetic, the skeleton's bone sequence and breath, the doc-table snip line and row-menu model, the grid's cell classification (value / null / blank / sealed), clip point, sort toggle and column badges, and the five-state ladder (which states speak for themselves, which may carry an inline verb). It imports no renderer and is pinned by one test set in `packages/design`. A kit that recomputed any of it would be a second design system wearing the same tokens.

Two blocks read records, and the difference is the question being asked. **Doc table** reads them as DOCUMENTS — a title and two facts per row — which is the right block for a drive. **Grid** reads them as the store holds them: every declared column, sortable by any of them, with the key badges and foreign-key target on the header and a cell vocabulary that keeps an absent value apart from an empty one and refuses to print a sealed one at all. The vault's records section uses the grid; a summary of the same rows would answer a different question.

`SectionBlock` carries an optional trailing verb — "Refresh", "Rows/Bytes", "Sort". It is always quiet: the app bar owns the route's verbs and the view's one filled control, so a verb about one SECTION of a route belongs to that section's head rather than being promoted into the bar, where it would lose the subject that makes it mean anything. Many such verbs state the current setting rather than an imperative, so the head needs no second element to say where it stands.

Where the block implementations live today:

| Technology | Implementation | Consumers |
| --- | --- | --- |
| React Native | `apps/mobile/src/kit/components` | every mobile screen — one implementation, as the rule requires |
| React DOM | `packages/client/src/react/ui` | the shell's operational routes and screens |
| React DOM | `packages/blueprints/apps/_shared` | the eight inline system apps |
| Imperative DOM | `packages/design/src/elements` + `kit.css` | the surfaces with no React tree: the one status line the frame docks, `showSkeleton`, the popover, the attachment strip |

There are no DOM custom elements left. [Issue #799](https://github.com/srikanth235/centraid/issues/799) retired the last four (`kit-avatar`, `kit-meter`, `kit-skeleton`, `kit-status-line`) and the `KitElement` base they shared: `Avatar`, `Meter` and `Skeleton` are React blocks in `packages/blueprints/apps/_shared`, and the status line is plain DOM built by `elements/feedback.ts`. They all emit the same `.kit-*` classes, so `kit.css` styles them unchanged — the elements' `display: contents` hosts contributed no layout of their own.

The two React DOM rows remain the one composition follow-up: the shell and inline blueprint apps share the headless logic but still own separate markup and stylesheets. The compatibility audit found only `--w-key-col` missing from the blueprint lowering; the consolidation is tracked in [issue #765](https://github.com/srikanth235/centraid/issues/765).

## Surface inventory

| Surface | Shared implementation | Local adapter | Design-lint coverage |
| --- | --- | --- | --- |
| Desktop | `packages/client` + `toCss()` | Electron host capabilities only | CSS consumer gate, type/radius/color rules, computed-style gallery |
| PWA | the same `packages/client` + `toCss()` | `apps/web/src/web.css` for host layout only | The same CSS gate roots and gallery contract as desktop |
| Blueprint apps | `packages/design/src/elements/kit.css` + `toBlueprintCss()` | App-specific content/layout | CSS consumer gate plus scaffold/contract tests |
| Expo | `toNativeTheme()` | `apps/mobile/src/kit/theme/native.ts` | Native consumer gate, native contract tests, target/type floor, hairline and logical-inset gates |
| Public site (`centraid.dev`, `/docs/`) | the generated `centraid-tokens.css` — `toCss()` verbatim, plus `toFontFaceCss()` and the PWA mark | `scripts/home-site/public/index.html`'s inline sheet and `scripts/docs-site/public/assets/docs.css` | `lint:site-tokens` — emitter freshness by bytes, unresolvable `var()`s, literal font families, font-CDN references, retired theme names. **Not** `lint:design-tokens`: see [design-divergences.md](design-divergences.md#the-public-web-surfaces) |

Desktop and PWA are one renderer from the design system's point of view. Pointer versus touch changes density, type, margin, and target values; host names and viewport width do not create more design modes.

## Ownership rules

1. Add or change a visual value in `packages/design/src`, then pin it in `DESIGN.md` and the matching contract test.
2. Lower a registry value exactly once for each syntax: shell CSS, blueprint CSS, or native objects. Implement a block's composition once for each rendering technology, and put the logic underneath it in `@centraid/design/blocks` rather than in either kit.
3. Keep platform adaptation structural. Expo may name a loaded font and convert tracking units; it may not choose a different type ramp, color role, radius, or target size.
4. Build a wash from the rung it tints, in the registry, not in a lowering. A wash whose alpha is the SAME in both themes lowers as `color-mix(in oklab, var(--role) N%, transparent)` in the two CSS emitters and as an evaluated `rgba()` in native (`--accent-soft`, `--bg-sel`). A wash whose alpha DIFFERS per theme cannot be a shared `color-mix()` string, so it is built once with `rgbaHex()` in `themes/shared.ts` and lowered verbatim by all three emitters (`--net-wash`, 7% light / 11% dark). Either way the alpha and the base colour live in one place; a lowering never re-types either.
5. Express a touch step, including a refusal to step, as a `nativeDelta`. `NATIVE_DELTA_BY_FAMILY` is the default (+2 / +3 for sans) and `NATIVE_DELTA_OVERRIDES` is the whole list of exceptions — a role that must NOT grow on touch declares a zero delta there (`band`, whose hold is forced by invariant 1's five-plus-More cap at 390px). A screen that works around the step instead is a second type scale.
6. Keep recipes honest. `RECIPES` is the canonical capability and accessibility inventory; a renderer-specific style belongs beside its real component or in an adapter that the component actually consumes. Do not emit unused CSS.
7. Use semantic foregrounds. `textInv` / `onAccent` is the solved foreground for the theme's ink action fill. `onStage` belongs on the fixed dark media ground. Arbitrary stored identity colours use `identityInk()` so contrast is measured rather than guessed.
8. Do not restore copied native theme files, per-app font/tone knobs, radius aliases, or a web-only component variant.

## Verification

Use repo scripts so the pinned toolchain and flags apply:

```sh
bun run lint:design-consumers
bun run lint:design-md
bun run lint:site-tokens
bun run design:gallery
bun run --cwd packages/design test
bun run --cwd apps/mobile test
bun run check:push
```

The CSS and native gates are syntax-specific implementations of the same policy. Neither has an allowance ledger.
