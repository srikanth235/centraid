# insights/ — app-engine's Insights sub-module

Centraid's **Insights domain**. Folded into `@centraid/app-engine` from the
former `@centraid/analytics` package (centraid#151), but kept behind its own
barrel (`index.ts`) and a one-way internal boundary so it stays a distinct
domain — neither the per-app engine nor the per-app run ledger.

- **`AnalyticsStore`** — push-based central run summaries. Implements
  app-engine's `RunSummarySink`, so `AgentRunsStore.finishRun` write-throughs
  one denormalized row per run (chat turn / automation fire / builder
  iteration). Backed by the central `centraid-analytics.sqlite`.
- **`InsightsStore`** — read-only aggregation over those summaries (KPIs, daily
  series, by-automation / by-model / recent-activity). The single source for
  the desktop Insights screen.
- **`analytics-db.ts`** — the `centraid-analytics.sqlite` migration ladder +
  `makeAnalyticsDbProvider`. This sub-module owns its own schema.

## Boundary

One-way internal dependency: `insights/` imports inward to the rest of
app-engine (the `DatabaseProvider` seam, the `RunSummary` / `RunSummarySink`
contract, the shared SQLite-open helper) and nothing in app-engine imports back
into `insights/`.

- The ladder is built through app-engine's shared `makeMigratedDbProvider`, so
  this file opens with the same WAL / `busy_timeout` / FK pragmas and the same
  migrate runner as every other centraid SQLite file — app-engine stays the
  single SQLite-open seam without owning this schema.
- The run-summary contract (`RunSummary`, `RunSummarySink`) lives at the
  app-engine package root (`run-summary-sink.ts`), so it is exported from there
  directly, not re-exported through this barrel. The ledger builds the row and
  emits through the injected sink; `insights/` implements it.

`UserStore` (identity) deliberately stays at the app-engine root: its route is
mounted by app-engine's own HTTP surface (`http-server` / `runtime`). See the
issue-151 receipt.

## Build / test

Built and tested as part of `@centraid/app-engine` (`bun run build` /
`bun run test` / `bun run typecheck` at the package root). The insights tests
live alongside the source as `*.test.ts`.
