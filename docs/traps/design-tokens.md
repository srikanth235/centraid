# Trap: design tokens

## What goes wrong

Agents hardcode hex/rgb, invent parallel CSS variables, import deep theme files, or edit blueprint `tokens.css` snapshots as if they were the source of truth. Visual drift across desktop, web, mobile, and sandboxed apps follows.

## Source of truth

| Layer | Package / path | Role |
| --- | --- | --- |
| Typed tokens | `packages/design/src/*` | Colors, type, spacing, icons, app metadata |
| Desktop/web CSS emit | `toCss()` | Shell themes |
| Blueprint apps | `toBlueprintCss()` / scaffolded `tokens.css` | Separate field-notebook language — not a fork of shell tokens by hand |
| Mobile | `toNativeTheme()` through `apps/mobile/src/kit/theme/native.ts` | Direct typed lowering; no copied palette or generated theme file |

Barrel: `@centraid/design` (`packages/design/src/index.ts`). Prefer `themes.light` / `themes.dark` over legacy `colors` alias for new code.

## Two themes, and the key must equal the kind

The registry is exactly `light` and `dark` (#608 group O cut the ten emulation presets — Notion, Airtable, GitHub, Solarized, Nord, Monokai). **A registry key must equal its `kind`.** Shell stylesheets key literally on `[data-theme='dark']` — `react/styles/toast.module.css`, `react/screens/SettingsConnectionsScreen.module.css` — so a dark preset registered under any other key takes the dark tokens while leaving those rules unfired: light chrome painted over a dark surface, with nothing in the UI to explain it. `themes/themes.test.ts` pins the invariant. Blueprint apps were never exposed to this while they were served: the retired iframe host resolved `themes[theme].kind` and handed the _kind_ across the frame. The shell's own stylesheets never got that treatment, and inline apps now share them.

Adding a third preset therefore means moving those rules onto a resolved-kind attribute **first**.

## Theme values are the floor, prefs are overrides

`react/shell/appearance.ts` applies appearance prefs as **inline styles** on `<html>`, and an inline style outranks every `[data-theme='…']` block `toCss()` emits. So a pref written unconditionally silently replaces the theme's own value: `--bg-l` at the pref default beat whatever `darkTheme` declared, and `--accent` from `ACCENT_PALETTE` meant a theme's declared accent never rendered at all (#608 group P). `bgL` and `accent` are now optional — written only when the owner has chosen one, and `removeProperty`'d when they have not. Anything new in that function needs the same treatment.

**There is exactly one dark ramp**, declared inline on `darkTheme`: neutral greyscale (`hsl(0 0% …)`), every surface derived from the `--bg-l` anchor. A three-position "surface temperature" knob (cool / neutral / warm, emitted as `[data-surface-temp]` blocks from a `themes/dark-ramp.ts` module) existed briefly and was cut. The reason is parity: the light theme has no temperature, so a dark-only knob made one half of the same setting behave unlike the other for no reason a member could name. `css.test.ts` asserts the emitted CSS contains no `data-surface-temp` at all, so the knob cannot creep back without a deliberate test change.

**When a theme declaration and the rendered product disagree, the product wins.** `darkTheme` declared `bgL: '18%'` while the pref layer forced `5%` inline over it, so the `18%` had never rendered — the near-black at `5%` _is_ Centraid Dark. Making the theme layer authoritative therefore meant moving the declaration down to `5%`, not letting a value nobody had ever seen redefine the product's appearance. A dead declaration is not a specification. One inherited consequence, noted on `darkTheme`: this far down the scale `--bg-app` is `calc(5% - 5%)`, i.e. true black.

## How agents get it wrong

1. **Hardcoded `#…` / `rgb()`** in client or blueprint CSS — use `var(--…)` from the token emit, or typed imports on RN.
2. **Editing generated `tokens.css` in an app** without regenerating from `@centraid/design` — next scaffold/sync overwrites or drifts.
3. **Skipping `bun run build` on `packages/design`** after token edits so consumers still see old `dist/`.
4. **Using shell tokens inside blueprint apps** (or vice versa) without going through the blueprint token path — CSP and theme-bridge assume the blueprint contract.
5. **Deep imports** like `@centraid/design/src/themes/centraid` — use package exports / barrel (governance no-deep-imports).
6. **Font-family overrides** in app CSS — UI grounding forbids arbitrary `font-family`; token stacks own type.

## There is ONE page, and an app does not retune it

A per-app surface-tone axis shipped once: an app set `data-tone` (neutral / paper / mat / cool / warm) and only `--bg` (`--bg-tone-*`) moved. It was removed entirely, for two measured reasons:

1. **Retuning `--bg` alone inverted the paper metaphor.** `--bg-elev` / `--bg-sunken` / `--skel` stayed pinned while only the page moved, and the system's rule is that raised paper is darker-in-light and lighter-in-dark. Photos, on a retuned page, drew its cards LIGHTER than its page in light mode — exactly backwards, because a card is a sheet laid on the page and the sheet did not move with it.
2. **The axis was imperceptible.** Measured on device, four of the five tones sat within 0.7 L* of neutral, and dark mode's whole five-tone spread was 2.4 L*.

The rule now: the shell and every app share ONE page colour, `--bg` / `colors.bg`. If a page tone ever returns, it must carry its whole surface SET — page, elev, sunken, and skel together — never `--bg` alone; a tone that moves one rung of the paper stack and pins the rest is how the inversion happened the first time. `PAGE` and `WALL` in `packages/design/src/themes/shared.ts` are deliberately not re-exported from the package barrel: reaching for the literal instead of the `--bg` role is the same per-app page retune this rule exists to prevent.

- [ ] Grounding a page? Read `--bg` / `colors.bg` — never a per-app page colour, and never a new `data-tone`.

## There is ONE face, and type follows the ROLE

v8 withdraws the same freedom on the type side that the tone axis had on the colour side. An app used to declare a **primary register** — reading or scanning — and its prose took a different face depending on which app it was in. That is gone. Every product role uses **Instrument Sans**:

- Pointer: display 32/36, title 20/26, reading 17/28, section 13/18, body 13/19, annotation and micro 11/15.
- Touch: display 27/31, title 20/26, reading 17/28, section 15/21, body 15/22, annotation 13/18, micro 11/15.
- `--t-mono` remains the annotation/numeric role: Instrument Sans with `font-variant-numeric: tabular-nums`, **not** a monospace face.

Source Serif 4 and the 500 cut were deleted and are not coming back through a side door. `packages/design/fonts` ships **four** `.woff2` files: latin/latin-ext at 400 and 600. `fonts.test.ts` pins that exact set.

`--font-code` names the **platform** code stack and downloads nothing. It is for code, an inline literal, or a file path shown verbatim — a fixed advance where the alignment carries meaning. A count, a date, a file size, a ticket, or a duration is a **number/annotation**, and takes `--t-mono`, which is Instrument Sans with tabular figures.

- [ ] Setting prose? Take the role. There is no app-level face, register, or `register` field on a manifest.
- [ ] Setting a number? `font: var(--t-mono); font-variant-numeric: var(--t-mono-numeric);` — not `font-family: var(--font-code)`.
- [ ] Reaching for `--font-code`? Only for code, an inline literal, or a file path.

The CSS debt ledger is empty. `scripts/lint-design-tokens.mjs` accepts only a current `--t-*` role or `--t-*-size` rung; arbitrary `var()` sizing does not count as token adoption. Radius declarations are closed over `--r-*`, the registry-emitted tile shape, the per-instance icon-chip radius, and the 26% app-mark geometry. Literal fallbacks, longhand literals, circles spelled as `50%`, and arithmetic over a radius token all fail. Do not repopulate `tests/design-token-css-budget.json`; it is intentionally `{}`.

Expo has the same zero-debt contract in native syntax. `scripts/lint-mobile-design.mjs` rejects literal font family/weight, numeric `fontSize`/`lineHeight`, numeric radius properties, and literal style/JSX hex or rgb(a) in production consumers. Use `t(role)`, `family.mono*` for actual code, `radii.role`, and `colors.role`. `apps/mobile/src/kit/theme/native.ts` and `resolve.ts` are the two lowering owners excluded from consumer scanning; the design package's native contract tests own their source values. There is no generated copy and no per-file mobile allowance map. Run both syntax gates together with `bun run lint:design-consumers`.

## Two values live under the 4px base, and they are named

`4 / 8 / 12 / 16 / 24 / 32` is the gap scale. v7 measured fifteen sub-base gaps in the reference — 1, 2, 3, 5 and 6px — and folded thirteen back onto it. The two survivors are seams rather than rhythm steps, and they are tokens precisely so the difference is legible in a diff:

| Token         | Value | Only use                                |
| ------------- | ----- | --------------------------------------- |
| `--sp-hair`   | 1px   | the rule inside a tight text stack      |
| `--sp-gutter` | 2px   | the seam between two images in a mosaic |

A loose `gap: 2px` is indistinguishable from someone eyeballing a rung; `var(--sp-gutter)` says which of the two exceptions is being claimed. Nothing else under 4px is permitted — a third sub-base value is a system change, not a call-site decision.

- [ ] Under 4px? Use `--sp-hair` or `--sp-gutter`, or move onto the scale. There is no third option.

## Checklist

- [ ] Change tokens in `packages/design/src`, not in a one-off CSS file under `apps/`
- [ ] Rebuild / let turbo rebuild dependents
- [ ] New theme? Its registry key equals its `kind`, or the literal `[data-theme='dark']` shell rules moved to the resolved kind first
- [ ] New appearance pref applied inline on `<html>`? It only writes when the owner set it, and clears when they did not
- [ ] Blueprint/mobile consumers: verify their direct `@centraid/design` lowering and run the relevant package tests
- [ ] Run `bun run lint:design-consumers`; do not add an allowance or a raw consumer value

## Related

- `packages/design`
- [design-machinery.md](../design-machinery.md)
- [coding-standards.md](../coding-standards.md)
- Issue #43 history in `receipts/issue-43-ui-grounding-design-tokens.md`

## The two layers of `packages/design`

`packages/design` is one package with two layers, and the distinction matters when you are deciding where a change belongs:

- **Token layer** (`src/`, imported as `@centraid/design`) — the typed values and the emitters (`toCss()` for the shell, `toBlueprintCss()` for app surfaces). Every visual decision lives here. It is IMPORTED.
- **Kit layer** (`kit/`, referenced as `@centraid/design/kit`) — the component substrate app surfaces load: `kit.css`, `kit.ts`, chart elements, toast and Ask controllers. Apps import it as a sibling (`./kit.ts`); each shell's bundler rewrites that specifier to this dir through `inline-vite-aliases.ts`. The raw-`.js`-plus-hand-written-`.d.ts` shape it still carries is a leftover of the retired serving plane (#799) and dissolves into the token layer under the same issue.

The kit holds **no design decisions of its own** (#672) — every colour, hairline, radius and face in `kit.css` is a contract token. If you find yourself adding a literal or a new `--name` there, the value belongs in the token layer and the name belongs in `src/contract.ts`.
