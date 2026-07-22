# insights/ — app-engine's Insights sub-module

Centraid's **Insights domain** — transparency and control over agent usage
(issue #514 rewrite). Folded into `@centraid/app-engine` from the former
`@centraid/analytics` package (#151).

- **`AnalyticsStore`** — read-only lens over the vault's `run_summary` VIEW.
- **`InsightsStore`** — aggregates for the desktop Insights screen: spend
  floors, agent-reported vs estimated cost, unpriced/unreported counts,
  by-source / by-runner / by-model, peak day, attention callout.

## Product rules

1. Prefer ACP/agent-reported USD when present; catalog estimates are labeled.
2. Unknown ≠ free (`unpricedRuns`, `unreportedRuns`).
3. Totals are floors when data is incomplete.
4. No fake subscription quota.

## Boundary

One-way: `insights/` imports inward to app-engine; nothing imports back.
Both stores take the vault's journal `DatabaseProvider`.
