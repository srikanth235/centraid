# Receipt — Issue #445: Honest model pricing: live catalog + repricing backfill

Issue: https://github.com/srikanth235/centraid/issues/445

## Checklist

- [x] Pricing catalog module: bundled LiteLLM snapshot + disk-cached TTL fetch + in-memory table; model-pricing.ts keeps costForUsage shape and NULL-for-unknown semantics
- [x] Model-id normalization + boundary-safe matching (provider/Bedrock prefixes, date suffixes)
- [x] Cache-read/write priced from catalog fields (5m default; _above_1hr honored when present)
- [x] Snapshot refresh script + committed filtered snapshot
- [x] Bounded repricing backfill for items/turns after catalog updates
- [x] Insights unpriced-run count surfaced
- [x] Tests: current Anthropic price anchors, matching edges, unknown stays NULL, backfill idempotence + turn re-derivation, offline fallback

## What changed

### Pricing catalog module: bundled LiteLLM snapshot + disk-cached TTL fetch + in-memory table; model-pricing.ts keeps costForUsage shape and NULL-for-unknown semantics

The frozen 6-prefix `PRICE_TABLE` (stale rates, $0 for every uncovered model) is replaced by a layered catalog in the ccusage/CodexBar shape:

- `packages/app-engine/src/pricing/types.ts` — `PricingEntry` with verbatim LiteLLM per-token field names + `PricingCatalog`.
- `packages/app-engine/src/pricing/catalog.ts` — in-memory table seeded from the committed snapshot (read as data via `readFileSync`, not a module import), `setPricingCatalog` overlay for the gateway's fresher fetch (an empty overlay never clobbers), synchronous `lookupEntry`.
- `packages/app-engine/src/pricing/litellm-snapshot.json` — committed filtered snapshot (21 KB, 96 models: 23 anthropic incl. claude-fable-5/opus 4–4.8/sonnet 3.7–4.6/haiku, 73 openai gpt/codex) with `$source`/`$note` MIT attribution to BerriAI/litellm.
- `packages/app-engine/src/model-pricing.ts` — rewritten but keeps its filename, public API (`costForUsage`, `priceForModel`, `ModelPrice`, `TokenUsage`) and the NULL-for-unknown header; delegates to `pricing/*`; stays the single `no-hardcoded-model-ids` allowlisted seam (and now holds no literal ids itself). The two call sites (`packages/app-engine/src/http/turn-sse.ts` SSE seam, `packages/app-engine/src/conversation/history.ts` recordNode freeze) are unchanged.
- `packages/gateway/src/serve/pricing-warmer.ts` — live LiteLLM fetch (10s timeout, 8 MB cap), filtered identically via the shared filter, written to `model-pricing.json` (path via `packages/gateway/src/paths.ts` + `packages/gateway/src/cli/paths.ts`), 24h TTL stale-while-revalidate; failure keeps last-good disk cache, else the bundled snapshot. Network is gated on a configured cache-file path (daemon/desktop set it), so the test suite makes zero external calls. Wired in `packages/gateway/src/serve/build-gateway.ts`.
- `packages/app-engine/src/index.ts` re-exports the new pricing symbols; `packages/app-engine/package.json` copies the snapshot into `dist/pricing/` at build.

### Model-id normalization + boundary-safe matching (provider/Bedrock prefixes, date suffixes)

`packages/app-engine/src/pricing/match.ts` — exact match first, then normalized (lowercase, strip `provider/` slash-prefixes, `anthropic.`/`openai.` dot-prefixes and regional Bedrock forms (`us.`/`eu.`/`apac.`/`jp.`/`au.`), `:version`/`-vN` and `-YYYYMMDD`/`-YYYY-MM-DD` suffixes), then boundary-safe longest candidate match (matches only at non-alphanumeric boundaries, so `claude-3-5` can match `claude-3-5-sonnet…` but never `claude-3-55…`). Unknown models return no entry — cost stays `undefined`/NULL, never a silent default price.

### Cache-read/write priced from catalog fields (5m default; _above_1hr honored when present)

`packages/app-engine/src/pricing/cost.ts` — `input×input_cost_per_token + output×output_cost_per_token + cacheRead×cache_read_input_token_cost + cacheWrite×cache_creation_input_token_cost`; the ledger's single cache-write bucket is treated as 5m writes (the ccusage/CodexBar fallback), falling back to `cache_creation_input_token_cost_above_1hr` when an entry carries only that; missing fields contribute 0; no 200k tiering. Also provides `entryToModelPrice` back-compat per-MTok view.

### Snapshot refresh script + committed filtered snapshot

`scripts/refresh-pricing-snapshot.ts` (dev-only, `bun scripts/refresh-pricing-snapshot.ts`) regenerates `packages/app-engine/src/pricing/litellm-snapshot.json` from the canonical LiteLLM URL through the same `packages/app-engine/src/pricing/filter.ts` `filterLiteLLM` the warmer uses (Anthropic Claude + OpenAI GPT/Codex chat families; drops image/audio/tts/realtime/fine-tune entries; keeps only the six price/provider fields).

### Bounded repricing backfill for items/turns after catalog updates

`packages/app-engine/src/conversation/reprice.ts` — `repriceLedger`: bounded (5000 scan / 1000 write caps), idempotent, resumable via a rowid cursor, SAVEPOINT-wrapped; recomputes catalog cost from frozen token counts for `items` rows (kind step/agent, model NOT NULL) wherever it differs from stored `cost_usd` (NULL-from-unknown and drifted rates alike), then re-derives each affected turn's `total_cost_usd` with the exact finishTurn SUM shape. Token columns and `conversation_digest` are never touched (digests are frozen copies — non-goal). Wired into the daily block of `packages/gateway/src/serve/vault-plane.ts` runSweep with a plane-held cursor (the warmer's TTL is 24h, so an hourly pass would almost always no-op; the steady-state drift probe is a Map lookup).

### Insights unpriced-run count surfaced

`packages/app-engine/src/insights/insights-store.ts` — KPIs gain `unpricedRuns` (finished live runs whose `total_cost_usd IS NULL`; the digest arm always carries numbers). Threaded through `packages/client/src/react/screen-contracts.ts` and `packages/client/src/centraid-api.d.ts`, rendered in `packages/client/src/react/screens/InsightsScreen.tsx` as a small "N unpriced" note in the Spent-KPI foot only when > 0, using the existing `kpiSub` styling.

### Tests: current Anthropic price anchors, matching edges, unknown stays NULL, backfill idempotence + turn re-derivation, offline fallback

- `packages/app-engine/src/model-pricing.test.ts` — rewritten: hand-computed USD expectations from the published Anthropic per-MTok anchors (claude-fable-5 10/50, claude-opus-4-8 5/25, claude-opus-4-1 15/75 legacy split, claude-sonnet-4-5 3/15, claude-haiku-4-5 1/5, gpt-5-codex 1.25/10; cache read = 0.1×, 5m write = 1.25×); matching edges (provider prefixes, `anthropic.` + regional Bedrock forms, date suffixes, boundary-safety, longest-match); unknown model stays `undefined`; `setPricingCatalog` overlay wins; snapshot import parses and covers the anchor families (offline fallback).
- `packages/app-engine/src/conversation/reprice.test.ts` — NULL-cost items priced + turn totals re-derived; drifted stale-rate items repriced; token columns untouched; second run is a no-op; caps respected; digest rows untouched.
- `packages/gateway/src/serve/pricing-warmer.test.ts` — disk-cache write/read, TTL staleness, fetch-failure fallback to last-good; zero live network in tests.
- `packages/app-engine/src/insights/insights-store.test.ts` — `unpricedRuns` counts NULL-cost finished runs, 0 when all priced.
- Rate-pinned expectations updated honestly: `packages/app-engine/src/conversation/history.test.ts` (fixture model to a snapshot-covered id, expected cost recomputed), `packages/client/src/react/screens/InsightsScreen.test.tsx`, `packages/client/src/react/shell/routes/InsightsRoute.test.tsx`, `packages/client/src/react/shell/App.test.tsx`, `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`.

## Out of scope

- Repricing already-archived `conversation_digest` rows (frozen copies of turn costs; new archives inherit correct costs; v0 dev vaults are recreated).
- Provider billing/spend APIs (CodexBar dashboards) — local computation from tokens only.
- 200k long-context tiering, batch/geo/fast-mode price modifiers.
- User-facing pricing knobs and ccusage-style cost modes (adapters never supply costUSD; calculate is the only mode).

## Decisions

- **`model-pricing.ts` keeps its filename and API** — it is the `no-hardcoded-model-ids` allowlisted seam; internals became the `pricing/` modules and the file itself now holds zero literal ids, so no new waivers were needed (the snapshot JSON is data, unscanned by the directive's source globs).
- **Warmer network is opt-in on a configured cache-file path** (mirrors the remote-templates gating): production daemon/desktop pass the path and refresh daily; the test suite performs zero external fetches. First cut fetched live during gateway tests — caught via test-log noise and fixed by the gating.
- **Backfill rides the daily sweep block**, not hourly — the catalog refreshes at most daily, and the pass is bounded + cursor-resumable so a large legacy ledger converges over a few days without a big-bang rewrite.
- **Rewriting frozen costs is sanctioned only through the backfill** — cost is derived data; token counts remain the immutable truth. The freeze-at-write comment now names the backfill as the single sanctioned rewriter.
- 1h cache-write pricing: the ledger has one cache-write bucket, so all writes price at the 5m rate (both reference tools' fallback); the `_above_1hr` field is read only when an entry lacks the 5m rate.

## Verification

```
bunx turbo run typecheck --filter=@centraid/app-engine --filter=@centraid/gateway --filter=@centraid/client
  Tasks: 25 successful
packages/app-engine full suite:          468 passed
packages/gateway isolated full suite:    706 passed | 2 skipped (zero live network calls)
packages/client insights targeted:        16 passed
packages/gateway pricing-warmer:           3 passed
bun run ci                                → exit 0 (28/28 tasks: oxfmt, oxlint, turbo typecheck, lint:types, lint:css)
```

Snapshot anchors verified against Anthropic published pricing (per-token): claude-fable-5 1e-05/5e-05 with 1e-06 cache-read and 1.25e-05 5m-write; claude-opus-4-8 5e-06/2.5e-05; claude-haiku-4-5 1e-06/5e-06.

Known flake, not a regression: the whole-monorepo `bunx turbo run test --concurrency=2` intermittently fails 4–5 heavy gateway suites under parallel load (status-admin, vault-quarantine, log rotation, draft-preview, lifecycle cron) with a different set each run; each passes in isolation and none touches pricing.

## Audit

**Check 1 — What changed faithfully describes the staged diff**
PASS – The "What changed" section names all 29 staged files (catalog types/match/cost/filter, snapshot, warmer/paths/vault-plane, reprice, insights, packaging, tests) and accurately summarizes the implementation of each component: pricing types + catalog in-memory table seeded from snapshot, matching rules (normalize → longest-match), cost formula (per-token fields + 5m cache-write), warmer disk-cache TTL, reprice bounded backfill, insights unpriced counter.

**Check 2 — All 7 checked checklist items are realized in the diff**
PASS – All items are staged and verified:
1. Pricing catalog + bundled snapshot + disk-cached warmer + model-pricing.ts public API unchanged ✓ (types.ts, catalog.ts, litellm-snapshot.json, model-pricing.ts, pricing-warmer.ts)
2. Model-id matching (normalize + boundary-safe longest-match) ✓ (pricing/match.ts)
3. Cache-read/write pricing (5m write, 1h fallback) ✓ (pricing/cost.ts)
4. Snapshot refresh script + committed snapshot ✓ (scripts/refresh-pricing-snapshot.ts, litellm-snapshot.json)
5. Bounded repricing backfill (5k scan / 1k write, cursor-resumable) ✓ (reprice.ts, wired in vault-plane.ts runSweep daily block)
6. Insights unpriced-run counter ✓ (insights-store.ts surfaces `unpricedRuns` field, threaded to UI)
7. Tests for price anchors, matching edges, unknown→NULL, backfill idempotence, offline fallback ✓ (model-pricing.test.ts, reprice.test.ts, pricing-warmer.test.ts, insights-store.test.ts, fixture updates)

**Check 3 — Checklist mirrors issue #445's checklist**
PASS – Receipt's 7-item checklist is verbatim-identical to issue #445's checklist (items ordered and worded identically).

## Steering

**Check 1 — Human steering events recorded in Accounting steering table**
FOUND ONE STEERING EVENT – 2026-07-17T15:27:19.304Z, user message: "the pricing problem is not solved for insights...pleas take a look at https://codexbar.app/ and https://github.com/ccusage/ccusage to solve for pricing...solve the cost problem in insights. act as orchestrator and spawn opus subagents". This is a mid-task **correction**: a redirect from the original #438 bounded-ledger orchestration task to a new task (#445 pricing), driven by observation that Insights costs are wrong. The message cites specific reference implementations (ccusage, CodexBar) and requests orchestration (spawn Opus subagents), confirming it is a task redirect, not a question or comment. Will record via ledger.

**Check 2 — No non-steering messages recorded as steering**
PASS – The only other genuine human messages in this session are: (1) 2026-07-17T13:37:48.402Z `/goal work on issue #438…` — the initial task directive, not steering relative to #445; (2) 2026-07-17T18:07:16.644Z `can you continue please` — a resume nudge after process restart, not a correction/redirect. No non-steering messages flagged.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
|-----------|---------|-------|------|------|-------------|--------|---------|-----------|
| steer-b10ad6d8-20260717-1 | b10ad6d8-505e-4365-920b-2e2d106dc673 | #445 | correction | classifier | Redirect: solve Insights pricing via ccusage/CodexBar patterns | pending | 1 | 2026-07-17T15:27:19.304Z |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-b10ad6d8-505-1784312149-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #445 | claude-fable-5 | 186 | 1067872 | 25460018 | 68763 | 1136821 | 42.2484 | 887 | 1700549 | 73772288 | 255292 | feat(insights): honest model pricing — LiteLLM catalog, warmer, repricing backfi |
