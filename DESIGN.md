---
version: alpha
name: Centraid
description: >-
  Field-notebook design system for a personal app builder. Calm, instrument-grade, neutral-led. One structural accent, hard-edged geometry, measured contrast. Token values here are generated from packages/design/src and pinned by packages/design/src/design-md.test.ts.
colors:
  # Brand. `primary` is an alias for the single structural accent — Centraid
  # has exactly one, and it is the brand teal.
  primary: "{colors.brand}"
  brand: "#3EC8B4"
  accent: "#3EC8B4"
  accent-light: "#62D6C6"
  accent-deep: "#2AA593"
  accent-midnight: "#12645A"
  accent-text: "#0F7A6C"
  on-accent: "#FFFFFF"

  # Semantic states. Never emphasis, never a second accent.
  success: "#456B39"
  success-dark: "#5C8A4E"
  danger: "#C44A4A"
  warning: "#9A6B1F"
  warning-dark: "#E0A94A"

  # App-icon palette — the saturated 8, identical across both themes.
  c-amber: "#E89A3C"
  c-forest: "#5C8A4E"
  c-indigo: "#4E68DD"
  c-ochre: "#B47B3F"
  c-rose: "#E55772"
  c-slate: "#5C677D"
  c-teal: "#2EA098"
  c-violet: "#7C5BD9"

  # Light theme — surfaces, ink, hairlines.
  light-bg: "#FCFCFC"
  light-bg-app: "#FFFFFF"
  light-bg-elev: "#FFFFFF"
  light-bg-sunken: "#F0F1F3"
  light-bg-wall: "#FCFCFC"
  light-text: "#14161B"
  light-text-soft: "rgba(20,22,27,0.78)"
  light-text-faint: "rgba(20,22,27,0.62)"
  light-text-ghost: "rgba(20,22,27,0.48)"
  light-text-inv: "#F4F5F7"
  light-line: "rgba(20,22,27,0.11)"
  light-line-strong: "rgba(20,22,27,0.20)"
  light-scrim: "rgba(20,22,27,0.52)"

  # Dark theme. Every surface is `hsl(0 0% calc(var(--bg-l) ± n))` off the
  # single `--bg-l: 5%` anchor; the hexes below are that anchor resolved, so
  # a contrast checker can read them.
  dark-bg: "#0D0D0D"
  dark-bg-app: "#000000"
  dark-bg-elev: "#181818"
  dark-bg-sunken: "#030303"
  dark-text: "#ECEEF2"
  dark-text-soft: "rgba(236,238,242,0.72)"
  dark-text-faint: "rgba(236,238,242,0.52)"
  dark-text-ghost: "rgba(236,238,242,0.38)"
  dark-text-inv: "#141820"
  dark-line: "rgba(220,230,245,0.08)"
  dark-line-strong: "rgba(220,230,245,0.16)"
  dark-scrim: "rgba(0,0,0,0.72)"
typography:
  display:
    fontFamily: system-ui
    fontSize: 28px
    fontWeight: 600
    lineHeight: 34px
  title:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: 600
    lineHeight: 26px
  body:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 400
    lineHeight: 22px
  body-strong:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 600
    lineHeight: 22px
  small:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18px
  mono:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
  tiny:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: 500
    lineHeight: 14px
rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 10px
  xl: 14px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 24px
  "6": 32px
  "7": 48px
components:
  kit-btn:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.2}"
  kit-btn-primary:
    backgroundColor: "{colors.accent-deep}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.2}"
  kit-btn-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  kit-btn-primary-pressed:
    backgroundColor: "{colors.accent-midnight}"
    textColor: "{colors.on-accent}"
  kit-badge-new:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.dark-text-inv}"
    rounded: "{rounded.sm}"
  kit-btn-danger:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  kit-input:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  kit-chip:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.small}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1}"
  kit-banner-success:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
  kit-banner-warning:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.warning}"
    rounded: "{rounded.md}"
  kit-app-side:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.small}"
  kit-app-topbar:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    typography: "{typography.title}"
  kit-modal:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.5}"
  kit-popover:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.3}"
  kit-empty:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-faint}"
    typography: "{typography.small}"
  kit-toast:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.3}"
  kit-msg-meta:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-faint}"
    typography: "{typography.mono}"
  kit-app-side-dark:
    backgroundColor: "{colors.dark-bg-sunken}"
    textColor: "{colors.dark-text-soft}"
    typography: "{typography.small}"
  kit-input-dark:
    backgroundColor: "{colors.dark-bg-sunken}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.md}"
  kit-modal-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.xl}"
  kit-banner-success-dark:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.success-dark}"
  kit-banner-warning-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.warning-dark}"
  kit-btn-accent-text:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.accent-text}"
    typography: "{typography.body-strong}"
  kit-icon-brand:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.brand}"
  kit-icon-accent-midnight:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.accent-midnight}"
  kit-avatar-amber:
    backgroundColor: "{colors.c-amber}"
    rounded: "{rounded.sm}"
  kit-avatar-forest:
    backgroundColor: "{colors.c-forest}"
  kit-avatar-indigo:
    backgroundColor: "{colors.c-indigo}"
  kit-avatar-ochre:
    backgroundColor: "{colors.c-ochre}"
  kit-avatar-rose:
    backgroundColor: "{colors.c-rose}"
  kit-avatar-slate:
    backgroundColor: "{colors.c-slate}"
  kit-avatar-teal:
    backgroundColor: "{colors.c-teal}"
  kit-avatar-violet:
    backgroundColor: "{colors.c-violet}"
  kit-scrim:
    backgroundColor: "{colors.light-scrim}"
    textColor: "{colors.light-text-inv}"
  kit-avatar-fallback:
    backgroundColor: "{colors.c-slate}"
    textColor: "{colors.light-text-inv}"
    rounded: "{rounded.sm}"
  kit-scrim-dark:
    backgroundColor: "{colors.dark-scrim}"
    textColor: "{colors.dark-text}"
  kit-skeleton:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text-ghost}"
    rounded: "{rounded.sm}"
  kit-hairline:
    backgroundColor: "{colors.light-line}"
    height: 1px
  kit-hairline-strong:
    backgroundColor: "{colors.light-line-strong}"
    height: 1px
  kit-hairline-dark:
    backgroundColor: "{colors.dark-line}"
    height: 1px
  kit-hairline-strong-dark:
    backgroundColor: "{colors.dark-line-strong}"
    height: 1px
  kit-app-wall:
    backgroundColor: "{colors.light-bg-wall}"
    textColor: "{colors.light-text}"
  kit-app-shell:
    backgroundColor: "{colors.light-bg-app}"
    textColor: "{colors.light-text}"
  kit-app-shell-dark:
    backgroundColor: "{colors.dark-bg-app}"
    textColor: "{colors.dark-text}"
  kit-ghost-rule:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.dark-text-ghost}"
  kit-faint-meta:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.dark-text-faint}"
---

# DESIGN.md — Centraid

Machine-readable design brief for AI coding agents, in the [getdesign.md](https://getdesign.md/) format — token front matter plus the reasoning behind it, in one root file. Conformance to the official spec is enforced by `bun run lint:design-md` (the `@google/design.md` linter); the truth of the values is enforced against the TypeScript source by [packages/design/src/design-md.test.ts](packages/design/src/design-md.test.ts).

This is a **brief**, not the spec. Depth lives in [docs/design-language.md](docs/design-language.md) (the prose rulebook), [packages/design/src/contract.ts](packages/design/src/contract.ts) (the enforced token vocabulary), and [docs/traps/design-tokens.md](docs/traps/design-tokens.md) (how agents get this wrong). If you change a token, change this file in the same commit.

## Overview

**Field notebook.** Calm, instrument-grade, personal. The product is where someone keeps their own life's data, so the chrome recedes and the data reads.

- **Neutrals do the work.** Hierarchy is type, spacing, and hairlines — not color.
- **One structural accent.** The accent marks state, selection, and the single primary action on a surface. Never decoration, never a second brand, never a gradient.
- **Hard-edged geometry.** Centraid is an instrument, not a pillow.
- **Contrast is measured, not eyeballed.** Every ink and status rung below carries the ratio it was tuned to.
- **Motion is confirmation, not entertainment.**

### The platform analogy

`packages/design` is one package with two layers, and reads as a small operating system:

| Layer | Analogy | What it is |
| --- | --- | --- |
| Token contract (`src/contract.ts`) | the OS | the only public vocabulary of semantic roles |
| Kit (`kit/kit.css`, `kit/elements.js`) | the system UI framework | the served substrate — `.kit-*` classes and `<kit-*>` elements, holding **no design decisions of its own** |
| `toBlueprintCss()` | the app SDK | what a sandboxed blueprint app is handed |

### Rules (binding)

1. Use tokens. No hex, `rgb()`, or `hsl()` literal in client, kit, or app CSS. A value with no token belongs in `packages/design/src`, and its name in `src/contract.ts`.
2. Never declare a new `--name` in app CSS or `kit.css`. New names go in the contract.
3. Never set `font-family` in app or kit CSS. Token stacks own type.
4. Spacing comes from `--sp-1`…`--sp-7`. A gutter off the scale is a bug, not a nuance.
5. `--t-*` are CSS `font` **shorthands**. Write `font: var(--t-body)`; `font-size: var(--t-body)` silently drops everything.
6. `--text-inv` is _inverse_ ink for filled/accent surfaces — not "invalid".
7. Every animation needs a `prefers-reduced-motion: reduce` branch that removes movement, not merely shortens it.
8. Deep-importing `@centraid/design/src/...` is forbidden — use the barrel.

### Front-matter naming

The front matter is one flat namespace, so the two themes are prefixed `light-*` and `dark-*`; in CSS these are the same token names (`--bg`, `--text`, …) resolved per theme. `primary` is an alias for `brand` — Centraid has exactly one structural accent. Component entries are the kit's class families, `*-dark` suffixed where a family's contrast pair differs by theme.

## Colors

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

**Known finding.** `bun run lint:design-md` reports two `contrast-ratio` warnings against `kit-btn-primary` and `kit-btn-primary-hover`: `--on-accent` is `#FFFFFF` (see `src/blueprint.ts`), which lands at 3.04:1 on `--accent-deep` and 2.07:1 on `--accent`. That is a real gap, not a modelling artefact — the filled primary button is the one place the accent carries text. It is left visible rather than papered over; the fix is a deepened `--on-accent` or a deepened accent fill, tracked as a design-token debt item. Warnings do not fail the gate; errors do.

### Semantic states

Not accents; never used for emphasis.

| Role        | Dark      | Light     | Measured                |
| ----------- | --------- | --------- | ----------------------- |
| `--success` | `#5C8A4E` | `#456B39` | 4.8:1 dark, 6.0:1 light |
| `--danger`  | `#C44A4A` | `#C44A4A` | clears AA on both ramps |
| `--warning` | `#E0A94A` | `#9A6B1F` | 9.2:1 dark, 4.6:1 light |

### App-icon palette

Eight saturated hues that read on graphite, exposed as `--c-<name>`: `amber #E89A3C` · `forest #5C8A4E` · `indigo #4E68DD` · `ochre #B47B3F` · `rose #E55772` · `slate #5C677D` · `teal #2EA098` · `violet #7C5BD9`.

These are icon fills, not text surfaces — the `kit-avatar-*` component entries carry `backgroundColor` only. An avatar that must render initials uses `kit-avatar-fallback` (slate + inverse ink), the one pairing tuned to clear AA.

### Surfaces and ink

Exactly two themes, `light` and `dark`; a registry key must equal its `kind`. There is one dark ramp, anchored on a single knob `--bg-l: 5%` — every dark surface is `hsl(0 0% calc(var(--bg-l) ± n))`, so moving one number retunes the whole ramp.

Ink descends `--text` → `--text-soft` → `--text-faint` → `--text-ghost`. These are `color:` on real prose, so each rung clears a floor against the lightest surface it can land on. Light theme, measured against `--bg`: **text 17.6:1, soft 8.8:1, faint 5.0:1, ghost 3.2:1**. Surfaces: `--bg`, `--bg-app`, `--bg-elev` (raised fill), `--bg-sunken` (recessed/track), `--bg-wall`. Hairlines: `--line`, `--line-strong`.

`--text-ghost` and the hairline tokens are structural, not prose — they carry borders, tracks, and disabled glyphs, so they answer to the 3:1 non-text floor rather than 4.5:1.

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

`display` and `sans` both resolve to `system-ui` today — they are distinct **roles**, so a surface may rebind one without the other; the front matter records the face each role currently carries.

Marketing/hero styles (`--t-display-1` 40, `--t-h2` 22, `--t-h3` 16) are **web-only, outside the chrome**, and are the single place weight 700 appears. They are not part of the chrome token set and so are not in the front matter.

**Mono is the signature.** Metadata, counts, dates, and eyebrows are mono; prose is not.

## Layout

`--sp-1`…`--sp-7` = **4 · 8 · 12 · 16 · 24 · 32 · 48** px. Emitted identically by `toCss()` and `toBlueprintCss()` from `src/density.ts`, and typed for mobile as `spacing`. The scale is fixed — there is no density switch on the token layer, and these are the only rungs.

Layout is a single-column reading surface plus chrome: `kit-app-side` (navigation), `kit-app-topbar` (context), and the content pane. Gutters step the scale, they do not interpolate: `--sp-3` inside a control, `--sp-4` between controls, `--sp-5` between sections.

## Elevation & Depth

Hairline borders separate; shadows lift sparingly. Three rungs only: `--shadow-sm`, `--shadow-md`, `--shadow-lg`. No heavy strokes, no drop-shadow stacks.

Depth reads through surface lightness before it reads through shadow: `--bg-sunken` recesses, `--bg-elev` raises, and only detached surfaces (popover, modal, toast) take a shadow at all.

### Motion

- One curve for the whole product: **`--ease: cubic-bezier(0.2, 0.7, 0.3, 1)`** — a calm, instrument-grade ease-out. The literal lives in `src/motion.ts` and nowhere else.
- **Standard transitions ≤ 200ms.** Anything longer needs a reason a member could name.
- Motion animates state changes and entrances. Nothing loops; nothing draws attention to itself while idle.

## Shapes

`--r-xs` 2 · `--r-sm` 4 · `--r-md` 6 · `--r-lg` 10 · `--r-xl` 14 (px).

Components live between 6–14px. Only sheets and modals soften past `xl`, composed inline (`var(--r-xl)` plus a pill on FABs). Nothing is fully rounded except an avatar or a FAB — hard-edged geometry is the identity.

## Components

Canonical and only copy of the kit: `packages/design/kit/kit.css`. Apps do not carry their own copies. The layer model is in [Overview](#the-platform-analogy).

**Class families** (compose, do not fork): `kit-app-*` (shell, side, topbar, brand), `kit-ask-*` (the assistant panel), `kit-msg-*`, `kit-btn`, `kit-input`, `kit-chip`, `kit-seg`, `kit-search`, `kit-popover`, `kit-modal`, `kit-banner`, `kit-empty`, `kit-icon`, `kit-toast(s)`, `kit-attach-*`, `kit-ref-*`, `kit-mention-*`, `kit-chart-*`, `kit-skeleton`, `kit-avatar`.

**Custom elements**: `<kit-avatar>`, `<kit-bar-chart>`, `<kit-line-chart>`, `<kit-mention-chip>`, `<kit-meter>`, `<kit-reference-strip>`, `<kit-skeleton>`, `<kit-toast>`.

**Tokens every `app.css` MUST define**: `--bg-elev`, `--line`, `--text`, `--text-soft`, `--accent`. Optional, degrading gracefully when absent: `--bg-sunken`, `--line-strong`, `--text-faint`, `--radius`, `--shadow-md`, `--accent-soft`.

The `components:` front matter is a representative slice, not the full kit — it records the contrast pair, type role, radius, and padding rung each family binds, so an agent can check its own work without reading `kit.css`.

## Do's and Don'ts

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

### References

- [docs/design-language.md](docs/design-language.md) — the binding prose rulebook
- [docs/traps/design-tokens.md](docs/traps/design-tokens.md) — source of truth vs hardcoded CSS
- [packages/design/src/contract.ts](packages/design/src/contract.ts) — enforced token vocabulary
- [packages/client/src/react/CSS-CONVENTIONS.md](packages/client/src/react/CSS-CONVENTIONS.md) — renderer CSS-Modules rules
- [packages/gateway/src/skills/ui-grounding.ts](packages/gateway/src/skills/ui-grounding.ts) — how this contract reaches app-authoring agents
