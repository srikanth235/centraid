# Receipt — Issue #514: Insights v0 transparency rewrite

Issue: https://github.com/srikanth235/centraid/issues/514

## Checklist

- [x] GitHub issue with product + tech brief
- [x] Ledger honesty: items.cost_source, prefer ACP cost, chat + automation freeze
- [x] repriceLedger skips agent costs
- [x] InsightsStore rewrite (hero KPIs, by-source/runner/model, peak, attention)
- [x] Insights UI rewrite (hero, chips, honesty, deep-links)
- [x] Contracts + e2e fixture + tests
- [x] Drop fake quota

## What changed

GitHub issue with product + tech brief: https://github.com/srikanth235/centraid/issues/514

Ledger honesty: items.cost_source, prefer ACP cost, chat + automation freeze:

- `packages/app-engine/src/stores/gateway-db.ts` — cost_source column, provider on run_summary, ensure ALTER
- `packages/app-engine/src/conversation/store.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/schema.ts`
- `packages/app-engine/src/conversation/history.ts` — recordNode resolveItemCost
- `packages/app-engine/src/conversation/runner.ts` — usage costSource
- `packages/app-engine/src/http/turn-sse.ts` — keep costUsd on accumulate; agent vs estimated
- `packages/app-engine/src/model-pricing.ts` — resolveItemCost
- `packages/app-engine/src/model-pricing.test.ts`
- `packages/app-engine/src/index.ts` — export resolveItemCost
- `packages/automation/src/handler/audit.ts` — usageCloseFields + closeRunNode cost freeze
- `packages/blueprints/kit/turn-stream.d.ts`

repriceLedger skips agent costs:

- `packages/app-engine/src/conversation/reprice.ts`
- `packages/app-engine/src/conversation/reprice.test.ts`

InsightsStore rewrite (hero KPIs, by-source/runner/model, peak, attention):

- `packages/app-engine/src/insights/insights-store.ts`
- `packages/app-engine/src/insights/insights-sql.ts`
- `packages/app-engine/src/insights/insights-types.ts`
- `packages/app-engine/src/insights/insights-store.test.ts`
- `packages/app-engine/src/insights/index.ts`
- `packages/app-engine/src/insights/README.md`
- `packages/app-engine/src/conversation/archive/digest-parity.test.ts` — bySource rename

Insights UI rewrite (hero, chips, honesty, deep-links):

- `packages/client/src/react/screens/InsightsScreen.tsx`
- `packages/client/src/react/screens/InsightsScreen.module.css`
- `packages/client/src/react/screens/InsightsScreen.test.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.test.tsx`
- Drop fake quota (no quotaTokens / INSIGHTS_QUOTA_TOKENS on surface)

Contracts + e2e fixture + tests:

- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/react/shell/App.test.tsx`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`

CI follow-up (oxlint `no-zero-fractions` on PR static):

- Replace `N.0` with `N` in Insights unit/e2e fixtures:
  - `packages/client/src/react/shell/routes/InsightsRoute.test.tsx`
  - `packages/client/src/react/screens/InsightsScreen.test.tsx`
  - `packages/app-engine/src/insights/insights-store.test.ts`
  - `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`

## Out of scope

- Provider invoice import, multi-currency, real billing quotas
- Repricing digests, CSV export, context-window meters on Insights

## Decisions

- Prefer agent/ACP USD over LiteLLM catalog when both could apply; catalog is labeled estimated only.
- No fake 8M token quota — incomplete data uses floor language (“at least”).
- Split InsightsStore SQL/types into sibling files to stay under repo-hygiene line limit.
- Digests remain total-only (no cost_source split); provenance KPIs are live-arm.

## Verification

```
bun run --filter @centraid/app-engine test -- src/insights src/conversation/reprice.test.ts src/conversation/history.test.ts src/conversation/archive/digest-parity.test.ts src/model-pricing.test.ts
bun run --filter @centraid/client test -- src/react/screens/InsightsScreen.test.tsx src/react/shell/routes/InsightsRoute.test.tsx
bun run --filter @centraid/app-engine typecheck
bun run --filter @centraid/client typecheck
bun run --filter @centraid/automation typecheck
bunx oxlint .
bun run check:pr
```

## Audit

**Check 1 — What changed faithfully describes the diff**
PASS – Tree matches the receipt’s major surfaces: gateway-db `cost_source` + run_summary provider, conversation write/reprice/history/turn-sse/model-pricing, automation audit freeze, insights-store/sql/types rewrite, InsightsScreen/Route/CSS/tests, and client contracts/API/e2e fixture.

**Check 2 — All checked checklist items are realized in the diff**
PASS – Every `[x]` item is present in code: issue #514 brief; `cost_source`/`resolveItemCost`/ACP-prefer freeze on chat + automation; reprice skips `agent`; InsightsStore KPIs/bySource/byRunner/byModel/peak/attention; UI hero/chips/honesty/deep-links; contracts + tests; no `INSIGHTS_QUOTA_TOKENS`/quotaTokens on Insights surface.

**Check 3 — Checklist mirrors the issue**
PASS – Checklist tracks issue #514 acceptance: ledger honesty (agent vs estimated), reprice non-clobber, Insights payload + UI transparency rewrite, drop fake quota, and tests/contracts for the v0 end-to-end path.

## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**
PASS – No interrupt or mid-task correction events occurred; the session was sequential product evaluation → implement-from-scratch + create issue. Zero steering rows required.

**Check 2 — no non-steering message is recorded as a steering event**
PASS – No false-positive steering rows exist; Accounting ### Steering table is absent/empty because there were no steering events.
