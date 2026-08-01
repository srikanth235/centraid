# Centraid Blueprint Kit — conventions

> **Do not trust any earlier revision of this file.** Every version before 2026-08 described a product that no longer exists: ten emulation themes (Notion / Airtable / GitHub / Solarized / Nord / Monokai — cut in #608), webfont stacks (Geist / Space Grotesk / JetBrains Mono — replaced by system stacks in #468 K11), and tokens that were never emitted (`--surface`, `--ink-*`, `--warn`, `--d-*`). Anything generated against those notes is wrong.

This file is the `readmeHeader` for the `.design-sync` push (see `.design-sync/config.json` and `NOTES.md`). It is hand-authored, not build output — but it is **not** the design contract. It only points at it.

## Read these instead

- **[../docs/design-language.md](../docs/design-language.md)** — the canonical rulebook: the "field notebook" point of view, the token-contract-as-OS model, and the binding typography / colour / spacing / motion rules.
- **[../docs/traps/design-tokens.md](../docs/traps/design-tokens.md)** — source of truth per layer, the two layers of `packages/design`, and the ways this gets done wrong.
- **`packages/design/src/contract.ts`** — the machine-checked list of every legal token name (`SHELL_TOKEN_CONTRACT`, `BLUEPRINT_TOKEN_CONTRACT`). If a variable is not in there, it does not exist.
- **`packages/design/kit/kit.css`** — the real `.kit-*` component CSS, and **`packages/design/kit/elements.js`** — the real `<kit-*>` custom-element definitions this sync ships verbatim (no wrapper, #327).

## The two rules that survive summarising

1. **Compose the real `<kit-*>` element.** Never hand-roll a lookalike out of raw divs. Variation goes through attributes/properties, not markup.
2. **Style your own layout glue with contract tokens only** — `var(--bg-elev)`, `var(--text-soft)`, `var(--line)`, `var(--r-lg)`, `var(--sp-4)`, `font: var(--t-body)`. No hex, no invented `--name`, no `font-family`.

Themes are exactly `light` and `dark`, selected with `data-theme` on an ancestor. There is no density attribute on the token layer; spacing is the fixed `--sp-1`…`--sp-7` scale.
