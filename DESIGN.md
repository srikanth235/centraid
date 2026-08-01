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
  accent-deep: "#22776B"
  accent-deep-dark: "#34B7A4"
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

  # …and the same eight as TEXT. The fills above are 2.2:1 (`c-amber`) to
  # 4.8:1 (`c-indigo`) as `color:` on a near-white surface, so a hue on type
  # reads this solved rung instead — `--c-<name>-text`, deepened on light and
  # lifted on dark by the same solver `accent-text` uses.
  c-amber-text: "#8f5611"
  c-forest-text: "#46693c"
  c-indigo-text: "#3452d8"
  c-ochre-text: "#83592e"
  c-rose-text: "#b91d3a"
  c-slate-text: "#535d71"
  c-teal-text: "#1f6d67"
  c-violet-text: "#6842d3"
  c-amber-text-dark: "#eba653"
  c-forest-text-dark: "#8eb881"
  c-indigo-text-dark: "#97a6eb"
  c-ochre-text-dark: "#d0a679"
  c-rose-text-dark: "#ee90a2"
  c-slate-text-dark: "#a3abbb"
  c-teal-text-dark: "#38c4ba"
  c-violet-text-dark: "#b4a1e9"

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
    textColor: "{colors.light-text-inv}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.2}"
  kit-btn-primary-hover:
    backgroundColor: "{colors.accent-deep}"
    textColor: "{colors.light-text-inv}"
  kit-btn-primary-dark:
    backgroundColor: "{colors.accent-deep-dark}"
    textColor: "{colors.dark-text-inv}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.2}"
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
  c-amber-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-amber-text}"
    typography: "{typography.body-strong}"
  c-forest-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-forest-text}"
    typography: "{typography.body-strong}"
  c-indigo-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-indigo-text}"
    typography: "{typography.body-strong}"
  c-ochre-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-ochre-text}"
    typography: "{typography.body-strong}"
  c-rose-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-rose-text}"
    typography: "{typography.body-strong}"
  c-slate-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-slate-text}"
    typography: "{typography.body-strong}"
  c-teal-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-teal-text}"
    typography: "{typography.body-strong}"
  c-violet-on-elev:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.c-violet-text}"
    typography: "{typography.body-strong}"
  c-amber-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-amber-text-dark}"
    typography: "{typography.body-strong}"
  c-forest-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-forest-text-dark}"
    typography: "{typography.body-strong}"
  c-indigo-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-indigo-text-dark}"
    typography: "{typography.body-strong}"
  c-ochre-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-ochre-text-dark}"
    typography: "{typography.body-strong}"
  c-rose-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-rose-text-dark}"
    typography: "{typography.body-strong}"
  c-slate-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-slate-text-dark}"
    typography: "{typography.body-strong}"
  c-teal-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-teal-text-dark}"
    typography: "{typography.body-strong}"
  c-violet-on-elev-dark:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.c-violet-text-dark}"
    typography: "{typography.body-strong}"
  kit-chart-series:
    backgroundColor: "{colors.accent}"
  kit-media-stage:
    backgroundColor: "{colors.dark-bg-app}"
    textColor: "{colors.on-accent}"
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

Machine-readable design brief for AI coding agents, in the [design.md](https://github.com/google-labs-code/design.md) format — token front matter plus the reasoning behind it, in one root file. Conformance to the official spec is enforced by `bun run lint:design-md` (the `@google/design.md` linter); the truth of the values is enforced against the TypeScript source by [packages/design/src/design-md.test.ts](packages/design/src/design-md.test.ts).

This is the **canonical design document** — the binding rulebook and the machine-readable brief in one file (docs/design-language.md was folded in here, #686). Implementation depth lives in [packages/design/src/contract.ts](packages/design/src/contract.ts) (the enforced token vocabulary) and [docs/traps/design-tokens.md](docs/traps/design-tokens.md) (how agents get this wrong). If you change a token, change this file in the same commit.

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

`toCss()` is the shell's own emit (desktop + web). `toBlueprintCss()` is the app surface's emit **and** the source mobile lowers from (`apps/mobile/scripts/generate-theme.ts` → `src/kit/theme/tokens.generated.ts`). One source, three lowerings.

### Rules (binding)

1. Use tokens. No hex, `rgb()`, or `hsl()` literal in client, kit, or app CSS. A value with no token belongs in `packages/design/src`, and its name in `src/contract.ts`.
2. Never declare a new `--name` in app CSS or `kit.css`. New names go in the contract.
3. Never set `font-family` in app or kit CSS. Token stacks own type.
4. Spacing comes from `--sp-1`…`--sp-7`. A gutter off the scale is a bug, not a nuance.
5. `--t-*` are CSS `font` **shorthands**. Write `font: var(--t-body)`; `font-size: var(--t-body)` silently drops everything. A shorthand also resets `font-family` — override the family before the shorthand, never after.
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
| `--accent-deep` | `#22776B` light / `#34B7A4` dark | the accent as a FILLED surface — primary button, brand mark, pressed chip. Carries `--text-inv`, so it is solved per theme rather than picked: 4.91:1 and 7.16:1. |
| `--accent-midnight` | `#12645A` | deepest rung |
| `--accent-text` | `#0F7A6C` (light theme) | brand-as-text; raw brand is 2.0:1 on near-white and fails at any size. 5.1:1 on `--bg`. |

Derive tints with `accentRamp()`. Do not hand-pick — `deep` and `text` are **solved** rungs (`accentFillShade()` / `accentTextShade()` in `src/color.ts`), each walking the base down its own hue to the lightest shade that clears its floor, so an owner-picked accent gets a legible button and a legible link for free.

**Two inks, two roles.** `--text-inv` is the ink on a `--accent-deep` fill; it flips per theme (`#F4F5F7` / `#141820`), which is why the fill flips with it. `--on-accent` is the fixed white for a _saturated_ accent or a scrim — a photo lightbox, a `--accent` badge — surfaces that are dark in both themes. They are not interchangeable.

**Fixed: the filled primary button (#686 F3).** `--accent-deep` used to be a lightness nudge off brand (`#2AA593`) painted under `--on-accent: #FFFFFF`, which measured **3.04:1** at rest and **2.07:1** on hover — a WCAG 1.4.3 failure the `@google/design.md` linter surfaced, and worse on the app surface, where `--accent-deep` was a `color-mix()` over a runtime hue and fell to **3.49:1** under `--c-amber` and **1.98:1** in dark.

A fixed ink cannot be right for every hue (amber wants dark ink, violet wants light) and CSS has no shipped way to choose one — `color-contrast()` is unimplemented, `color-mix()` cannot branch. So the **fill** moved, per theme, and the button's ink became `--text-inv`, which already flips. The shell rungs are solved in TypeScript; the app rungs are the same `color-mix()` machinery retuned (`62%` accent over a near-black hue anchor on light, `70%` under a near-white one on dark). Hover no longer brightens: it steps the fill 12% toward `--text`, i.e. always _away_ from its own ink, so a hover can only raise the ratio.

Measured against the ink each surface actually carries — `packages/design/src/contrast.test.ts` recomputes this grid from the emitted CSS on every run:

| Accent               | Light fill | rest  | hover | Dark fill | rest | hover |
| -------------------- | ---------- | ----- | ----- | --------- | ---- | ----- |
| brand / default teal | `#2A7E71`  | 4.86  | 5.68  | `#81D8C8` | 9.05 | 9.49  |
| `--c-amber`          | `#906128`  | 5.35  | 6.16  | `#EFB67A` | 8.55 | 9.06  |
| `--c-forest`         | `#3B5A31`  | 7.80  | 8.61  | `#88AB7D` | 5.88 | 6.54  |
| `--c-indigo`         | `#31428A`  | 9.22  | 10.10 | `#7A93E9` | 5.49 | 6.22  |
| `--c-ochre`          | `#724F29`  | 7.33  | 8.17  | `#CA9F75` | 6.41 | 7.09  |
| `--c-rose`           | `#8E3747`  | 7.53  | 8.45  | `#F08897` | 6.63 | 7.33  |
| `--c-slate`          | `#394253`  | 10.11 | 10.90 | `#858FA1` | 4.89 | 5.62  |
| `--c-teal`           | `#206762`  | 6.61  | 7.38  | `#73BBB4` | 6.83 | 7.48  |
| `--c-violet`         | `#4D3988`  | 9.31  | 10.18 | `#9C89E6` | 5.51 | 6.23  |
| shell chrome         | `#22776B`  | 4.91  | 5.82  | `#34B7A4` | 7.16 | 7.92  |

Every cell clears 4.5:1, the binding hues are the brand teal on light (4.86) and `--c-slate` on dark (4.89), and no fill exceeds 11:1 — the guard that stops "darken until it passes" from turning every button black. Each fill also clears 3:1 against the card behind it (4.7:1 at worst), which is why the dark ramp lifts rather than deepens: on a 15%-lightness surface, "dark enough for white ink" and "separated from the background" have no overlap.

### Semantic states

Not accents; never used for emphasis.

| Role        | Dark      | Light     | Measured                |
| ----------- | --------- | --------- | ----------------------- |
| `--success` | `#5C8A4E` | `#456B39` | 4.8:1 dark, 6.0:1 light |
| `--danger`  | `#C44A4A` | `#C44A4A` | clears AA on both ramps |
| `--warning` | `#E0A94A` | `#9A6B1F` | 9.2:1 dark, 4.6:1 light |

### App-icon palette

Eight saturated hues that read on graphite, exposed as `--c-<name>`: `amber #E89A3C` · `forest #5C8A4E` · `indigo #4E68DD` · `ochre #B47B3F` · `rose #E55772` · `slate #5C677D` · `teal #2EA098` · `violet #7C5BD9`.

`kit-chart-series` is the same kind of entry: `--accent` painted as an SVG mark (`.kit-chart-barrect`, `.kit-chart-line`), never as a text surface. `kit-media-stage` is the one place `--on-accent` is recorded — a photo lightbox or slideshow is a fixed near-black stage in both themes, so its chrome takes the fixed white rather than the theme's inverse ink.

These are icon fills, not text surfaces — the `kit-avatar-*` component entries carry `backgroundColor` only. An avatar that must render initials uses `kit-avatar-fallback` (slate + inverse ink), the one pairing tuned to clear AA.

**A palette hue on type reads `--c-<name>-text`, never `--c-<name>`.** As `color:` on a near-white surface the fills measure **2.2:1** (`--c-amber`) to 4.8:1 (`--c-indigo`) — the same problem `--accent-text` exists to solve for the accent, and until #686 the palette had no equivalent rung. So every surface that wanted a hue on type hand-picked a deeper literal of its own, and when the #686 burn-down replaced those literals with the raw fills the contrast they had been quietly carrying went with them: the `docs` file-kind labels fell from 4.80–5.82:1 to **2.24–4.71:1**, five of six below AA.

`--c-<name>-text` is that missing rung, solved by the same machinery as `--accent-text` (`src/color.ts`) and emitted by **both** emitters, per theme — deepened under a light surface, lifted under a dark one, hue and saturation untouched. It is solved against the hardest surface either emitter ships _with a 12% wash of the hue itself on it_, because a palette hue on type is almost never on a bare surface: a coloured chip, badge, or thumbnail label sits on a weak tint of its own hue, which has already walked the background toward the ink. A bare surface is then strictly easier.

| Hue | Light text | worst | on its 12% tint | Dark text | worst | on its 12% tint |
| --- | --- | --- | --- | --- | --- | --- |
| `--c-amber` | `#8f5611` | 5.30 | 4.89 | `#eba653` | 6.02 | 4.90 |
| `--c-forest` | `#46693c` | 5.55 | 4.89 | `#8eb881` | 5.55 | 4.86 |
| `--c-indigo` | `#3452d8` | 5.56 | 4.81 | `#97a6eb` | 5.34 | 4.82 |
| `--c-ochre` | `#83592e` | 5.41 | 4.80 | `#d0a679` | 5.60 | 4.89 |
| `--c-rose` | `#b91d3a` | 5.63 | 4.95 | `#ee90a2` | 5.44 | 4.83 |
| `--c-slate` | `#535d71` | 5.86 | 5.01 | `#a3abbb` | 5.42 | 4.93 |
| `--c-teal` | `#1f6d67` | 5.40 | 4.81 | `#38c4ba` | 5.82 | 4.94 |
| `--c-violet` | `#6842d3` | 5.62 | 4.85 | `#b4a1e9` | 5.49 | 4.98 |

The `c-<hue>-on-elev` / `c-<hue>-on-elev-dark` component entries record the canonical pairing — the rung on a raised card — the same way `kit-avatar-*` records the fills' pairing.

The solve moves **lightness only**. That is the guard against "darken it until it passes": let it desaturate and eight hues converge on one grey that clears every floor and codes nothing. What it cannot promise is that any two hues stay apart — `ochre` is `amber` at lower chroma, so solving both to one floor collapses them from 0.125 to 0.028 in oklab, and a surface that colour-codes a _set_ must pick hues that survive it (the `docs` app codes six file kinds and deliberately carries no amber/ochre pair).

### Surfaces and ink

Exactly two themes, `light` and `dark`; a registry key must equal its `kind`. There is one dark ramp, anchored on a single knob `--bg-l: 5%` — every dark surface is `hsl(0 0% calc(var(--bg-l) ± n))`, so moving one number retunes the whole ramp.

Ink descends `--text` → `--text-soft` → `--text-faint` → `--text-ghost`. These are `color:` on real prose, so each rung clears a floor against the lightest surface it can land on. Light theme, measured against `--bg`: **text 17.6:1, soft 8.8:1, faint 5.0:1, ghost 3.2:1**. Surfaces: `--bg`, `--bg-app`, `--bg-elev` (raised fill), `--bg-sunken` (recessed/track), `--bg-wall`. Hairlines: `--line`, `--line-strong`.

`--text-ghost` and the hairline tokens are structural, not prose — they carry borders, tracks, and disabled glyphs, so they answer to the 3:1 non-text floor rather than 4.5:1.

Blueprint apps express identity by moving **`--app-hue`** (default `171`) — their neutrals are `hsl(var(--app-hue) …)`. An app does not redefine a palette.

## Typography

**Roles, not families.** The contract names `sans`, `display`, `mono` (plus `serif` on the blueprint surface); surfaces bind roles to faces and never introduce a role. Web and desktop use **system stacks only** — `system-ui` for sans/display, `ui-monospace` for mono. No webfont family first; the chrome never blocks on a network font fetch (#468 K11). Mobile maps the same roles to loaded platform faces because RN cannot combine `fontFamily` with `fontWeight` (see the #686 entry in [docs/decisions.md](docs/decisions.md)).

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

- One curve for the whole product: **`--ease: cubic-bezier(0.2, 0.7, 0.3, 1)`** — a calm, instrument-grade ease-out. The literal lives in `src/themes/shared.ts` and nowhere else.
- **Standard transitions ≤ 200ms.** Anything longer needs a reason a member could name.
- Motion animates state changes and entrances. Nothing loops; nothing draws attention to itself while idle.

## Shapes

`--r-xs` 2 · `--r-sm` 4 · `--r-md` 6 · `--r-lg` 10 · `--r-xl` 14 (px).

Components live between 6–14px. Only sheets and modals soften past `xl`, composed inline (`var(--r-xl)` plus a pill on FABs). Nothing is fully rounded except an avatar or a FAB — hard-edged geometry is the identity.

## Components

Canonical and only copy of the kit: `packages/design/kit/kit.css`. Apps do not carry their own copies. The layer model is in [Overview](#the-platform-analogy).

**Class families** (compose, do not fork): `kit-app-*` (shell, side, topbar, brand), `kit-ask-*` (the assistant panel), `kit-msg-*`, `kit-btn`, `kit-input`, `kit-chip`, `kit-seg`, `kit-search`, `kit-popover`, `kit-modal`, `kit-banner`, `kit-empty`, `kit-icon`, `kit-toast(s)`, `kit-attach-*`, `kit-ref-*`, `kit-mention-*`, `kit-chart-*`, `kit-skeleton`, `kit-avatar`.

**Custom elements**: `<kit-avatar>`, `<kit-bar-chart>`, `<kit-line-chart>`, `<kit-mention-chip>`, `<kit-meter>`, `<kit-reference-strip>`, `<kit-skeleton>`, `<kit-toast>`.

**Tokens every `app.css` MUST define**: `--bg-elev`, `--line`, `--text`, `--text-inv`, `--text-soft`, `--accent`. Optional, degrading gracefully when absent: `--bg-sunken`, `--line-strong`, `--text-faint`, `--radius`, `--shadow-md`, `--accent-soft`.

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

- [docs/traps/design-tokens.md](docs/traps/design-tokens.md) — source of truth vs hardcoded CSS
- [packages/design/src/contract.ts](packages/design/src/contract.ts) — enforced token vocabulary
- [packages/client/src/react/CSS-CONVENTIONS.md](packages/client/src/react/CSS-CONVENTIONS.md) — renderer CSS-Modules rules
- [packages/gateway/src/skills/ui-grounding.ts](packages/gateway/src/skills/ui-grounding.ts) — how this contract reaches app-authoring agents
