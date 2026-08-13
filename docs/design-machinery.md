# Design machinery

Inventory and ownership map for the visual system across desktop, PWA, blueprint apps, and Expo. The binding visual rules live in [DESIGN.md](../DESIGN.md); this document describes how those rules reach each renderer without becoming four design systems.

## One pipeline

| Stage | Owner | Responsibility |
| --- | --- | --- |
| Product grammar | `DESIGN.md` | Binding values, roles, surface rules, and component behavior |
| Typed registry | `packages/design/src` | Theme ramps, semantic roles, type, spacing, radii, density, motion, icons, app identity, and recipe inventory |
| Shell lowering | `toCss()` | CSS custom properties for the shared React shell used by desktop and PWA |
| Blueprint lowering | `toBlueprintCss()` | CSS custom properties for sandboxed app surfaces |
| Native lowering | `toNativeTheme()` | Concrete React Native values with no CSS parsing or runtime override layer |
| Native adapter | `apps/mobile/src/kit/theme/native.ts` | Expo font-family names and `em` tracking converted to React Native points |
| Components | `packages/client/src/react/ui`, `packages/design/kit`, `apps/mobile/src/kit` | Renderer-specific primitives that consume roles; they do not own token values |
| Enforcement | design contract tests, consumer lint, type/target floors, gallery | Proves the registry, lowerings, and consumers remain aligned |

The direction is one-way:

`DESIGN.md → packages/design registry → one lowering per renderer → components → screens`

A screen must not generate a token, a component must not invent a scale, and a lowering must not keep a second editable registry.

## Surface inventory

| Surface | Shared implementation | Local adapter | Design-lint coverage |
| --- | --- | --- | --- |
| Desktop | `packages/client` + `toCss()` | Electron host capabilities only | CSS consumer gate, type/radius/color rules, computed-style gallery |
| PWA | the same `packages/client` + `toCss()` | `apps/web/src/web.css` for host layout only | The same CSS gate roots and gallery contract as desktop |
| Blueprint apps | `packages/design/kit/kit.css` + `toBlueprintCss()` | App-specific content/layout | CSS consumer gate plus scaffold/contract tests |
| Expo | `toNativeTheme()` | `apps/mobile/src/kit/theme/native.ts` | Native consumer gate, native contract tests, target/type floor, hairline and logical-inset gates |

Desktop and PWA are one renderer from the design system's point of view. Pointer versus touch changes density, type, margin, and target values; host names and viewport width do not create more design modes.

## Ownership rules

1. Add or change a visual value in `packages/design/src`, then pin it in `DESIGN.md` and the matching contract test.
2. Lower a registry value exactly once for each syntax: shell CSS, blueprint CSS, or native objects.
3. Keep platform adaptation structural. Expo may name a loaded font and convert tracking units; it may not choose a different type ramp, color role, radius, or target size.
4. Keep recipes honest. `RECIPES` is the canonical capability and accessibility inventory; a renderer-specific style belongs beside its real component or in an adapter that the component actually consumes. Do not emit unused CSS.
5. Use semantic foregrounds. `textInv` / `onAccent` is the solved foreground for the theme's ink action fill. `onStage` belongs on the fixed dark media ground. Arbitrary stored identity colours use `identityInk()` so contrast is measured rather than guessed.
6. Do not restore copied native theme files, per-app font/tone knobs, radius aliases, or a web-only component variant.

## Verification

Use repo scripts so the pinned toolchain and flags apply:

```sh
bun run lint:design-consumers
bun run lint:design-md
bun run design:gallery
bun run --cwd packages/design test
bun run --cwd apps/mobile test
bun run check:push
```

The CSS and native gates are syntax-specific implementations of the same policy. Neither has an allowance ledger.
