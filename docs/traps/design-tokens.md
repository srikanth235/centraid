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

## How agents get it wrong

1. **Hardcoded `#…` / `rgb()`** in client or blueprint CSS — use `var(--…)` from the token emit, or typed imports on RN.
2. **Editing generated `tokens.css` in an app** without regenerating from design-tokens — next scaffold/sync overwrites or drifts.
3. **Skipping `bun run build` on design-tokens** after token edits so consumers still see old `dist/`.
4. **Using shell tokens inside blueprint apps** (or vice versa) without going through the blueprint token path — CSP and theme-bridge assume the blueprint contract.
5. **Deep imports** like `@centraid/design-tokens/src/themes/nord` — use package exports / barrel (governance no-deep-imports).
6. **Font-family overrides** in app CSS — UI grounding forbids arbitrary `font-family`; token stacks own type.

## Checklist

- [ ] Change tokens in `packages/design-tokens/src`, not in a one-off CSS file under `apps/`
- [ ] Rebuild / let turbo rebuild dependents
- [ ] Blueprint/mobile consumers: verify direct `@centraid/design-tokens` generation and run the relevant package tests
- [ ] Grep for new hex in the touched UI surfaces

## Related

- `packages/design-tokens`
- [coding-standards.md](../coding-standards.md)
- Issue #43 history in `receipts/issue-43-ui-grounding-design-tokens.md`
