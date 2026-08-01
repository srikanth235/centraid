# Centraid Desktop Shell — conventions

> **Do not trust any earlier revision of this file.** Every version before 2026-08 described a product that no longer exists: ten emulation themes (Notion / Airtable / GitHub / Solarized / Nord / Monokai — cut in #608), a `data-density` attribute, webfont stacks (Geist / Space Grotesk / JetBrains Mono — replaced by system stacks in #468 K11), and ink tokens that were renamed away (`--ink`, `--ink-2/3/4`, `--ink-inv`, `--warn`, `--d-1…7`). Anything generated against those notes is wrong.

This file is the `readmeHeader` for the desktop-shell `.design-sync` push (see `.design-sync/desktop.config.json` and `desktop.NOTES.md`). It is hand-authored, not build output — but it is **not** the design contract. It only points at it.

## Read these instead

- **[../docs/design-language.md](../docs/design-language.md)** — the canonical rulebook: aesthetic point of view, the token-contract-as-OS model, and the binding typography / colour / spacing / motion rules.
- **[../docs/traps/design-tokens.md](../docs/traps/design-tokens.md)** — source of truth per layer and the ways this gets done wrong.
- **[../packages/client/src/react/CSS-CONVENTIONS.md](../packages/client/src/react/CSS-CONVENTIONS.md)** — how the renderer is actually structured: tokens, a ~60-line reset, and co-located `*.module.css` per component. There are no global component classes.
- **`packages/design/src/contract.ts`** — `SHELL_TOKEN_CONTRACT` is the machine-checked list of every legal token name. If a variable is not in there, it does not exist.

## The rules that survive summarising

1. **Compose the real primitives** (`Button`, `IconButton`, `Icon`, `Logo`, `AppCard`, `StatusPill`, `KindBadge` in `packages/client/src/react/ui/`) and vary them through props. Class names are hashed by CSS Modules — never reference one literally.
2. **Style your own layout glue with contract tokens only** — surfaces `--bg`/`--bg-app`/`--bg-elev`/`--bg-sunken`, ink `--text`/`--text-soft`/ `--text-faint`/`--text-ghost`/`--text-inv`, hairlines `--line`/ `--line-strong`, states `--danger`/`--warning`/`--success`, radii `--r-xs…--r-xl`, spacing `--sp-1…--sp-7`, type `font: var(--t-body)` with families `--font-sans`/`--font-display`/`--font-mono`.
3. **State is a data-attribute, not a class string.**

Themes are exactly `light` and `dark`, selected with `data-theme`. There is no density attribute; spacing is the fixed `--sp-*` scale.
