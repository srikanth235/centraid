# @centraid/analytics

Centraid's **Insights domain** — neither the per-app engine nor the per-app run
ledger, so it lives *beside* [`@centraid/app-engine`](../app-engine) rather than
inside it (centraid#151):

- **`AnalyticsStore`** — push-based central run summaries. Implements
  app-engine's `RunSummarySink`, so `AgentRunsStore.finishRun` write-throughs
  one denormalized row per run (chat turn / automation fire / builder
  iteration) without app-engine ever importing this package. Backed by the
  central `centraid-analytics.sqlite`.
- **`InsightsStore`** — read-only aggregation over those summaries (KPIs, daily
  series, by-automation / by-model / recent-activity). The single source for
  the desktop Insights screen.
- **`analytics-db.ts`** — the `centraid-analytics.sqlite` migration ladder +
  `makeAnalyticsDbProvider`. This package owns its own schema.

## Boundary

One-way dependency: `@centraid/analytics` → `@centraid/app-engine`, never back.

- The ladder is built through app-engine's shared `makeMigratedDbProvider`, so
  this file opens with the same WAL / `busy_timeout` / FK pragmas and the same
  migrate runner as every other centraid SQLite file — app-engine stays the
  single SQLite-open seam without owning this schema.
- The run-summary contract (`RunSummary`, `RunSummarySink`) lives in app-engine
  (the ledger builds the row) and is re-exported from this barrel for
  ergonomics. app-engine emits through the injected sink and never imports back.

`UserStore` (identity) deliberately stays in app-engine: its route is mounted by
app-engine's own HTTP surface (`http-server` / `runtime`), so relocating it
would invert that seam and create a cycle. See the issue-151 receipt.

## Build / test

```sh
bun run build
bun run test
bun run typecheck
```
