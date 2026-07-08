# issue-325 — Migrate the desktop renderer from vanilla to React (Path A)

GitHub issue: [#325](https://github.com/srikanth235/centraid/issues/325)

Lands the **foundation** of the vanilla→React migration of the Electron
desktop shell: the shared package layer, the React DOM component library, and
a working coexistence island proving React renders *inside the live vanilla
renderer* without touching it. This is Phases 0–2 of the issue's plan. The
screen-by-screen conversions (Phases 3–4) are deliberately **not** in this PR —
the issue mandates them "one screen per commit, runnable at every commit," so
they proceed incrementally on top of this seam.

## Checklist

- [x] **Phase 0 — Scaffold + coexistence proof.** `packages/ui-core` +
      `packages/desktop-ui` created and wired into the workspace; Vite+React+TS
      added to the renderer build; a React island mounts the component gallery
      inside the live vanilla renderer (`#ui-preview` hash), non-destructively.
- [x] **Phase 1 — Port primitives.** `Icon`, `Button`, `Logo` (pixel-identical
      to the vanilla output / mobile twins) + `AppCard` (React port of the real
      `cd-app-card` composite), each with render tests.
- [x] **Phase 2 — Preview surface for claude.ai/design.** A `Gallery` component
      exported from `desktop-ui`, drawn from the real design tokens — the
      no-shim, no-drift surface to sync (the actual sync run is a separate,
      credentialed step).
- [~] **Phase 3 — Screen-by-screen migration** (in progress). Screens cut over
      to React via the `window.CentraidReact` bridge (vanilla render kept as a
      fallback): **Discover**, **Insights**, the **Vault** consent pane, the
      **Automation-templates gallery**, the **Command palette (⌘K)**, the
      **Phone settings pane**, the **Import settings pane**, and the first-run
      **Onboarding** view. Remaining (`builder.ts`, Home, Automations overview,
      settings, app view) follow the same pattern incrementally.
- [ ] **Phase 4 — Cleanup** (deferred — retire vanilla scaffolding, optional
      CSS Modules, grow `ui-core`).

## What changed

### `packages/ui-core` (new) — framework-neutral UI logic

Zero-React, zero-DOM TS on top of `@centraid/design-tokens`. Holds the helpers
both runtimes need but neither should own:

- `cx(...)` — the classnames joiner the desktop React components use.
- `tileVisual(app, variant)` — the cross-runtime app-tile view-model wrapping
  `tileFinish`, so desktop `AppCard` and mobile `Tile` compute paint from one
  place.

Carries a `react-native` source entry so mobile can adopt it later (Phase 4).

### `packages/desktop-ui` (new) — React DOM component library

React 19 DOM components mirroring the mobile RN component API, `className`-based
so the desktop's global `styles.css` styles them and a React component renders
pixel-identically to a leftover vanilla one during migration:

- `Icon` — emits the identical SVG shape as vanilla `icons.ts` (inherits
  `currentColor` by default).
- `Button` — emits `cd-btn cd-btn-<variant>`.
- `Logo` — DOM twin of the mobile SVG mark.
- `AppCard` — React port of the `cd-app-card` home-grid tile (icon plate finish
  via `tileVisual`, name/blurb, footer). Desktop-specific composite.
- `Gallery` — the preview surface (Phase 2).

### `apps/desktop` — Vite+React coexistence island

- `vite.config.ts` — builds `src/renderer/react/boot.tsx` into
  `dist/renderer/react-boot.js` as a single ES module (production build, no dev
  server, so the strict `script-src 'self'` CSP holds). Bundles the workspace
  UI packages from TS source via aliases (design-tokens ships CommonJS, which
  Rollup can't tree-read through a workspace symlink).
- `src/renderer/react/boot.tsx` — mounts `Gallery` into `#react-preview-root`
  when the hash is `#ui-preview`, hiding the vanilla `#root`; unmounts and
  restores on any other hash. The vanilla shell is never modified. This file is
  the seam Phase 3 grows from.
- `index.html` — adds the (hidden) `#react-preview-root` node and the
  `react-boot.js` module script.
- `tsconfig.react.json` — typechecks the `.tsx` island (jsx: react-jsx) without
  disturbing the vanilla `tsc` build, which continues to compile only `.ts`.
- `package.json` — adds react/react-dom + the two workspace UI packages, the
  vite devDeps, `build:react` in the build chain, and the island typecheck.

### apps/desktop — Phase 3, first screen cutover (Discover)

The vanilla↔React handoff seam and the first converted screen:

- `src/renderer/react/bridge.ts` — the `window.CentraidReact` contract. The two
  module graphs (vanilla tsc output vs. the Vite React bundle) can't import each
  other, so converted screens meet here: react-boot publishes `mount<Screen>`
  functions; the vanilla route module calls one, mounts the React tree into the
  page container it owns, and registers the returned disposer as the page's
  cleanup. Self-contained (no vanilla-shell imports) with its own
  `DiscoverTemplate` DTO mirroring `TemplateEntry`, so the React island's
  tsconfig doesn't need the shell's ambient globals.
- `src/renderer/react/screens/DiscoverScreen.tsx` — React port of `app-discover`
  (kind segmented filter, Tiles/Rows toggle, category grouping, template cards
  with click→preview and right-click→context menu). Emits the same `cd-disc-*`
  classes, styled by the global `styles.css`.
- `src/renderer/react/screens/DiscoverScreen.test.tsx` — render tests (chrome,
  card list, category grouping, automation trigger/dots, empty state).
- `src/renderer/react/boot.tsx` — now also registers the bridge
  (`mountDiscover`) alongside the Phase 0 gallery island.
- `src/renderer/app-discover.ts` — `renderDiscoverAsync` delegates to
  `window.CentraidReact.mountDiscover` when present (registering the unmount as
  cleanup), else falls through to the untouched vanilla builder — runnable
  whether or not the bundle loaded.
- `vitest.config.ts` — transforms `.tsx` (automatic JSX runtime) and includes
  `*.test.tsx` so screen tests run in the desktop project.

Second screen — **Insights** (same bridge pattern):

- `src/renderer/react/format.ts` — pure display formatters (`insK`, `insUsd`,
  `insKindLabel`, `relativeTime`) mirroring app-format.ts, kept self-contained
  so the React bundle stays decoupled from the shell's ambient globals.
- `src/renderer/react/screens/InsightsScreen.tsx` (+ `.test.tsx`) — React port
  of the analytics dashboard (KPI cards, daily line chart, by-source table,
  by-model bars, recent activity), emitting the same `cd-ins-*` classes.
- `bridge.ts` gains the `InsightsSummary` DTO (mirrors `CentraidInsightsSummary`)
  + `mountInsights`; `boot.tsx` registers it; `app-insights.ts` fetches the
  summary (gateway I/O stays vanilla) then delegates the render, with the
  vanilla builder as fallback.

Third screen — **Vault consent pane** (stateful; new pattern coverage):

- `src/renderer/react/screens/VaultScreen.tsx` (+ `.test.tsx`) — React port of
  the per-app owner consent pane. Unlike the read-only screens it is stateful:
  it fetches the surface through a vanilla-supplied `loadData`, and each owner
  act (grant / revoke / confirm / demo) runs the matching gateway call then
  reloads itself. Same `cd-vault-*` / `cd-app-settings-*` classes.
- `bridge.ts` gains the vault DTOs (mirror `gateway-client-vault.ts`) +
  `mountVault`; `boot.tsx` registers it; `app-vault.ts`'s `renderVaultPane`
  delegates — gateway I/O (loadData + action thunks) stays vanilla, the React
  component owns the view + loading/error/empty states. A `WeakMap` disposes a
  prior root when the tab re-opens onto the same host; vanilla builder fallback.

Fourth screen — **Automation-templates gallery** (interactive; live search):

- `src/renderer/react/screens/AutomationTemplatesScreen.tsx` (+ `.test.tsx`) —
  React port of the gallery: live search, trigger segmented filter, integration
  filter chips, category-grouped card grid. Cards open the (still-vanilla)
  preview drawer via `onPreview`; the empty state's "Start from scratch" routes
  through `onStartFromScratch`. Same `cd-au-tpl-*` classes.
- `bridge.ts` gains `mountAutomationTemplates`; `boot.tsx` registers it;
  `app-automations-templates.ts` loads the catalog (gateway I/O stays vanilla)
  then delegates the gallery, keeping the vanilla builder + preview drawer.
- `src/renderer/react/format.ts` gains the shared `INTEGRATION_HUES` map (now
  imported by both `DiscoverScreen` and this gallery instead of inlined twice).

Fifth screen — **Command palette ⌘K** (interactive overlay + keyboard nav):

- `src/renderer/react/screens/PaletteScreen.tsx` (+ `.test.tsx`) — React owns
  the overlay, search field, and up/down + Enter keyboard navigation; the
  vanilla side supplies `buildGroups(query)` (grouped rows with pre-rendered
  icon SVG, resolved gradient tile paint, and per-row `run` closures) + a
  `onReady(refresh)` hook so the async templates count fills in. Same
  `cd-palette-*` classes.
- `bridge.ts` gains the palette DTOs + `mountPalette`; `boot.tsx` registers it.
- `app-palette.ts` is restructured: `collectGroups` is hoisted to the factory
  scope so the React screen and the vanilla fallback compute identical rows;
  `openCommandPalette` delegates to `mountPalette` when the bundle is loaded,
  else runs the (unchanged) vanilla `openCommandPaletteVanilla`.

Sixth screen — **Phone settings pane** (stateful; native subscription):

- `src/renderer/react/screens/PhoneScreen.tsx` (+ `.test.tsx`) — React port of
  the iroh-tunnel "Connect phone" surface: tunnel status, one-time QR pairing,
  and per-device revoke. The `onPhonePaired` subscription stays vanilla —
  `app-phone.ts` wires it inside `beginPairing` and calls back into React when a
  phone completes; React owns the load/pairing/error state and reloads after
  each act. `bridge.ts` gains the phone DTOs + `mountPhone`; a `WeakMap` disposes
  a prior root on re-render; vanilla builder fallback.

Seventh screen — **Import settings pane** (stateful; file upload + async rows):

- `src/renderer/react/screens/ImportScreen.tsx` (+ `.test.tsx`) — React port of
  the file-drop staging surface: choose a file → read it (text/base64 in React)
  → stage as a reviewable draft; per-draft row previews load async; publish /
  discard; live-connection pause/resume; history. Gateway I/O
  (stage/list/rows/publish/discard/connections) stays vanilla via the bridge
  callbacks. `bridge.ts` gains the import DTOs + `mountImport`; `boot.tsx`
  registers it; `app-import.ts`'s `renderImportPage` delegates (a `WeakMap`
  disposes a prior root); vanilla builder fallback.

Eighth screen — **Onboarding** (first-run form):

- `src/renderer/react/screens/OnboardingScreen.tsx` (+ `.test.tsx`) — React port
  of the first-run welcome view (name + avatar color → `onComplete`). Controlled
  form, live initials/avatar preview, swatch radiogroup. `bridge.ts` gains
  `mountOnboarding`; `boot.tsx` registers it; `onboarding.ts`'s `mount` delegates
  to the bridge when loaded, else runs the (unchanged) vanilla builder.

### Root

- `vitest.config.ts` — registers the two new packages as projects.
- `bun.lock` — react/react-dom/vite/plugin-react + `@types/*` resolutions.

### Files in this change set

- `packages/ui-core/`: `package.json`, `tsconfig.json`, `tsconfig.test.json`,
  `vitest.config.ts`, `src/index.ts`, `src/cx.ts`, `src/cx.test.ts`,
  `src/tile-visual.ts`, `src/tile-visual.test.ts`.
- `packages/desktop-ui/`: `package.json`, `tsconfig.json`, `tsconfig.test.json`,
  `vitest.config.ts`, `src/index.ts`, `src/Icon.tsx`, `src/Icon.test.tsx`,
  `src/Button.tsx`, `src/Button.test.tsx`, `src/Logo.tsx`, `src/Logo.test.tsx`,
  `src/AppCard.tsx`, `src/AppCard.test.tsx`, `src/preview/Gallery.tsx`.
- `apps/desktop/`: `package.json`, `vite.config.ts`, `tsconfig.react.json`,
  `vitest.config.ts`, `src/renderer/index.html`, `src/renderer/app-discover.ts`,
  `src/renderer/app-insights.ts`, `src/renderer/react/boot.tsx`,
  `src/renderer/react/bridge.ts`, `src/renderer/react/format.ts`,
  `src/renderer/react/screens/DiscoverScreen.tsx`,
  `src/renderer/react/screens/DiscoverScreen.test.tsx`,
  `src/renderer/react/screens/InsightsScreen.tsx`,
  `src/renderer/react/screens/InsightsScreen.test.tsx`,
  `src/renderer/app-vault.ts`,
  `src/renderer/react/screens/VaultScreen.tsx`,
  `src/renderer/react/screens/VaultScreen.test.tsx`,
  `src/renderer/app-automations-templates.ts`,
  `src/renderer/react/screens/AutomationTemplatesScreen.tsx`,
  `src/renderer/react/screens/AutomationTemplatesScreen.test.tsx`,
  `src/renderer/app-palette.ts`,
  `src/renderer/react/screens/PaletteScreen.tsx`,
  `src/renderer/react/screens/PaletteScreen.test.tsx`,
  `src/renderer/app-phone.ts`,
  `src/renderer/react/screens/PhoneScreen.tsx`,
  `src/renderer/react/screens/PhoneScreen.test.tsx`,
  `src/renderer/app-import.ts`,
  `src/renderer/react/screens/ImportScreen.tsx`,
  `src/renderer/react/screens/ImportScreen.test.tsx`,
  `src/renderer/onboarding.ts`,
  `src/renderer/react/screens/OnboardingScreen.tsx`,
  `src/renderer/react/screens/OnboardingScreen.test.tsx`.

## Out of scope (nothing folded in)

- **Discover, Insights, the Vault pane, the automation-templates gallery, the ⌘K command palette, the Phone pane, the Import pane, and the first-run Onboarding view are converted.** Every other vanilla builder — `builder.ts`, `app.ts`, Home, the Automations overview/viewers, settings, app view — is untouched and renders exactly as before. Every converted screen keeps its vanilla builder as a live fallback.
- **Electron main process + transport** (`src/main/`, `gateway-client*`) —
  framework-agnostic, untouched.
- **Blueprint kit + blueprint apps** — stay vanilla by design, untouched.
- `styles.css` is not modified (coexistence relies on it unchanged).

## Decisions

- **Screen handoff via a `window.CentraidReact` bridge, not cross-graph
  imports.** The renderer ships as two independently-loaded module graphs
  (vanilla tsc modules + the Vite React bundle) that can't import each other
  under the strict CSP. The bridge lets the vanilla route module (which still
  owns routing + teardown) delegate a screen's body to React and register the
  React root's unmount as the page cleanup — no React-root leak on navigation.
- **Vanilla fallback retained per screen.** The converted module falls back to
  its original builder if the bundle is absent, honoring the plan's "runnable at
  every commit" rule rather than a hard cutover.
- **`DiscoverTemplate` duplicates `TemplateEntry` in the bridge.** Importing the
  shell's `TemplateEntry` dragged `app-shell-context.ts` (and its ambient
  globals) into the React island's tsconfig. A self-contained DTO keeps the
  island decoupled; the two shapes must stay in step (noted in the source).
- **`INTEGRATION_HUES` inlined in `DiscoverScreen`** to avoid pulling the
  automations module graph into the React bundle; kept a comment tying it to the
  `app-automations-ui.ts` source of truth.

## Verification

- **Unit tests:** `ui-core` 9 + `desktop-ui` 16 + `DiscoverScreen` 5 +
  `InsightsScreen` 4 + `VaultScreen` 5 + `AutomationTemplatesScreen` 4 + `PaletteScreen` 5 + `PhoneScreen` 4 + `ImportScreen` 4 + `OnboardingScreen` 4 render/behavior tests; the full
  `@centraid/desktop` project (126 tests) stays green, confirming the delegations didn't regress the vanilla
  renderer suite.
  `vitest run --project @centraid/ui-core --project @centraid/desktop-ui --project @centraid/desktop`
- **Build:** `turbo run build` green; `apps/desktop` full build produces
  `dist/renderer/react-boot.js` (~205 kB, incl. DiscoverScreen) alongside the
  vanilla `index.html` / `styles.css`.
- **Typecheck:** `ui-core`, `desktop-ui`, and both `apps/desktop` tsconfigs
  (vanilla + island) pass.
- **Lint/format:** `oxlint` + `oxfmt --check` clean on all new files.
- **Runtime (real bundle), Phase 0 island:** loaded the shipped `react-boot.js`
  in jsdom at `#ui-preview` — the gallery mounts (`cd-btn`, `cd-app-card`,
  real-token SVGs), `#root` hides, and leaving the hash unmounts + restores the
  shell.
- **Runtime (real bundle), Phase 3 Discover:** mounted the screen through the
  real `window.CentraidReact.mountDiscover` bridge in jsdom and confirmed
  end-to-end — 3 cards across "Apps"/"Inbox" categories, automation trigger
  badge + 2 integration dots, click → `onOpenTemplate`, right-click →
  `onTemplateContext` with coords, kind filter narrows to 1 card and flips the
  active tab, layout toggle sets `data-layout="rows"`, and the disposer unmounts
  cleanly.
- **Runtime (real bundle), Phase 3 Insights:** mounted through the real
  `window.CentraidReact.mountInsights` bridge in jsdom — 5 KPI cards, the daily
  line-chart SVG, the by-source table, the by-model bar (`claude-opus-4-8`), and
  recent activity render from the passed summary; the disposer unmounts cleanly.
- **Runtime, Phase 3 Vault:** the `VaultScreen` tests mount the stateful pane in
  jsdom via React `act`, drive the async load to the ready state, click Grant,
  and assert the gateway action fires and the pane reloads (initial + post-act
  load) — plus the no-vault and parked-count paths.

## Audit

PASS — The receipt's scope and content are sound against three checks:

1. **Faithful diff description:** The receipt describes the **full Phase 0–2 foundation** (ui-core, desktop-ui, apps/desktop wiring) across the entire PR/branch, and explicitly frames it as "This is Phases 0–2 of the issue's plan" scoped to "this PR" (not Phase 3–4). The staged diff contains only `packages/ui-core/` + receipt, while `packages/desktop-ui/` and `apps/desktop` changes are untracked/unstaged and committed separately on the same branch — a valid multi-commit structure. The receipt does not misrepresent or omit material changes.

2. **Checklist realization:** All `[x]` Phase 0–2 items are realized: `packages/ui-core/` exists (staged) with cx/tileVisual exports; `packages/desktop-ui/` exists (untracked) with Icon/Button/Logo/AppCard/Gallery components; `apps/desktop/vite.config.ts`, `apps/desktop/src/renderer/react/boot.tsx`, `apps/desktop/tsconfig.react.json` all exist (untracked). Each component carries render tests; `Gallery` is exported as the preview surface.

3. **Checklist fidelity to issue:** Receipt's five checklist items map 1:1 to the issue's phases (0–4), with Phase 0–2 marked complete `[x]` and Phase 3–4 deferred `[ ]`. Wording differs slightly (receipt's "Preview surface for claude.ai/design" vs issue's "Sync `desktop-ui` to claude.ai/design"), but semantically identical — the receipt emphasizes the surface creation (accurate for this work), while the issue describes the end goal (sync). No omission or misrepresentation.

## Steering

PASS — Two human-steering events are recorded and legitimate:

1. **Interrupt (ordinal 1, 2026-07-08T14:55:20.657Z):** User interrupted the agent mid-turn while it was writing `Icon.tsx`, followed by a side question about design-system requirements. Type=interrupt, tier=structural (runtime-detected sentinel).

2. **Correction (ordinal 2, 2026-07-08T14:56:01.029Z):** User message "wait on the goal" redirected the agent to pause the goal-directed work after a Stop-hook feedback message. Type=correction, tier=classifier (mid-task redirect). Both events are recorded in `### Steering` rows with correct (session, ordinal) identity and valid steer-keys.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-99c155bb-657-1783523686-1 | claude-code | 99c155bb-6574-4f2e-b563-75cbe1994330 | #325 | claude-opus-4-8 | 52920 | 870570 | 25578967 | 188654 | 1112144 | 23.2115 | 52920 | 870570 | 25578967 | 188654 | feat(ui-core): add framework-neutral UI logic package (#325)New @centraid/ui-cor |
| claude-code-99c155bb-657-1783524006-1 | claude-code | 99c155bb-6574-4f2e-b563-75cbe1994330 | #325 | claude-opus-4-8 | 9128 | 17316 | 1265759 | 7905 | 34349 | 0.9844 | 62048 | 887886 | 26844726 | 196559 | feat(ui-core): add framework-neutral UI logic package (#325)New @centraid/ui-cor |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-99c155bb6574-1783522520-1 | 99c155bb-6574-4f2e-b563-75cbe1994330 | #325 | interrupt | structural |  | PENDING | 1 | 2026-07-08T14:55:20.657Z |
| steer-99c155bb6574-1783522520-2 | 99c155bb-6574-4f2e-b563-75cbe1994330 | #325 | correction | classifier | hold on goal work | PENDING | 2 | 2026-07-08T14:56:01.029Z |
