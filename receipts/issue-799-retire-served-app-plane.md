# Issue #799 — retire the served-app plane and dissolve the kit layer — Centraid is a superapp

GitHub issue: [#799](https://github.com/srikanth235/centraid/issues/799)

Umbrella worked to completion in one branch by root-agent orchestration
(per AGENTS.md and docs/multi-agent.md): the root agent owned the staged
plan below and dispatched sub-agents on the stage slices, integrating at
the seams between stages. One commit per stage; each stage ran the scoped
gate loop before its commit.

## Checklist

- [x] Stage 1 — retire the mobile WebView cover (AppDetail, WebView bridge, catalog compat branches, template-gate e2e flow; relocate transfer-policy to lib/upload).
- [ ] Stage 2 — retire the client iframe + builder and gateway serving wiring (AppFrame, AppViewRoute, opaque documents, builder routes, web-app-sessions, authoring skills, scaffold/draft surfaces).
- [ ] Stage 3 — retire app-engine UI-byte serving (static-server, app-bundle, bridge-script, css-module, asset-variants, query-bundle, app router kinds, KIT_DIR wiring, visual-harness).
- [ ] Stage 4 — retire the blueprints blank-app scaffolder + template gallery (scaffold files/defaults, served half of app-rewrites, index.json, remote templates, index.html markers).
- [ ] Stage 5 — kit dissolution A: rehome the non-design kit modules to packages/client as typed TypeScript; delete the legacy Ask controller and its strangler.
- [ ] Stage 6 — kit dissolution B: fold the DOM substrate into packages/design/src as typed modules; delete the served-sibling alias apparatus; rewrite the sibling imports to package imports; land the coverage-scope-reachability amendment in the same commit as its check change.
- [ ] Stage 7 — custom-element endgame: replace JSX-emitted kit-* tags with React blocks, delete elements-base + element classes, prune orphaned kit.css rules, re-pin design-gallery baselines.
- [ ] Stage 8 — identity + decisions sweep: superapp positioning across the root docs, one app render path in ARCHITECTURE.md, decisions.md supersessions, glossary/design-machinery/traps/test-matrix updates.

## What changed

### Stage 1 — retire the mobile WebView cover (AppDetail, WebView bridge, catalog compat branches, template-gate e2e flow; relocate transfer-policy to lib/upload).

Deleted the WebView app cover `apps/mobile/src/screens/AppDetail.tsx` and the
WebView bridge `apps/mobile/src/lib/bridge/dispatch.ts`,
`apps/mobile/src/lib/bridge/injected.ts`, and
`apps/mobile/src/lib/bridge/protocol.ts`; the native upload path's
`transfer-policy.ts` + `transfer-policy.test.ts` were relocated from
`lib/bridge/` to `apps/mobile/src/lib/upload/transfer-policy.ts` and
`apps/mobile/src/lib/upload/transfer-policy.test.ts` (importers
`apps/mobile/src/lib/upload/uploader.ts` and
`apps/mobile/src/lib/upload/expo-native.ts` updated).

Screen registrations removed from `apps/mobile/App.tsx`,
`apps/mobile/lazy-screens.tsx`, `apps/mobile/src/navigation.ts`, and
`apps/mobile/src/deep-links.ts`. `apps/mobile/src/screens/home/catalog.ts`
lost its remote-app/`pair` compatibility branches plus `NATIVE_APP_IDS` and
`GATEWAY_CATALOG` (tests in `apps/mobile/src/screens/home/catalog.test.ts`);
`apps/mobile/src/lib/gateway.ts` lost `appLiveUrl()`, `listAppRegistry()`,
`isOpenableApp()`, and `AppRegistryRow` (inlined into `resolveAppMeta`'s
parameter) while keeping `appQuery()` — the RPC plane survives;
launcher consumers `apps/mobile/src/screens/home/LauncherGrid.tsx`,
`apps/mobile/src/screens/home/AllAppsSheet.tsx`,
`apps/mobile/src/screens/home/SearchOverlay.tsx`, and
`apps/mobile/src/screens/Home.tsx` dropped the dead `installed`/pair paths
(Home keeps `resolveGatewayBase` only for the offline flag).
`apps/mobile/src/lib/notifications-navigation.ts` (+
`apps/mobile/src/lib/notifications-navigation.test.ts`) lost the
`{kind:"app"}` destination arm; `apps/mobile/src/screens/Approvals.tsx`
follows. Comment-only staleness fixed in `apps/mobile/src/lib/phone-link.ts`,
`apps/mobile/src/lib/automations.ts`,
`apps/mobile/src/apps/photos/PhotosSearch.tsx`, and
`apps/mobile/src/apps/assistant/assistant-companion.ts` (companion page
label for the retired screen removed).

The `template-gate` e2e flow retired: `tests/agent-e2e-mobile/flows/template-gate.md`
and `tests/agent-e2e-mobile/flows/template-gate.mjs` deleted, with the
`scripts/lint-e2e-flows.mjs` FILES list, `.github/workflows/e2e.yml`, and
`apps/mobile/scripts/android-emulator-e2e.sh` invocation lists updated.
`tests/matrix.json` records the flow replacement: matrix flow
`mobile-native-v0-resilience` (owner
`tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`, an existing
committed flow) with `replacesMinimumTestsFlow: "mobile-template-gate"` and
an `approvedMinimumTestsDeviation`; the minimum-checks floor rose 7 → 13.

Docs: `ARCHITECTURE.md` (served plane no longer lists mobile WebViews),
`README.md`, `docs/glossary.md` (served-app row), `docs/traps/blueprint-csp.md`
(scope narrowed), `tests/agent-e2e-mobile/README.md`,
`tests/agent-e2e-mobile/AGENTS.md`.

Survivals verified: `react-native-webview` stays (sole consumer
`apps/mobile/src/apps/docs/DocumentViewer.tsx`); the app RPC plane and
tunnel (`phone-link.ts`, `resolveGatewayBase()`) untouched.

## Decisions

- **App-scoped notifications now land on the notice list, not a per-app
  screen.** `mobileNotificationsDestination`'s `{kind:"app", appId}` arm
  pushed the deleted `AppDetail`; there is no generic native per-app route
  (a native cover needs a nested-navigator target Approvals' stack does not
  compose). Routing app notices to the eight native covers would be a new
  feature (shared id → nested-route map), out of this retirement's scope.
- **`LauncherItem.installed` removed beyond the literal ask** — it was only
  ever `false` on the deleted `pair` branch; keeping it would have left a
  dead dim/"tap to pair" path in the launcher surfaces.
- **template-gate's matrix seat transferred, not vacated.** `test:ratchet`
  forbids flow deletion outright, so `tests/matrix.json` promotes the
  existing `native-v0-resilience` flow (previously only a cell owner) to a
  matrix flow with `replacesMinimumTestsFlow` and a recorded deviation; the
  declared-check floor went up (7 → 13), so the gate tightened rather than
  weakened. template-gate had short-circuited to a trivial pass because its
  own `NATIVE_ON_MOBILE` set covers all 8 `kind: "app"` templates in
  `packages/blueprints/index.json`, leaving it nothing to gate.
- **Quality-knob movement recorded through the sanctioned deviation channel**
  (`tests/quality/classification-ratchet.json`, same mechanism as #791's
  entry): "#799 stage 1 retires the mobile WebView app cover; tests/matrix.json transfers template-gate's matrix seat to the existing native-v0-resilience flow via replacesMinimumTestsFlow with the declared-check floor raised 7 -> 13, weakening no quality grade, budget, or demonstrated-red claim."
- **UI-impact evidence emitter added to the surviving flow**:
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` (companion doc
  `tests/agent-e2e-mobile/flows/native-v0-resilience.md`) now publishes its
  post-restart Home frame to
  `artifacts/e2e/ui-impact/issue-799-mobile-native-home.png`, since the
  retired template-gate flow can no longer carry mobile UI evidence.

## User impact

Mobile users see no visible change from stage 1: the launcher was already
all-native (`GATEWAY_CATALOG = []`), so the retired WebView cover was
reachable only for user-built apps — a set of size zero. App-scoped
notifications now open the notifications list instead of a (previously
empty) generic app screen.

First-run: unchanged — ticket-only onboarding still lands on the native
Home springboard; no step was added or removed.

![Mobile native Home evidence](artifacts/e2e/ui-impact/issue-799-mobile-native-home.png)

## Out of scope

- #765's shell/blueprint React DOM markup consolidation and v9 binding-layer
  revamp (stage 7 consumes existing blocks; it does not absorb that work).
- Any behavior change to the 8 apps, the replica/outbox engine, the
  automation plane (beyond keeping its clone path intact), or the
  vault/consent surface.
- Historical ledgers (CHANGELOG, COSTS, STEERING, receipts) are append-only
  and were not rewritten.

## Verification

Per-stage scoped gates; final verification before push is `bun run check:pr`.

Stage 1 (all pass; the one mobile suite failure,
`src/apps/tally/PendingRestartJourney.test.tsx` "Cannot bundle node:sqlite",
reproduces identically on a clean tree and predates this change):

```sh
bun run turbo typecheck --filter=@centraid/mobile
bun run --cwd apps/mobile test
bun run knip
bun run format:check
bun run lint
bun run lint:e2e-flows
bun run test:matrix
bun run test:ratchet
bash .governance/run.sh
bun run lint:quality-knobs
bun run check:ui-receipt
```

Two `check:push` lanes fail for environment reasons unrelated to the diff,
verified identical on a clean tree: `design:gallery` (all 22 baseline
entries mismatch uniformly under this container's substituted Playwright
headless-shell build; CI's path-gated `design-gallery` job with the pinned
browser is authoritative) and the mobile suite's pre-existing
`PendingRestartJourney.test.tsx` "Cannot bundle node:sqlite" failure. CI
remains the enforcing copy for both.

## Audit

Fresh-context sub-agent audits run per stage commit; the verdict below
reflects the latest audited change set (stage 1: mobile WebView cover
retirement).

Verdict: PASS

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | claude-code | 6773a445-74cb-5c55-9494-ec5129a0bdf9 |
