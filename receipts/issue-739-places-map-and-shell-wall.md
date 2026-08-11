# issue-739 — Places becomes a map a person can read, and the shell stops spending what isn't its

GitHub issue: [#739](https://github.com/srikanth235/centraid/issues/739)

One exercise: reading the shipped surfaces against the v4 design handoff. The
handoff is not a new design — it is the document the current code was written
**from** — so this was an audit for drift, not a redirection. Ground truth in
the handoff's own order: `DESIGN.md`, the changelog, then the prototype HTML.

## Checklist

Shell

- [x] The desktop stem paints the wall, not the page
- [x] Retire the shell's hues — `colorKey` deleted, not left optional
- [x] One shared `DESTINATION_MARKS` map, so both surfaces agree on glyphs
- [x] `--page-margin` / `--page-margin-compact`, replacing restated paddings
- [x] The springboard tiers off its own pane, not the viewport
- [x] The search control gets a magnifier

Places

- [x] L1a — a coordinate adopts a place the member already named
- [ ] L1b — automatic place naming is deferred to a design against recognition automations
- [x] L2 — one projection module, executed by both renderers
- [x] L3 — the pin is a photograph; no coordinates printed anywhere
- [x] `media.add_asset` accepts coordinates, so the inline door can make a place
- [x] The phone stops emitting: `MapView` replaced by the shared projection

Photos viewer

- [x] The editor paints through a mounted `<img>`, so pending blobs resolve
- [x] The stage owns its skeleton and a `painted` state
- [x] The compact Lightbox derives the stage from one named sheet height
- [x] An open sheet suspends the zoom foot and filmstrip; the gutter goes

Seeded data

- [x] `seed.js` places 16 of 19 frames across 9 coordinates; counts pinned

Docs

- [x] `docs/photos-places.md` and the AGENTS index

## What changed

### Shell

**The desktop stem paints `--bg-app`.** The frame and the app are different
objects and now read as such. This is the mobile Home capsule's principle
("on the frame's NEUTRAL page colour, never the app's mat") applied to
desktop. Two alternatives were ruled out first: `--bg-sunken` would have
turned ~200 in-content wells invisible, and tinting the content side
reproduces exactly the inversion that retired the per-app tone axis (recorded
in `themes/shared.ts`: retuning `--bg` alone broke the paper metaphor, and
four of five tones sat within 0.7 L\*). `roles.ts` now states what `--bg-app`
means and that the ink ramp is solved against it — `contrast.test.ts` already
measured every text role against this rung, so no new floor was introduced.

**The shell gave the hues back.** `LauncherDestination` loses `colorKey`
entirely — deleted rather than left optional, because an optional hue is an
invitation to fill it in — and the ten of twelve destinations that carried one
are de-hued. The tinted
chip grounds in `.launchChip` / `.sheetRowChip` become transparent glyphs in
`--text-faint`, `.launchBar` paints `var(--text)`, `AllAppsSheet` loses its
now-meaningless `scheme` prop, and `paletteData.ts` stops emitting `hue`. The
reasoning is invariant 3: the eight identity hues are worth having only
because "a colour on screen means an app", so Notifications wearing Photos'
amber and Devices wearing People's violet was not a second use of the wheel,
it was the retirement of the rule.

**`DESTINATION_MARKS` (new `packages/design/src/destinations.ts`).** The shell
and the phone keep separate destination lists on purpose — different ids,
different per-entry fields — but they were also naming their icons
independently, and Analytics, Data and Devices each ended up wearing the wrong
glyph on one surface. The concept→mark map is now shared; the lists are not.
Two new icons (`Devices`, `Database`) and a test file come with it.

**`--page-margin` / `--page-margin-compact`.** New tokens in `css.ts`,
`blueprint.ts` and `roles.ts`, with Photos' `--gutter` rewritten on top of
them, replacing hardcoded `20px` across five CSS modules. The compact rung is
a companion, not a second scale: a pane that discovers it is narrow re-points
one variable instead of restating a padding rule per row. Native emits only
the one number, because every phone screen is compact by definition and RN has
no cascade to inherit an override through.

**The springboard tiers off itself.** `HomeSpringboard.module.css` converts
from a viewport media query to `@container` queries (900 / 620 / 340) on its
own element — a pane that is narrow inside a wide window was getting desktop
columns.

**The stem, in detail.** The search control gains a magnifier and the words
"Search everything": `⌘K` is a hint the web deliberately withholds (an
installed PWA cannot claim the chord), which had left the control as a
bordered box, a line of grey text, and nothing saying "search". Chip sizes
move to 26 in the stem and 30 in the band — one rung apart because the two
forms read at different distances — the vault avatar goes 24 → 30 so the one
identity that outranks every destination stops reading as another launcher
row, and band tokens (`--bg` → `--bg-elev`, `--line` → `--line-strong`)
separate the band from the page. A new `.launchSeam` does a different job:
rendered only when `!compact && destination.id === "home"`, it groups Home
away from the destinations below it in the desktop stem, and is suppressed on
the band entirely. The search control takes the same `--line-strong` border
with a `--line-sel` hover, and `.appIdentity` gains `overflow: hidden`. A new
`--compact-band-inset` is consumed by `CaptureOverlay`, and the compact app
bar wraps to two rows with `.appCount` hidden.

### Places

**A coordinate can now become a place through the inline door.**
`media.add_asset` takes optional `latitude`/`longitude`, guarded by a
`coordinate_pair_complete` precondition so half a pair is refused rather than
half-stored. The schema note is explicit that this is an **assertion by the
caller**, not an extraction, so it does not route around the staging
`media.location` gate. Before this, a place was derived only from spool
metadata, which is why a fully seeded vault showed an empty Places shelf.

**`findOrCreatePlaceTx` resolves in three steps instead of one.** First a
place the member already named within ~170m, then the ~11m identity rung, then
a coordinate label. Step one is what makes Places readable on day one with no
geocoding: the vault already holds named places from the rest of the product,
so a photograph in the back garden joins "Home" instead of minting
`37.4419, -122.1430` beside it. The two radii answer different questions —
"same coordinate" is ~11m; "that place" has to cover a house and its garden.

**Automatic place naming remains deferred.** `main` replaced the enrichment
service and gateway sweep architecture with self-contained recognition
automations in #735. The merge resolution deliberately removes this branch's
old `place-name` service client, sweep, and reference implementation instead
of resurrecting deleted infrastructure or disguising a redesign as conflict
resolution. The member-named-place adoption above remains the shipped naming
layer; coordinate placeholders remain hidden from the UI.

**One projection, two renderers.** New `place-map.ts` imports nothing — no
React, no stylesheet, no token. The web draws it in SVG; Expo draws the same
output through `react-native-svg`. Three things it is careful about: longitude
scaled by the cosine of the centre latitude (a Tahoe roll at 39°N is otherwise
29% too wide), one scale on both axes, and **merging in pixels rather than
degrees**. That last replaced the phone's hand-rolled 0.1° bucket, which
merged two towns on a country-wide map and split one street on a city one.

**The pin is the photograph.** The first cut of this work drew outline dots on
a graticule labelled in degrees down both margins. It was accurate, drawn to
scale, and unreadable — and because no gazetteer is installed, the place
_names_ were coordinates too, so it said the same unhelpful thing twice. Both
were revised before this commit, so the diff shows no degree labels at all
rather than their removal: each pin is a picture taken at that place with its
count on it, and what survives of the cartography is what people say out loud
— a scale bar, north, and an unlabelled grid for rhythm. A new `readableName`
predicate refuses a coordinate-shaped label in all three channels: under a
pin, in a pin's accessible name, and in the shelf headings, where a place with
nothing better to say is now "A place with no name yet".

**The plumbing that carries a coordinate to a pin.** `readPlaces`
(`queries/_shared.ts`) now maps `geo_lat`/`geo_lng` onto `lat`/`lng`, both
`queries/library.ts` and `queries/search.ts` carry them through their `placeOf`
closures, and the `Place` shape in `types.ts` gains the fields. A place list
without coordinates can only ever be a list.

**The phone stopped emitting.** `PlacesMap.tsx` no longer draws `MapView`.
Removing that basemap removed an OS-map-vendor egress that was the only place
in the product where looking at your own library told a third party anything.

### Photos viewer

**The editor paints through a mounted `<img>`.** It used a detached
`new Image()`, which lives outside the DOM and therefore outside the media
observer that resolves a pending blob — so an edit could open on the
"unavailable" copy rather than the photograph. The source is now a real
element carrying `BLOB_PENDING_ATTR` and routed through `safeMediaUrl`, and
`draw()` gates on `img.complete && naturalWidth > 0` so a canvas is never
sized from a 0×0 frame.

**`ViewerStage` owns a `painted` state** and its own skeleton element, so the
stage no longer shows a bare box while bytes arrive. The skeleton takes a
ground derived from `--on-stage`/`--stage`, not `--skel`: `--skel` is a paper
tone, correct for a placeholder on the page and wrong on a near-black stage,
where it flashes brighter than the photograph it stands in for. The loading
`<img>` stays mounted (the blob authorizer only finds elements in the tree)
but is taken out of flow at 1×1 and zero opacity, because a failed `<img>`
paints the broken glyph as replaced content and no `color` silences it.

**The compact Lightbox gives the photograph its width back.** On the phone
(`max-width: 720px`), the info sheet's height is now one named number,
`--ph-sheet: 64%`, and the stage derives its own height from it
(`.lightbox[data-info="open"] .stagewrap`, driven by a new `data-info` root
attribute in `Lightbox.tsx`) — so the sheet cannot be resized without the
photograph following. `align-self: flex-start` rather than `flex: none` is
what bounds it: `.body` is a row flex container, so the block axis is the
cross axis, and `flex: none` collapsed the stage to the width of the image
inside it. An open sheet also suspends the zoom foot and the filmstrip, which
steer a photograph nobody can reach under a metadata form — `visibility`
rather than `display: none`, so the strip keeps its scroll position across the
toggle. And `.mediaWrap`'s `padding-inline` drops from `60px` to `var(--sp-2)`:
reserving a gutter so two 44px circles could stand outside the image spent 22%
of a 549px screen and left the photograph at 51% of the viewport it is
displayed in. The circles carry their own opaque fill and hairline, so they
hold their edge over a photograph.

Alongside: `title` attributes stripped, `icons.tsx` set `inline-flex`, a
`:where()` specificity fix in `Chrome.module.css`, a `filters.ts` copy change,
a redesigned Toolbar select, label registers moved to `--t-small` /
`--t-small-strong` (`.launchLabel`, `.stemFootLabel`, `ShelfStrip`'s `.tab`),
and several `min-inline-size: 0` truncation fixes.

### Seeded data

**`seed.js` gains coordinates.** `PLACE_BY_FILE` maps 16 of the 19 frames onto
9 coordinates, spread into all three `media.add_asset` calls through
`placeInput(file)`, with a log line reporting located frames and distinct
places. Three properties are chosen rather than incidental: several frames
share a coordinate so grouping is visible, portraits share coordinates with
landscapes so People and Places intersect, and three frames stay unlocated
because a roll where every frame knows where it was is not a roll anyone has.
`demo-seed.test.ts` pins all three counts.

## Decisions

**The pin became a photograph, and the degree margins came off entirely.** The
first implementation drew outline dots on a graticule labelled `39.0°N` /
`120.1°W`. It was correct and unreadable, and the maintainer said so on sight.
The judgment call was that this is not a labelling problem to tune but a
register mistake: degrees are cartographer's vocabulary, and a member
recognises a place by the picture. `formatDegrees` and its tests were deleted
rather than kept "for later".

**A coordinate is refused as a name in every channel, even though it is the
only name we have.** Nine sections now all read "A place with no name yet",
which is repetitive. The alternative — printing `37.4419, -122.1430` as a
heading — is worse, because it looks like an answer. The repetition resolves
itself when a gazetteer is installed; a wrong-register label would not.

**`readableName` is duplicated rather than shared with the vault's
`isCoordinateLabel`.** A blueprint runs in the app sandbox and does not link
`@centraid/vault`. The shape matched is a four-line regex, and forcing a shared
module for it would be a dependency edge bought with nothing.

**No basemap, on either surface — and the phone lost the one it had.** Every
tile URL is a location, so a basemap would make Places the only feature in the
product that emits anything about vault contents. Removing `react-native-maps`
made the phone strictly more private than before this work; the cost, stated
plainly, is that there is no land under the pins.

**The rebase keeps the recognition-automations architecture intact.** The
branch originally split and extended `service-client.ts`, but #735 deleted
that transport and its gateway sweeps. Conflict resolution takes `main` for
capture OCR, semantic search, the vault plane, and recognition value shapes;
all old-seam additions remain deleted. A future automatic place resolver is a
separate product and licensing decision, not a compatibility shim.

**The `Podfile.lock` hermes-engine drift was reverted, not committed.** It came
from a failed `pod install` on this host, not from this work. `ci:native-state`
L4 was already red before this branch and is not blessed here.

## User impact

Photos now shows located photographs as recognisable image pins on the same
privacy-preserving projection on web and mobile. Coordinates are never printed
as if they were names, and the mobile surface no longer contacts an operating
system map provider. The shared shell has clearer wall/content contrast and a
recognisable search control, while the photo viewer uses more of a compact
screen and reliably resolves pending local blobs.

First-run: onboarding and the fresh Home remain unchanged. The changed desktop
Photos harness opens the integrated app surface and emits
`artifacts/e2e/ui-impact/issue-739-places-map-and-shell-wall.png`; the focused
projection and renderer suites pin the populated Places behavior.


## Out of scope

- **Automatic coordinate-to-settlement naming.** It needs a licensed
  gazetteer, a self-contained automation design, and provenance/backfill rules
  for the current architecture. Coordinate placeholders remain hidden until
  that work is intentionally designed.
- **A vendored coastline** (Natural Earth 110m) — the cheaper middle path to
  real land with no network. Same reason.
- **Proxied or consent-gated tiles.** Designed and documented in
  `docs/photos-places.md`; not built, because nothing asked for them yet.
- **Removing `react-native-maps` from `package.json`.** Nothing imports it,
  but deleting it without regenerating `Podfile.lock` breaks incremental iOS
  builds, and CocoaPods 1.16.2 aborts on this host under Ruby 4.0.3
  (`Unicode Normalization not appropriate for ASCII-8BIT`). Parked in
  `knip.json` with the full removal recipe recorded in `QUALITY.md`.

## Verification

- `bun run typecheck` — 35/35 packages.
- `bun run lint`, `bun run format`, `bun run knip` — clean.
- Per-package `bun run test`: blueprints 93 files / 3283 tests, gateway 222,
  client 232, mobile 133, vault 147, design 33. All
  pass. The combined `bun run test` shows sporadic failures under parallel
  load (a different file each run, each passing in isolation); that contention
  predates this work.
- New behaviour tests worth naming: "merges or separates by the DRAWING, not
  by the data"; "measures its own scale bar honestly" (checked against the
  known ~215km Palo Alto → west shore distance rather than against the
  projection's own arithmetic); "prints no coordinates anywhere — not on the
  margins, not under a pin".
- The privacy claim is a test, not a comment. An earlier revision asserted
  `not.toMatch(/<image\b/)`, which became wrong once pins were images; the
  committed test asserts every `src` is same-origin or `data:`, which is the
  claim that was always being made and is exactly what the blueprint CSP
  admits.
- Live in the browser against a throwaway gateway: three pins over the seeded
  Bay-to-Tahoe roll, **zero overlapping bounding boxes** (measured with
  `getBoundingClientRect`), no `°N` anywhere in the figure, and no coordinate
  in any shelf heading.

### Commands

```sh
bun run typecheck
bun run lint
bun run knip
bun run --cwd packages/blueprints test
bun run --cwd packages/gateway test
bun run --cwd packages/vault test
bun run --cwd apps/mobile test
```

### Checklist crosswalk

Each checked item, and where it is evidenced:

- The desktop stem paints the wall, not the page — `chrome.module.css`'s
  `.stem` takes `--bg-app`; see "The desktop stem paints `--bg-app`".
- Retire the shell's hues — `colorKey` deleted, not left optional — see "The
  shell gave the hues back".
- One shared `DESTINATION_MARKS` map, so both surfaces agree on glyphs — see
  the `DESTINATION_MARKS` paragraph; `destinations.test.ts` covers it.
- `--page-margin` / `--page-margin-compact`, replacing restated paddings — see
  that paragraph; the tokens are asserted in `design-md.test.ts`'s pinning.
- The springboard tiers off its own pane, not the viewport — see "The
  springboard tiers off itself" (`@container` at 900 / 620 / 340).
- The search control gets a magnifier — see "The stem, in detail".
- L1a — a coordinate adopts a place the member already named — see
  "`findOrCreatePlaceTx` resolves in three steps"; `media-places.test.ts`.
- L1b — deliberately deferred during the #735 architecture reconciliation;
  see "Automatic place naming remains deferred" and Out of scope.
- L2 — one projection module, executed by both renderers — see "One
  projection, two renderers"; `place-map.test.ts`.
- L3 — the pin is a photograph; no coordinates printed anywhere — see "The pin
  is the photograph"; `PlaceMap.test.tsx` asserts no `°NSEW` in the markup.
- `media.add_asset` accepts coordinates, so the inline door can make a place —
  see "A coordinate can now become a place through the inline door".
- The phone stops emitting: `MapView` replaced by the shared projection — see
  "The phone stopped emitting".
- The editor paints through a mounted `<img>`, so pending blobs resolve — see
  "The editor paints through a mounted `<img>`".
- The stage owns its skeleton and a `painted` state — see "`ViewerStage` owns a
  `painted` state".
- The compact Lightbox derives the stage from one named sheet height — see
  "The compact Lightbox gives the photograph its width back" (`--ph-sheet`).
- An open sheet suspends the zoom foot and filmstrip; the gutter goes — same
  paragraph (`visibility: hidden`, `60px` → `var(--sp-2)`).
- `seed.js` places 16 of 19 frames across 9 coordinates; counts pinned — see
  "Seeded data"; `demo-seed.test.ts`.
- `docs/photos-places.md` and the AGENTS index — both are in the file list below.


### Known-red, not blessed

`bun run --cwd apps/mobile ci:native-state` (L4, iOS fingerprint) was already
failing on this host before this work began — pre-existing hermes-engine
checksum drift. The host-local `Podfile.lock` edit that drift produced was
reverted rather than committed.


## Files in this change set

Named for the file-coverage check; every path below is described by one of the
sections above.

- `AGENTS.md`
- `QUALITY.md`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/screens/home/places.ts`
- `docs/photos-places.md`
- `knip.json`
- `packages/blueprints/apps/photos/Chrome.module.css`
- `packages/blueprints/apps/photos/components/AlbumBar.module.css`
- `packages/blueprints/apps/photos/components/Editor.module.css`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/Lightbox.module.css`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/PlaceMap.module.css`
- `packages/blueprints/apps/photos/components/PlaceMap.test.tsx`
- `packages/blueprints/apps/photos/components/PlaceMap.tsx`
- `packages/blueprints/apps/photos/components/Places.tsx`
- `packages/blueprints/apps/photos/components/SelectionBar.module.css`
- `packages/blueprints/apps/photos/components/ShelfStrip.module.css`
- `packages/blueprints/apps/photos/components/Toolbar.module.css`
- `packages/blueprints/apps/photos/components/ViewerStage.tsx`
- `packages/blueprints/apps/photos/filters.ts`
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/photos/place-map.test.ts`
- `packages/blueprints/apps/photos/place-map.ts`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/search.ts`
- `packages/blueprints/apps/photos/search-groups.test.ts`
- `packages/blueprints/apps/photos/seed.js`
- `packages/blueprints/apps/photos/types.ts`
- `packages/blueprints/manifest.json`
- `packages/client/src/react/screens/HomeSpringboard.module.css`
- `packages/client/src/react/shell/AllAppsSheet.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/CaptureOverlay.module.css`
- `packages/client/src/react/shell/Stem.tsx`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/inlineFrame.test.tsx`
- `packages/client/src/react/shell/launcherModel.test.ts`
- `packages/client/src/react/shell/launcherModel.ts`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/design/src/blueprint.ts`
- `packages/design/src/css.ts`
- `packages/design/src/destinations.test.ts`
- `packages/design/src/destinations.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/index.ts`
- `packages/design/src/roles.ts`
- `packages/design/src/themes/shared.ts`
- `packages/gateway/src/serve/demo-seed.test.ts`
- `packages/vault/src/commands/media-places.test.ts`
- `packages/vault/src/commands/media.ts`
- `receipts/issue-739-places-map-and-shell-wall.md`

## Audit

Independent post-merge audit against `git diff origin/main`:

1. **What changed faithfully describes the final diff — PASS.** The receipt's
   file inventory exactly matches the 54-file PR diff. The merge removes every
   old enrichment-service/place-name path, preserves `main`'s recognition
   architecture, and describes the added #739 desktop evidence harness.
2. **Every checked checklist item is realized — PASS.** The auditor verified
   the shell wall/hue/glyph/margin/container/search work; member-named place
   adoption, coordinate input, shared projection, photo pins, and no basemap;
   viewer loading and compact-sheet changes; seeded counts; and docs. L1b is
   explicitly unchecked and deferred.
3. **The checklist mirrors issue #739 — PASS.** Every actionable Proposal and
   Problem item is represented. Automatic place naming remains visible as
   unchecked scope rather than being silently omitted; the viewer, seed, and
   docs additions are disclosed separately.

### Superseded pre-rebase record

The record below describes the original branch before #735 replaced the
enrichment-service seam. Its `place-name` claims and file inventory are not
claims about the reconciled PR; the Decisions and Out of scope sections above
record the final merge policy. Final verification is the green `check:pr` and
GitHub Actions run recorded when this merge resolution lands.

Attested by an independent sub-agent against `git diff --cached`, the receipt, and issue #739.

**1. '## What changed' faithfully describes the diff — PASS**

Every area of the 64-file diff now has a counterpart in the section, including the
two that earlier rounds refuted:

- **The compact Lightbox rework is covered.** "The compact Lightbox gives the
  photograph its width back" names `--ph-sheet: 64%`, the `data-info` root attribute
  (present in `Lightbox.tsx` as `data-info={!editing && infoOpen ? "open" : undefined}`),
  `.lightbox[data-info="open"] .stagewrap { align-self: flex-start; block-size: calc(100%
  - var(--ph-sheet)) }`, the `visibility: hidden` suspension of `.stageFoot`/`.filmstrip`,
  and `.mediaWrap { padding-inline: 60px → var(--sp-2) }`. All five are in
  `Lightbox.module.css`'s `max-width: 720px` block as described.
- **`seed.js` is covered.** "Seeded data" names `PLACE_BY_FILE`,
  `placeInput(file)`, the three `media.add_asset` spreads, and the new log line; I
  counted 16 file entries over 9 distinct coordinate pairs, matching the claim, and
  `demo-seed.test.ts` pins 16 `place_id IS NOT NULL`, 9 `core_place`, 3 `place_id IS NULL`.

Spot-checks of the rest held: `.stem { background: var(--bg-app) }` in `chrome.module.css`
with the matching `roles.ts` / `themes/shared.ts` restatements; `colorKey` removed from
`LauncherDestination` and every entry; `DESTINATION_MARKS` in the new
`packages/design/src/destinations.ts` consumed by both `launcherModel.ts` and
`apps/mobile/src/screens/home/places.ts`; `--gutter: var(--page-margin)` in
`Chrome.module.css` with `20px` retired from AlbumBar, SelectionBar, ShelfStrip and
Toolbar (five modules counting Chrome itself); `@container home-springboard` tiers at
900/620/340 replacing the deleted viewport `@media (max-width: 720px)` block;
`<Icon name="Search" />` + "Search everything" + `.stemSearchSpacer` in `Stem.tsx`;
`NAMED_PLACE_RADIUS_DEG = 0.0015` and the three-step `findOrCreatePlaceTx` with
`isCoordinateLabel`; `latitude`/`longitude` schema properties plus the
`coordinate_pair_complete` precondition and `input.latitude ?? meta.latitude` in
`addAsset`; `place-name` added to `ENRICH_CAPABILITIES` with `EnrichPlaceItem` /
`EnrichPlaceNameResult` and a `null`-preserving reader; `PLACE_NAME_SWEEP_SPEC` wired
through `VaultPlane.runPlaceNameSweep()`; `nameFor` in `tools/enrichment-service/src/
capabilities/place-name.ts` ranking by distance-as-fraction-of-a-population-derived
reach; `projectPlaces` in `place-map.ts` (no React/CSS/token imports) with cosine
longitude scaling, one `unitsPerPx` and pixel-space merging; `MapView`/`Marker` and the
0.1° bucket deleted from `apps/mobile/src/apps/photos/PlacesMap.tsx` in favour of
`projectPlaces` over `react-native-svg`; `readableName` gating pin labels, the mobile
readout and the `Places.tsx` shelf heading.

Lesser inaccuracies recorded, none of them material:

- **A count is wrong.** "all eleven destinations are de-hued" — `LAUNCHER_DESTINATIONS`
  holds **twelve** entries (home, assistant, approvals, automations, connectors, starred,
  insights, atlas, household, gateway, storage, settings), of which ten previously
  carried a `colorKey`. The change itself is exactly as described.
- **`.launchSeam`'s purpose is misattributed.** The receipt reads "a new `.launchSeam`
  plus band tokens (…) separate the band from the page". The seam does nothing of the
  sort: in `Stem.tsx` it is rendered only when `!compact && destination.id === "home"`,
  i.e. it is a hairline grouping Home away from the destinations under it in the desktop
  stem, and it is suppressed on the band entirely. The element is disclosed by name, so
  a reader can find it, but the stated reason is not the code's.
- **Query plumbing is unmentioned.** `queries/_shared.ts` `readPlaces` now returns
  `lat`/`lng` from `geo_lat`/`geo_lng`, `queries/library.ts` and `queries/search.ts`
  emit them on the joined place, and `types.ts` `Place` gains the optional fields.
  Supporting work for a claimed feature (the map cannot plot without it), not a separate
  invariant.
- Two smaller shell items are folded silently: `.appIdentity { overflow: hidden }` in
  `chrome.module.css` (a clipping backstop, described in-file) and the search control's
  border moving `--line` → `--line-strong` with a `--line-sel` hover, which the receipt
  attributes only to the band.

**2. Each '- [x]' item is realized in the diff — PASS**

- Desktop stem paints the wall — `chrome.module.css` `.stem { background: var(--bg-app) }`; `roles.ts`'s `--bg-app` role and `themes/shared.ts`'s `WALL` doc restate it. Realized.
- `colorKey` deleted, not optional — field gone from `LauncherDestination`, every entry de-hued, `AllAppsSheet` loses `scheme`/`ICON_CHIP_TINT`, `App.tsx` drops the prop, `paletteData.ts` drops `hue`, `launcherModel.test.ts` asserts `Object.hasOwn(d, "colorKey") === false`. Realized.
- One shared `DESTINATION_MARKS` — new `packages/design/src/destinations.ts` (+ `destinations.test.ts`), exported from `index.ts`, consumed by both lists; new `Devices` and `Database` glyphs in `icons.ts`. Realized.
- `--page-margin` / `--page-margin-compact` — emitted by `css.ts` and `blueprint.ts` from `pageMargin`, roled in `roles.ts`, `--gutter` rewritten on them in `Chrome.module.css` and `20px` replaced in four more modules. Realized.
- Springboard tiers off its own pane — `container: home-springboard / inline-size` on `.section`, viewport media query deleted, three `@container` tiers added at the end of the file. Realized.
- Search magnifier — `<Icon name="Search" size={16} strokeWidth={1.8} />` in `Stem.tsx` with `.stemSearch > svg` styling. Realized.
- L1a adopt a member-named place — step-1 bounding-box `SELECT` in `findOrCreatePlaceTx` with cosine-corrected longitude radius and `isCoordinateLabel` filtering adoptables; `media-places.test.ts` added. Realized.
- L1b `place-name` capability — `ENRICH_CAPABILITIES`, wire types + reader in `service-client.ts`, `PLACE_NAME_SWEEP_SPEC`, `runPlaceNameSweep()` on the sweep clock, `placeNameCapability` in `registry.ts` gated on `gazetteerPresent`. Realized.
- L2 one projection, both renderers — `place-map.ts` imported by `components/PlaceMap.tsx` and by mobile `PlacesMap.tsx`. Realized.
- L3 pin is a photograph, no coordinates printed — pins are images inside `button`/`Pressable`; `readableName` gates pin label, accessible name, mobile readout and shelf heading; `PlaceMap.test.tsx` asserts no `°[NSEW]`. Realized.
- `media.add_asset` accepts coordinates — schema properties, `coordinate_pair_complete` precondition, `input.latitude ?? meta.latitude` in `addAsset`. Realized.
- Phone stops emitting — `MapView`/`Marker` imports and render deleted; the npm dependency survives, which the receipt discloses in '## Out of scope' and `QUALITY.md`, with `react-native-maps` added to `knip.json`'s `ignoreDependencies`. Realized.
- Editor paints through a mounted `<img>` — the `new Image()` effect is deleted; a `.source` `<img>` with `ref={imgRef}`, `safeMediaUrl`, and a `BLOB_PENDING_ATTR`-aware `onError`; `draw()` returns early unless `img.complete && img.naturalWidth !== 0`. Realized.
- Stage owns its skeleton and a `painted` state — `useState(false)` in `Media`, `.skeleton` div while unpainted, `.loading` on the image, `setPainted(true)` in `onLoad`; `.skeleton` grounds in `color-mix(in oklab, var(--on-stage) 12%, var(--stage))`. Realized.
- Compact Lightbox derives the stage from one named sheet height — `--ph-sheet: 64%` on `.lightbox`, `.info { block-size: var(--ph-sheet) }`, `.stagewrap { block-size: calc(100% - var(--ph-sheet)) }`. Realized.
- Open sheet suspends the zoom foot and filmstrip; the gutter goes — `.lightbox[data-info="open"] .stageFoot, … .filmstrip { visibility: hidden; block-size: 0 }` and `.mediaWrap { padding-inline: var(--sp-2) }`. Realized.
- `seed.js` places 16 of 19 frames across 9 coordinates; counts pinned — `PLACE_BY_FILE` has 16 keys over 9 distinct pairs, spread into all three `add_asset` calls; `demo-seed.test.ts` pins 16 / 9 / 3. Realized.
- Docs — `docs/photos-places.md` added, `## place-name: a coordinate is not bytes` plus a sweep-table row in `docs/enrichment-service.md`, and the AGENTS.md index row. Realized.

**3. '## Checklist' mirrors the issue's checklist — PASS**

Issue #739 carries no literal `- [ ]` checklist; its actionable list is the '## Proposal'
section, read together with '## Problem'. Every Proposal bullet has a receipt item: stem →
`--bg-app`; delete `colorKey` outright; one shared `DESTINATION_MARKS`; `--page-margin` /
`--page-margin-compact`; container queries for the springboard; the magnifier; Places'
three layers (names = L1a + L1b, geometry = L2, cartography = L3); no basemap on either
surface (the phone item); the viewer's mounted `<img>`. The `media.add_asset` item answers
Problem §2's first bullet. The receipt's '## Out of scope' matches the issue's (gazetteer
and coastline as licensing calls) and extends it with three further parked items.

Receipt items with no counterpart in the issue — additions, not mirrors, and disclosed
as work rather than smuggled in: "The stage owns its skeleton and a `painted` state" (the
issue's §3 names only the editor's detached `new Image()`), the two compact-Lightbox
items, the `seed.js` item, and the Docs item.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 68189439-8557-4cd3-9e90-961a46f58161 |
| 2026-08-11 | codex | 019fef34-d7cc-7cc2-a9e0-83964bc4f746 |
