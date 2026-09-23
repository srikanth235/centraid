# Trap: design tokens

## What goes wrong

Agents hardcode hex/rgb, invent parallel CSS variables or Kotlin/Swift colour tables, import deep theme files, or hand-edit a generated token artifact as if it were the source of truth. Visual drift across the two native shells and the public web surfaces follows.

## Source of truth

| Layer | Package / path | Role |
| --- | --- | --- |
| Typed tokens | `packages/design/src/*` | Colors, type, spacing, icons, app metadata |
| CSS emit | `toCss()` (`packages/design/src/css.ts`) | Light and dark theme blocks for web surfaces |
| App-surface CSS emit | `toBlueprintCss()` (`packages/design/src/blueprint.ts`) | The app-surface token language — not a hand fork of the shell tokens |
| Element layer | `packages/design/src/elements/` (`@centraid/design/elements`, `kit.css`) | The browser substrate; see [below](#the-two-layers-of-packagesdesign) |
| Native | `toNativeTheme(scheme)` (`packages/design/src/native.ts`), emitted by `bun contracts/tools/export-native-theme.ts` into `design/native-theme.json`, `mobile/shared/src/commonMain/kotlin/dev/centraid/design/Tokens.kt` and `mobile/iosApp/Design/Theme.swift` ([design-machinery.md](../design-machinery.md)) | The same lowering, emitted — every value concrete, no `var()` or runtime override layer |
| Public sites | `scripts/site-tokens.mjs` (`bun run site:tokens`, checked by `bun run lint:site-tokens`) | See [design-machinery.md](../design-machinery.md#the-public-web-surfaces) |

Barrel: `@centraid/design` (`packages/design/src/index.ts`). Prefer `themes.light` / `themes.dark` over the legacy `colors` alias for new code.

**Generated artifacts are regenerated, never edited.** The gate's `emitters` step (`pr`) and `mobile-jvm` step both rerun the emitters, run `bun run format`, and fail on `git diff --exit-code -- copy design mobile`. `copy/*.json` and `mobile/.../design/Copy.kt` are the exception: their upstream was retired and they are now edited by hand, as their own banners say.

Every surface lowers `packages/design`; a colour written anywhere else is a token that belongs there instead.

## Two themes, and the key must equal the kind

The registry is exactly `light` and `dark` (#608 group O cut the ten emulation presets). **A registry key must equal its `kind`.** Stylesheets key literally on `[data-theme='dark']` — `packages/design/src/elements/kit.css` does — so a dark preset registered under any other key takes the dark tokens while leaving those rules unfired: light chrome painted over a dark surface, with nothing in the UI to explain it. `themes/themes.test.ts` pins the invariant.

Adding a third preset therefore means moving those rules onto a resolved-kind attribute **first**.

## Theme values are the floor, prefs are overrides

An appearance preference applied as an **inline style** on `<html>` outranks every `[data-theme='…']` block `toCss()` emits. So a pref written unconditionally silently replaces the theme's own value (#608 group P: a pref default for `--bg-l` beat the dark theme's declaration, and an accent palette meant a theme's declared accent never rendered). A pref is written only when the owner has chosen one, and removed when they have not.

**There is exactly one dark ramp**, declared inline on `darkTheme`: neutral greyscale (`hsl(0 0% …)`), every surface derived from the `--bg-l` anchor. The light theme has no temperature knob, so the dark theme has none either — a dark-only knob made one half of the same setting behave unlike the other for no reason a member could name.

**When a theme declaration and the rendered product disagree, the product wins.** `darkTheme` sits at `bgL: '5%'` because that near-black is what Centraid Dark rendered as; a dead declaration is not a specification. One inherited consequence, noted on `darkTheme`: this far down the scale `--bg-app` is `calc(5% - 5%)`, i.e. true black.

## How agents get it wrong

1. **Hardcoded `#…` / `rgb()`** in CSS, Kotlin or Swift — use `var(--…)` from the token emit, or the emitted native theme.
2. **Editing a generated artifact** (`design/*.json`, `Tokens.kt`, `Theme.swift`) without rerunning the emitter — the gate's drift check fails, or the next emit overwrites it.
3. **Skipping `bun run --cwd packages/design build`** after token edits so a consumer of `dist/` still sees old values.
4. **Using shell tokens inside an app surface** (or vice versa) without going through the `toBlueprintCss()` path.
5. **Deep imports** like `@centraid/design/src/themes/centraid` — use the package exports (governance no-deep-imports).
6. **Font-family overrides** in app CSS — token stacks own type.

## There is ONE page, and an app does not retune it

A per-app surface-tone axis (`data-tone`: neutral / paper / mat / cool / warm, moving only `--bg`) was removed, for two measured reasons:

1. **Retuning `--bg` alone inverted the paper metaphor.** `--bg-elev` / `--bg-sunken` / `--skel` stayed pinned while only the page moved, and the system's rule is that raised paper is darker-in-light and lighter-in-dark. A card on a retuned page drew LIGHTER than its page in light mode — exactly backwards.
2. **The axis was imperceptible.** Measured on device, four of the five tones sat within 0.7 L* of neutral, and dark mode's whole five-tone spread was 2.4 L*.

The rule: the shell and every app share ONE page colour, `--bg` / `colors.bg`. If a page tone ever returns, it must carry its whole surface SET — page, elev, sunken, and skel together — never `--bg` alone. `PAGE` and `WALL` in `packages/design/src/themes/shared.ts` are deliberately not re-exported from `themes/index.ts` or the package barrel: reaching for the literal instead of the `--bg` role is the same per-app page retune this rule exists to prevent.

- [ ] Grounding a page? Read `--bg` / `colors.bg` — never a per-app page colour, and never a new `data-tone`.

## There is ONE face, and type follows the ROLE

An app does not declare a reading or scanning register, and its prose does not change face by app. Every product role uses **Instrument Sans**:

- Pointer: display 32/36, title 20/26, reading 17/28, section 13/18, body 13/19, annotation and micro 11/15.
- Touch: display 27/31, title 20/26, reading 17/28, section 15/21, body 15/22, annotation 13/18, micro 11/15.
- `--t-mono` remains the annotation/numeric role: Instrument Sans with `font-variant-numeric: tabular-nums`, **not** a monospace face.

`packages/design/fonts` ships **four** `.woff2` files: latin/latin-ext at 400 and 600. `fonts.test.ts` pins that exact set.

`--font-code` names the **platform** code stack and downloads nothing. It is for code, an inline literal, or a file path shown verbatim — a fixed advance where the alignment carries meaning. A count, a date, a file size, a ticket, or a duration is a **number/annotation**, and takes `--t-mono`, which is Instrument Sans with tabular figures.

- [ ] Setting prose? Take the role. There is no app-level face, register, or `register` field on a manifest.
- [ ] Setting a number? `font: var(--t-mono); font-variant-numeric: var(--t-mono-numeric);` — not `font-family: var(--font-code)`.
- [ ] Reaching for `--font-code`? Only for code, an inline literal, or a file path.

The CSS debt ledger is empty. `scripts/lint-design-tokens.mjs` (`bun run lint:design-tokens`) reads **one** target, `packages/design/src/elements` — `extension/static` stood beside it until the extension went with the v0 tree in [#1029](https://github.com/srikanth235/centraid/issues/1029), and a named target that does not exist made the gate throw rather than check. It accepts only a current `--t-*` role or `--t-*-size` rung; arbitrary `var()` sizing does not count as token adoption. Radius declarations are closed over `--r-*`, the registry-emitted tile shape, the per-instance icon-chip radius, and the 26% app-mark geometry. Literal fallbacks, longhand literals, circles spelled as `50%`, and arithmetic over a radius token all fail. Do not repopulate the CSS debt ledger — `tests/budgets.json#designTokenCss` is intentionally empty.

## Three values live under the 4px base, and they are named

`4 / 8 / 12 / 16 / 24 / 32` is the gap scale. Two sub-base survivors are seams rather than rhythm steps, and they are tokens precisely so the difference is legible in a diff. A third, `--sp-chip`, is a recorded system change for the one chip drawn on a photograph tile ([#1015](https://github.com/srikanth235/centraid/issues/1015), R-NY-15):

| Token         | Value | Only use                                   |
| ------------- | ----- | ------------------------------------------ |
| `--sp-hair`   | 1px   | the rule inside a tight text stack         |
| `--sp-gutter` | 2px   | the seam between two images in a mosaic    |
| `--sp-chip`   | 3px   | the inline inset of a chip on a photo tile |

A loose `gap: 2px` is indistinguishable from someone eyeballing a rung; `var(--sp-gutter)` says which of the three exceptions is being claimed. Nothing else under 4px is permitted — a fourth sub-base value is a system change in `packages/design`, never a call-site or kit constant.

- [ ] Under 4px? Use `--sp-hair`, `--sp-gutter` or `--sp-chip` (typed: `subBase.hair|gutter|chip`), or move onto the scale. There is no fourth option.

## Checklist

- [ ] Change tokens in `packages/design/src`, not in a one-off CSS, Kotlin or Swift file
- [ ] Rerun `bun contracts/tools/export-native-theme.ts` and `bun run format`, and commit the regenerated artifacts
- [ ] New theme? Its registry key equals its `kind`, or the literal `[data-theme='dark']` rules moved to the resolved kind first
- [ ] New appearance pref applied inline on `<html>`? It only writes when the owner set it, and clears when they did not
- [ ] Run `bun run --cwd packages/design test` and `bun run lint:design-tokens`; do not add an allowance or a raw consumer value

## Related

- `packages/design`
- [design-machinery.md](../design-machinery.md)
- [coding-standards.md](../coding-standards.md)
- Issue #43 history in `receipts/issue-43-ui-grounding-design-tokens.md`

## The two layers of `packages/design`

`packages/design` is one package with two layers, and the distinction matters when you are deciding where a change belongs:

- **Token layer** (`src/`, imported as `@centraid/design`) — the typed values and the emitters (`toCss()`, `toBlueprintCss()`, `toNativeTheme()`). Every visual decision lives here. It is IMPORTED.
- **Element layer** (`src/elements/`, imported as `@centraid/design/elements`) — the browser substrate app surfaces render on: `kit.css`, the status line, confirm-to-act, the popover, the formatters, the refresh discipline and the attachment flow. It defines no custom elements ([#799](https://github.com/srikanth235/centraid/issues/799)), so importing it registers nothing. The subpath carries no `react-native` condition and is never re-exported from `src/index.ts`, because the token layer must stay loadable where there is no `document`; `src/native-contract.test.ts` asserts that separation rather than trusting it. The viewer's local day key (`localDayKey`) lives in the token layer; the element barrel re-exports it for DOM callers.

The element layer holds **no design decisions of its own** (#672) — every colour, hairline, radius and face in `kit.css` is a contract token. If you find yourself adding a literal or a new `--name` there, the value belongs in the token layer and the name belongs in `src/contract.ts`.
