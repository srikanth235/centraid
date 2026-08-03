# Handoff: Centraid Design System — the Binding Layer

## Overview

Centraid is a **personal, local-first superapp**: one shell wrapping many first-party apps
(Docs, Photos, Calendar, People, Tasks, Files, Chat) with more arriving over time, on three
surfaces — a desktop shell, an installable web PWA, and a native mobile app.

The core problem this system solves: **one recognisable product identity wrapping many apps
with very different content characters.** A photo grid wants to disappear behind imagery, a
document wants long-form reading comfort, a calendar wants dense scannable structure, chat
wants conversational warmth. They must feel like rooms in one house, not separate products,
while each app's content leads.

The answer is a **binding layer of five invariants**. Everything not named as an invariant is
explicitly the app's own choice. That division is the system.

## About the design files

The files in this bundle are **design references created in HTML** — prototypes showing
intended look and behaviour. They are **not production code to copy**. The task is to
recreate these designs in the target codebase's existing environment (React, Vue, SwiftUI,
React Native, etc.) using its established patterns and libraries. If no environment exists
yet, choose the framework appropriate to the surface and implement the designs there.

Specifically: the prototype resolves design tokens into inline style strings at render time.
**Do not port that approach.** Build a real token layer (see *Design tokens* below) and
render tokens through whatever styling mechanism the codebase already uses.

## Fidelity

**High-fidelity.** Colours, typography, spacing, radii, motion durations and easings are all
final and specified below. Copy is final. Recreate pixel-accurately using the codebase's own
primitives.

Two caveats where the prototype is a simulation rather than a spec:

- **Photographs** are represented by low-chroma CSS gradients. Real imagery replaces them.
- **Mobile** is shown in a phone frame in a browser. Native mobile needs the per-surface
  adaptations called out under *Per-surface behaviour*.

---

# The five invariants

These are the contract. An app may not override them.

### 1. Navigation — the stem

A reserved band **92px wide**, on the leading edge on desktop, on the bottom on mobile. It
holds the launcher and nothing else. It is never themed by an app, never scrolls away, and
never changes width.

Its promise is *"always the same distance from the reading edge"* — **not** "from the left".
Under RTL it mirrors. Use logical CSS properties (`border-inline-start`, `padding-inline-start`,
`margin-inline-end`, `text-align: start`, `inset-inline`) throughout, never physical ones.

Mobile band is **capped at 5 apps plus a "More" item** that opens All apps. A tab below 44px
stops being a tap target, so the cap is a hard constraint, not a preference. The desktop stem
scrolls vertically instead, so it has no cap.

### 2. One type ramp, two registers

Seven roles, one ramp. Every app declares its primary register — **reading** or **scanning** —
and draws all roles from the same ramp. Numerics are always mono and tabular, in every app,
without exception.

| Role | Face | Size / leading | Used for |
|---|---|---|---|
| Display | Instrument Serif 400 | 31/1.15, −.01em (mobile 26–27) | App titles, document titles |
| Reading | Source Serif 4 400 | 19/1.72 (mobile 17.5) | Docs body, Chat messages |
| Body | Instrument Sans 400 | 15/1.5 | UI prose, descriptions |
| UI | Instrument Sans 500 | 13/1.45 | Controls, rows, labels |
| Micro | Instrument Sans 400 | 11/1.4, caps .06em | Section labels, chips |
| Numeric | DM Mono 400 | 11.5, tabular | Times, counts, sizes, dates, versions |
| Link | Instrument Sans 400 | inherits, underlined | Prose links only |

**Font stacks — CJK fallbacks are mandatory.** Instrument has no CJK coverage; without
explicit fallbacks the display face silently drops to a UA default and the signature
disappears in the largest markets.

```
sans:    'Instrument Sans', 'Helvetica Neue', 'Hiragino Sans', 'Noto Sans JP',
         'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif
serif:   'Source Serif 4', Charter, 'Hiragino Mincho ProN', 'Noto Serif JP',
         'Noto Serif SC', 'Songti SC', Georgia, serif
mono:    'DM Mono', 'IBM Plex Mono', monospace
display: 'Instrument Serif', Charter, 'Hiragino Mincho ProN', 'Noto Serif JP',
         'Noto Serif SC', 'Songti SC', Georgia, serif
```

Nothing may fall below **11px**. Navigation labels are never tertiary text — they sit on `ink2`
at minimum.

### 3. One control vocabulary — and the shell owns no colour

A button, a field, a switch, a segmented control, a row, a sheet, an empty state, a consent
block. Apps compose from this set and may not restyle it.

**Every control is ink on paper. Commit is a filled ink button, never a hue.** This is the
load-bearing decision: if the shell spends no colour, then every colour on screen provably
belongs to an app, and the per-app identity hues actually mean something.

Rules that follow, all of them non-negotiable:

- **One filled ink element per view.** Without an accent hue, primacy is carried by
  fill-versus-outline alone; a second filled button destroys the hierarchy.
- **Destructive is an outlined button in the consequence red** (`net`). Nothing alarming is
  ever a large filled surface. Red appears only as a border or a 2px rule.
- **Actions live in bounded controls, not bare text.** Where a control must be text, it
  carries the ink step (full `ink` against `ink2` body copy) plus a hover ground plus a
  trailing `→`. Hover alone is insufficient — mobile has no hover.
- **One hue is reserved** for prose links, text selection and the focus ring. It is never
  permitted on a control.
- **State is never expressed with container `opacity`.** Opacity composites every descendant
  and silently invalidates token-level contrast. Recessive states get their own colour token
  on the leaf element.
- **`aria-label` on a container is a replacement, not an addition.** Use it only on controls
  whose visible content is an icon.

### 4. One spatial rhythm

4px base. Spacing scale **4 / 8 / 12 / 16 / 24 / 32**.

| Value | Number |
|---|---|
| Control height | 34px |
| Row height | 44px |
| Segmented control | 28px |
| Content margin | 32px desktop, 18px mobile |
| Radius — controls | 7px |
| Radius — containers | 12px |
| Radius — content | 0px |
| Radius — app icon container | 26% of its size |
| Stem width | 92px |

Density tiers (`comfortable` / `compact` / `dense`) scale **row height and content padding
only** — never control size, because a control below 34px stops being reliably hittable.

**Any text in a fixed-height container is line-clamped, never `overflow: hidden`.** A clipped
baseline reads as a rendering bug. Prefer `minmax(<n>px, auto)` over a fixed grid row so
content grows at 150%+ text scale instead of slicing.

**A row carrying more than two pieces of information gets a distinct mobile composition, not a
narrower desktop one.** `flex-wrap` on the parent is inert when children are `nowrap` with
`flex: 1` — the intent has to be expressed as structure.

### 5. One motion and feedback grammar

| Case | Value |
|---|---|
| Entry / settle | 280ms `cubic-bezier(.2,.7,.2,1)` |
| State change | 140ms `cubic-bezier(.3,0,.4,1)` |
| Feedback | The status line updates in place |
| Reduced motion | Duration → 0, opacity only |

**Never:** spinner, bounce, parallax, scale-on-hover, red dot, badge count, toast.

State is reported on **one persistent status line** at the bottom of the frame, in the numeric
register with a small neutral dot. A long local operation gets a **determinate** bar and exact
counts — a spinner says "wait" without saying how long, which is the one thing a local-first
product always knows.

`prefers-reduced-motion` is honoured **in one place** (a global rule), not per component.

---

# What an app may set for itself

Everything below is explicitly free. This list is as important as the invariants.

| Property | Freedom |
|---|---|
| Surface tone | Free. Photos takes a chroma-free mat, Docs warm paper, Calendar cool white, Chat warm neutral. |
| Density tier | Free — comfortable, compact or dense. |
| Layout | Free. Full-bleed grid, reading measure, 7-column table, message stack. No constraint. |
| Primary register | Declared, not invented — reading, scanning, or none, chosen from the ramp. |
| Colour | One identity hue, used in the icon chip and as a content marker. **Never on a control.** |

Surface tones as implemented:

| Tone | Light | Dark |
|---|---|---|
| neutral | `#FDFDFC` | `#0E0E0E` |
| paper (Docs) | `#FCFBF8` | `#12110E` |
| mat (Photos) | `#F0EFED` | `#0A0A0A` |
| cool (Calendar) | `#FBFCFC` | `#0D0E0F` |
| warm (Chat) | `#FDFBF7` | `#131110` |

---

# Design tokens

## Colour roles

| Role | Light | Dark | Used for |
|---|---|---|---|
| `ink` | `#141414` | `#EDEDEC` | Primary text, commit fill |
| `ink2` | `#5A5A58` | `#9A9A98` | Secondary text, inactive labels |
| `ink3` | `#70706D` | `#878785` | Tertiary text |
| `line` | `#E5E4E1` | `#232322` | Control borders, section rules |
| `lineS` | `#EFEEEB` | `#1B1B1A` | Hairline separators, tile borders |
| `surf` | `#F5F4F2` | `#171716` | Raised surface: tiles, today cell, hover ground |
| `accent` | `#141414` | `#EDEDEC` | = `ink`. The shell owns no hue |
| `onAccent` | `#FDFDFC` | `#0E0E0E` | Text on a filled ink control |
| `link` | `#2D4BA8` | `#9DB0F0` | Prose links and selection only |
| `ring` | `#4A67C8` | `#8098E8` | Focus ring |
| `net` | `#9A3B2E` | `#E08878` | "Leaves the device" — rules and borders, never a fill |

### Two contrast rules that are easy to get wrong

**`ink3` is validated against `surf`, not `bg`.** In dark mode every raised surface (tiles,
consent card, today cell) is *lighter* than the page, so the page background is the easy case.
Validating against it guarantees a failure the moment text lands on a card.

**Every value above clears WCAG AA (4.5:1) at 11px against the worst surface it is painted on.**
Re-verify if any surface tone changes.

## App identity hues

`oklch(0.50 0.09 <h>)` in light, `oklch(0.72 0.09 <h>)` in dark.

| App | Hue | App | Hue |
|---|---|---|---|
| Vault | 0 | Almanac | 180 |
| Chat | 12 | Docs | 210 |
| Photos | 28 | Files | 255 |
| Sift | 50 | Ledger | 290 |
| Tasks | 70 | People | 320 |
| Calendar | 150 | Home | none — uses `ink2` |

**Reserve a band.** Since the shell owns no hue there is currently no exclusion zone, but if a
brand hue is ever introduced, the app palette must cede ±25° around it, enforced at submission.
Third-party hues get clamped to `C ≤ .09` and the lightness above, so no vendor can out-shout
the system.

**Colour is never the only channel.** Every app icon is distinguishable by silhouette alone,
which is what makes the hue system safe for colour-blind users.

## App icons

Classic filled marks in a **rounded-square container**, radius 26% of size. Container is the
app hue at **13% tint** (light) / **20%** (dark); the mark is the full hue. Two-tone: a
secondary form at 50% opacity for decoration only.

**Identity must live in the primary silhouette**, as `fill-rule: evenodd` knockouts so the
container tint reads as negative space. Never put the identifying detail in the low-opacity
secondary path — it falls below the 3:1 non-text contrast threshold at the sizes actually used.
Verify each mark is distinguishable at **14px**, the smallest size in use.

Sizes in use: 30px (stem, mobile band), 28px (All apps), 22px (tile headers), 26px (privacy rows).

Container styling is **constant** — selection is carried by the label weight plus a 2px hue
bar, following iOS convention. No gradients, no gloss, no drop shadows: the metaphor is a
tinted paper label, not a glass button.

---

# Screens

All screens sit inside the frame: stem (or mobile band) + app bar + content + status line.

### Foundations
The spec itself, rendered live: the five invariants, the type ramp with real samples, the
colour-role table, the control vocabulary with working controls, the divergence policy, and the
motion spec. Useful as the acceptance reference.

### Home — two tiers
**Tier 1: a springboard of content tiles.** Every tile carries an identical invariant header —
app icon, name at 12px UI, count in tabular mono — and below that line the body belongs to the
app and uses its declared register. This is the superapp's structural advantage: it owns all
the data, so the launcher can preview everything. No OS can do this because no OS can read
across app sandboxes.

Tile size classes: `small` 1×1, `medium` 2×1, `large` 2×2. Grid is 4 columns desktop / 2 mobile,
`grid-auto-rows: minmax(136px, auto)` desktop / `minmax(152px, auto)` mobile. Large flattens to
2×1 on mobile.

Tile bodies must be **structurally distinct per app character** — this was a real defect when
People, Tasks and Files were three identical lists:

| App | Size | Body |
|---|---|---|
| Photos | large | Thumbnail mosaic, bleeding to the tile edges, no icon |
| Docs | medium | Title + prose in the reading register, clamped to whole lines |
| Chat | small | Sender + message in the reading register |
| Calendar | small | Next event: when (numeric) / title / after-line pinned to the bottom |
| People | small | Row of overlapping face circles + one line |
| Tasks | small | Checkboxes, one struck through |
| Files | medium | Ruled rows with sizes in mono |
| Ledger, Sift | small | One large figure in the numeric register |
| Vault | small | A state chip |

**Tier 2: All apps.** A searchable sheet listing every installed app as a 44px row with icon,
recency, count, and a switch that pins/unpins. Pinning adds the app to the home grid *and* the
stem. Unpinned rows read as a neutral chip with a lighter name — never a dimmed one.

### Photos
Chroma-free mat surface, compact density, 6-column full-bleed grid with 2px gutters, grouped by
month with micro-register labels. Content leads: no chrome inside the grid.

### Docs
Warm paper, reading register at 19/1.72, measure capped at **34em**, display-serif title with a
ruled byline. Prose links in the reserved hue, always underlined.

### Calendar
Cool white, scanning register, dense. **Desktop:** 7-column month grid, 42 cells, ~78px tall,
events as 2px hue rules with mono times, today's cell on `surf`. **Mobile:** an **agenda list**,
not a month grid — a 7-column grid at 390px gives 42px cells, which cannot hold a title at any
legible size. Date column 34px, event title above time so the title gets full width.

### Chat
Warm neutral, reading register at 18px serif, sender/time in mono above each message, own
messages aligned to the end. Composer is a field plus one ink button.

### Backup
Answers the product's real emotional risk: local-first means *loss*, not exposure. Leads with
"your space lives on this device; a backup is the only copy that survives losing it." Device
list (each with role chip, size, scope, last-seen), three cards on what is copied and how it is
encrypted — including *"what is held back: nothing"* — and a restore card using the
**destructive** button, since restoring overwrites everything.

### Privacy — the grants ledger
Organised **by store**, because the user's question is "who can see my photos?" not "what does
Sift do?". Stores with no grants say *"reachable by nothing"* — the strongest privacy claim on
the screen. Revoke switches are live and strike through the mode. Footer names every network
call in the whole product.

### States
Four cases that are usually left undesigned, each in real system language:

- **First run** — the home grid is made of content, so on day one it has none. It says what to
  do, with dashed placeholders rather than seven empty tiles.
- **Working** — determinate bar, exact counts, no spinner, static skeletons (a shimmer would be
  attention-seeking), and the note that the app stays usable.
- **Two devices disagree** — both versions shown with device and time, three equal options, no
  default and nothing destructive, because guessing wrong here cannot be undone.
- **Out of room** — cause, consequence, one action. The consequence line is the important one:
  *"right now it is the only copy."*

### Cross-app search
⌘K anywhere, the stem's Search control, or "Search everything" on Home. It searches **objects,
not apps**, grouped by app with the icon as group marker; each result row is kind (mono) /
title (UI) / meta (numeric). Empty state shows recents plus suggestion chips.

The index carries a `topic` field per object, so "Pemberton" reaches a document, an album,
three events, two files, two people, a message, two tasks and an account — not just literal
title matches. This is the single most valuable thing the superapp can do that an OS cannot.

---

# Interactions & behaviour

- **⌘K / Ctrl-K** toggles cross-app search; **Esc** closes any overlay.
- **Overlays:** desktop = centred dialog or top-anchored palette; mobile = bottom sheet for
  All apps, full-screen for search. One scrim, `rgba` per theme.
- **Consent flow:** detail → confirm. The confirm scrim sits **over the app's own detail page**,
  never over a blank pane — the page becomes a document at the moment you are asked to decide.
- **Install:** determinate progress with a percentage, then the status line updates. No toast.
- **Offline:** a bordered banner, and every commit becomes disabled with the reason inline —
  never a tooltip.
- **Focus:** a 2px ring in `ring`, offset 2px, via a CSS custom property so a focused ink
  button gets a visible ring rather than black-on-black.

## Per-surface behaviour

| | Desktop | PWA | Native mobile |
|---|---|---|---|
| Navigation | Stem, leading edge, scrolls | Same; no ⌘K (browser claims it) — surface an explicit Search control | Bottom band, 5 + More |
| Overlays | Centred dialog / palette | Same | Sheets, full-screen search |
| Calendar | Month grid | Month grid ≥900px, agenda below | Agenda list |
| Density | App's declared tier | Same | One tier looser; 44px minimum targets |

**Not yet designed** — flag these as open rather than inventing: multi-window / split panes on
desktop, and the assistant with its cross-store consent model.

## State

`screen`, `surface`, `theme`, `density`, `rtl`, `pins{}`, `revoked{}`, `searchOpen`, `searchQuery`,
`allAppsOpen`, `allAppsQuery`, `installProgress`, `statusMessage`.

`pins` and `revoked` are user data and must persist. Theme follows the OS by default with an
explicit override.

---

# Implementation notes for the port

**Tokens must resolve at build time for React Native.** The prototype uses
`color-mix(in oklab, <hue> 13%, transparent)` for every icon container, `oklch()` for app hues,
`-webkit-line-clamp`, `aspect-ratio` grids and `fill-rule: evenodd`. None of `color-mix` or
`oklch` exists in RN — resolve them to concrete values in the token layer rather than at render.

**Semantic tokens, per-surface renderers.** Roles stay identical across surfaces; each renderer
maps them to platform primitives. The one thing that must never be surface-specific is the
*meaning* of a role.

**Pseudo-state styles take literals or custom properties, never interpolated values.** In the
prototype's templating, a `style-hover` written with a value hole compiles to an empty rule with
no error. The general lesson for any port: hover/active/focus styling should reference CSS custom
properties set per theme, so it stays static at parse time.

**Text scale.** Emit `rem`, not `px`, so 200% OS text scale works. The prototype is `px` and
therefore only partially proves this; the `minmax()` grid rows are the pattern to follow.

---

# Files

| File | What it is |
|---|---|
| `Centraid System - Binding Layer.dc.html` | **The reference.** All nine screens, both themes, both surfaces, LTR/RTL, plus a "Show the seams" overlay that outlines what is invariant versus what each app chose. |
| `Centraid - Three Own Directions.dc.html` | The three first-principles directions this system came from (Margin / Breath / Voice). Useful for understanding *why* the stem and the two registers are the invariants. |
| `Centraid Discover - Symphony.dc.html` | The Discover / app-catalogue flow with the full consent model: access table, plain-language confirm, install progress, offline. Not yet folded into the binding layer. |
| `Centraid Discover - Refinements.dc.html` | Four refinement studies of Discover (base / quiet rows / gallery / console). Historical. |
| `Centraid Design Directions.dc.html` | The original five-direction strategy memo. Background reading. |
| `support.js`, `doc-page.js` | Runtime for the prototypes. Not part of the design. |

Open each in a browser. Use the control bar at the top of each file to switch screen, surface,
theme, RTL and the seams overlay.

## Acceptance checklist

- [ ] Every colour role clears 4.5:1 at 11px against `surf`, not just `bg`, in both themes
- [ ] No text below 11px anywhere
- [ ] No container `opacity` used to express state
- [ ] Every icon-only control has a label; decorative SVG is `aria-hidden`
- [ ] `prefers-reduced-motion` honoured globally
- [ ] Focus ring visible on a filled ink button
- [ ] RTL mirrors — no physical direction properties remain
- [ ] Mobile band capped at 5 + More; no tab below 44px
- [ ] Text in fixed-height containers is line-clamped, never clipped
- [ ] One filled ink element per view
- [ ] No spinner, toast, badge count or red dot anywhere
