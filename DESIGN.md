# DESIGN.md — Centraid

Machine-readable design brief for AI coding agents, following the [getdesign.md](https://getdesign.md/) convention: colors, type, spacing, components, and the reasoning behind them, in one root file.

This is a **brief**, not the spec. Depth lives in [docs/design-language.md](docs/design-language.md) (the prose rulebook), [packages/design/src/contract.ts](packages/design/src/contract.ts) (the enforced token vocabulary), and [docs/traps/design-tokens.md](docs/traps/design-tokens.md) (how agents get this wrong). Values below are pinned against the TypeScript source by `packages/design/src/design-md.test.ts` — if you change a token, change this file in the same commit.

## Point of view

**Field notebook.** Calm, instrument-grade, personal. The product is where someone keeps their own life's data, so the chrome recedes and the data reads.

- **Neutrals do the work.** Hierarchy is type, spacing, and hairlines — not color.
- **One structural accent.** The accent marks state, selection, and the single primary action on a surface. Never decoration, never a second brand, never a gradient.
- **Hard-edged geometry.** Centraid is an instrument, not a pillow.
- **Contrast is measured, not eyeballed.** Every ink and status rung below carries the ratio it was tuned to.
- **Motion is confirmation, not entertainment.**

## Rules (binding)

1. Use tokens. No hex, `rgb()`, or `hsl()` literal in client, kit, or app CSS. A value with no token belongs in `packages/design/src`, and its name in `src/contract.ts`.
2. Never declare a new `--name` in app CSS or `kit.css`. New names go in the contract.
3. Never set `font-family` in app or kit CSS. Token stacks own type.
4. Spacing comes from `--sp-1`…`--sp-7`. A gutter off the scale is a bug, not a nuance.
5. `--t-*` are CSS `font` **shorthands**. Write `font: var(--t-body)`; `font-size: var(--t-body)` silently drops everything.
6. `--text-inv` is _inverse_ ink for filled/accent surfaces — not "invalid".
7. Every animation needs a `prefers-reduced-motion: reduce` branch that removes movement, not merely shortens it.
8. Deep-importing `@centraid/design/src/...` is forbidden — use the barrel.

## Color

### Brand

`BRAND = #3EC8B4` (teal) — logo, app-icon marks, emitted theme-independently as `--brand`.

Accent ramp derived from brand, all four exposed as tokens:

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#3EC8B4` | FAB, sparkle, primary CTA, focus ring |
| `--accent-light` | `#62D6C6` | "new" badges, hovered active rows |
| `--accent-deep` | `#2AA593` | pressed states, depth |
| `--accent-midnight` | `#12645A` | deepest rung |
| `--accent-text` | `#0F7A6C` (light theme) | brand-as-text; raw brand is 2.0:1 on near-white and fails at any size. 5.1:1 on `--bg`. |

Derive tints with `accentRamp()`. Do not hand-pick.

### Semantic states

Not accents; never used for emphasis.

| Role        | Dark      | Light     | Measured                |
| ----------- | --------- | --------- | ----------------------- |
| `--success` | `#5C8A4E` | `#456B39` | 4.8:1 dark, 6.0:1 light |
| `--danger`  | `#C44A4A` | `#C44A4A` | clears AA on both ramps |
| `--warning` | `#E0A94A` | `#9A6B1F` | 9.2:1 dark, 4.6:1 light |

### App-icon palette

Eight saturated hues that read on graphite, exposed as `--c-<name>`: `amber #E89A3C` · `forest #5C8A4E` · `indigo #4E68DD` · `ochre #B47B3F` · `rose #E55772` · `slate #5C677D` · `teal #2EA098` · `violet #7C5BD9`.

### Surfaces and ink

Exactly two themes, `light` and `dark`; a registry key must equal its `kind`. There is one dark ramp, anchored on a single knob `--bg-l: 5%` — every dark surface is `hsl(0 0% calc(var(--bg-l) ± n))`, so moving one number retunes the whole ramp.

Ink descends `--text` → `--text-soft` → `--text-faint` → `--text-ghost`. These are `color:` on real prose, so each rung clears a floor against the lightest surface it can land on. Light theme, measured against `--bg`: **text 17.6:1, soft 8.8:1, faint 5.0:1, ghost 3.2:1**. Surfaces: `--bg`, `--bg-app`, `--bg-elev` (raised fill), `--bg-sunken` (recessed/track), `--bg-wall`. Hairlines: `--line`, `--line-strong`.

Blueprint apps express identity by moving **`--app-hue`** (default `171`) — their neutrals are `hsl(var(--app-hue) …)`. An app does not redefine a palette.

## Typography

**Roles, not families.** The contract names `sans`, `display`, `mono`; surfaces bind roles to faces and never introduce a role. Web and desktop use **system stacks only** — `system-ui` for sans/display, `ui-monospace` for mono. No webfont family first; the chrome never blocks on a network font fetch (#468 K11). Mobile maps the same roles to loaded platform faces because RN cannot combine `fontFamily` with `fontWeight` (see the #686 entry in [docs/decisions.md](docs/decisions.md)).

**Two weights across the chrome: 400 and 500/600. No bold.**

| Token             | Size / line-height | Family  | Weight |
| ----------------- | ------------------ | ------- | ------ |
| `--t-display`     | 28 / 34            | display | 600    |
| `--t-title`       | 20 / 26            | display | 600    |
| `--t-body`        | 15 / 22            | sans    | 400    |
| `--t-body-strong` | 15 / 22            | sans    | 600    |
| `--t-small`       | 13 / 18            | sans    | 400    |
| `--t-mono`        | 12 / 16            | mono    | 500    |
| `--t-tiny`        | 11 / 14            | sans    | 500    |

Marketing/hero styles (`--t-display-1` 40, `--t-h2` 22, `--t-h3` 16) are **web-only, outside the chrome**, and are the single place weight 700 appears.

**Mono is the signature.** Metadata, counts, dates, and eyebrows are mono; prose is not.

## Spacing

`--sp-1`…`--sp-7` = **4 · 8 · 12 · 16 · 24 · 32 · 48** px. Emitted identically by `toCss()` and `toBlueprintCss()` from `src/density.ts`, and typed for mobile as `spacing`. The scale is fixed — there is no density switch on the token layer, and these are the only rungs.

## Radii

`--r-xs` 2 · `--r-sm` 4 · `--r-md` 6 · `--r-lg` 10 · `--r-xl` 14 (px).

Components live between 6–14px. Only sheets and modals soften past `xl`, composed inline (`var(--r-xl)` plus a pill on FABs).

## Elevation

Hairline borders separate; shadows lift sparingly. Three rungs only: `--shadow-sm`, `--shadow-md`, `--shadow-lg`. No heavy strokes, no drop-shadow stacks.

## Motion

- One curve for the whole product: **`--ease: cubic-bezier(0.2, 0.7, 0.3, 1)`** — a calm, instrument-grade ease-out. The literal lives in `src/motion.ts` and nowhere else.
- **Standard transitions ≤ 200ms.** Anything longer needs a reason a member could name.
- Motion animates state changes and entrances. Nothing loops; nothing draws attention to itself while idle.

## Components

`packages/design` is one package with two layers, and reads as a small operating system:

| Layer | Analogy | What it is |
| --- | --- | --- |
| Token contract (`src/contract.ts`) | the OS | the only public vocabulary of semantic roles |
| Kit (`kit/kit.css`, `kit/elements.js`) | the system UI framework | the served substrate — `.kit-*` classes and `<kit-*>` elements, holding **no design decisions of its own** |
| `toBlueprintCss()` | the app SDK | what a sandboxed blueprint app is handed |

Canonical and only copy of the kit: `packages/design/kit/kit.css`. Apps do not carry their own copies.

**Class families** (compose, do not fork): `kit-app-*` (shell, side, topbar, brand), `kit-ask-*` (the assistant panel), `kit-msg-*`, `kit-btn`, `kit-input`, `kit-chip`, `kit-seg`, `kit-search`, `kit-popover`, `kit-modal`, `kit-banner`, `kit-empty`, `kit-icon`, `kit-toast(s)`, `kit-attach-*`, `kit-ref-*`, `kit-mention-*`, `kit-chart-*`, `kit-skeleton`, `kit-avatar`.

**Custom elements**: `<kit-avatar>`, `<kit-bar-chart>`, `<kit-line-chart>`, `<kit-mention-chip>`, `<kit-meter>`, `<kit-reference-strip>`, `<kit-skeleton>`, `<kit-toast>`.

**Tokens every `app.css` MUST define**: `--bg-elev`, `--line`, `--text`, `--text-soft`, `--accent`. Optional, degrading gracefully when absent: `--bg-sunken`, `--line-strong`, `--text-faint`, `--radius`, `--shadow-md`, `--accent-soft`.

## Do / Don't

**Do**

- Set `--app-hue` and `--accent` to claim an app identity.
- Compose kit classes and elements; add app-local layout glue styled with contract vars.
- Override the documented optional tokens from the `kit.css` header contract.
- Express hierarchy with type, spacing, and one hairline.
- Regenerate `tokens.css` / `tokens.generated.ts` from source.

**Don't**

- Hardcode colors, radii, spacing, or font stacks.
- Invent a `--name` in app CSS or `kit.css`.
- Set `font-family`, or restyle another component's internals across a module or kit boundary.
- Use a status color for emphasis, or the accent for decoration.
- Hand-edit a generated token snapshot.
- Fork the shell token set into an app surface, or vice versa — CSP and the theme bridge assume the blueprint contract.

## References

- [docs/design-language.md](docs/design-language.md) — the binding prose rulebook
- [docs/traps/design-tokens.md](docs/traps/design-tokens.md) — source of truth vs hardcoded CSS
- [packages/design/src/contract.ts](packages/design/src/contract.ts) — enforced token vocabulary
- [packages/client/src/react/CSS-CONVENTIONS.md](packages/client/src/react/CSS-CONVENTIONS.md) — renderer CSS-Modules rules
- [packages/gateway/src/skills/ui-grounding.ts](packages/gateway/src/skills/ui-grounding.ts) — how this contract reaches app-authoring agents
