# issue-227 — Split renderer app.ts into route modules

GitHub issue: [#227](https://github.com/srikanth235/centraid/issues/227)

`apps/desktop/src/renderer/app.ts` had grown to ~8000 lines — one IIFE holding
the whole shell plus every route surface, behind a long-standing `file-size-limit`
governance waiver noting the split was pending. This breaks it into focused,
importable route modules behind a shared `ShellContext` + a late-bound entry
registry, with no behavior change. app.ts drops from 7981 → 1573 lines.

## Checklist

- [x] Introduce ShellContext + ShellEntries registry and shared types/consts (app-shell-context.ts)
- [x] Extract pure formatters into app-format.ts
- [x] Extract the Insights route into app-insights.ts
- [x] Extract the Discover + Starred routes into app-discover.ts
- [x] Extract the command palette into app-palette.ts
- [x] Extract app cards, context menu, new-app sheet, and builder entry into app-cards.ts
- [x] Extract the app view + per-app settings into app-appview.ts
- [x] Extract the settings page + share dialog into app-settings.ts
- [x] Extract the Automations surfaces into app-automations.ts and sub-modules (ui, templates, run view)
- [x] Slim app.ts to the shell core and preserve the window.Centraid surface
- [ ] Optional follow-up: split the single-automation view out of the automations orchestrator

## What changed

The architecture: app.ts keeps the mutable shell state and DOM primitives; each
route surface is a factory `createXModule(ctx)` that closes over a `ShellContext`.
Cross-module calls route through a late-bound `ctx.shell.*` registry, which keeps
the import graph acyclic. Each extracted function is re-bound to a same-named
`const` in app.ts, so the nav dispatcher and `window.Centraid` are unchanged.

- Introduce ShellContext + ShellEntries registry and shared types/consts (app-shell-context.ts) — the contract module holding the context interface, the late-bound entry registry, and shared types/consts (`AppearancePrefs`, `ShellRoute`, `TemplateEntry`, `ACCENT_PALETTE`, `GatewayProfile`).
- Extract pure formatters into app-format.ts — the stateless display helpers (`relativeTime`, `cronToHuman`, `formatDuration`, `prettyJson`, `isAutomationTemplate`, …).
- Extract the Insights route into app-insights.ts — `createInsightsModule(ctx)`.
- Extract the Discover + Starred routes into app-discover.ts — `createDiscoverModule(ctx)`.
- Extract the command palette into app-palette.ts — `createPaletteModule(ctx)` (⌘K).
- Extract app cards, context menu, new-app sheet, and builder entry into app-cards.ts — `createCardsModule(ctx)`; the context-menu DOM state is module-local.
- Extract the app view + per-app settings into app-appview.ts — `createAppViewModule(ctx)` (openApp, mountUserApp, knobs, standing orders).
- Extract the settings page + share dialog into app-settings.ts — `createSettingsModule(ctx)`.
- Extract the Automations surfaces into app-automations.ts and sub-modules (ui, templates, run view) — the orchestrator plus `app-automations-ui.ts`, `app-automations-templates.ts`, and `app-automations-runview.ts`.
- Slim app.ts to the shell core and preserve the window.Centraid surface — app.ts now holds only appearance/prefs, navigation, profiles, sidebar, Home, the shared primitives, and the ShellContext wiring + boot; `window.Centraid` is reconstructed byte-identical.

Each route module over 500 lines carries a `file-size-limit` governance waiver
(`route-module #227`) in its first ten lines; the original app.ts waiver is moved
into the first ten lines after its header comment grew.

## Out of scope

- No behavior, styling, or feature change — pure structural extraction.
- The single-automation view still lives inside the automations orchestrator
  (app-automations.ts, ~889 lines); splitting it into its own module is the one
  unchecked follow-up above.
- No changes to `builder.ts` / `app-chat.ts` / other siblings beyond confirming
  the `window.Centraid` surface they consume is unchanged.

## Verification

- `bun run build:ts` (tsc, NodeNext) passes clean after every extraction.
- `bun run typecheck` (tsconfig.test.json) passes; `bun run test` is green (81
  unit tests).
- Full `bun run build` passes; the e2e suite (pre-existing-broken in this
  environment) reaches the identical boot-parity point as the unmodified
  baseline, so the refactored renderer boots and renders the same.
- The window.Centraid surface is byte-identical — every `window.Centraid.*` call
  site in `builder.ts` and `app-chat.ts` still resolves.
- Slim app.ts to the shell core and preserve the window.Centraid surface:
  confirmed app.ts is 1573 lines (was 7981) and the exported object matches.
