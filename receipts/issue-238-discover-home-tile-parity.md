# issue-238 — Discover template tiles match Home library tiles

GitHub issue: [#238](https://github.com/srikanth235/centraid/issues/238)

The Discover/Templates tiles and the Home library tiles were two parallel
implementations that had drifted in width, height, font, radius, background, and
head layout, and shared no code. This converges them visually and removes the
duplicated tile chrome.

## Checklist

- [x] Discover tiles match Home tiles in size, name font, corner radius, and background
- [x] Discover tile height matches Home via a shared height token
- [x] Discover grid width and position match Home's shelf envelope
- [x] Rows-layout footer columns (kind badge, trigger, integration dots) align
- [x] Extract the duplicated layout-toggle glyphs and button factory into a shared module
- [x] Single-source the shared tile values (padding, gap, radius, background, icon, badge slot, shelf envelope) as design tokens

## What changed

- Discover tiles match Home tiles in size, name font, corner radius, and
  background: `.cd-disc-card` now uses a vertical head (44px glyph plate on its
  own row, name + 2-line-clamped blurb beneath, foot pinned to the bottom), the
  Space Grotesk display font for the name (`font: var(--t-title)`), a 12px
  radius, and the translucent `color-mix` background — matching
  `.cd-app-card--small`. The Discover glyph was bumped 18→21px and its plate
  38→44px in `app-discover.ts`.
- Discover tile height matches Home via a shared height token: introduced
  `--lib-tile-h` (248px, sized to Home's richest automation tile) and applied it
  to both `.cd-app-card--small` and `.cd-disc-card`, so a tile reads at the same
  height on both pages.
- Discover grid width and position match Home's shelf envelope: added
  `.cd-disc-scroll` (drops the `.cd-main-scroll` padding) so `.cd-disc-wrap`
  alone owns the width envelope, mirroring Home's padding-free day1 scroll +
  `.cd-hsec`. Previously Discover double-padded and rendered ~112px narrower,
  indented ~56px further right.
- Rows-layout footer columns (kind badge, trigger, integration dots) align:
  fixed-width slots for the kind badge and trigger chip plus an always-rendered,
  fixed-width integration-dots container (empty when a template has no
  integrations) so the columns stay true regardless of dot count.
- Extract the duplicated layout-toggle glyphs and button factory into a shared
  module: new `apps/desktop/src/renderer/app-glyphs.ts` owns `TILES_SVG`,
  `ROWS_SVG`, `APP_BADGE_SVG`, and `buildLayoutToggle()`; `app.ts`,
  `app-discover.ts`, and `app-cards.ts` import them instead of each redefining
  the glyphs and the `mkLayoutBtn` block.
- Single-source the shared tile values (padding, gap, radius, background, icon,
  badge slot, shelf envelope) as design tokens: added `--lib-tile-pad/-gap/
  -radius/-bg/-bg-hover/-icon/-icon-radius`, `--lib-row-badge-w`, and
  `--lib-shelf-max/-pad-x`; both card families and both shelf envelopes
  reference them so the pages can no longer drift.
- Minor: cached the repeated `isStarred()` lookups per card in `renderAppCard` /
  `renderHomeAutomationCard`, and dropped a redundant `gap` re-declaration on
  `.cd-apps-grid--small` (inherited from `.cd-apps-grid`).

## Out of scope

- Collapsing the two tile class families (`.cd-app-card*` and `.cd-disc-card*`)
  and their parallel rows-layout blocks into a single shared `.cd-lib-tile`
  component with shared DOM. That requires renaming child classes across both
  renderers and rewriting the Discover card builder (its foot carries
  trigger+dots; Home's carries a timestamp), which risks the verified pixel
  parity. The token pass removes the maintenance/drift hazard; the full DOM
  merge is a larger, separately-verifiable change left for a follow-up.

## Decisions

- **Tokenized the shared values instead of merging the two rule sets into one
  selector.** A grouped-selector merge would relocate declarations across a
  large stylesheet and risk changing the cascade (and the just-verified parity);
  substituting identical literals with `var()` tokens is value-preserving by
  construction, so it kills the drift hazard with zero rendering change.
- **`--lib-tile-h` is pinned to Home's richest tile (248px) rather than being
  content-driven.** Home puts apps + automations in one grid so all tiles stretch
  to the tallest (the automation meta strip); Discover splits them into category
  grids, so a shared explicit height is the cheapest way to lock the two pages
  together. Sparser tiles intentionally leave slack above a bottom-pinned foot —
  the same thing Home already does for its app tiles.
- **Verified via headless-Chromium computed styles, not the live Electron app.**
  The running dev app exposes no debug port and a second instance would either
  fight the live data store or boot empty; Chromium (Blink) computes identical
  CSS to Electron, so a computed-style diff of the two tiles is the
  apples-to-apples check.

## Verification

- Discover tiles match Home tiles in size, name font, corner radius, and
  background, and Discover tile height matches Home via a shared height token:
  a headless-Chromium computed-style probe of `.cd-app-card` vs `.cd-disc-card`
  (real stylesheet + dark design tokens + Google Fonts) reports all 13 measured
  properties identical — width 232, height 248, radius 12px, the same
  `color-mix` background, padding `15px 16px`, gap 11px, name font Space Grotesk
  15px, desc font Geist 12.5px, icon 44×44 radius 12px.
- Discover grid width and position match Home's shelf envelope: the same harness
  with the full scroll+envelope nesting reports an identical card left edge
  (336px), width, and column count at both a 1372px and 1800px window.
- Rows-layout footer columns (kind badge, trigger, integration dots) align: a
  rows-layout render across rows carrying 3 / 2 / 0 integration dots reports the
  badge, trigger, and dots-right-edge at the same x in every row.
- Extract the duplicated layout-toggle glyphs and button factory into a shared
  module, and single-source the shared tile values as design tokens: `bun run
  build` (tsc) compiles clean with no dangling references, and `oxfmt --check` /
  `oxlint` pass on the changed files.
- CI `format:check` (oxfmt 0.43.0, the repo-pinned version) wraps two
  pre-existing long lines in `renderHomeAutomationCard`; reformatted `app.ts`
  with the repo binary so `bun run format:check` passes on all 509 files.
