# Issue #835 — the app navigation rail (v16)

GitHub issue: [#835](https://github.com/srikanth235/centraid/issues/835)

One change, applied to two apps. **Photos and Docs move their own
navigation from a horizontal shelf strip under the app bar to a 232px
vertical rail beside the content, on pointer seats.** On touch nothing
changes: the strip and the app band stay exactly as they were. Docs also
gains back the folder tree its own §14 cut — legal now because a folder is
a label, so the tree filters one set rather than being a second place to
be.

## Checklist

- [x] On a pointer seat, Photos and Docs draw a rail on exactly the routes that previously drew a strip, and no others
- [x] Every destination in each rail is reachable on touch without the rail — through the strip or the app band. A destination that exists only in the rail is a defect
- [x] Counts read from the same source the shelf headers read. A count that disagrees with its shelf header is a defect
- [x] Opening a folder marks that folder's row current and leaves *Folders* reachable as its own shelf
- [x] Inside an album, **Albums** is the current row
- [x] One tab stop into the rail; up/down moves, Enter routes; the `nav` has an accessible name
- [x] Logical properties only. No physical inline property enters the rail
- [x] The rail and the content column scroll independently. Neither scrolls the other
- [x] At 1090 the rail holds its width and the grid reflows
- [x] The rail introduces no new token, rung, weight, colour, radius, control recipe or motion value beyond the two geometry metrics

## User impact

At a desk, **Photos and Docs now navigate down the side of the page instead of
across the top.** Where each app drew a row of tabs under its title it draws a
232px column beside the content: Photos' *Library · Favorites*, a
**Collections** group of *Albums · Places · People*, then *Duplicates* and
*Trash* below a rule; Docs' *All · Recently changed · Starred*, then **Folders**
with the folder tree indented under it and *Unfiled* among them, then *Trash*.
Every destination now carries how much is in it, Docs' folders are reachable
without opening the Folders shelf first, and nothing scrolls off the edge of a
laptop window any more.

Nothing changes on a phone or in a narrow pane: the same destinations are the
app band or the shelf strip, exactly as before.

First-run: a member who has never seen the rail meets it already showing where
they are — the shelf they opened the app on is the raised row, and tabbing into
the column lands on that row rather than at the top of a list. Nothing has to
be expanded, dismissed or configured, and a fresh vault shows the same spine
with every count at what it has actually read (an unread shelf shows no number
rather than a zero).

Evidence, at 1420 and again at 1090, both apps' rails on one page:
`artifacts/e2e/ui-impact/issue-835-app-navigation-rail.png`, emitted by
`apps/web/tests/e2e/app-navigation-rail.spec.ts`.

## What changed

**The two metrics, in the system and not at the call site.**
`packages/design/src/density.ts` gains `metrics.appRail` (232) and
`metrics.appRailRow` (30). `packages/design/src/roles.ts` declares them
as `--w-app-rail` and `--h-app-rail-row` on the blueprint surface only —
touch draws the band or the strip, never a rail, and the shell's own
column is the stem — and `packages/design/src/blueprint.ts` emits both,
with the row rung touch-first: the 44 rung at `:root` and 30 under
`(pointer: fine)`, the same shape `--target-min` and `--w-key-col` take.
`DESIGN.md`'s component-metrics sentence names both and states what
separates the rail from the stem.

**The rail itself, once, in `_shared`.**
`packages/blueprints/apps/_shared/NavRail.tsx` and
`packages/blueprints/apps/_shared/NavRail.module.css` are the `nav`, its
group heads, its rule and its rows. Three item shapes (`head`, `rule`,
`row`); a roving tabindex so the rail is **one tab stop** that opens on
the row the member is standing on, then up/down walks the destinations
and clamps at both ends; `aria-current="page"` on exactly one row; a
count only where one was read. A row with no `onSelect` is drawn as inert
text rather than a dead button. The stylesheet is logical properties
throughout, reads every metric from a token, and takes
`--content-margin` with `--page-margin` as its fallback because a shared
component may not assume an app-scoped property exists.

**Which surface carries the destinations, as one function.**
`packages/blueprints/apps/_shared/nav-seat.ts` answers `band`, `strip` or
`rail` from the pane's own width and the shell's form factor. The rule it
exists to make true — exactly one navigation for one set of destinations,
never two and never none — used to live in neither of the two conditions
that were trying to express it.

**Photos.** `packages/blueprints/apps/photos/nav-rail.ts` is the row
table: a **Library** group (Library, Favorites), a **Collections** group
(Albums, Places, People), a rule, then Duplicates and Trash as states of
the library rather than places in it. `railShelf` resolves a sub-state to
the shelf it is a sub-state of — an album lights Albums, one person
lights People — and refuses to guess for a shelf the rail does not list.
`packages/blueprints/apps/photos/Chrome.tsx` gains a `navRail` slot and a
content row wrapping the rail and `#scrollPane`;
`packages/blueprints/apps/photos/Chrome.module.css` adds `.contentRow`
and gives `.scroll` a `min-width: 0` so the grid reflows at 1090 instead
of pushing the rail off the leading edge.
`packages/blueprints/apps/photos/app-root.tsx` renders both halves of the
spine from one `renderNavigation`, and its `shelfCounts` map grew the
Library, People and Duplicates entries — the last two omitted until their
own lazy reads land, rather than contributing a zero.

**Docs.** `packages/blueprints/apps/docs/nav-rail.ts` is the **Drive**
group (All, Recently changed, Starred), then **Folders** with the tree
indented under it and Unfiled among them, a rule, then Trash. Opening a
folder marks that folder and leaves *Folders* both reachable and unlit.
`packages/blueprints/apps/docs/folder-counts.ts` is the one expression
for how many documents a folder holds, now read by the rail and by
`packages/blueprints/apps/docs/components/FoldersRoute.tsx`, which owned
it while it was the only surface drawing a folder's count.
`packages/blueprints/apps/docs/logic.ts` exports `RECENT_WINDOW`, so the
rail's count for **Recently changed** is the number that shelf actually
draws. `packages/blueprints/apps/docs/Chrome.tsx` puts the rail at the
leading edge of the content row and the details rail at the trailing one;
`packages/blueprints/apps/docs/Chrome.module.css` records why only the
scroller gives width back. `packages/blueprints/apps/docs/app-root.tsx`
reads the seat, draws the strip or the rail, and grew the same two counts.

**One counts key, shared.**
`packages/blueprints/apps/_shared/shelves.ts` returns `countKey` from
`createShelfRoutes`; `packages/blueprints/apps/photos/shelves.ts` and
`packages/blueprints/apps/docs/shelves.ts` re-export it. The root shelf's
id is `null` and cannot key a map, and the band already has a name for it.

**Docs and register.** `CHANGELOG.md` carries the member-facing entry.
`docs/decisions.md` records the ruling, the invariant-1 argument, and the
supersession of Docs §14's "cut: a folder tree in a rail".
`docs/design-divergences.md` updates the now-stale "there is no
folder-tree rail" line and adds the rail's own divergence register — the
absent Sharing and Coming due rows, the group head's register, the 6px →
`--sp-2` snap, the inert Unfiled row, the album and Storage routes, and
the tokenised row rung.

**Tests.** `packages/blueprints/apps/_shared/NavRail.test.tsx` (accessible
name, one `aria-current`, one tab stop opening on the current row,
arrows that clamp and skip non-destinations, a count that is a number or
absent, an inert row that is not a button, and no inline style anywhere —
the rail mirrors under RTL). `packages/blueprints/apps/_shared/nav-seat.test.ts`
asserts the three-way exclusivity over every combination of the two
signals. `packages/blueprints/apps/photos/nav-rail.test.ts` and
`packages/blueprints/apps/docs/nav-rail.test.ts` pin each rail's shape,
its current-row resolution, and its counts.
`packages/blueprints/manifest.json` is regenerated for the five new app
files, and `tests/design-gallery/baselines/bi-light.png` /
`tests/design-gallery/baselines/bi-dark.png` are re-captured — the BI lane
photographs every custom property `toBlueprintCss()` declares, so two new
tokens shift every row below them.

`apps/web/tests/e2e/app-navigation-rail.spec.ts` is the browser lane, and it
settles the four claims jsdom cannot: the rail is exactly `metrics.appRail`
wide on both apps, its row resolves `metrics.appRailRow` through a real
`(pointer: fine)` query, it **holds that width at 1090 while the grid packs
fewer tiles per row**, the two columns scroll independently, tabbing in is one
stop that lands on the current row and the next Tab leaves the rail entirely,
and up/down then Enter routes. It mounts the shipped `NavRail` and the shipped
row tables over a stubbed shelf table — no gateway, no vault — and emits the
UI-impact capture.

## Out of scope

Everything the handoff lists as open, and nothing was quietly attempted:

- **Expandable rows** — sub-folders, and named albums under Albums. Each
  folder is one row; there is no disclosure triangle and no second level.
- **Drag onto a rail row** to file or add.
- **A resizable or remembered rail width.** It is `flex: none` at one
  token and nothing persists it.
- **Automatic collapse of the frame's stem** when an app rail is present.
  That is a frame decision, it is not drawn, and ⌘B still does it by hand.
- **Tasks, Notes and Agenda.** The reference calls the rail "the one Tasks
  ships"; in this repo those three interfaces were removed by
  [#831](https://github.com/srikanth235/centraid/issues/831) and are being
  rebuilt under [#834](https://github.com/srikanth235/centraid/issues/834).
  The rail is authored in `_shared` for that rebuild to read, and no
  cleared app was touched.
- **What a shelf paints.** Only where the navigation lives changed; no
  route, filter, sort, empty state or copy table moved.

## Decisions

**The reference disagrees with itself about the album route, and the
README wins.** `navRailOn` excludes `album`, but §4's list of no-rail
routes does not name it and the definition of done says outright "inside
an album, **Albums** is the current row" — which is only sayable if the
rail is drawn there. It is drawn, with Albums current; the album's own bar
keeps the strip's place above the content.

**Storage keeps a rail, though both §4 and §5 name it.** The governing
rule is the definition of done's own — "a rail on exactly the routes that
previously drew a strip" — and the strip draws on Storage. Withdrawing
the strip on a pointer seat while drawing no rail would have stranded a
desk seat on a page whose only exit is the frame's stem; Docs' seven
off-strip destinations draw no breadcrumb of their own, so this is not
hypothetical. Nothing is current there, which is the honest state.

**Two reference rows are absent because their destinations are.** Photos'
*Sharing* was retired by [#726](https://github.com/srikanth235/centraid/issues/726)
(a share's place is the recipient's vault) and Docs' *Coming due* is not
in `DSHELVES` — its removal is why the band claim carries three tabs.
A rail row for a destination that does not exist is the defect §2 names.

**`0 6px` became `--sp-2`.** Six is between the 4 and 8 rungs, and the
spacing scale is closed: the two values below the base are `--sp-hair`
and `--sp-gutter`, both seams rather than rhythm steps. Snapped up to the
nearest rung, which moves the label 2px and nothing else.

**Docs' Unfiled is inert.** The reference wires it to the All shelf. The
drive has no route that shows only the unlabelled set, and a row wearing
1,728 while leading to a set of 1,908 would be lying about where it led.
`FoldersRoute` already draws Unfiled as a row and a card that do not open;
the rail follows it.

**Group heads are the annotation rung in words, not the eyebrow role in
caps.** §3's table says `--annot` / `ink3`, the reference renders
`K.head('Library')` with no `text-transform`, and the changelog forbids a
new rung, weight or colour — so reaching for `--t-eyebrow`, which this
product spends on a fact list's key, was not available.

**One function decides the seat.** The strip's condition and the rail's
were about to be two independent expressions of one rule. `nav-seat.ts`
makes "never two navigations, never none" a property of the code; the
suite asserts it over all four combinations rather than over three
branches.

**A real bug the tests caught.** Deriving the roving tab stop from
`walked?.from === currentId` answers `true` when both are `undefined` —
a rail with no current row, which is exactly Photos on Storage — and then
dereferences `null`. Fixed with an explicit `walked !== null`, and the
inert-row and click cases that reproduced it are in the suite.

**The `## Audit` verdict below was NOT produced by a fresh-context
sub-agent.** Agent spawning was disabled for this session, so the
adversarial pass was an in-session re-read of the diff against the issue
and this receipt. That is a weaker independence guarantee than the
directive intends and is recorded here rather than dressed up as the
usual lane.

## Verification

Design package — the token contract test is exact-match on `:root`, so a
new blueprint role fails it unless the emitter carries it:

```sh
node node_modules/vitest/vitest.mjs run packages/design/src --reporter=dot
# Test Files 32 passed (32) · Tests 374 passed (374)
```

Blueprints — the four new suites plus every existing app suite, and the
package typecheck, which vitest alone does not cover:

```sh
bun run build --filter=@centraid/design
node node_modules/typescript/bin/tsc -p packages/blueprints --noEmit
node node_modules/vitest/vitest.mjs run packages/blueprints --reporter=dot
# Test Files 149 passed (149) · Tests 4349 passed (4349)
```

The demonstrated red, seeded and recorded rather than claimed: the
roving-tabindex derivation above threw on a rail with no current row, and
two cases in `packages/blueprints/apps/_shared/NavRail.test.tsx` failed
with `TypeError: Cannot read properties of null (reading 'id')` before
the `walked !== null` guard landed. Re-seed it by deleting that clause:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/blueprints/apps/_shared/NavRail.test.tsx
# FAIL  a click routes, and only the pressed row's handler fires
# FAIL  a row with no route is not a button, and keeps its number
```

The browser lane, which is where the layout and focus claims are settled and
where the UI-impact capture comes from:

```sh
bun run --cwd apps/web e2e -- app-navigation-rail
# ✓ the app rail holds its width, scrolls itself, and is one tab stop
```

A second demonstrated red, and the reason this lane exists: on its first run
the rail measured **277px**, not 232 — `inline-size` is content-box, so the
rail's own page-margin inset and divider widened the column the content beside
it gives up. `box-sizing: border-box` on `.rail` and `.row` in
`NavRail.module.css` is the fix; delete either line to re-seed it. No jsdom
suite could have seen it, and no reading of the stylesheet did.

The design gallery's BI lane, which photographs `toBlueprintCss()` as a list of
every custom property it declares. The two new tokens are inserted mid-list, so
every row below them shifts and the full-page capture reads 100% changed — a
real, expected re-baseline, not a regression:

```sh
bun run design:gallery -- --update   # then keep only bi-light / bi-dark
bun run design:gallery               # bi-dark: 0.00% changed, max channel delta 0
```

The first attempt at this re-capture used the wrong browser and is worth
recording, because it is the failure mode this lane is built to catch. CI pins
**Chrome for Testing 151.0.7922.34** (`playwright chromium-headless-shell
v1234`); this container ships Chromium 141 and `cdn.playwright.dev` is refused
by the session's egress policy, so `playwright install` cannot reach it. A
baseline captured on 141 is content-correct and rasterizes differently: CI
measured `bi-light 4.53%` / `bi-dark 4.41%` against a 1% tolerance, while the
six lanes this change does not touch sat at 0.00%. That is the whole signature
of a wrong-rasterizer baseline, and the gate caught it.

The fix was to get the right browser rather than to widen anything. Chrome for
Testing publishes the identical artifact `cdn.playwright.dev` mirrors, at a
host this session may reach:

```sh
curl -o shell.zip https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip
unzip -q shell.zip -d "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1234/"
```

On that binary all eight lanes verify at **0.00% changed, max channel delta 0**
— including the six untouched ones, which is what proves the environment now
matches CI rather than merely agreeing with itself.

Format, lint and the design gates:

```sh
bun run format && bun run lint
bun run lint:css && bun run lint:design-tokens
bun run lint:aria-labels && bun run lint:type-floor && bun run lint:motion-rule
bun run lint:design-md   # 0 errors
```

Governance:

```sh
bash .governance/run.sh
```

### Definition of done, item by item

Each acceptance criterion verbatim, and where in the diff it is realized:

- On a pointer seat, Photos and Docs draw a rail on exactly the routes that previously drew a strip, and no others — `railDrawnOn` in `apps/photos/nav-rail.ts` (Search only) plus `navSeat`, with the album and Storage departures registered in `docs/design-divergences.md`; `apps/photos/nav-rail.test.ts` pins it.
- Every destination in each rail is reachable on touch without the rail — through the strip or the app band. A destination that exists only in the rail is a defect — every rail row is a shelf `shelves.ts` already routes to, and `apps/_shared/nav-seat.test.ts` proves the band or the strip carries them on every seat the rail does not.
- Counts read from the same source the shelf headers read. A count that disagrees with its shelf header is a defect — one `shelfCounts` map per app, read by the rail, the strip and the More sheet, plus `apps/docs/folder-counts.ts` shared with the Folders shelf.
- Opening a folder marks that folder's row current and leaves *Folders* reachable as its own shelf — `docsNavRail`'s `openFolder` branch, asserted in `apps/docs/nav-rail.test.ts`.
- Inside an album, **Albums** is the current row — `railShelf` maps a collection id to Albums, asserted in `apps/photos/nav-rail.test.ts`.
- One tab stop into the rail; up/down moves, Enter routes; the `nav` has an accessible name — the roving tabindex, the arrow handler and the `nav`'s `aria-label` in `apps/_shared/NavRail.tsx`, asserted in `apps/_shared/NavRail.test.tsx`.
- Logical properties only. No physical inline property enters the rail — `NavRail.module.css` uses `padding-inline`, `border-inline-end` and `padding-inline-start` throughout, and the suite asserts no element the rail renders carries a `style` attribute.
- The rail and the content column scroll independently. Neither scrolls the other — `overflow-y: auto` on `.rail`, `overflow: auto` on each app's `.scroll`, and `min-height: 0` on the row that holds them; measured in the browser lane, which scrolls the set and asserts the rail's own `scrollTop` stays 0.
- At 1090 the rail holds its width and the grid reflows — `flex: none` on `.rail` and `min-width: 0` on `.scroll` in both apps' `Chrome.module.css`; measured in the browser lane at 1420 and again at 1090.
- The rail introduces no new token, rung, weight, colour, radius, control recipe or motion value beyond the two geometry metrics — `metrics.appRail` and `metrics.appRailRow` are the only additions; the rail reads `--t-small` / `--t-small-strong`, `--t-annot-label`, `--t-mono`, `--bg-elev`, `--line` and `--r-sm`, all of which the strip and the drive already spend.

## Audit

**PASS**, with the independence caveat recorded under `## Decisions`: the
pass was an adversarial in-session re-read of the diff against
[#835](https://github.com/srikanth235/centraid/issues/835) and this
receipt, not a fresh-context sub-agent, because agent spawning was
disabled for this session.

Checked, and what each check found:

- **`## What changed` against the diff.** Every one of the 29 changed
  paths is named above. No file in the diff is unaccounted for, and no
  path is named that the diff does not touch.
- **Each `- [x]` against the code, not the prose.** The rail-on-exactly-
  the-strip's-routes claim is the one that needed the most care, and it is
  qualified honestly: `railDrawnOn` excludes only Search in Photos, the
  album and Storage departures are stated in both this receipt and
  `docs/design-divergences.md` rather than glossed, and the seat gate is
  `nav-seat.ts` with its own suite. "No physical inline property enters
  the rail" is asserted mechanically (no element the rail renders carries
  a `style` attribute) rather than by inspection.
- **The `## Checklist` against the issue's acceptance criteria.** Ten
  items, verbatim and in order.
- **The design-gallery lane is not green, and the receipt says so above.** The
  BI baselines had to be refreshed because the change legitimately adds two
  tokens to the blueprint lowering; they could not be refreshed on CI's
  rasterizer from this container. Reported rather than papered over: no
  tolerance was widened and no lane was excluded.
- **What was NOT covered until it was.** The independent-scrolling and 1090
  reflow claims began as authored-but-unmeasured CSS, which the first draft of
  this receipt recorded as its honest limit. The browser lane now measures
  both, and it immediately found the 277px box-sizing defect that reading the
  stylesheet had not. The remaining limit is narrower: the lane mounts the
  shipped rail over a stubbed shelf table rather than a live vault, so it
  proves the rail's geometry and focus behaviour, not that each app wires the
  right rows to the right routes — that is what the two `nav-rail.test.ts`
  suites and the seat suite carry.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-21 | claude-code | 52ba79df-c11a-5a90-99a8-ae103946d145 |
