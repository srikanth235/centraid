# issue-519 — Make the Vault Atlas Relations page approachable: the "Map" redesign

GitHub issue: [#519](https://github.com/srikanth235/centraid/issues/519)

Follow-on to the closed #441, which shipped the Atlas screen (Kinds / Relations
/ Browse) rendering the vault schema correctly but *database-native*: nodes
named `core_party`, raw FK arcs, the whole graph at once. #441 rendered the
model; this makes the Relations surface legible to the person who owns the
vault. A brainstorm converged on a published mock (dark "instrument"
aesthetic), approved with "integrate it", then integrated onto the real
schema-driven page. The orrery's anti-hairball invariant is preserved
throughout — a kind's bearing is a fixed compass direction allocated once over
the whole node set; only radius changes on re-centre, and the camera is a pure
viewport transform that never touches geometry or bearings.

## Checklist

- [x] Part 1 — Data plumbing: friendly names + blurbs on atlas graph nodes
- [x] Part 2 — UI redesign: pan/zoom camera, human readouts, sample rows, detail dial
- [x] Part 3 — File-size refactor: split orrery leaves/hooks and the test kit under the 500-line cap

## What changed

(This receipt, `receipts/issue-519-vault-atlas-map-approachable.md`, lands with
the commit. Landed as a single commit — see `## Decisions`.)

### Part 1 — Data plumbing: friendly names + blurbs on atlas graph nodes

- `packages/vault/src/schema/atlas.ts`: `ATLAS_KIND_FRIENDLY` — a curated
  `{ name, blurb }` for all 64 ontology kinds, keyed by logical `schema.table`
  (`core.party` → "People — everyone you know: people and organisations."). The
  `AtlasTableEntry` gains `friendly: string` + optional `blurb?: string`;
  `entryFor()` resolves the curated name, falling back to the mechanical
  `humanizeKind(table)` for uncurated machinery kinds (blurb omitted, never
  fabricated).
- `packages/vault/src/schema/atlas-census.ts`: the server `AtlasGraphNode` type
  + `atlasGraph()` emit `friendly` always and `blurb` only when present.
- `packages/client/src/gateway-client-atlas.ts`: the client `AtlasGraphNode`
  carries the same optional `friendly?` / `blurb?` twin fields verbatim (wire
  parity).
- Tests: `packages/vault/src/schema/atlas.test.ts` adds an **invariant** test
  (every curated key must match a real ontology registry logical name — a schema
  rename fails loudly) plus a fallback test;
  `packages/vault/src/schema/atlas-census.test.ts` asserts human-name emission
  on the graph payload.

### Part 2 — UI redesign: pan/zoom camera, human readouts, sample rows, detail dial

- `packages/client/src/react/screens/atlasOrreryGeometry.ts`: pure camera math
  (`ViewTransform`, `zoomView`, `panView`, `clientToViewBox`, `ZOOM_MIN/MAX`,
  `IDENTITY_VIEW`) — no `getScreenCTM`/`createSVGPoint`, so it is jsdom-safe —
  plus detail-dial predicates (`AtlasDetailLevel`, `kindCarriesData`,
  `visibleAtLevel`, `edgeVisibleAtLevel`) that FILTER, never synthesize.
- `packages/client/src/react/screens/AtlasOrreryChart.tsx`: all layers wrapped
  in a `data-testid="atlas-viewport"` `<g>` carrying the camera transform;
  friendly labels lead; physical SQL name demoted to a mono subtitle and only
  shown at the Everything level.
- `packages/client/src/react/screens/AtlasOrreryPanel.tsx`: readouts lead with
  the friendly name + mono subtitle + blurb; edge readouts render as plain
  sentences ("44,902 of 44,902 Observations point to People"); a "A few of
  yours" section.
- `packages/client/src/react/screens/atlasSampleRows.ts` (new):
  `useSampleRows(logical, fetcher)` — fetches up to 3 real rows for the CENTRE
  only via the existing `browseRows` endpoint (zero new gateway plumbing),
  per-mount cached, honest on empty/error (shows nothing, never a fabricated
  value); `pickSampleDisplay(row)` reduces a row to one display string via a
  sealed-aware 3-pass heuristic.
- `packages/client/src/react/screens/AtlasRelationsTab.tsx`: the orchestrator —
  drag/wheel/pan/zoom wiring via the camera hook, question chips, and the
  Simple/Standard/Everything dial (default Simple) with filter predicates and a
  caption lens tally stating what is hidden.
- `packages/client/src/react/screens/AtlasScreen.tsx`: tab label "Relations" →
  "Map" (id unchanged); wires `fetchSampleRows` over
  `browseRows({ table, limit: 3 })`.
- `packages/client/src/react/screens/AtlasRelationsTab.module.css`: tokens-only
  styles for the new controls (zoom, chips, dial, samples, dimmed/lede/sublabel
  states).

### Part 3 — File-size refactor: split orrery leaves/hooks and the test kit under the 500-line cap

The three files above outgrew the repo's 500-line file cap, so the
self-contained pieces were lifted into focused leaves/hooks (behaviour
unchanged — the full suite stays green):

- `packages/client/src/react/screens/AtlasOrreryCore.tsx` (new): the brass
  centre-plate leaf, lifted out of `AtlasOrreryChart.tsx` (518 → 439 lines).
- `packages/client/src/react/screens/atlasOrreryCamera.ts` (new):
  `useOrreryCamera` — the pan/zoom state, pointer/wheel handlers, and drag-vs-
  click guard, lifted out of `AtlasRelationsTab.tsx`.
- `packages/client/src/react/screens/atlasOrreryMotion.ts` (new):
  `usePrefersReducedMotion` + `useRecenterAnimation` (the radius-only re-centre
  animation), lifted out of `AtlasRelationsTab.tsx` (645 → 499 lines).
- `packages/client/src/react/screens/atlasRelationsTestKit.tsx` (new): the
  shared fixture, mount harness, and DOM query helpers.
- `packages/client/src/react/screens/atlasOrreryGeometry.test.ts` (new): the
  pure geometry + detail-dial predicate tests, split out of the component suite.
- `packages/client/src/react/screens/AtlasRelationsTab.test.tsx`: now the
  component suite only, importing the kit (797 → 413 lines); `flush` unrolled to
  drop the lone lint suppression.

## Out of scope

- The Kinds census and Browse editor tabs (untouched).
- The FK/graph derivation and the bearing-allocation invariant (unchanged — the
  dial filters the same nodes; the camera reframes them).
- Any new gateway endpoint (sample rows reuse `browseRows`).

## Decisions

- **New issue #519, not the closed #441.** #441 was the ontology audit + the
  original Atlas screen; this end-user approachability redesign is distinct
  work, so it was filed as its own proposal per issue-first intake.
- **Single commit, not the two originally sketched.** Governance runs a
  fresh-context sub-agent attestation per commit; the vault/client seam is a
  natural split but not worth doubling that attestation, so the change lands as
  one commit with the split documented as Parts 1–3 above.
- **File-size refactor (Part 3) folded in.** Integration pushed three files past
  the 500-line cap. Rather than waive `repo-hygiene`, the self-contained camera,
  motion, centre-plate, and test-fixture pieces were extracted into leaves/hooks
  — a net legibility win, verified behaviour-preserving by the unchanged suite.

## Verification

Client **1061/1061** and vault **864** pass; the full pre-push gate is green
(includes the desktop strict `noUncheckedIndexedAccess` typecheck over the test
files, and `repo-hygiene` now that every touched file is ≤500 lines):

```sh
bun run --filter @centraid/client test   # 1061 passed
bun run --filter @centraid/vault test    # 864 passed
bun run check:pr                         # format, oxlint, typecheck, knip, lint:css, ratchet
```

Manual: live browser pass (scratchpad Vite harness + Playwright, since localhost
is blocked in the in-app browser pane) confirming default = Simple (68 visible
nodes, 0 ghost edges), Everything = 86 nodes + physical sublabels, sample rows
render for People, node/edge readouts read human, zoom viewport transform
applies, caption tally "18 kinds hidden (empty or plumbing)", **zero console
errors**.

## Audit

**Check 1 — What changed faithfully describes the diff**

PASS – The receipt's `## What changed` section accurately documents all 19 staged files (6 modified in vault layer, 8 new client components, 5 refactored extracts) and correctly describes their purpose (friendly-name plumbing, camera math, readout layers, sample rows, file-cap compliance).

**Check 2 — All checked checklist items are realized in the diff**

PASS – All three checked items are present in the staged diff: Part 1's `ATLAS_KIND_FRIENDLY` constant with 64 curated entries + test invariants exist in `atlas.ts`/`atlas-census.ts`; Part 2's camera hook, geometry predicates, and `atlasSampleRows.ts` fetcher exist across 6 modified files; Part 3's 5 extracted leaves (`AtlasOrreryCore`, `atlasOrreryCamera`, `atlasOrreryMotion`, `atlasRelationsTestKit`, `atlasOrreryGeometry.test.ts`) and the reduced-size parent files all present.

**Check 3 — Checklist mirrors the issue**

PASS – Issue #519's 5 acceptance criteria (friendly names + invariant test; pan/zoom/camera; readouts + sample rows; dial filters; "Map" label) are collectively satisfied by the receipt's three-part checklist, verified in the `## Verification` section (vault/client tests green, manual browser confirm of all 5 criteria).

## Steering

**Check 1 — Every human-steering event is recorded in ### Steering under ## Accounting**

PASS – One genuine steering event detected: interrupt at 2026-07-23T04:26:04.313Z (line 723 of transcript); recorded in `### Steering` table below with steer-key `steer-51322a1d510-20260723-1`.

**Check 2 — No non-steering message is recorded as a steering event**

PASS – Verified that ordinary forward-progress messages ("yes, mock up please"; "ability to drag, zoom in, zoom out?"; "looking good, integrate it"; "please act as orchestrator...") are sequential responses to agent work or answers to agent questions, not mid-task redirects or corrections.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-51322a1d-510-1784785720-1 | claude-code | 51322a1d-5103-4928-b2d1-ab916dc6f411 | #519 | claude-opus-4-8 | 3203 | 3317473 | 98895678 | 666060 | 3986736 | 86.8496 | 3203 | 3317473 | 98895678 | 666060 | feat(vault): curated friendly names + blurbs on atlas graph nodes (#519)The Atla |
| claude-code-51322a1d-510-1784787108-1 | claude-code | 51322a1d-5103-4928-b2d1-ab916dc6f411 | #519 | claude-opus-4-8 | 255 | 373259 | 23271977 | 208516 | 582030 | 19.1830 | 3458 | 3690732 | 122167655 | 874576 | feat(client): approachable Vault Atlas "Map" — human names, camera, samples, dia |
| claude-code-51322a1d-510-1784787197-1 | claude-code | 51322a1d-5103-4928-b2d1-ab916dc6f411 | #519 | claude-opus-4-8 | 8 | 11289 | 909727 | 6340 | 17637 | 0.6840 | 3466 | 3702021 | 123077382 | 880916 | feat(client): approachable Vault Atlas "Map" — human names, camera, samples, dia |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-51322a1d510-20260723-1 | 51322a1d-5103-4928-b2d1-ab916dc6f411 | #519 | interrupt | structural | User interrupted long-running model response mid-execution | 9c3eedf4 | 723 | 2026-07-23T04:26:04.313Z |
