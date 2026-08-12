---
version: alpha
name: Centraid
description: >-
  The Binding Layer: one ink-on-paper shell wrapping many first-party apps across a desktop shell, an installable web PWA, served blueprint apps, and native mobile. Values are pinned to packages/design/src.
colors:
  primary: "{colors.brand}"
  brand: "#141414"
  accent: "#141414"
  accent-dark: "#EDEDEC"
  accent-light: "#3D3D3B"
  accent-light-dark: "#C8C8C6"
  accent-deep: "#141414"
  accent-deep-dark: "#EDEDEC"
  accent-hover: "#000000"
  accent-hover-dark: "#FFFFFF"
  accent-text: "#141414"
  accent-text-dark: "#EDEDEC"
  accent-soft: "rgba(20,20,20,.08)"
  link: "#2D4BA8"
  link-dark: "#9DB0F0"
  net: "#9A3B2E"
  net-dark: "#E08878"
  stage: "#0B0B0B"
  on-stage: "#EDEDEC"
  stage-line: "#2A2A29"
  stage-sunken: "#1A1A19"
  ring: "#4A67C8"
  ring-dark: "#8098E8"
  success: "#3a6540"
  success-dark: "#7fb588"
  danger: "#9a3b2e"
  danger-dark: "#e08878"
  warning: "#7c5619"
  warning-dark: "#d9a75b"
  c-amber: "#904e46"
  c-forest: "#397247"
  c-indigo: "#635a93"
  c-ochre: "#845922"
  c-rose: "#8c4c61"
  c-slate: "#3e6596"
  c-teal: "#00707e"
  c-violet: "#7a5283"
  c-amber-dark: "#d78f85"
  c-forest-dark: "#7bb587"
  c-indigo-dark: "#a39bda"
  c-ochre-dark: "#c99b65"
  c-rose-dark: "#d48da2"
  c-slate-dark: "#7ea7dc"
  c-teal-dark: "#58b4c4"
  c-violet-dark: "#be92c8"
  c-amber-text: "#894a43"
  c-forest-text: "#346841"
  c-indigo-text: "#5f568d"
  c-ochre-text: "#7c5420"
  c-rose-text: "#894a5f"
  c-slate-text: "#3a5e8b"
  c-teal-text: "#006774"
  c-violet-text: "#744e7d"
  c-amber-text-dark: "#d78f85"
  c-forest-text-dark: "#7bb587"
  c-indigo-text-dark: "#a39bda"
  c-ochre-text-dark: "#c99b65"
  c-rose-text-dark: "#d48da2"
  c-slate-text-dark: "#7ea7dc"
  c-teal-text-dark: "#58b4c4"
  c-violet-text-dark: "#be92c8"
  light-bg: "#FDFDFC"
  light-bg-app: "#F0EFED"
  light-bg-elev: "#F5F4F2"
  light-bg-sunken: "#F9F8F6"
  light-text: "#141414"
  light-text-soft: "#4A4A48"
  light-text-faint: "#5A5A58"
  light-text-ghost: "#6C6C69"
  light-text-disabled: "#9C9C99"
  light-text-inv: "#FDFDFC"
  light-line: "#EFEEEB"
  light-line-strong: "#E5E4E1"
  dark-bg: "#0E0E0E"
  dark-bg-app: "#060606"
  dark-bg-elev: "#171716"
  dark-bg-sunken: "#121211"
  dark-text: "#EDEDEC"
  dark-text-soft: "#ADADAB"
  dark-text-faint: "#9A9A98"
  dark-text-ghost: "#878785"
  dark-text-disabled: "#565654"
  dark-text-inv: "#0E0E0E"
  dark-line: "#1B1B1A"
  dark-line-strong: "#232322"
  light-skel: "#E4E3E0"
  dark-skel: "#1E1E1D"
typography:
  display:
    fontFamily: "Source Serif 4"
    fontSize: "31px"
    fontWeight: "400"
    lineHeight: "36px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Instrument Sans"
    fontSize: "20px"
    fontWeight: "500"
    lineHeight: "26px"
  reading:
    fontFamily: "Source Serif 4"
    fontSize: "19px"
    fontWeight: "400"
    lineHeight: "31px"
  body:
    fontFamily: "Instrument Sans"
    fontSize: "15px"
    fontWeight: "400"
    lineHeight: "22px"
  body-strong:
    fontFamily: "Instrument Sans"
    fontSize: "15px"
    fontWeight: "500"
    lineHeight: "22px"
  small:
    fontFamily: "Instrument Sans"
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "19px"
  small-strong:
    fontFamily: "Instrument Sans"
    fontSize: "13px"
    fontWeight: "500"
    lineHeight: "19px"
  control:
    fontFamily: "Instrument Sans"
    fontSize: "11px"
    fontWeight: "500"
    lineHeight: "15px"
  eyebrow:
    fontFamily: "Instrument Sans"
    fontSize: "11px"
    fontWeight: "400"
    lineHeight: "15px"
    letterSpacing: "0.06em"
    textTransform: "uppercase"
  mono:
    fontFamily: "Instrument Sans"
    fontSize: "11px"
    fontWeight: "400"
    lineHeight: "15px"
    fontVariantNumeric: "tabular-nums"
rounded:
  xs: "0px"
  sm: "4px"
  md: "7px"
  lg: "12px"
  xl: "12px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
components:
  Button:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    typography: "{typography.small-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  Button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.light-text-inv}"
    typography: "{typography.small-strong}"
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
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.net}"
    rounded: "{rounded.md}"
  IconButton:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  TextField:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  Search:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Surface:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
  ListRow:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    padding: "{spacing.4}"
  Chip:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
  Badge:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.md}"
  Segmented:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Dialog:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.5}"
  Sheet:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
    padding: "{spacing.5}"
  StatusLine:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.mono}"
  Banner:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
  Empty:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text-faint}"
    typography: "{typography.small}"
  Loading:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text-soft}"
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
  Error:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  AppTile:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
  AppHeader:
    backgroundColor: "{colors.light-bg}"
    textColor: "{colors.light-text}"
    typography: "{typography.display}"
  Nav:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text-soft}"
  Switch:
    backgroundColor: "{colors.light-bg-sunken}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  Checkbox:
    backgroundColor: "{colors.light-bg-elev}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.sm}"
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
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
  Avatar:
    backgroundColor: "{colors.c-slate}"
    textColor: "{colors.light-text-inv}"
    rounded: "{rounded.pill}"
---

# DESIGN.md — Centraid

This is the normative product constitution and the machine-readable design brief in the official [design.md](https://github.com/google-labs-code/design.md) format. Values in this file are pinned to [packages/design/src](packages/design/src) by the design-md tests; the official linter runs through `bun run lint:design-md`.

## Overview

Centraid is a personal, local-first superapp: one shell wrapping many first-party apps whose content characters could not be more different — a photo grid wants to disappear behind imagery, a document wants reading comfort, an agenda wants dense scannable structure. They have to feel like rooms in one house, not separate products, while each app's content leads.

The answer is a **binding layer of five invariants**. Everything not named as an invariant is explicitly the app's own choice, and the freedom table below is as binding as the invariants are. That division is the system.

The product grammar is one semantic contract with three lowerings: shell CSS (`SH`/`SH-c`), blueprint CSS (`BI`/`BS`), and typed native (`MO`). A served blueprint and an inline blueprint are the same app contract; only the host boundary changes. A role is a name, a meaning, and a contrast obligation together — a profile may omit one only by declaring `unsupported` and a reason.

### The five invariants

1. **Navigation is the stem.** A reserved band 240px wide on the leading edge, or the bottom band on mobile. It holds which vault you are in and on which gateway, the Search control, the launcher, and a foot of All apps and Settings — and nothing else. It is never themed by an app, never scrolls away, and never changes width. It may be reclaimed outright (⌘B, persisted), which is a different thing from shrinking: hidden or full width, never an in-between, and never a drawer — no scrim, no float over the content, and nothing dismisses it for you. The compact band ignores the preference, because a phone with no way to move is not a phone. Its promise is "always the same distance from the reading edge" — not "from the left" — so every rule that positions it uses logical properties and it mirrors under RTL. The mobile band is capped at 5 apps plus More; a tab below 44px stops being a tap target, so the cap is a constraint and not a preference.
2. **One ramp, two faces.** Six sizes, two bundled faces, two weights. An app does **not** declare a register: the face a piece of text takes is a property of its **role**, not of the app it appears in. Serif is the reading role only — a document, a note, empty-state prose, a conflict excerpt; sans is everything else, in every app equally. Nothing falls below 11px, navigation labels never fall below `--text-soft`, and numerics are tabular in every app without exception.
3. **One control vocabulary, and the shell owns no colour.** Every control is ink on paper; commit is a filled ink button, never a hue. At most one filled ink element per view. Destructive is an **outlined** button in `--net`, never a fill. Actions live in bounded controls; where a control must be text it carries the ink step plus a hover ground plus a trailing arrow, because hover alone is nothing on a phone. One hue is reserved for prose links, selection and the focus ring, and it is never permitted on a control. State is never expressed with container `opacity` — a recessive state takes its own token on the leaf element.
4. **One spatial rhythm.** 4px base, scale 4 / 8 / 12 / 16 / 24 / 32. Control 34px, row 44px, segmented 28px, stem 240px. Density tiers scale row height and content padding only. Any text in a fixed-height container is line-clamped, never `overflow: hidden` — a clipped baseline reads as a rendering bug.
5. **One motion and feedback grammar.** Entry and settle at 280ms, a state change at 140ms, and state reported on one persistent status line rather than a toast. Never a spinner, a bounce, a parallax, a scale-on-hover, a red dot, a badge count, or a toast. `prefers-reduced-motion` is honoured in one global rule.

### What an app may set for itself

This list is as important as the invariants. An app that stays inside it needs no permission from the system, and an app that steps outside it is changing the product, not its own screen.

| Property | Freedom | Token |
| --- | --- | --- |
| Density tier | Free — comfortable, compact, or dense. Row height and content padding only. | `data-density` → `--density-row`, `--density-pad` |
| Layout | Free. Full-bleed grid, reading measure, 7-column table, message stack. No constraint. | — |
| Colour | One identity hue, in the icon chip and as a content marker. **Never on a control.** | `--app-hue`, `--app-identity`, `--c-*` |
| Surface | **FIXED — the one row here that is not a freedom.** One axis: pointer or touch. Width is a canvas, not a surface; a narrower stage carries no rules of its own, so there is no third set of values for an app to declare and no second word for the middle one. | `--target-min`, `--page-margin` |

The table lost two rows with v4s. **Primary register** is gone: the face follows the role, not the app, so there is no reading-or-scanning choice to declare and no `register` field on a manifest. **Surface tone** is gone: there is one ground per theme, `#FDFDFC` light and `#0E0E0E` dark, and the seam between two apps is a route change rather than a colour change. Neither is a setting an app may reach for by another name.

Everything else — control shape, ink ramp, hairlines, motion, the stem, the status line — belongs to the system.

### The brief-to-repo role mapping

The Binding Layer brief names its roles differently from this repo. The values poured into the existing registry names; there is **no alias layer**. This table is the mapping, once, so nobody has to re-derive it.

| Brief | Repo role | Note |
| --- | --- | --- |
| `ink` | `--text` | Primary ink; also `--accent`, because the accent IS the ink. |
| `ink2` | `--text-soft` | Secondary ink and inactive navigation labels. |
| `ink3` | `--text-faint` | Validated against the deepest surface in the system, not against `--bg`. |
| `surf` | `--bg-elev` | Raised paper. Darker than the page in light, lighter in dark. |
| `line` | `--line-strong` | The brief's `line` is the EXPLICIT boundary, which is this repo's strong rung. |
| `lineS` | `--line` | The brief's hairline is this repo's light rung — the names already ordered this way. |
| `accent` | `--accent` | Ink. `--accent-fill`, `--accent-deep`, `--accent-deep-hover`, `--accent-text` and `--accent-soft` all resolve from it. |
| `onAccent` | `--text-inv` | The page colour, not pure white. |
| `link` | `--link` | New role. Prose links and selection only. |
| `ring` | `--focus-ring-color` | New value. 2px at a 2px offset via `--focus-ring`. |
| `net` | `--net` | New role. Borders and 2px rules only, never a fill. |

Retired with the flip: the teal brand hue, the five-accent `ACCENT_PALETTE` and the native `accentKey` parameter, the `--bg-l` dark-ramp anchor, `--t-hero`, `--t-greeting`, and the 48px spacing rung.

### The app identity hues

`oklch(0.50 0.09 h)` in light and `oklch(0.72 0.09 h)` in dark, resolved to sRGB hex at build time by `oklchToHex` in [packages/design/src/oklab.ts](packages/design/src/oklab.ts). One lightness and one chroma per theme, only the hue moves — which is what makes the hues equally loud and stops one app out-shouting another. A third-party hue is clamped to the same chroma and lightness before it is admitted.

| App    | Hue | Key      | App    | Hue | Key      |
| ------ | --- | -------- | ------ | --- | -------- |
| locker | 0   | `rose`   | docs   | 210 | `teal`   |
| photos | 28  | `amber`  | notes  | 255 | `slate`  |
| tasks  | 70  | `ochre`  | tally  | 290 | `indigo` |
| agenda | 150 | `forest` | people | 320 | `violet` |

Home takes no hue: it renders in `--text-soft`. Colour is never the only channel — every app mark is distinguishable by silhouette alone at 14px, which is what makes the hue system safe for colour-blind readers.

## Colors

**The shell spends no colour.** `--accent` is ink in both themes, and so are `--accent-fill`, `--accent-deep`, `--accent-text` and `--accent-light`. `--accent-deep-hover` steps the fill further FROM the ink it carries, so a hover can never reduce a label's contrast. `--accent-soft` is an 8% ink wash for hover ground, never a fill. If a hue ever reappears in this family, every app identity colour silently stops meaning "this belongs to that app".

Three hues are reserved and named. `--link` is prose links and text selection, and is never permitted on a control; `--bg-sel` and `--line-sel` are washes of it. `--focus-ring-color` is the ring. `--net` is "this leaves the device" — a border or a 2px rule, never a fill, because nothing alarming should be a large filled surface. `--danger` is solved from the same base as `--net` so a destructive action and a network egress read as one consequence.

`--stage` and `--on-stage` are the opaque media ground and its ink for a viewer, a slideshow, and an editor (the Photos v4 handoff, §2.2/§B) — `#0B0B0B` / `#EDEDEC`, **the same literal in both themes**, because the media ground does not follow the theme: a viewer that lightened under "light mode" would blow out the photograph it is framing. `--stage-line` (`#2A2A29`) is the hairline between chrome and media ON the stage, because `--line` is invisible against near-black. `--stage-sunken` (`#1A1A19`) is the recess cut INTO the stage — the media transport's unplayed track and any other trough whose fill is `--on-stage` — because `--bg-sunken` follows the PAGE and would punch a near-white hole in the media ground, while `--stage-line` is tuned to be seen as an edge where a trough is tuned to recede. `--skel` (`#E4E3E0` / `#1E1E1D`) is the ground a tile paints before its bytes arrive; `--bg-elev` reads as a card, and an absence is not a card, so a loading tile gets its own rung rather than borrowing one that implies content already landed. None of the three moves a token that existed before it, and none is a new hue.

The surface roles are `--bg`, `--bg-app`, `--bg-elev`, `--bg-sunken`, `--bg-wall`, `--bg-chrome`, `--bg-hud`, `--bg-hover`, `--bg-press`, and `--bg-sel`. **There is one page, and an app does not retune it.** A per-app surface-tone axis (`data-tone` → `--bg-tone-*`, five tones) shipped and was retired for two reasons, both measured: retuning `--bg` alone while `--bg-elev`/`--bg-sunken`/`--skel` stayed pinned inverted the paper metaphor — Photos drew cards LIGHTER than its page in light mode, where the system's rule is that raised paper is darker-in-light and lighter-in-dark — and, on device, four of the five tones sat within 0.7 L* of neutral while dark mode's whole spread was 2.4 L*, an axis nobody could perceive. If a page tone ever returns, it must carry its whole surface SET — page, elev, sunken, and skel together — never `--bg` alone. Surfaces are PAPER, not elevation: in light the raised surface is darker than the page, in dark it is lighter — a tile is a sheet laid on the page, not a plane floating above it.

The ink roles are `--text`, `--text-soft`, `--text-faint`, `--text-ghost`, `--text-inv`, `--on-accent`, and `--text-disabled`. **`--text-faint` is validated against the deepest surface in the system, not against `--bg`** — in dark every raised surface is lighter than the page, and in light `--bg-wall` is deeper than both, so measuring on the page alone guarantees a failure the moment text lands on a card. Lines are `--line` (hairline separators, tile borders), `--line-strong` (control borders, section rules), and `--line-sel`. Focus is `--focus-ring` plus `--focus-ring-color` on web and blueprint; native owns its platform focus treatment.

The semantic states are `--success`, `--warning`, and `--danger`. Each is solved per theme against the hardest surface it lands on AND against a 12% wash of itself; hue separation is measured in Oklab, so a merely legible grey is not a status colour. Disabled text uses `--text-disabled`; non-text disabled affordances use `--o-disabled: 0.45` once, on the LEAF, never on a container — opacity composites every descendant and silently invalidates token-level contrast.

The role registry marks values as `literal`, `scalar`, `solved`, or `wash`; only adapters such as `--target-min` carry environment-dependent values. Both ramps are literal: the `--bg-l` anchor retired because the Binding Layer's dark surfaces are warm-tinted paper, which a one-knob greyscale calc cannot express. There is no alias layer. `--r-*`, `--sp-*`, and `--font-*` are shared names and values in the shell and blueprint emitters.

## Typography

Roles are not families, and since v4s there are **two** faces, both shipped from the repo with no network fetch: `Instrument Sans` sans and `Source Serif 4` serif. `Instrument Serif` and `DM Mono` are withdrawn — display is the one serif, and numerics are the sans with `font-variant-numeric: tabular-nums` — which removes two font downloads from every first paint. A third family token, `--font-mono`, names the **platform** code stack (`ui-monospace, SFMono-Regular, Menlo, …`) and ships no bytes; it is reached only by code surfaces — the fenced-code highlighter, the builder's editor pane, a keyboard chip, a secret or a path shown verbatim — never by a numeric. Both bundled family tokens carry mandatory CJK fallbacks: neither face has CJK coverage, and without them the reading face silently drops to a UA default in the largest markets. Mobile maps those genera to loaded faces through the same names.

| Role | Brief role | Face | Size / line-height | Weight | Native delta |
| --- | --- | --- | --- | --- | --- |
| `--t-display` | Display | Source Serif 4 | 31 / 36, −0.01em | 400 | −4 / −4 |
| `--t-title` | (sanctioned intermediate) | Instrument Sans | 20 / 26 | 500 | +2 / +2 |
| `--t-reading` | Reading | Source Serif 4 | 19 / 31 | 400 | −1.5 / −2 |
| `--t-body` | Body | Instrument Sans | 15 / 22 | 400 | +2 / +2 |
| `--t-body-strong` | Body emphasis | Instrument Sans | 15 / 22 | 500 | +2 / +2 |
| `--t-small` | UI | Instrument Sans | 13 / 19 | 400 | +2 / +2 |
| `--t-small-strong` | UI | Instrument Sans | 13 / 19 | 500 | +2 / +2 |
| `--t-control` | Micro | Instrument Sans | 11 / 15 | 500 | +2 / +2 |
| `--t-eyebrow` | Micro caps | Instrument Sans | 11 / 15, +0.06em, uppercase | 400 | +2 / +2 |
| `--t-mono` | Numeric | Instrument Sans | 11 / 15, tabular-nums | 400 | +2 / +2 |

`--t-title` is the one role with no slot in the brief. It is kept deliberately: a section heading between the 31px display serif and the 15px body is real, and the alternative is every surface inventing one. Everything else is the brief's seven roles, with the two-weight pairs named from the prose side (`small`) and the control side (`small-strong`, `control`).

Link is not a size role: it inherits, takes `--link`, and is always underlined.

Every `--t-*` is a `font` shorthand, and the properties that shorthand cannot carry travel beside it as their own tokens rather than as decoration a stylesheet has to remember: `--t-display-tracking` −0.01em, `--t-eyebrow-tracking` 0.06em, `--t-eyebrow-transform` uppercase, and `--t-mono-numeric` tabular-nums. "Numerics are tabular in every app, without exception" is only true while that last one exists and is used.

The numeric role also declares its own reading direction: `--t-mono-direction` `ltr` and `--t-mono-bidi` `isolate`, set once on the role, never per span. A number is not a word — under RTL the bidi algorithm reorders a mixed digit-and-word run (`30 July 2026 · 17:42` reads back to front) unless the role pins its own direction and isolates it from the surrounding paragraph. This lands on TEXT elements only: a layout container must never carry the numeric face, because its inline axis would flip along with it. The defect was shell-wide, not app-specific — it was reordering the stem's gateway line and the account handle beside every mono-set date and count in the product. The distinct composable size rungs are `--t-display-size` 31px, `--t-title-size` 20px, `--t-reading-size` 19px, `--t-body-size` 15px, `--t-small-size` 13px, and `--t-control-size` 11px — **six**, not seven. `--t-body-strong-size` does not exist because it would duplicate the body rung, and the same is true of `--t-small-strong-size`, `--t-eyebrow-size` and, since v7 folded the numeric role from 11.5 to 11, `--t-mono-size`: annotation, micro caps and numerics are one 11px rung, so they get one name. Half a pixel from 11 is not a step, and 11.5px lowers to `.71875rem`, which is where a ladder stops being a ladder. There are no line-height rungs. The declaration order in `typography.ts` is ramp order precisely because it decides which name owns each rung.

Native consumes the pre-lowered `nativeDelta`; it does not parse CSS or do runtime math. Two roles step DOWN on a phone rather than up — display to 27 and reading to 17.5 — because a 31px serif title overruns a 390px screen. Text scaling and Dynamic Type may enlarge a role, never shrink it below 11px.

## Layout

`--sp-1` 4px, `--sp-2` 8px, `--sp-3` 12px, `--sp-4` 16px, `--sp-5` 24px, and `--sp-6` 32px are the one spacing scale; the 48px rung retired because the system's largest rhythm step is the 32px desktop content margin. Content margin is its own scale beside the gaps — 32px desktop, 18px mobile — because a page margin is the distance from the paper's edge to the text block, not a gap between two things; the mobile value deliberately does not sit on the 4px ladder, and native lowers it as `pageMargin`.

The component metrics are tokens, not conventions: `--h-control` 34px, `--h-row` 44px, `--h-segmented` 28px, and `--w-stem` 240px. Density tiers move `--density-row` and `--density-pad` only — comfortable 44/16, compact 38/12, dense 34/8 — and never control size, because a control below 34px stops being reliably hittable. Mobile renders one tier looser than declared.

Radii are `--r-xs` 0px (content), `--r-sm` 4px (the one sub-control rung), `--r-md` 7px (controls), `--r-lg` 12px and `--r-xl` 12px (containers), and `--r-pill` 999px. An app icon container is 26% of its own size, which no static token can carry — `iconChipRadius()` in [packages/design/src/radii.ts](packages/design/src/radii.ts) is the one source for it.

The target-min adapter is 44px for coarse web and iOS, 48dp for Android, and 32px for fine-pointer web. Safe-area insets belong to the native renderer. Compact shell law begins at 720px; it changes navigation arrangement, not token meaning. Prefer `minmax(<n>px, auto)` over a fixed grid row so content grows at 150% text scale instead of slicing, and express a mobile row's different information density as STRUCTURE — `flex-wrap` on a parent is inert when the children are `nowrap` with `flex: 1`.

## Elevation & Depth

There is very little of it. `--bg-elev` is raised paper and `--bg-sunken` a recessed track; `--shadow-sm`/`--shadow-md`/`--shadow-lg` exist for a dialog, a sheet and a popover, and for nothing else. Glass retired with the flip: `--glass-sheen` is `none` in both themes, because the metaphor is a tinted paper label, not a button under a lens. `--device-wall` is a wall composite, not a content surface. An app icon container has no gradient, no gloss and no drop shadow.

Motion has two cases and two curves. Entry and settle is `--dur-2: 280ms` on `--ease-entry: cubic-bezier(0.2, 0.7, 0.2, 1)`; a state change is `--dur-1: 140ms` on `--ease: cubic-bezier(0.3, 0, 0.4, 1)`. `prefers-reduced-motion` is honoured in ONE global rule emitted by `toCss()` — duration to zero, opacity only — and never per component.

Feedback is one persistent status line at the bottom of the frame, in the numeric register with a small neutral dot. A long local operation gets a determinate bar and exact counts: a spinner says "wait" without saying how long, which is the one thing a local-first product always knows.

## Shapes

Geometry is an instrument, not a pillow: content is square, a control is 7px, a container is 12px, an identity mark is 26% of its size, and only an avatar or a switch track is a pill. A shape does not decide semantics, and a renderer does not silently pick a radius because a component happens to be a card.

## Components

The recipe inventory is the contract: Button, IconButton, TextField, Search, Surface, ListRow, Chip, Badge, Segmented, Dialog, Sheet, StatusLine, Banner, Empty, Loading, Error, AppTile, AppHeader, Nav, Switch, Checkbox, Select, DateTimeField, Tooltip, Progress, and Avatar. Each recipe declares rest plus supported hover/pressed/focus/disabled/loading/invalid/selected/open states, capability (`web`, `blueprint`, `native`), and accessibility obligations. Segmented absorbs tabs; ListRow absorbs grip/reorder.

Button variants are `primary`, `secondary`, `quiet`, and `destructive`. `primary` is the ink fill with `--text-inv` on it, and there is at most one per view. `secondary` is the default raised action. `quiet` has no fill. `destructive` is OUTLINED in `--net` — a filled destructive button is not part of this grammar, and the `destructiveFilled` variant is retired as the kit re-skin removes its last renderer. All controls use `--h-control` and `--target-min`, a visible 2px focus ring at a 2px offset, and the recipe's duration. Haptics are a native moment channel, not a visual state. DateTimeField uses the native picker on mobile; Tooltip is supplemental and unsupported on native.

`StatusLine` is the one feedback channel: a single persistent line docked to the bottom of the frame, in the numeric register with a small neutral dot, updated in place — no stacking, no floating overlay, no auto-dismiss animation, and at most one inline text action. The toast container it replaces is retired outright, not aliased. `Loading` is determinate-only with static skeletons — a shimmer is attention-seeking about work the product can simply describe.

The three renderers are generated from the same recipe table: the kit renderer emits scoped CSS, the shell renderer emits the shared recipe CSS, and native composes typed recipe states. Kit primitives are recipe-derived; content remains app-owned. Inline apps scope under `:where(.centraid-inline-scope)` and served apps use the same recipe output. Freshness, CSS↔native, and scoped≡served tests are required.

One icon registry owns iconKey resolution for manifest, index, and app metadata. Components use semantic concepts (`back`, `close`, `ask`, `settings`, `add`, `trash`, `leave`, `up`) before concrete glyphs. Every icon shares one contract regardless of which app claims it: single-tone stroke on a 24 grid, `fill: none`, round caps and joins, and `aria-hidden` on the `<svg>` — an app-specific mark (Photos' `heart`, `album`, `place`, `person`, `dupe`, `restore`, `removeFrom`, `info`, `more`, and its shared `trash`/`add`/`share`/`download`) draws new artwork inside that same contract rather than a one-off. Identity uses one initials formatter and one identity-colour resolver. Relative time and bytes use one formatter module. `aria-label` on a container is a REPLACEMENT, not an addition: use it only on controls whose visible content is an icon, and mark decorative SVG `aria-hidden`.

## Responsive Behavior

The local responsive constitution is explicit: SH-c is the compact shell at 720px and composes as the mobile band; BI/BS remain host-relative; MO uses safe-area-aware sheets and 44pt/48dp target floors. The mobile band is capped at 5 apps plus More and no tab falls below 44px. Layout may adapt, but role names, colour meaning, type hierarchy, radii, spacing, icon keys, and action scarcity do not. Components must survive 200% zoom, Dynamic Type, reduced motion, coarse/fine pointers, keyboard focus, RTL, and light/dark themes. Under RTL the stem mirrors, which is only true while every rule uses logical properties.

## Agent Prompt Guide

When authoring an app, start with a recipe and a moment, then choose only roles from [packages/design/src/roles.ts](packages/design/src/roles.ts). Declare your density tier and your register; do not retune the page — there is one — and do not invent a new axis. Use `primary` once per viewport and `secondary` for ordinary actions. Use `--accent-text` for the action colour on type, `--text-inv` for published fills, `--link` for prose links only, `--net` for anything that leaves the device, and a status role only for status. Put every number in `--t-mono`. Pick an iconKey from the shared registry. Use `formatRelativeTime`, `formatBytes`, `identityInitials`, and `identityColor`; do not write local copies. For an unsupported surface capability, state why in the recipe/profile matrix. Run `bun run check:pr`, the affected contract tests, and the screenshot lane before presenting work.

## Do's and Don'ts

Do use shared roles, recipes, icon keys, formatters, safe-area adapters, and generated lowerings. Do keep app identity separate from the shell, which spends none. Do line-clamp text in a fixed-height container. Do give a recessive state its own token on the leaf element. Do add a receipt and update the matching refactor progress log when a system fact changes.

Do not hardcode colours, font stacks, spacing, radii, icon dictionaries, or foreground choices. Do not add a new token in app CSS or kit CSS. Do not put a hue on a control, ship a second filled element in one view, fill a destructive button, or use a toast as a notification. Do not express state with container `opacity`, clip text with `overflow: hidden`, use a spinner, a badge count or a red dot, or write a physical direction property where a logical one exists. Do not restore `--bg-l`, `--t-hero`, `--t-greeting`, `--sp-7`, `ACCENT_PALETTE`, `--t-tiny`, `--lib-*`, `--font-title`, `--mono`, `--bezel*`, or `--accent-midnight` as compatibility aliases.

### References

- [packages/design/src/roles.ts](packages/design/src/roles.ts) — role registry and profile matrix
- [packages/design/src/recipes/index.ts](packages/design/src/recipes/index.ts) — the recipe inventory
- [packages/design/src/contract.ts](packages/design/src/contract.ts) — emitted property contracts
- [packages/design/src/fonts.ts](packages/design/src/fonts.ts) — the four bundled faces and the `@font-face` emitter
- [issue #707](https://github.com/srikanth235/centraid/issues/707) — the Binding Layer brief this constitution implements, quoted in full in the issue; the design-agent prototypes are reference-only and are not kept in the repo
- [docs/traps/design-tokens.md](docs/traps/design-tokens.md) — source-of-truth trap
- [docs/refactors/product-grammar.md](docs/refactors/product-grammar.md) — migration safety argument and progress log
- `bun run lint:design-md` — official design.md validation
- `bun run check:pr` — the full local mirror of CI
