# Design machinery

Inventory and ownership map for the visual system across the native mobile shells, the desktop seat, the Rust core and the public web surfaces. The binding visual rules live in [DESIGN.md](../DESIGN.md); this document describes how those rules reach each renderer without becoming several design systems.

## One pipeline

| Stage | Owner | Responsibility |
| --- | --- | --- |
| Product grammar | `DESIGN.md` | Binding values, roles, surface rules, and component behavior |
| Typed registry | `packages/design/src` | Theme ramps, semantic roles, type, spacing, radii, density, motion, icons, app identity, and recipe inventory |
| CSS lowering | `toCss()` | CSS custom properties. Its consumer today is the public-site emitter below |
| Native lowering | `toNativeTheme(scheme)` | Concrete values with no CSS parsing or runtime override layer — every value ready to render, no `var()`, `calc()`, `color-mix()` or `oklch()` |
| Native emission | [`contracts/tools/export-native-theme.ts`](../contracts/tools/export-native-theme.ts) | Writes the native lowering as data — `design/native-theme.json`, `mobile/shared/src/commonMain/kotlin/dev/centraid/design/Tokens.kt` and `mobile/iosApp/Design/Theme.swift` — and calls the two emitters below, so one command writes every native artifact |
| Catalogue emission | [`contracts/tools/export-native-catalog.ts`](../contracts/tools/export-native-catalog.ts) | The app catalogue, identity hues, icon-chip colours and icon path data: `design/native-catalog.json`, `Catalog.kt`, `mobile/iosApp/Design/Catalog.swift` |
| Identity corpus | [`contracts/tools/export-design-corpus.ts`](../contracts/tools/export-design-corpus.ts) | Runs the real presentation functions (`partyHueKey`, `identityInitials`, `figureTone`) over a fixed hostile corpus into `design/identity-corpus.json` |
| Rust lowering | [`crates/design`](../crates/design/README.md) | Reads `design/native-theme.json` and is asserted row by row against the identity corpus, so a parity fixture's presentation fields can be compared at all |
| Public-site lowering | `scripts/site-tokens.mjs` | `toCss()` verbatim plus the bundled `@font-face` block, emitted into a committed `centraid-tokens.css` for `centraid.dev` and `centraid.dev/docs/`. Not a further lowering — it re-serves `toCss()` and adds only a page-scale layer (reading measure, section rhythm, the one sanctioned display step) that composes from tokens above it |
| Headless block layer | `packages/design/src/blocks` | The block vocabulary's logic with no renderer in it |
| Enforcement | design contract tests, the emitter drift gate, the native specs | Proves the registry, the emitted artifacts and their consumers remain aligned |

The direction is one-way:

`DESIGN.md → packages/design registry → one lowering per renderer → emitted artifacts → components → screens`

A screen must not generate a token, a component must not invent a scale, and a lowering must not keep a second editable registry.

`copy/*.json` and `mobile/shared/.../design/Copy.kt` travel beside these artifacts but are no longer generated: their upstream was the v0 app tree, and they are the source now ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

The values under the 4px base are the registry's `subBase` seams — `hair` (1), `gutter` (2), `chip` (3). A shell holds no sub-4px constant of its own ([#1015](https://github.com/srikanth235/centraid/issues/1015), R-NY-15).

## Values lower per renderer; composition is per rendering technology

Two different rules, often confused:

- **VALUES: one lowering per renderer.** A colour, a rung, a radius, a duration is emitted once for each syntax from the one registry. This is the pipeline above.
- **COMPOSITION: one implementation per RENDERING TECHNOLOGY.** A block (section, rows, panel, chips, note, empty, doc table, grid, bars, distribution, skeleton) is markup plus styling, and markup is technology-bound: a Compose tree, a SwiftUI view and a DOM node are genuinely different things. Each technology gets one implementation, never one per app.
- **LOGIC: shared across all of them.** Underneath sits the headless block layer (`packages/design/src/blocks`) — the stacked-column arithmetic, the day fold, the distribution's ordering and share arithmetic, the skeleton's bone sequence, the doc-table and grid models, and the five-state ladder. It imports no renderer and is pinned by one test set in `packages/design`. A kit that recomputed any of it would be a second design system wearing the same tokens.

Two blocks read records, and the difference is the question being asked. **Doc table** reads them as DOCUMENTS — a title and two facts per row. **Grid** reads them as the store holds them: every declared column, sortable by any of them, with a cell vocabulary that keeps an absent value apart from an empty one and refuses to print a sealed one at all.

`SectionBlock` carries an optional trailing verb — "Refresh", "Rows/Bytes", "Sort". It is always quiet: the app bar owns the route's verbs and the view's one filled control, so a verb about one SECTION of a route belongs to that section's head.

## Surface inventory

| Surface | Shared implementation | Local adapter | Design-lint coverage |
| --- | --- | --- | --- |
| Mobile (Compose, SwiftUI) | the emitted native table and catalogue | Compose and SwiftUI read the emitted tables; neither holds a literal | the drift gate below, `NativeThemeSpec` over the emitted table in both schemes, `CatalogSpec`, and `NativeAccessibilityLintSpec` over both view trees (`mobile/shared/src/jvmTest`) |
| Rust | `crates/design` | none | `crates/design/tests/corpus.rs` asserts every corpus row; `copy::route_gaps` names a route id present on one side and not the other ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-T1) |
| Public site (`centraid.dev`, `/docs/`) | the generated `centraid-tokens.css` — `toCss()` verbatim, plus `toFontFaceCss()` | `scripts/home-site/public/index.html`'s inline sheet and `scripts/docs-site/public/assets/docs.css` | `lint:site-tokens` — emitter freshness by bytes, unresolvable `var()`s, literal font families, font-CDN references, retired theme names. **Not** `lint:design-tokens`: see [the public web surfaces](#the-public-web-surfaces) |

Pointer versus touch changes density, type, margin, and target values; host names and viewport width do not create more design modes.

## Ownership rules

1. Add or change a visual value in `packages/design/src`, then pin it in `DESIGN.md` and the matching contract test, and regenerate the emitted artifacts.
2. Lower a registry value exactly once for each syntax. **A lowering outside TypeScript is generated, never written**: the emitter is extended rather than duplicated, one command writes every artifact, and a drift gate fails when a committed artifact stops matching what the emitter produces. Three `NativeColors` entries are CSS `box-shadow` strings and five more are `rgba()` functions, so the emitter parses the colours into channels and splits the shadows into a named `effects` map — it does not invent a native elevation grammar, which would be a design decision an emitter does not get to make ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-E6a). Implement a block's composition once for each rendering technology, and put the logic underneath it in `packages/design/src/blocks` rather than in either shell.
3. Keep platform adaptation structural. A shell may name a loaded font and convert tracking units; it may not choose a different type ramp, color role, radius, or target size.
4. Build a wash from the rung it tints, in the registry, not in a lowering. A wash whose alpha is the SAME in both themes lowers as `color-mix(in oklab, var(--role) N%, transparent)` in CSS and as an evaluated `rgba()` in native (`--accent-soft`, `--bg-sel`). A wash whose alpha DIFFERS per theme is built once with `rgbaHex()` in `themes/shared.ts` and lowered verbatim (`--net-wash`, 7% light / 11% dark). Either way the alpha and the base colour live in one place; a lowering never re-types either.
5. Express a touch step, including a refusal to step, as a `nativeDelta`. `NATIVE_DELTA_BY_FAMILY` is the default (+2 / +3 for sans) and `NATIVE_DELTA_OVERRIDES` is the whole list of exceptions — a role that must NOT grow on touch declares a zero delta there (`band`, whose hold is forced by invariant 1's five-plus-More cap at 390px). A screen that works around the step instead is a second type scale.
6. Keep recipes honest. `RECIPES` is the canonical capability and accessibility inventory; a renderer-specific style belongs beside its real component. Do not emit unused output.
7. Use semantic foregrounds. `textInv` / `onAccent` is the solved foreground for the theme's ink action fill. `onStage` belongs on the fixed dark media ground. Arbitrary stored identity colours use `identityInk()` so contrast is measured rather than guessed.
8. Do not hand-write a native theme or catalogue file, per-app font/tone knobs, radius aliases, or a renderer-only component variant.

## Verification

```sh
bun run --cwd packages/design test          # the registry and its lowerings
bun run lint:design-md                      # DESIGN.md itself
bun run lint:design-tokens                  # zero-debt CSS gate
bun run lint:site-tokens                    # the public-site sheets
bun contracts/tools/export-native-theme.ts && bun run format && git diff --exit-code design copy mobile
cargo test -p centraid-design               # the Rust lowering against the corpus
cargo xtask gate --profile pr               # runs the `emitters` drift step
cargo xtask gate --profile mobile-jvm       # regenerates and diffs, then `./gradlew -p mobile mobileJvm`
```

The drift line is the gate: `emitters` in `cargo xtask gate --profile pr` and the `mobile-jvm` profile both regenerate and fail on a diff, so a token change that forgets to regenerate reds where a test would. Neither gate has an allowance ledger.

## The public web surfaces

`centraid.dev` and `centraid.dev/docs/` render in the product's design ([decisions.md](decisions.md#product-grammar-and-block-composition), 2026-08-21): `scripts/site-tokens.mjs` lowers `packages/design`'s `toCss()` and its vendored Instrument Sans into a committed `centraid-tokens.css` per surface, and `bun run lint:site-tokens` fails on drift. The rows below are what a long-form public page does that a product screen does not. Each is a current decision, not a to-do.

| Divergence | Decision | Enforcement / reason |
| --- | --- | --- |
| `--t-hero-size` / `--t-chapter-size` step above `--t-display` (32px) for the landing hero and a docs chapter opener. | Keep. | A scrolling page opens on a title carrying the whole page; a product screen opens on a title carrying one pane. Both compose from `--t-display-size` itself — `clamp(calc(var(--t-display-size) * 1.15), …)` — and take the display role's own face, weight and tracking, so it is the ramp stretched rather than a second scale. Emitted once, in the site layer of the generated sheet; a page may not invent another. |
| `--sp-band` / `--sp-band-lg` / `--sp-band-xl` set the section rhythm above `--sp-6` (32px). | Keep. | 32px is the largest rhythm step _inside_ a screen — the desktop content margin. A page that scrolls through twelve sections needs a step between them, and these stack the top rung (`calc(var(--sp-6) * 2 … * 4)`) rather than introducing a rung the product does not have. |
| A docs chapter's full-bleed `.dark` band paints on `--stage` / `--on-stage`, a ground that does not follow the theme. | Keep for chapter pages; **not** for the ontology. | `--stage` is the product's opaque media ground, and the closest honest token for a band that reads dark in both themes. It carries exactly two ink rungs, so a band gets two and no third is invented. The ontology page is excluded because its whole vocabulary is hue: a hue solved against the page reads wrong on near-black, so its bands take `--bg-app` and follow the theme. `docs.css` scopes every `section.dark` rule with `body:not(.ontology-page)`. |
| The ontology page colour-codes "canonical core" and "domain extension" with two of the eight app identity hues (`--c-indigo`, `--c-ochre`). | Keep. | That axis exists to mark CONTENT at one lightness and one chroma per theme, and is never permitted on a control — which is exactly what a schema legend is. Type takes the solved `--c-*-text` rungs; the fill rungs stay on washes and borders. The page's one pressed control (`.ctlbtn`) takes the ink fill, not a hue. |
| `bun run lint:design-tokens` is not pointed at `scripts/*-site`. | Open, and deliberately not closed by widening a budget. | The gate's checked-in budget is empty and must stay empty. `src/content/ontology-style.css` still sizes in rem and carries per-diagram literals, so adding the directory today would mean recording debt. `lint:site-tokens` fences what this pass actually closed — the face, the CDN, the theme names, and unresolvable `var()`s — and the ontology sheet's sizes are the remaining work. |
