# issue-151 — land app-engine on its charter

GitHub issue: [#151](https://github.com/srikanth235/centraid/issues/151)

`app-engine` had drifted into a grab-bag. Its charter — restated in #149 —
is narrow: *the per-app engine + the shared agent-run ledger*. But it still
hosted app creation (`scaffold*` / `clone`), gateway-wide reporting
(`analytics-store` / `insights-store`), and identity (`user-store`) — none
of which are per-app engine or the run ledger. This relocates them so the
package boundary matches the charter, in two moves: one rename-and-fold and
one new package.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Move A — fold scaffold/clone into renamed `@centraid/app-blueprints`
- [x] Move B — extract `@centraid/analytics` behind a `RunSummarySink` seam

## What changed

### Move A — fold scaffold/clone into renamed `@centraid/app-blueprints`

App creation is *how a new app comes into being*, not *how an app runs*. It
only landed in app-engine as an `agent-harness` refugee (#145) and has zero
coupling to engine core — the six files import only each other, node, and
`@centraid/design-tokens`. Meanwhile the two halves of "instantiate an app"
were split across packages and stitched together by hand in the gateway:
`app-templates` produced the source (`templateSourceDir` / `resolveTemplates`)
and `clone.ts` consumed it. Both depended on only `design-tokens`, so they
fold into one home.

- Renamed `@centraid/app-templates` → `@centraid/app-blueprints` (a blank
  scaffold and a cloned template are both blueprints you instantiate). The
  bundled template gallery + remote-fetch resolver stay; the package now also
  owns blank-app scaffolding.
- Moved `scaffold{,-files,-defaults,-types}.ts`, `clone.ts`, `app-rewrites.ts`
  (+ the `scaffold-files` / `clone` / `update-app-meta` tests) from app-engine
  into app-blueprints and exported them from its barrel. Dropped the
  scaffold/clone re-exports and the now-unused `@centraid/design-tokens`
  dependency from app-engine.
- Repointed consumers: gateway lifecycle routes (merged the templates +
  scaffold imports into a single `@centraid/app-blueprints` import) and
  `automation/scaffold-automation` (split: `isValidAppId` stays on app-engine,
  `AppScaffoldError` / `ScaffoldFile` / `AppInfo` → app-blueprints). Added the
  workspace dependency to gateway + automation.
- Updated `.oxlintrc` ignore paths, the docs, and prose/grounding references
  (skills `ui-grounding`, desktop comments) to the new package name; fixed the
  broken relative links in the issue-64 receipt that pointed at the old path.

Acyclic by construction: app-blueprints depends only on `design-tokens`, and
no app-engine module references the moved files.

### Move B — extract `@centraid/analytics` behind a `RunSummarySink` seam

`AnalyticsStore` (push-based central run summaries) and `InsightsStore`
(read-only aggregation over them) are the **Insights domain** — gateway-wide
reporting over `centraid-analytics.sqlite`, neither the per-app engine nor the
per-app run ledger. Their only inward edge was `AgentRunsStore`'s best-effort
write-through, and it was `import type` + a single method (`recordRunSummary`) —
a seam, not a coupling.

- New `@centraid/analytics` (depends on `@centraid/app-engine`, never back).
  Moved `analytics-store.ts` + `insights-store.ts` (+ their tests) into it, and
  the `centraid-analytics.sqlite` migration ladder + `makeAnalyticsDbProvider`
  (`analytics-db.ts`) — so the package owns its own schema, not just its logic.
- Added `run-summary-sink.ts` to app-engine defining `RunSummary` (the row the
  ledger builds) and `RunSummarySink { recordRunSummary(s) }`. `AgentRunsStore`
  and `ChatHistoryStore` now hold a `RunSummarySink` instead of importing
  `AnalyticsStore`, so app-engine no longer references its own reporting
  consumer. `AnalyticsStore implements RunSummarySink`; the host injects it —
  the same pattern as `ChatRunner` / `AutomationHost`.
- Exported app-engine's shared SQLite-open primitive as `openMigratedDb` /
  `makeMigratedDbProvider` (previously private `openDb` / `makeProvider`).
  `@centraid/analytics` builds its provider through `makeMigratedDbProvider`, so
  app-engine stays the single place every centraid SQLite file is opened with
  the load-bearing WAL / `busy_timeout` / FK pragmas and the shared migrate
  runner — *without* owning the analytics schema. app-engine's `gateway-db.ts`
  drops to two ladders (gateway identity + per-app runtime ledger).
- Repointed consumers (`gateway` serve + automations-routes, `automation` fire,
  `agent-runtime` run-automation-local, `openclaw-plugin`) to import
  `AnalyticsStore` / `InsightsStore` / `makeAnalyticsDbProvider` from
  `@centraid/analytics`; `RunSummary` stays on `@centraid/app-engine`. Added the
  workspace dep to those four packages.

The package earns its existence by owning a coherent domain end-to-end (schema +
store + read API), with a build-enforced one-way edge — not a thin logic-only
shim. (`@centraid/stores` was the working name while identity was a candidate to
join; once `UserStore` had to stay, `analytics` became the honest name.)

## Out of scope

- **`UserStore`** (identity) stays in app-engine. Its route is mounted by
  app-engine's own HTTP surface (`http-server` / `runtime` hold it directly),
  so relocating it to a package that depends on app-engine would invert that
  seam and create a cycle. It is the "minor / defer" cluster from the audit;
  the gateway migration ladder stays with it (app-engine keeps the gateway +
  runtime ladders; only the analytics ladder moved out).
- **Chat** (`chat-history*`, `chat-routes`, `chat-runner`, `chat-transcript`)
  stays in app-engine. A chat turn *is* a `runs` row in the same
  `runtime.sqlite` as the ledger, discriminated by `RunKind` — the
  persistence genuinely is the ledger, which does not move.
- The **runtime** migration ladder in `gateway-db.ts` stays — it is the
  genuine agent-run ledger.
- `deregister-cleanup.ts` stays — registry lifecycle, no DB.
- `model-pricing.ts` stays — frozen into `run_nodes.cost_usd` at write time,
  so it is ledger-internal.

## Verification

- `turbo typecheck` — clean across all 21 tasks.
- `turbo test` (bounded concurrency) — all 18 packages green: analytics 13,
  app-blueprints 37, automation 59, agent-runtime 59, app-engine 306,
  gateway 62, openclaw 6, skills 6. (Under unbounded `turbo test` the
  subprocess-spawning gateway/app-engine suites can flake on machine-resource
  contention; they pass standalone and at `--concurrency=2`.)
- `oxlint` + `oxfmt --check` — clean.
