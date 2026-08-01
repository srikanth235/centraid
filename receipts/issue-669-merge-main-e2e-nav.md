# Issue #669 — Merge main into sidebar IA PR and restore desktop e2e navigation

## Checklist

- [x] Merge `origin/main` into `claude/sidebar-ux-ia-ef2760` with zero conflict markers
- [x] Resolve `ShellApp.tsx` keeping #667 compact drawer + #670 memoized Outlet
- [x] Auto-merged `App.tsx` / `package.json` / `ci.yml` retain both parents' intents
- [x] Desktop e2e reaches Discover via ⌘K palette (not a missing rail button)
- [x] Desktop e2e reaches Analytics (Insights rename) for the spend hero screen

## What changed

- **Merge `origin/main` into `claude/sidebar-ux-ia-ef2760` with zero conflict markers** — merge commit `f03a66f9` brings main's #670 perf work onto the PR head; tree search shows no unresolved `<<<<<<<` / `=======` / `>>>>>>>` markers.
- **Resolve `ShellApp.tsx` keeping #667 compact drawer + #670 memoized Outlet** — `packages/client/src/react/shell/ShellApp.tsx` keeps `useCompactLayout`, route-keyed drawer `{open, at}`, `onDismissSidebar`, and `compact` on `ShellFrame`, and wraps both `renderScreen` and `renderSidebar` in the memoized `Outlet` boundary from #670 so heartbeat re-renders do not rebuild the whole route tree.
- **Auto-merged `App.tsx` / `package.json` / `ci.yml` retain both parents' intents** — `App.tsx` keeps PR open-Discover / palette wiring and main's `useGatewayStatus`, `resetQueryCache`, optimistic conversation patches; `package.json` keeps `check:push` / `run-gates` and gains `perf:app-weight`; `.github/workflows/ci.yml` keeps push-gate wiring and the mobile `perf:app-weight` weigh step.
- **Desktop e2e reaches Discover via ⌘K palette (not a missing rail button)** — `apps/desktop/tests/e2e/fixtures.ts` adds `gotoPaletteNav` (`Meta+k` → filter → row click) and routes `Discover` through it from `gotoNav`. Call sites in `apps/desktop/tests/e2e/appview-templates-insights.spec.ts` (10.1, 10.2, 10.4) keep `gotoNav(page, "Discover")` and now hit the product entry.
- **Desktop e2e reaches Analytics (Insights rename) for the spend hero screen** — rail alias `Insights` → `Analytics` in `gotoNav`; spec 11.1 uses `gotoNav(page, "Analytics")` and still asserts `insights-hero`.

## Decisions

- Prefer teaching `gotoNav` the post-#667 entry points (palette for Discover; Analytics label) over re-adding rail rows solely for e2e — matches the PR product intent.
- Default merge (not rebase) of `origin/main` onto the published PR branch to avoid rewriting shared history.
- None other: conflict resolution is the union of both parents' behaviours, not a redesign.

## Out of scope

- Merging PR #669 to main (only make it mergeable + green).
- Redesigning sidebar IA beyond conflict resolution and CI repair.
- Full local Electron desktop e2e when the environment cannot run it; CI is the green proof for that lane.

## Verification

```
# no conflict markers after merge
rg -n '^<<<<<<<|^>>>>>>>' packages/client/src/react/shell/ShellApp.tsx apps/desktop/tests/e2e

# client shell / IA unit tests (shipped modules)
bun run --cwd packages/client test -- \
  src/react/shell/Sidebar.test.tsx \
  src/react/shell/ShellApp.test.tsx \
  src/react/shell/useCompactLayout.test.ts \
  src/react/shell/App.test.tsx
# → 4 files, 49 tests passed

bun run check:push
# → ✓ 25/25 gates passed (captured under implementer scratch)
```

Structural e2e proof: `gotoNav` no longer clicks a rail button named Discover; palette path is the shipped product path from #667. Analytics label is the rail button for the insights route.

## Audit

Fresh-context audit against the working tree (e2e fixtures + `ShellApp.tsx` / `App.tsx` / root `package.json` / `ci.yml`) and the receipt narrative for merge tip `f03a66f9` + e2e nav repair. Default REFUTED if uncertain.

- **(1) `## What changed` faithfully describes the diff** — PASS
  - Merge / zero markers: no `<<<<<<<` / `=======` / `>>>>>>>` under `packages/client/src/react/shell` or `apps/desktop/tests/e2e`; receipt correctly frames the work as merge-main + e2e repair rather than a new IA redesign.
  - `ShellApp.tsx`: still has `useCompactLayout`, route-keyed `drawer` `{open, at}`, `dismissSidebar` → `onDismissSidebar`, `compact` on `ShellFrame`, and memoized `Outlet` wrapping both `renderScreen` and `renderSidebar` (issue #670 boundary).
  - Auto-merged parents: `App.tsx` still wires `openDiscover`, `useGatewayStatus`, `resetQueryCache`, and optimistic `patchConversation`; root `package.json` keeps `check:push` / `run-gates` and `perf:app-weight`; `.github/workflows/ci.yml` has the mobile `perf:app-weight` step (and desktop lane also weighs).
  - E2e: `fixtures.ts` adds `gotoPaletteNav` (`Meta+k` → dialog filter → exact row click), `PALETTE_ONLY_NAV` includes `Discover`, and `RAIL_LABEL_ALIASES` maps `Insights` → `Analytics`; `appview-templates-insights.spec.ts` 10.1/10.2/10.4 still call `gotoNav(..., "Discover")`, 11.1 calls `gotoNav(..., "Analytics")` and asserts `insights-hero`. No material e2e/merge-fix surface is omitted or mislabeled.

- **(2) Each `- [x]` item is realized in the diff** — PASS
  - [x] Merge with zero conflict markers → clean tree (see above).
  - [x] `ShellApp.tsx` keeps #667 compact drawer + #670 memoized Outlet → present on disk.
  - [x] Auto-merged `App.tsx` / `package.json` / `ci.yml` retain both intents → Discover/palette + gateway/query/optimistic paths; push gates + `perf:app-weight`.
  - [x] Desktop e2e reaches Discover via ⌘K palette → `gotoNav` delegates Discover to `gotoPaletteNav`, not a rail button.
  - [x] Desktop e2e reaches Analytics for spend hero → alias + 11.1 `gotoNav(page, "Analytics")` + `insights-hero`.

- **(3) `## Checklist` mirrors the issue/goal checklist for this merge-green work** — PASS
  - Issue/goal for #669 is merge `origin/main` into the sidebar IA PR and restore green desktop e2e navigation after #667 rail moves (Discover → palette; Insights → Analytics), without redesigning IA.
  - Receipt checklist is exactly that five-row goal set (merge cleanliness, ShellApp union resolution, auto-merge intent retention, Discover palette path, Analytics spend hero) — no extra product scope, no missing merge-green gate.

Verdict: PASS / PASS / PASS — receipt narrative, checked items, and merge-green checklist are mutually consistent with the tree.

## Steering

PASS — no human steering events in this session; the goal was fully specified (merge conflicts + green PR #669).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

### Steering
