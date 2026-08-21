# issue-775 — Restore Insights and Vault Atlas UI lost in the v9 block-layer migration

GitHub issue: [#775](https://github.com/srikanth235/centraid/issues/775)

Commit `5af4a20a` (#765/#766) adopted the v9 design binding layer and, as
collateral, retired working UI from the Insights/Analytics screens and the
Data route (Vault Atlas). None of the losses were sanctioned in
`docs/design-divergences.md`, and the gateway kept shipping `byHarness`,
`byModel`, `byEffort`, `peakDay`, `retries`, and `failedCostUsd` with
nothing rendering them. This issue restores the functionality through the
block vocabulary — new blocks, never one-off screen code.

## Checklist

- [x] DistributionBlock: labelled proportional rows over the Progress recipe
- [x] Spend breakdowns restored (source / harness / model / effort)
- [x] Daily chart: one column per day, dated axis, peakDay note, spend units
- [x] Panel figure variant: the spend hero, plus per-fact caveats
- [x] Resource receipt measurement window ("since …")
- [x] Mobile: breakdowns, dated chart, unhealthy-component row action
- [x] GridBlock: declared columns, sortable headers, per-column registers
- [x] Vault Browse records grid restored (pk/fk, sealed, null vs empty)
- [x] Unwritten kinds visible as `off` ghost rows + "Never written" chip
- [x] SectionBlock trailing verb (census refresh, record sort)

## What changed

### Headless block layer (`packages/design/src/blocks/`)

`packages/design/src/blocks/distribution.ts` (new): `distributionRows()`
orders by weight and measures each share against the **total**, not the
maximum — the retired screen drew harness against the max and model
against the total, two stories about the same dollars. A positive weight
keeps a 1% floor so a row that measured something is never drawn as
nothing. `packages/design/src/blocks/bars.ts`: `dayFold()` (the
calendar-offset fold both kits had duplicated), `barShares()`,
`dayMark()`. `packages/design/src/blocks/grid.ts` (new):
`gridCell` — the four-kind cell vocabulary
(value / null / blank / sealed) with reversible clipping at
`GRID_CLIP_AT` — plus `gridSortNext` / `gridSortOf`,
`gridColumnBadges`, `gridColumnHint`, `gridColumnSortable`.
`packages/design/src/blocks/contracts.ts`: `DistributionDatum`,
`PanelFigureData`, `PanelFactData.note`, `GridColumnData` (key / label /
register / pk / fk-target / sealed / fixed), `GridSortData`, and
`SectionActionData` (the section's trailing verb, quiet-only, never
destructive).
`packages/design/src/blocks/fixtures.ts` and
`packages/design/src/blocks/blocks.test.ts` pin the arithmetic once;
`packages/design/src/blocks/insights.ts` now coalesces source buckets and
formats breakdown rows through caller-provided number formatters, so the
desktop and mobile Insights models share these rules instead of duplicating
them; `packages/design/src/blocks/index.ts` exports it all.

### React DOM kit (`packages/client/src/react/ui/`)

`DistributionBlock.tsx` / `DistributionBlock.module.css` /
`DistributionBlock.test.tsx` (new) — first React lowering of the
`Progress` recipe; the share bar is `aria-hidden` with the percentage
stated in words. `GridBlock.tsx` / `GridBlock.module.css` /
`GridBlock.test.tsx` (new) — a `<table>` composed from existing recipes
(DocTable's sunken band and hairline rows, badge chip, text step);
`aria-sort` on the sorted column, sealed drawn as a `--seam` chip and
never printed, inline-axis scroll rather than dropped columns.
`PanelBlock.tsx` / `PanelBlock.module.css` / `PanelBlock.test.tsx` —
figure variant (one fact promoted to display type with a qualifier line)
and per-fact caveat. `BarsBlock.tsx` / `BarsBlock.module.css` /
`BarsBlock.test.tsx` — axis relaxed from a fixed triple to the caller's
marks, `note` slot, dense-gutter mode for 30 columns.
`SectionBlock.tsx` / `SectionBlock.module.css` — the trailing-verb slot.
`blockParity.test.tsx` asserts both kits against the shared fixtures.

### Analytics screens

`packages/client/src/react/screens/insights-model.ts` (new, mirrors the
mobile leg's model/screen split and keeps both under the line cap),
`packages/client/src/react/screens/InsightsScreen.tsx` and
`InsightsScreen.test.tsx`: promoted spend figure; spend-per-day at one
column per day with dated marks and the `peakDay` note; four breakdowns
(`bySource`, `byHarness`, `byModel`, `byEffort`) alongside the kept
three-bucket source summary; `retries` and `failedCostUsd` stated;
resource receipt gained its measurement window and per-row caveats.

Mobile: `apps/mobile/src/kit/components/DistributionBlock.tsx` /
`DistributionBlock.styles.ts` / `DistributionBlock.test.tsx` (new, row
form stacked for 390pt), `PanelBlock.tsx` / `PanelBlock.styles.ts` /
`PanelBlock.test.tsx` (figure + caveat), `BarsBlock.tsx` /
`BarsBlock.styles.ts` / `BarsBlock.test.tsx` (stopped sampling
internally — `MAX_COLUMNS` guard + adaptive gutter; the block erasing
spikes was the real rigidity, not the axis),
`apps/mobile/src/kit/components/blockParity.test.tsx`,
`apps/mobile/src/apps/insights/Insights.tsx` / `Insights.test.tsx` and
`apps/mobile/src/apps/insights/insights-model.ts` /
`insights-model.test.ts` / `insights-model.health.test.ts` (the health /
standing / export pins split out to respect the file-size directive)
restored to match, and `apps/mobile/src/lib/insights.ts` wire mirror
gained the missing `byHarness` / `peakDay` / `failedCostUsd`. The
gateway fact now names the unhealthy component and carries a "See
what's wrong" verb into the alerts place.

`apps/desktop/tests/e2e/appview-templates-insights.spec.ts` asserts the
restored figure and breakdowns. `docs/design-machinery.md` block list,
headless-layer inventory, grid-vs-doc-table doctrine, and the section
verb are recorded.

### Atlas screens (`packages/client/src/react/screens/`)

`AtlasScreen.tsx` / `AtlasScreen.test.tsx`, `AtlasKindsSection.tsx`,
`AtlasRecordsSection.tsx` / `AtlasRecordsSection.test.tsx`,
`atlasScreenModel.ts` / `atlasScreenModel.test.ts`: Browse shows every
declared column in store order, sortable by any — column headers are the
fine control, the section verb the coarse one, both writing one `sort`
state with the landed page authoritative (`orderBy`/`dir` come off the
response, so the arrow never moves before the rows; a re-sort drops the
keyset cursor). Unwritten kinds render as `off` ghost rows saying
"Never written" (fourth chip added; verb kept but inert); the pack label
is finally drawn; "All kinds" now means all, with the empty state
counting **written** kinds so a schema-only vault still reads as empty.
Census freshness stamp + Refresh ride the Kinds section head;
`tableCaption` takes an `order` argument instead of hard-coding "newest
first".

### Checklist crosswalk

DistributionBlock: labelled proportional rows over the Progress recipe — see "Headless block layer" and "React DOM kit".
Spend breakdowns restored (source / harness / model / effort) — see "Analytics screens".
Daily chart: one column per day, dated axis, peakDay note, spend units — see "Analytics screens".
Panel figure variant: the spend hero, plus per-fact caveats — see "React DOM kit" and "Analytics screens".
Resource receipt measurement window ("since …") — see "Analytics screens".
Mobile: breakdowns, dated chart, unhealthy-component row action — see "Analytics screens" (mobile paragraph).
GridBlock: declared columns, sortable headers, per-column registers — see "Headless block layer" and "React DOM kit".
Vault Browse records grid restored (pk/fk, sealed, null vs empty) — see "Atlas screens".
Unwritten kinds visible as `off` ghost rows + "Never written" chip — see "Atlas screens".
SectionBlock trailing verb (census refresh, record sort) — see "Atlas screens".

## User impact

Analytics answers "why is my spend what it is" again: the month's spend
is a headline figure you can read at a glance instead of a 13px fact
among facts, the four categorical breakdowns (source, harness, model,
effort) are back as labelled proportional rows, and the daily chart
plots spend with one column per real, dated day — a spike no longer
disappears into a sampled column. The resource receipt says what window
its numbers cover. On the Data route, Browse is a data browser again:
every column of every record, sortable by any of them, with primary and
foreign keys badged, sealed values marked but never printed, and an
absent value visibly different from an empty one — you can compare two
records on a field without opening each in turn. Kinds that were never
written are visible instead of silently missing from "showing 9 of 40",
and the census carries its freshness stamp with a Refresh.

First-run: nothing to configure and no migration — every restored
surface renders data the gateway was already sending, so the change is
visible the first time Analytics or Data is opened after updating. A
vault with no records still reads as empty; a schema-only vault now
shows its unwritten kinds rather than an empty list.

Evidence: `artifacts/e2e/ui-impact/issue-775-analytics-restored.png`
(emitted by `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`,
test 11.1, on a populated Analytics page).

## Decisions

- **Share denominator is the total, not the max** — every run has exactly
  one harness/model/effort/source, so breakdown rows are a partition; a
  fully unpriced window falls back to tokens for the whole breakdown,
  never row-by-row.
- **Bar shares floor at 1%** for any positive value — a $0.004 day and a
  $0 day must not draw identically; the figure beside it stays exact.
- **The share bar is `aria-hidden` with the share said in words**, not
  `role="progressbar"` — this measures what happened; progressbar
  announces work in flight.
- **`null` and `""` are distinct cell kinds** — genuinely new: the
  pre-migration grid conflated them (`text === "" → null`); the honest
  distinction was implemented rather than the old conflation restored.
- **Kept the three source buckets** alongside the new per-source
  distribution — restoring adds, it does not silently drop shipped
  behaviour.
- **Deleted dead helpers** `docRowsFrom`, `kindGlyph`, `writtenText`
  with the three-column summary they served; `DocTable` survives as the
  Gallery's "records as documents" block.
- **Two sort affordances, one state** — headers fine, section verb
  coarse; the landed page is authoritative so the arrow can never move
  before the rows.

## Out of scope

- Mobile GridBlock adoption (the contract addition is purely additive;
  mobile parity tests import fixtures explicitly and are unaffected).
- The sanctioned retirements: single-segment bars with no "failed"
  legend (the rollup has no per-day outcome split), the gradient
  area-chart wash, the mobile status dots that bypassed the role
  registry, "Needs attention" → "Recent runs", identity/verbs in the app
  bar, the Orrery placement.
- Any gateway/rollup schema change — everything restored renders data
  already on the wire.

## Verification

```sh
bun run --cwd packages/design test && bun run --cwd packages/design typecheck
bun run --cwd packages/client test && bun run --cwd packages/client typecheck
bun run --cwd apps/mobile test && bun run --cwd apps/mobile typecheck
bun run lint && bun run format:check
bash .governance/run.sh
```

Observed on the integrated tree: design 387 tests across 34 files;
client 2232 across 246 files with typecheck clean; mobile 1349+ tests
(the split insights-model files pass 47 together) with typecheck clean;
oxlint + oxfmt clean; design lints (`lint:css`, `lint:design-tokens`,
`lint:aria-labels`, `lint:container-opacity`, `lint:type-floor`,
`lint:motion-rule`) pass. Known environmental failures only: mobile
`PendingRestartJourney.test.tsx` (`node:sqlite` bundling) and desktop
`ipc-core.test.ts` (Electron binary download blocked in the dev
container), both failing identically on the untouched baseline. Both
slices were built by isolated worktree agents against `5af4a20a`'s
before-state as the functional reference, then re-landed on the branch
as fresh commits with hooks active.

## Files

- `packages/design/src/blocks/distribution.ts` · `packages/design/src/blocks/grid.ts` · `packages/design/src/blocks/bars.ts` · `packages/design/src/blocks/contracts.ts` · `packages/design/src/blocks/fixtures.ts` · `packages/design/src/blocks/blocks.test.ts` · `packages/design/src/blocks/index.ts`
- `packages/design/src/blocks/insights.ts`
- `packages/client/src/react/ui/DistributionBlock.tsx` · `packages/client/src/react/ui/DistributionBlock.module.css` · `packages/client/src/react/ui/DistributionBlock.test.tsx` · `packages/client/src/react/ui/GridBlock.tsx` · `packages/client/src/react/ui/GridBlock.module.css` · `packages/client/src/react/ui/GridBlock.test.tsx` · `packages/client/src/react/ui/PanelBlock.tsx` · `packages/client/src/react/ui/PanelBlock.module.css` · `packages/client/src/react/ui/PanelBlock.test.tsx` · `packages/client/src/react/ui/BarsBlock.tsx` · `packages/client/src/react/ui/BarsBlock.module.css` · `packages/client/src/react/ui/BarsBlock.test.tsx` · `packages/client/src/react/ui/SectionBlock.tsx` · `packages/client/src/react/ui/SectionBlock.module.css` · `packages/client/src/react/ui/blockParity.test.tsx`
- `packages/client/src/react/screens/InsightsScreen.tsx` · `packages/client/src/react/screens/InsightsScreen.test.tsx` · `packages/client/src/react/screens/insights-model.ts` · `packages/client/src/react/screens/AtlasScreen.tsx` · `packages/client/src/react/screens/AtlasScreen.test.tsx` · `packages/client/src/react/screens/AtlasKindsSection.tsx` · `packages/client/src/react/screens/AtlasRecordsSection.tsx` · `packages/client/src/react/screens/AtlasRecordsSection.test.tsx` · `packages/client/src/react/screens/atlasScreenModel.ts` · `packages/client/src/react/screens/atlasScreenModel.test.ts`
- `apps/mobile/src/kit/components/DistributionBlock.tsx` · `apps/mobile/src/kit/components/DistributionBlock.styles.ts` · `apps/mobile/src/kit/components/DistributionBlock.test.tsx` · `apps/mobile/src/kit/components/PanelBlock.tsx` · `apps/mobile/src/kit/components/PanelBlock.styles.ts` · `apps/mobile/src/kit/components/PanelBlock.test.tsx` · `apps/mobile/src/kit/components/BarsBlock.tsx` · `apps/mobile/src/kit/components/BarsBlock.styles.ts` · `apps/mobile/src/kit/components/BarsBlock.test.tsx` · `apps/mobile/src/kit/components/blockParity.test.tsx`
- `apps/mobile/src/apps/insights/Insights.tsx` · `apps/mobile/src/apps/insights/Insights.test.tsx` · `apps/mobile/src/apps/insights/insights-model.ts` · `apps/mobile/src/apps/insights/insights-model.test.ts` · `apps/mobile/src/apps/insights/insights-model.health.test.ts` · `apps/mobile/src/lib/insights.ts`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts` · `docs/design-machinery.md` · `receipts/issue-775-insights-atlas-restoration.md`

## Audit

PASS — a fresh-context audit against issue #775 and the branch diff (including the uncommitted working-tree split) confirms every load-bearing claim. `distribution.ts` measures each share against the summed total with a stable weight-descending sort and a 1% floor for positive weights, exactly as the Decisions section states; `grid.ts` implements the four-kind cell vocabulary (`value`/`null`/`blank`/`sealed`) with sealed winning over absence, reversible clipping at `GRID_CLIP_AT`, ascending-first sort toggling, and header badges/hints; the Atlas screens draw never-written kinds as `off` ghost rows with the verb kept but inert, add the fourth "Never written" chip, make "All kinds" genuinely mean all while the empty state counts written kinds, and put the census stamp plus Refresh on the Kinds section head via the new SectionBlock trailing verb. The two-sort-affordances-one-state claim holds in `AtlasRecordsSection.tsx`: `orderBy`/`dir` come off the landed response, a re-sort replaces rows and drops the keyset cursor, and `tableCaption` takes the order rather than hard-coding "newest first". The Insights restoration is real on both seats — promoted spend figure, four distributions, `retries` and `failedCostUsd` stated, `peakDay` note, dated spend-per-day chart, "since …" measurement window — the mobile wire mirror gains `byHarness`/`peakDay`/`failedCostUsd`, the unhealthy-component fact carries "See what's wrong" into the alerts tab, the dead helpers (`docRowsFrom`, `kindGlyph`, `writtenText`) are deleted, the desktop e2e spec asserts the restored figure and harness breakdown, and the working-tree `insights-model.health.test.ts` split is present and self-describing. The design suite re-runs at 387 tests across 34 files, matching the Verification section.

The shared `insights.ts` headless helper now owns source-bucket coalescing and breakdown denominator rules while each seat retains its own number formatting; the focused design suite passes at 391 tests across 34 files.

One nit the audit recorded: the receipt originally attributed `GridColumnData` and `GridSortData` to `grid.ts`; they are declared in `contracts.ts` (grid.ts imports them). The attribution above was corrected in response. The types exist with exactly the listed fields, so this was a placement inaccuracy, not a substantive one. The Out of scope list is honest — mobile has no GridBlock, the sanctioned retirements stay retired, and nothing on the gateway or rollup schema changed.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | claude-code | 2ef4ed7c-09e9-59f4-affc-0966e87f6f16 |
| 2026-08-14 | codex | 019fffad-d461-7c32-acbd-f6d7af89a752 |
