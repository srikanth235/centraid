---
version: alpha
name: Centraid
description: >-
  Product grammar for Centraid's desktop shell, compact shell, blueprint apps, served apps, and native mobile surfaces. Values are pinned to packages/design/src.
colors:
  primary: "{colors.brand}"
  brand: "#3EC8B4"
  accent: "#3EC8B4"
  accent-light: "#62D6C6"
  accent-deep: "#22776B"
  accent-deep-dark: "#34B7A4"
  accent-text: "#0F7A6C"
  accent-soft: "rgba(62,200,180,.12)"
  success: "#436837"
  success-dark: "#6ba15b"
  danger: "#a53636"
  danger-dark: "#d37878"
  warning: "#7c5619"
  warning-dark: "#e0a94a"
  c-amber: "#E89A3C"
  c-forest: "#5C8A4E"
  c-indigo: "#4E68DD"
  c-ochre: "#B47B3F"
  c-rose: "#E55772"
  c-slate: "#5C677D"
  c-teal: "#2EA098"
  c-violet: "#7C5BD9"
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
  light-bg: "#FCFCFC"
  light-bg-app: "#FFFFFF"
  light-bg-elev: "#FFFFFF"
  light-bg-sunken: "#F0F1F3"
  light-text: "#14161B"
  light-text-soft: "rgba(20,22,27,0.78)"
  light-text-faint: "rgba(20,22,27,0.62)"
  light-text-ghost: "rgba(20,22,27,0.48)"
  light-text-inv: "#F4F5F7"
  light-line: "rgba(20,22,27,0.11)"
  light-line-strong: "rgba(20,22,27,0.20)"
  dark-bg: "#0D0D0D"
  dark-bg-app: "#000000"
  dark-bg-elev: "#1A1A1A"
  dark-bg-sunken: "#050505"
  dark-text: "#ECEEF2"
  dark-text-soft: "rgba(236,238,242,0.72)"
  dark-text-faint: "rgba(236,238,242,0.52)"
  dark-text-ghost: "rgba(236,238,242,0.38)"
  dark-text-inv: "#141820"
  dark-line: "rgba(220,230,245,0.08)"
  dark-line-strong: "rgba(220,230,245,0.16)"
typography:
  display:
    fontFamily: "system-ui"
    fontSize: "28px"
    fontWeight: "600"
    lineHeight: "34px"
  title:
    fontFamily: "system-ui"
    fontSize: "20px"
    fontWeight: "600"
    lineHeight: "26px"
  body:
    fontFamily: "system-ui"
    fontSize: "15px"
    fontWeight: "400"
    lineHeight: "22px"
  body-strong:
    fontFamily: "system-ui"
    fontSize: "15px"
    fontWeight: "600"
    lineHeight: "22px"
  small:
    fontFamily: "system-ui"
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "18px"
  small-strong:
    fontFamily: "system-ui"
    fontSize: "13px"
    fontWeight: "600"
    lineHeight: "18px"
  mono:
    fontFamily: "ui-monospace"
    fontSize: "12px"
    fontWeight: "500"
    lineHeight: "16px"
  control:
    fontFamily: "system-ui"
    fontSize: "11px"
    fontWeight: "500"
    lineHeight: "14px"
  eyebrow:
    fontFamily: "ui-monospace"
    fontSize: "10px"
    fontWeight: "600"
    lineHeight: "13px"
  hero:
    fontFamily: "system-ui"
    fontSize: "40px"
    fontWeight: "600"
    lineHeight: "44px"
  greeting:
    fontFamily: "ui-serif"
    fontSize: "28px"
    fontWeight: "600"
    lineHeight: "34px"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
components:
  Button:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  Button-primary:
    backgroundColor: "{colors.accent-deep}"
    textColor: "{colors.light-text-inv}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  Button-secondary:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Button-quiet:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-soft}"
    rounded: "{rounded.md}"
  Button-destructive:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  Button-destructiveFilled:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.light-text-inv}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  IconButton:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  TextField:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  Search:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  Surface:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
  ListRow:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    padding: "{spacing.4}"
  Chip:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  Badge:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  Segmented:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Dialog:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.5}"
  Sheet:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.5}"
  Toast:
    backgroundColor: "{colors.dark-bg-elev}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.4}"
  Banner:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Empty:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-faint}"
    typography: "{typography.small}"
  Loading:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
  Error:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  AppTile:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.xl}"
  AppHeader:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    typography: "{typography.title}"
  Nav:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-soft}"
  Switch:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
  Checkbox:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.xs}"
  Select:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  DateTimeField:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Tooltip:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.xs}"
    padding: "{spacing.2}"
  Progress:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
  Avatar:
    backgroundColor: "{colors.c-slate}"
    textColor: "{colors.light-text-inv}"
    rounded: "{rounded.pill}"
---

# DESIGN.md — Centraid

This is the normative product constitution and the machine-readable design brief in the official [design.md](https://github.com/google-labs-code/design.md) format. Values in this file are pinned to [packages/design/src](packages/design/src) by the design-md tests; the official linter runs through `bun run lint:design-md`.

## Overview

Centraid is a calm field notebook for personal data. Neutrals do the work: hierarchy comes from type, spacing, surfaces, and hairlines. The product grammar is one semantic contract with three lowerings: shell CSS (`SH`/`SH-c`), blueprint CSS (`BI`/`BS`), and typed native (`MO`). A served blueprint and an inline blueprint are the same app contract; only the host boundary changes.

The five laws are binding:

1. A role is a name, meaning, and contrast obligation. A profile may omit only by declaring `unsupported` and a reason.
2. Accent is a word, not a slot. Centraid teal (`#3EC8B4`) owns action and selection; app identity is a separate hue.
3. Scarcity is visible: at most one accent-filled action is composed into a viewport, including host chrome. The default button is `secondary`, never accent-filled.
4. Containers follow interaction shape: a notification is a toast/banner; a decision is a dialog/sheet.
5. Fills publish their ink. A renderer never chooses foreground by guessing from a background.

## Colors

`--accent` is the product accent on all five surfaces. `--accent-fill` and `--accent-deep-hover` are solved fill roles paired with `--text-inv`; `--accent-text` is the solved text rung. `--accent-soft` is a wash only. App identity is `--app-identity`/`--app-hue` in blueprint surfaces and is not a second action accent.

The surface roles are `--bg`, `--bg-app`, `--bg-elev`, `--bg-sunken`, `--bg-wall`, `--bg-chrome`, `--bg-hud`, `--bg-hover`, `--bg-press`, and `--bg-sel`. The ink roles are `--text`, `--text-soft`, `--text-faint`, `--text-ghost`, `--text-inv`, `--on-accent`, and `--text-disabled`; fill roles publish their required ink. Lines are `--line`, `--line-strong`, and `--line-sel`. Focus is `--focus-ring` plus `--focus-ring-color` on web/blueprint; native owns its platform focus treatment.

The semantic states are `--success`, `--warning`, and `--danger`. Each has a light and dark solve and is tested against card, track, and its own wash. Status hue separation is measured in Oklab; a merely legible grey is not a status color. Disabled text uses `--text-disabled`; non-text disabled affordances use `--o-disabled: 0.45` once, never stacked opacity.

The role registry marks values as `literal`, `scalar`, `solved`, or `wash`; only adapters such as `--target-min` and `--bg-l` carry environment-dependent values. The shell dark ramp pins `--bg-l: 5%`; the blueprint dark ramp pins `--bg-l: 10%`. There is no alias layer. `--r-*`, `--sp-*`, and `--font-*` are shared names and values in the shell and blueprint emitters. Motion uses `--dur-1: 120ms` and `--dur-2: 200ms`.

## Typography

Roles are not families. There is one face per genus: `system-ui` sans, `ui-serif` serif, and `ui-monospace` mono. Mobile maps those genera to loaded Geist, Playfair Display, and JetBrains Mono faces. The legacy marketing face and its 700 scale are retired.

| Role               | Size / line-height | Weight | Native delta |
| ------------------ | ------------------ | ------ | ------------ |
| `--t-display`      | 28 / 34            | 600    | +2 / +2      |
| `--t-title`        | 20 / 26            | 600    | +2 / +2      |
| `--t-body`         | 15 / 22            | 400    | +2 / +2      |
| `--t-body-strong`  | 15 / 22            | 600    | +2 / +2      |
| `--t-small`        | 13 / 18            | 400    | +2 / +2      |
| `--t-small-strong` | 13 / 18            | 600    | +2 / +2      |
| `--t-mono`         | 12 / 16            | 500    | +1 / +2      |
| `--t-control`      | 11 / 14            | 500    | +2 / +2      |
| `--t-eyebrow`      | 10 / 13            | 600    | +1 / +2      |
| `--t-hero`         | 40 / 44            | 600    | +2 / +2      |
| `--t-greeting`     | 28 / 34            | 600    | +2 / +2      |

Every `--t-*` is a `font` shorthand. The distinct composable size rungs are `--t-body-size` 15px, `--t-control-size` 11px, `--t-display-size` 28px, `--t-eyebrow-size` 10px, `--t-hero-size` 40px, `--t-mono-size` 12px, `--t-small-size` 13px, and `--t-title-size` 20px. `--t-body-strong-size` does not exist because it would duplicate the body rung. There are no line-height rungs. Native consumes the pre-lowered `nativeDelta`; it does not parse CSS or do runtime math. Text scaling and Dynamic Type may enlarge a role, never shrink below its accessibility floor.

## Layout

`--sp-1` 4px, `--sp-2` 8px, `--sp-3` 12px, `--sp-4` 16px, `--sp-5` 24px, `--sp-6` 32px, and `--sp-7` 48px are the one spacing scale. There is no density token. Radii are `--r-xs` 2px, `--r-sm` 4px, `--r-md` 6px, `--r-lg` 10px, `--r-xl` 14px, and `--r-pill` 999px. A container follows the interaction shape: reading surfaces stay hard-edged; a dialog/sheet composes `xl`; a chip/avatar/FAB composes `pill`.

The target-min adapter is 44px for coarse web and iOS, 48dp for Android, and 32px for fine-pointer web. Safe-area insets belong to the native renderer. Compact shell law begins at 720px; it changes navigation arrangement, not token meaning. Zoom, Dynamic Type, and reduced motion are required test axes.

## Elevation & Depth

`--bg-sunken` recesses, `--bg-elev` raises, and `--shadow-sm`/`--shadow-md`/`--shadow-lg` are used only for a meaningful elevation change. Glass is detached-host chrome (`--glass-film`/`--glass-sheen`) and never blueprint content. `--device-wall` is a wall composite, not a content surface. Motion uses one curve, `--ease: cubic-bezier(0.2, 0.7, 0.3, 1)`, and normal transitions stay at or below 200ms; reduced motion removes movement.

## Shapes

Geometry is an instrument, not a pillow: action controls use `md`, surfaces use `lg`/`xl`, chips and identity marks use `pill`. A shape does not decide semantics, and a renderer does not silently pick a radius because a component happens to be a card.

## Components

The Revision 3 recipe inventory is the contract: Button, IconButton, TextField, Search, Surface, ListRow, Chip, Badge, Segmented, Dialog, Sheet, Toast, Banner, Empty, Loading, Error, AppTile, AppHeader, Nav, Switch, Checkbox, Select, DateTimeField, Tooltip, Progress, and Avatar. Each recipe declares rest plus supported hover/pressed/focus/disabled/loading/invalid/selected/open states, capability (`web`, `blueprint`, `native`), and accessibility obligations. Segmented absorbs tabs; ListRow absorbs grip/reorder.

Button variants are exactly `primary`, `secondary`, `quiet`, `destructive`, and `destructiveFilled`. `primary` is accent fill with inverse ink; `secondary` is the default raised action; `quiet` has no fill; destructive variants use danger roles. All controls use `--target-min`, visible focus, and the recipe's duration. Haptics are a native moment channel, not a visual state. DateTimeField uses the native picker on mobile; Tooltip is supplemental and unsupported on native.

The three renderers are generated from the same recipe table: the kit renderer emits scoped CSS, the shell renderer emits the shared recipe CSS, and native composes typed recipe states. Kit primitives are recipe-derived; content remains app-owned. Inline apps scope under `:where(.centraid-inline-scope)` and served apps use the same recipe output. Freshness, CSS↔native, and scoped≡served tests are required.

One icon registry owns iconKey resolution for manifest, index, and app metadata. Components use semantic concepts (`back`, `close`, `ask`, `settings`, `add`, `trash`, `leave`, `up`) before concrete glyphs. Feather dictionaries, blueprint-local icon maps, and kit literals are not sources of truth. Identity uses one initials formatter and one identity-color resolver. Relative time and bytes use one formatter module.

## Responsive Behavior

The local responsive constitution is explicit: SH-c is the compact shell at 720px; BI/BS remain host-relative; MO uses safe-area-aware sheets and 44pt/48dp target floors. Layout may adapt, but role names, color meaning, type hierarchy, radii, spacing, icon keys, and action scarcity do not. Components must survive 200% zoom, Dynamic Type, reduced motion, coarse/fine pointers, keyboard focus, and light/dark themes.

## Agent Prompt Guide

When authoring an app, start with a recipe and a moment, then choose only roles from `packages/design/src/roles.ts`. Use `primary` once per viewport; use `secondary` for ordinary actions. Use `--accent-text` for accent text, `--text-inv` for published fills, and a status role only for status. Pick an iconKey from the shared registry. Use `formatRelativeTime`, `formatBytes`, `identityInitials`, and `identityColor`; do not write local copies. For an unsupported surface capability, state why in the recipe/profile matrix. Run `bun run check:pr`, the affected contract tests, and the screenshot lane before presenting work.

## Do's and Don'ts

Do use shared roles, recipes, icon keys, formatters, safe-area adapters, and generated lowerings. Do keep app identity separate from product accent. Do add a receipt and update the matching refactor progress log when a system fact changes.

Do not hardcode colors, font stacks, spacing, radii, icon dictionaries, or foreground choices. Do not add a new token in app CSS or kit CSS. Do not make a default button accent-filled, create a second accent, or use a toast as a decision container. Do not restore `--t-tiny`, `--lib-*`, `--font-title`, `--mono`, `--bezel*`, or `--accent-midnight` as compatibility aliases.

### References

- [packages/design/src/roles.ts](packages/design/src/roles.ts) — role registry and profile matrix
- [packages/design/src/recipes/index.ts](packages/design/src/recipes/index.ts) — Revision 3 recipes
- [packages/design/src/contract.ts](packages/design/src/contract.ts) — emitted property contracts
- [docs/traps/design-tokens.md](docs/traps/design-tokens.md) — source-of-truth trap
- [docs/refactors/product-grammar.md](docs/refactors/product-grammar.md) — migration safety argument and progress log
- `bun run lint:design-md` — official design.md validation
