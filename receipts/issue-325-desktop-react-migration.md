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
- [ ] **Phase 3 — Screen-by-screen migration** (deferred — incremental, starts
      with `builder.ts`).
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
  `src/renderer/react/boot.tsx`, `src/renderer/index.html`.

## Out of scope (nothing folded in)

- **No renderer screen was converted.** `builder.ts`, `app.ts`, and every other
  vanilla builder are untouched; the app runs exactly as before (the island is
  invisible until you open `#ui-preview`).
- **Electron main process + transport** (`src/main/`, `gateway-client*`) —
  framework-agnostic, untouched.
- **Blueprint kit + blueprint apps** — stay vanilla by design, untouched.
- `styles.css` is not modified (coexistence relies on it unchanged).

## Verification

- **Unit tests:** 25 new tests pass (`ui-core` 9, `desktop-ui` 16) —
  `vitest run --project @centraid/ui-core --project @centraid/desktop-ui`.
- **Build:** `turbo run build` green for both packages; `apps/desktop` full
  build produces `dist/renderer/react-boot.js` (199 kB) alongside the vanilla
  `index.html` / `styles.css`.
- **Typecheck:** `ui-core`, `desktop-ui`, and both `apps/desktop` tsconfigs
  (vanilla + island) pass.
- **Lint/format:** `oxlint` + `oxfmt --check` clean on all new files.
- **Runtime (real bundle):** loaded the shipped `react-boot.js` in jsdom with
  `location.hash = '#ui-preview'` and confirmed end-to-end — the gallery mounts
  (`cd-btn`, `cd-app-card`, SVG glyphs from real tokens), `#root` is hidden, and
  clearing the hash unmounts the island and restores the shell.

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
