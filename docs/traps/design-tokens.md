# Trap: design tokens

## What goes wrong

Agents hardcode hex/rgb, invent parallel CSS variables, import deep theme files, or edit blueprint `tokens.css` snapshots as if they were the source of truth. Visual drift across desktop, web, mobile, and sandboxed apps follows.

## Source of truth

| Layer | Package / path | Role |
| --- | --- | --- |
| Typed tokens | `packages/design-tokens/src/*` | Colors, type, spacing, icons, app metadata |
| Desktop/web CSS emit | `toCss()` | Shell themes |
| Blueprint apps | `toBlueprintCss()` / scaffolded `tokens.css` | Separate field-notebook language — not a fork of shell tokens by hand |
| Mobile | Imports typed values (often from `src` for RN) | No separate hex palette |

Barrel: `@centraid/design-tokens` (`packages/design-tokens/src/index.ts`). Prefer `themes.light` / `themes.dark` over legacy `colors` alias for new code.

## Two themes, and the key must equal the kind

The registry is exactly `light` and `dark` (#608 group O cut the ten emulation presets — Notion, Airtable, GitHub, Solarized, Nord, Monokai). **A registry key must equal its `kind`.** Shell stylesheets key literally on `[data-theme='dark']` — `react/styles/toast.module.css`, `react/screens/SettingsConnectionsScreen.module.css` — so a dark preset registered under any other key takes the dark tokens while leaving those rules unfired: light chrome painted over a dark surface, with nothing in the UI to explain it. `themes/themes.test.ts` pins the invariant. Blueprint apps were never exposed to this because `AppFrame` resolves `themes[theme].kind` and hands the _kind_ to the iframe; the shell's own stylesheets never got that treatment.

Adding a third preset therefore means moving those rules onto a resolved-kind attribute **first**.

## Theme values are the floor, prefs are overrides

`react/shell/appearance.ts` applies appearance prefs as **inline styles** on `<html>`, and an inline style outranks every `[data-theme='…']` block `toCss()` emits. So a pref written unconditionally silently replaces the theme's own value: `--bg-l` at the pref default beat whatever `darkTheme` declared, and `--accent` from `ACCENT_PALETTE` meant a theme's declared accent never rendered at all (#608 group P). `bgL` and `accent` are now optional — written only when the owner has chosen one, and `removeProperty`'d when they have not. Anything new in that function needs the same treatment.

**There is exactly one dark ramp**, declared inline on `darkTheme`: neutral greyscale (`hsl(0 0% …)`), every surface derived from the `--bg-l` anchor. A three-position "surface temperature" knob (cool / neutral / warm, emitted as `[data-surface-temp]` blocks from a `themes/dark-ramp.ts` module) existed briefly and was cut. The reason is parity: the light theme has no temperature, so a dark-only knob made one half of the same setting behave unlike the other for no reason a member could name. `css.test.ts` asserts the emitted CSS contains no `data-surface-temp` at all, so the knob cannot creep back without a deliberate test change.

**When a theme declaration and the rendered product disagree, the product wins.** `darkTheme` declared `bgL: '18%'` while the pref layer forced `5%` inline over it, so the `18%` had never rendered — the near-black at `5%` _is_ Centraid Dark. Making the theme layer authoritative therefore meant moving the declaration down to `5%`, not letting a value nobody had ever seen redefine the product's appearance. A dead declaration is not a specification. One inherited consequence, noted on `darkTheme`: this far down the scale `--bg-app` is `calc(5% - 5%)`, i.e. true black.

## How agents get it wrong

1. **Hardcoded `#…` / `rgb()`** in client or blueprint CSS — use `var(--…)` from the token emit, or typed imports on RN.
2. **Editing generated `tokens.css` in an app** without regenerating from design-tokens — next scaffold/sync overwrites or drifts.
3. **Skipping `bun run build` on design-tokens** after token edits so consumers still see old `dist/`.
4. **Using shell tokens inside blueprint apps** (or vice versa) without going through the blueprint token path — CSP and theme-bridge assume the blueprint contract.
5. **Deep imports** like `@centraid/design-tokens/src/themes/centraid` — use package exports / barrel (governance no-deep-imports).
6. **Font-family overrides** in app CSS — UI grounding forbids arbitrary `font-family`; token stacks own type.

## Checklist

- [ ] Change tokens in `packages/design-tokens/src`, not in a one-off CSS file under `apps/`
- [ ] Rebuild / let turbo rebuild dependents
- [ ] New theme? Its registry key equals its `kind`, or the literal `[data-theme='dark']` shell rules moved to the resolved kind first
- [ ] New appearance pref applied inline on `<html>`? It only writes when the owner set it, and clears when they did not
- [ ] Blueprint/mobile consumers: verify direct `@centraid/design-tokens` generation and run the relevant package tests
- [ ] Grep for new hex in the touched UI surfaces

## Related

- `packages/design-tokens`
- [coding-standards.md](../coding-standards.md)
- Issue #43 history in `receipts/issue-43-ui-grounding-design-tokens.md`
