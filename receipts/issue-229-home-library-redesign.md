# issue-229 — Unified Home library + inline card action toolbar

GitHub issue: [#229](https://github.com/srikanth235/centraid/issues/229)

The Home page showed apps and automations as two separate, visually-divergent
sections, diverging from Discover which already clubs both under one segmented
filter. And each app card's only affordance was a single hover-revealed `•••`
overflow menu (poor discoverability), while automation cards had no actions.
This reworks Home to mirror Discover's clubbing and replaces the lone overflow
with an inline hover action toolbar shared by both card kinds. Desktop renderer
only — no gateway or runtime change.

## Checklist

- [x] Replace the two Home sections with a unified library shelf
- [x] Render automations as cards in the app-card visual family, kind-grouped beside apps
- [x] Drop the standalone "N active" count from the shelf header, keeping the needs-attention badge
- [x] Replace the lone overflow menu with an inline hover action toolbar on app cards
- [x] Give automation cards the same toolbar with real Run now / Star / overflow actions
- [x] Expose the automation glyph + status primitives and a generic openMenu so Home can reuse them

## What changed

- Replace the two Home sections with a unified library shelf — `buildHomeApps`
  + `buildHomeAutomations` collapse into one `buildHomeLibrary` in `app.ts`. A
  segmented All / Apps / Automations filter (reusing Discover's `.cd-disc-seg`
  pill control) rides the header with live counts; the body repaints in place
  into kind-grouped sections, and a "Browse templates →" link opens Discover.
- Render automations as cards in the app-card visual family, kind-grouped
  beside apps — new `renderHomeAutomationCard` builds each row as a
  `.cd-app-card--small` with the identity hue glyph tile, status pill, trigger
  summary, last-run, and integration dots, so apps and automations share one
  uniform grid. The standalone "Recent runs" rail is dropped (last-run now
  rides each card).
- Drop the standalone "N active" count from the shelf header, keeping the
  needs-attention badge — only the `⚠ N needs attention` summary shows, and
  only when a most-recent run failed.
- Replace the lone overflow menu with an inline hover action toolbar on app
  cards — `renderAppCard` now floats a frosted pill of ghost icon buttons
  (Edit with Centraid · Star · `⋯`) over the card's bottom-right as a wrap
  sibling; the `⋯` keeps the rarer Open / Rename / Share / Reveal / Delete.
- Give automation cards the same toolbar with real Run now / Star / overflow
  actions — Run now calls `runAutomationNow` then opens the run viewer; the
  `⋯` menu offers Open / Run now / Edit in builder / Delete (confirm →
  `deleteAutomation` → re-render).
- Expose the automation glyph + status primitives and a generic openMenu so
  Home can reuse them — the automations module now returns `autoGlyphTile` +
  `auStatusPill`, and the cards module returns `openMenu`; `captureTrigger`
  matches the new `.cd-card-act` overflow class so the toolbar stays visible
  while its menu is open.

## Out of scope

- No gateway, runtime, or data-model change — desktop renderer only.
- The recent-runs feed remains on the Automations overview surface; it was
  removed only from Home in favour of the per-card last-run.
- Starring automations persists state but the Starred page is still its
  existing placeholder.

## Verification

- `tsc -p tsconfig.json` (build:ts) and `tsc -p tsconfig.test.json --noEmit`
  (typecheck) pass for `@centraid/desktop`.
- Full `bun run build` passes; the app boots in Electron with the unified
  library shelf, the segmented filter switching All / Apps / Automations, and
  the inline hover toolbar revealing on both app and automation cards.
