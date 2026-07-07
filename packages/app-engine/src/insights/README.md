# insights/ — app-engine's Insights sub-module

Centraid's **Insights domain**. Folded into `@centraid/app-engine` from the
former `@centraid/analytics` package (centraid#151), but kept behind its own
barrel (`index.ts`) and a one-way internal boundary so it stays a distinct
domain — neither the per-app engine nor the per-app run ledger.

- **`AnalyticsStore`** — a read-only lens over the vault's `run_summary`
  VIEW. `run_summary` was once a denormalized table maintained by a
  best-effort write-through at run completion; that was justified only while
  the rollup lived in a different file than the ledger. Now the ledger and
  the rollup share the vault's `journal.db`, so `run_summary` is a VIEW over
  the ledger tables (`turns ⋈ conversations`, plus each run's dominant model
  from `items`) — one row per finished run, every kind (chat turn /
  automation fire / builder iteration). No write path, no drift, nothing to
  rebuild. `getSummary` / `listSummaries` read it; mutations happen on the
  ledger tables the view derives from and are visible here immediately.
- **`InsightsStore`** — read-only aggregation over those summaries (KPIs, daily
  series, by-automation / by-model / recent-activity). The single source for
  the desktop Insights screen. Follows the active vault.

The `run_summary` view is declared in app-engine's conversation-ledger DDL
(`stores/gateway-db.ts`, `CONVERSATION_LEDGER_DDL`), alongside the tables it
reads — this sub-module owns the reporting shape, not the schema.

## Boundary

One-way internal dependency: `insights/` imports inward to the rest of
app-engine (the `DatabaseProvider` seam, the `RunSummary` DTO) and nothing in
app-engine imports back into `insights/`.

- Both stores are constructed with the vault's journal `DatabaseProvider`
  (`makeJournalDbProvider`, or the gateway's active-vault resolver), so a
  vault switch re-resolves the handle and every figure lands on the current
  vault's ledger.
- The `RunSummary` DTO lives at the app-engine package root
  (`run-summary-sink.ts`) and is exported from there directly, not
  re-exported through this barrel. (The file's name is historical — it once
  also declared a `RunSummarySink` write-through seam, deleted when
  `run_summary` became a view.)

`UserStore` (identity) deliberately stays at the app-engine root: its route is
mounted by app-engine's own HTTP surface (`http-server` / `runtime`). See the
issue-151 receipt.

## Build / test

Built and tested as part of `@centraid/app-engine` (`bun run build` /
`bun run test` / `bun run typecheck` at the package root). The insights tests
live alongside the source as `*.test.ts`.
