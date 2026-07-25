# issue-549 — Vault Atlas Map: replace the orrery with a hierarchical sunburst

GitHub issue: [#549](https://github.com/srikanth235/centraid/issues/549)

Follow-on to the closed [#519](https://github.com/srikanth235/centraid/issues/519),
which shipped the Map tab as an orrery with a Simple/Standard/Everything density
dial. In use the progressive disclosure failed in the worst possible way: at the
Simple level whole domains became **unreachable** — not dimmed, not collapsed,
but gone — while their names stayed printed on the bezel. A user could read
"Locker" on the rim and have nothing to click.

The root cause was `visibleAtLevel` in `atlasOrreryGeometry.ts` using *absence of
data* as a visibility filter, compounded by pack sectors sized by kind count (a
one-table domain got a ~4° sliver) and ~200 FK arcs drawn at once. That is a
*hierarchy* problem being treated as a *density* problem: the vault genuinely has
three rungs — vault → domain → kind — and the orrery flattened all of them onto
one plane.

## Checklist

- [x] Every domain is present and clickable at the root rung, including domains whose every kind holds zero rows
- [x] Every domain gets an equal angular span regardless of how many kinds it declares
- [x] An empty kind reaches `ringFloor` and never renders at zero radius
- [x] The plumbing switch is the ONLY thing that removes a domain, and it is additive — turning it off never hides ontology
- [x] Ring and text index are two renderings of one selection model, so every wedge is reachable by keyboard and screen reader
- [x] No two adjacent domains share a hue; grey is reserved for machinery
- [x] Kinds inside one domain are visually distinguishable by colour
- [x] `bun run check:pr` green

## What changed

(This receipt, `receipts/issue-549-vault-atlas-sunburst.md`, lands with the
commit.)

### The invariant

`packages/client/src/react/screens/atlasSunburstGeometry.ts` (new) states and
enforces the rule the whole redesign rests on:

> **Presence is categorical, quantity is radial.**

Every domain gets an EQUAL angular span, and every kind inside a domain gets an
equal span of that domain. Nothing is a 4° slice because its schema declares one
table, and nothing is removed because it holds no rows. How much you have moves
the wedge's OUTER RADIUS and nothing else — `reachRadius(0, …)` returns
`ringFloor`, a substantial band rather than a hairline, so an empty kind keeps a
real, clickable target.

The module holds the pure geometry (`wedgeAngles`, `reachRadius`, `sectorPath`,
`ringBounds`, `labelMode`/`labelPlacement`/`labelRadius`, `truncateLabel`) and
the hierarchy derivation (`buildDomains`, `visibleDomains`, `ringItems`,
`findKind`, `neighboursOf`, `kindsByPhysical`), so both can be tested directly
without a DOM.

`buildDomains` joins the census — the only source of exact per-table row counts —
with the graph, which supplies curated `friendly` names and blurbs. The census is
required; **the graph is an enhancement**. When it is absent every kind falls
back to its mechanical census label and carries no blurb; we never fabricate a
name or a description the server did not send. This is what lets the Map degrade
gracefully and needs no new gateway endpoint.

### The three leaves

- `packages/client/src/react/screens/AtlasSunburstChart.tsx` (new) — the stateless SVG body. Three layers and
  nothing else: the **working ring** (the current rung's children, at equal
  spans, each reaching outward by row count), the **bezel** (every domain at a
  fixed bearing, drawn only when drilled in, so lateral movement never costs a
  trip back to the root), and the **centre plate** (the rung you stand on, and
  the control that goes up). It holds no state and makes no visibility decision:
  what it is handed, it draws.
- `packages/client/src/react/screens/AtlasSunburstList.tsx` (new) — the text index. Not a legend: it is the second
  half of a single selection model, sharing `hot` and `selected` with the ring,
  and it exists because a wedge is a poor target for a screen reader, a keyboard,
  or any name longer than its arc.
- `packages/client/src/react/screens/AtlasKindDetail.tsx` (new) — the detail rail, and where the FK graph finally
  lives. The orrery drew every reference as an arc at once, which is a picture of
  the schema rather than an answer to a question; here the same edges are a short
  list of named neighbours you walk one hop at a time.

### The orchestrator

`packages/client/src/react/screens/AtlasRelationsTab.tsx` is rewritten around `focus | selected | plumbing | hot`.
Two behaviours worth calling out: a hop into a machinery kind turns the plumbing
switch **on** rather than dead-ending, and toggling plumbing off while standing
inside machinery walks back to the root instead of stranding the user on a rung
that no longer exists.

`packages/client/src/react/screens/AtlasScreen.tsx` now passes `stats` alongside `graph`. The `relations` tab id is
unchanged — only the rendering is replaced.

### Colour

A second pass after the first review round ("the color palette is too bland").
The 8-hue palette was not dull; it was being **spent badly**, for three separate
reasons:

1. **Hue order collided.** Slots were taken in declaration order — `amber,
   forest, indigo, ochre, rose, slate, teal, violet`. Slots 0 and 3 are two
   browns (`#E89A3C` / `#B47B3F`) a viewer reads as one colour, and slot 5 is
   `slate` (`#5C677D`), a grey that makes whichever domain lands there look
   *disabled*. `PALETTE_HUES` is reordered for maximum adjacent separation —
   `teal, rose, indigo, amber, violet, forest, ochre` — and `slate` is lifted out
   entirely as `MACHINERY_HUE`. Plumbing paints grey, which is semantically right
   and frees all seven chromatic slots for the ontology packs. `assignHues`
   indexes ontology packs among *themselves*, so a machinery band sitting
   mid-registry never knocks the ramp out of step.
2. **One domain was one flat colour.** Drilling into Core gave 21 identical
   wedges — the busiest view in the app was monochrome. Each domain now carries a
   *pair* of hues (`hue` / `hue2`) and its kinds sweep between them via
   `toneMix`, so the fan reads as a spectrum and position is legible by colour.
3. **The mix went through grey.** The first attempt mixed in `oklab`, which walks
   a straight line through the colour solid: teal → rose passes within a hair of
   neutral and the middle of a 21-kind fan came out mud. The CSS now mixes in
   **`oklch`**, which rotates around the hue circle holding chroma the whole way.
   `TONE_SWEEP` is 32%, not the 55% first tried — at 55% an oklch rotation landed
   Core's last kinds on gold while its own bezel arc was still teal.

`SunburstDomain` and `RingItem` carry `hue` / `hue2` / `mix` directly, so the
paint is derived once in the geometry and the components stop re-deriving it from
a threaded pack-order array (`packOrder` and `packHueVar` are gone).

Two further paint fixes, both found only by rendering:

- **Empty domains kept their chroma.** A 14%-opacity amber on graphite is brown —
  the drabbest thing on the ring, for a domain whose only sin is being new. The
  chroma now lives in a bright dashed *stroke* with a hue glow, not a dimmed
  fill.
- **Depth.** A single shared `<radialGradient>` sheen gives every wedge a
  highlight along the inner edge falling to a deepened rim, so a flat fill reads
  as a lit surface. The bezel went 0.32 → 0.62 base opacity with a bloom on the
  arc you are standing in, and the centre plate takes a wash of the focused
  domain's hue so the centre answers "where am I" in colour before you read the
  name.

`packages/client/src/react/screens/AtlasRelationsTab.module.css` is a full replacement (881 orrery lines → 631).
Tokens and the per-wedge `--hue` / `--hue2` / `--mix` custom properties only; no
hardcoded hex.

### Checklist crosswalk

Where each checked item lands in the code above:

- **Every domain is present and clickable at the root rung, including domains
  whose every kind holds zero rows** — `ringItems` maps every visible domain to a
  wedge with no row-count predicate anywhere in the path, and
  `AtlasSunburstChart` gives each one `role="button"` + `tabIndex={0}`. Pinned by
  the `locker` / `business` fixtures in `makeStats()`.
- **Every domain gets an equal angular span regardless of how many kinds it
  declares** — `wedgeAngles(index, count)` derives the span from `360 / count`
  alone; nothing about rows or kind count enters it.
- **An empty kind reaches `ringFloor` and never renders at zero radius** —
  `reachRadius` returns `ringBounds(mode).floor` for `rows <= 0`, and the floor
  band is drawn at full span as the hit target so a short wedge is exactly as
  easy to click as a long one.
- **The plumbing switch is the ONLY thing that removes a domain, and it is
  additive — turning it off never hides ontology** — `visibleDomains` is the only
  filter in the module and its predicate is `plumbing || d.packKind ===
  'ontology'`.
- **Ring and text index are two renderings of one selection model, so every wedge
  is reachable by keyboard and screen reader** — `AtlasSunburstChart` and
  `AtlasSunburstList` are handed the same `items`, `hot`, `selected`,
  `onActivate` and `onHot` from the orchestrator; the list renders real
  `<button>` elements.
- **No two adjacent domains share a hue; grey is reserved for machinery** —
  `assignHues` walks the reordered `PALETTE_HUES` and short-circuits every
  machinery pack to `MACHINERY_HUE`.
- **Kinds inside one domain are visually distinguishable by colour** — `toneMix`
  gives each sibling a distinct `--mix` along its domain's oklch sweep.

### Deleted

The orrery, in full — `packages/client/src/react/screens/AtlasOrreryChart.tsx`,
`packages/client/src/react/screens/AtlasOrreryCore.tsx`,
`packages/client/src/react/screens/AtlasOrreryPanel.tsx`,
`packages/client/src/react/screens/atlasOrreryCamera.ts`,
`packages/client/src/react/screens/atlasOrreryMotion.ts`,
`packages/client/src/react/screens/atlasOrreryGeometry.ts`,
`packages/client/src/react/screens/atlasOrreryGeometry.test.ts`.

### Tests

- `packages/client/src/react/screens/atlasSunburstGeometry.test.ts` (new, 49 tests) — the pure invariant suite.
  Nothing here may ever return "fewer items because they are empty".
- `packages/client/src/react/screens/AtlasRelationsTab.test.tsx` (28 tests) — rewritten as the component suite.
- `packages/client/src/react/screens/atlasRelationsTestKit.tsx` — gains `makeStats()`, a census fixture built
  around the defect: `locker` is a domain whose every kind holds zero rows, and
  `business` is an empty domain the graph payload never mentions at all. Under
  the old dial both vanished from the chart while keeping their names on the
  bezel; every suite asserts they are present AND selectable.

## Out of scope

- **The Kinds tab.** It already implements the right principle — every kind the
  schema defines gets a permanent cell, and empty ones render as dashed "never
  written" ghosts so the negative space is legible. Folding it into the Map was
  considered and rejected; it is not the surface with the defect.
- **The Browse tab.**
- **Any gateway or vault-side change.** The census and graph payloads are used
  exactly as they are.
- **The `relations` tab id**, unchanged.

## Decisions

- **New issue #549, not the closed #519.** #519 is closed and its receipt is
  frozen by doc-integrity. This is distinct follow-on work correcting a defect
  that #519's own design introduced, so it was filed as its own proposal per
  issue-first intake rather than reopening or double-receipting.
- **Sunburst, not tiles.** A tile grid was offered as an alternative and the
  radial form was chosen; the deciding factor is that a sunburst encodes the
  three rungs (vault → domain → kind) natively, whereas tiles flatten two of
  them back together.
- **Map tab only.** The initial scope sketch included folding Kinds into Map;
  reading `AtlasKindsTab.tsx` showed it already renders every kind including
  empties, so that half of the scope was withdrawn as wrong before any code was
  written.
- **Census as hierarchy, graph as enhancement.** Deriving the tree from the
  census means the Map still works when the graph payload is missing, and needs
  no new endpoint.

## Verification

Full pre-push gate green — **`bun run check:pr` green**, EXIT=0, 15/15 turbo
tasks successful:

```sh
bun run check:pr    # format, oxlint, sherif, turbo lint, typecheck, lint:types,
                    # knip, lint:css, lint:e2e-flows, test:matrix, test:ratchet,
                    # test:ratchet:unit, test:affected
```

The two Atlas suites specifically:

```sh
bun run --filter @centraid/client vitest run \
  src/react/screens/atlasSunburstGeometry.test.ts \
  src/react/screens/AtlasRelationsTab.test.tsx    # 77 passed (49 + 28)
```

Client suite: **1240/1240**.

Manual: live render in a scratchpad Vite harness (localhost is reachable from the
in-app browser pane) at **both themes** and **both rungs** — root (all five
domains on the ring including the two whose kinds are entirely empty, drawn as
bright dashed bands in their own hue) and drilled into Core with the bezel,
detail rail, sample rows and "Connects to" chips. Core was widened to the real
vault's 21 kinds to exercise the radial-label rung; label overflow checked
programmatically (`overflowing: []`). Zero console errors.

Two harness traps worth recording (both cost real time, neither is a product
bug): `packages/design-tokens/dist` was stale in this worktree and missing the
`icons` export, which broke the module graph *silently* — the page rendered blank
with no console error, and only an explicit `await import()` inside a
`try/catch` surfaced it. And the built dist is CJS, so a harness pulling it over
Vite's `/@fs` path cannot see its named exports; the fix is a `resolve.alias` to
`packages/design-tokens/src/index.ts`.

## Audit

**Check 1 — What changed faithfully describes the diff**

PASS – The receipt accurately describes all changes: deleted 7 orrery files (AtlasOrreryChart.tsx, AtlasOrreryCore.tsx, AtlasOrreryPanel.tsx, atlasOrreryCamera.ts, atlasOrreryGeometry.ts, atlasOrreryGeometry.test.ts, atlasOrreryMotion.ts); created 5 new sunburst files (AtlasSunburstChart.tsx, AtlasSunburstList.tsx, AtlasKindDetail.tsx, atlasSunburstGeometry.ts, atlasSunburstGeometry.test.ts); modified 5 existing files (AtlasRelationsTab.tsx, AtlasRelationsTab.test.tsx, AtlasRelationsTab.module.css, AtlasScreen.tsx, atlasRelationsTestKit.tsx). The invariant "presence is categorical, quantity is radial" is enforced in the pure geometry module, hue assignment and colour mixing via oklch are implemented as specified, and the three-leaf architecture (Chart, List, KindDetail) plus orchestrator (RelationsTab) matches the description.

**Check 2 — All checked checklist items are realized in the diff**

PASS – All 8 items are verified: (1) Empty domains `locker` and `business` are present in the test fixture and asserted as reachable; (2) `wedgeAngles` gives equal spans regardless of kind count (49 tests in atlasSunburstGeometry.test.ts); (3) `reachRadius(0, count)` returns `ringFloor` (112 units), not zero, verified by `puts an empty wedge at the floor` test; (4) plumbing switch in AtlasRelationsTab is the only visibility control, additive on hop to machinery; (5) ring/list share `hot` and `selected` state in AtlasRelationsTab; (6) PALETTE_HUES reordered to `teal, rose, indigo, amber, violet, forest, ochre` with adjacent separation, MACHINERY_HUE reserved for slate; (7) `assignHues` gives each domain hue pair (hue/hue2) and kinds sweep via oklch color-mix; (8) `bun run check:pr` verifies as green (noted in Verification section).

**Check 3 — Checklist mirrors the issue**

PASS – The receipt's 8-item Checklist exactly matches the issue's 8 Acceptance criteria items word-for-word: presence + clickability, equal span, ringFloor, plumbing-only, ring + index selection, hue separation, colour distinction, and gate green.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-58c51d93-d6a-1784951253-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 4115 | 1748086 | 109470305 | 537739 | 2289940 | 79.1247 | 4115 | 1748086 | 109470305 | 537739 | feat(client): Vault Atlas Map — hierarchical sunburst replaces the orrery (#549) |
| claude-code-58c51d93-d6a-1784951550-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 8 | 19520 | 1026183 | 7871 | 27399 | 0.8319 | 4123 | 1767606 | 110496488 | 545610 | feat(client): Vault Atlas Map — hierarchical sunburst replaces the orrery (#549) |
| claude-code-58c51d93-d6a-1784951607-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 8 | 7753 | 1057263 | 952 | 8713 | 0.6009 | 4131 | 1775359 | 111553751 | 546562 | feat(client): x (#549)Issue: #549 |
| claude-code-58c51d93-d6a-1784951704-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 10 | 7717 | 1608969 | 5884 | 13611 | 0.9999 | 4141 | 1783076 | 113162720 | 552446 | feat(client): Vault Atlas Map — hierarchical sunburst replaces the orrery (#549) |
| claude-code-58c51d93-d6a-1784951754-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 2 | 4640 | 270849 | 178 | 4820 | 0.1689 | 4143 | 1787716 | 113433569 | 552624 | feat(client): x (#549)Issue: #549 |
| claude-code-58c51d93-d6a-1784951820-1 | claude-code | 58c51d93-d6ac-42f2-9913-334c9b743033 | 549 | claude-opus-5 | 8 | 3572 | 1102616 | 4535 | 8115 | 0.6870 | 4151 | 1791288 | 114536185 | 557159 | feat(client): x (#549)Issue: #549 |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-58c51d93d6ac-20260725-1 | 58c51d93-d6ac-42f2-9913-334c9b743033 | #549 | interrupt | structural |  | PENDING | 457 | 2026-07-25T03:14:13.787Z |

## Steering

**Check 1 — Every human-steering event is recorded in ### Steering under ## Accounting**

PASS – One genuine steering event found and recorded: the user interrupted a `bun run check:pr` Bash call at line 654 of the transcript with timestamp 2026-07-25T03:14:13.787Z, followed immediately by a `[Request interrupted by user for tool use]` message and a `/compact` command; this interrupt is recorded in the Steering table above with steer-key `steer-58c51d93d6ac-20260725-1`, type `interrupt`, tier `structural`, ordinal 457.

**Check 2 — No non-steering message is recorded as a steering event**

PASS – Only the interrupt event is recorded; the transcript contains tool denials and forward-progress messages ("/frontend-design:frontend-design the color palette is too bland", "thd direction is good...go ahead and make change") which are agent-requested feedback or answers to agent questions, not mid-task redirects or corrections requiring steering accounting.
