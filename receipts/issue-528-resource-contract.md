# Receipt — Issue #528: resource contract — Phase A+B (legibility + pause)

Issue: https://github.com/srikanth235/centraid/issues/528

Phases A+B only: L1 budget/effective summary + structured profile fields on health, and the hot-apply "Pause background work" control + L2 "How we sized this" panel. Phases C–F (accountability receipt, QoS/wakeup hygiene, power-context posture, continuous baseline, L3 knobs) are follow-on work.

## Checklist

- [x] Resource card shows an L1 plain-language budget/effective summary (user units first; knob detail at L2+)
- [x] Health/metrics expose a structured profile + budget (host facts, class, mode, resolved knobs) suitable for UI
- [x] Pause background work available at L0, hot-applied, with duration options and a visible "paused" state on health
- [x] L2 expandable "How we sized this" panel shows host facts, derivation, and effective values
- [x] Copy attributes sizing to this gateway's host; running vs desired shown while a restart is pending
- [x] One policy path; load-shed / event-loop pressure remain separate from capacity
- [x] Receipt + PR(s); Conventional Commits with issue suffix; `bun run check:pr` green

## What changed

Health/metrics expose a structured profile + budget (host facts, class, mode, resolved knobs) suitable for UI:

- `packages/gateway/src/serve/hardware-profile.ts` — `StructuredResourceProfile` + pure `toStructuredResourceProfile(profile)` mapping (class / mode / host facts / resolved knobs)
- `packages/gateway/src/serve/hardware-profile.test.ts` — mapping cases: constrained/conserve, standard/performance, null fsync
- `packages/gateway/src/serve/health-registry.ts` — `HealthMetrics.resourceProfile` + always-present `metrics.backgroundPause`; `MetricsSourceResult` widened; in-memory pause state (`pauseBackgroundWork` / `resumeBackgroundWork` / `backgroundPauseState` / `shouldPauseBackgroundWork`, `MAX_BACKGROUND_PAUSE_MS` 24h, expiry auto-clears on read via injected clock)
- `packages/gateway/src/serve/health-registry.test.ts` — resourceProfile passthrough; pause default / indefinite / duration-expiry / idempotent-resume specs
- `packages/gateway/src/serve/build-gateway.ts` — publish `resourceProfile` through the existing metrics source; register the resource route beside health; compose pause into the vault-sweep gate
- `packages/client/src/centraid-api.d.ts` — `CentraidResourceProfile` + `CentraidBackgroundPause` on `CentraidHealthMetrics`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx` — `HealthMetricsDTO` gains `resourceProfile?` / `backgroundPause?`

Pause background work available at L0, hot-applied, with duration options and a visible "paused" state on health:

- `packages/gateway/src/routes/resource-routes.ts` — `POST /centraid/_gateway/resource/pause` (`durationMs` optional; positive integer ≤ 24h else 400; absent ⇒ indefinite) and `DELETE …/pause` (resume); 405 otherwise; same host bearer gate as health
- `packages/gateway/src/routes/resource-routes.test.ts` — valid/no-body/24h-ceiling, invalid durations + malformed JSON 400, DELETE, 405, other-path passthrough
- `packages/gateway/src/serve/resource-mode.ts` — `formatBackgroundPausedDetail` / `formatBackgroundResumedDetail` human copy beside the load-shed helpers; pause/resume flip a `background-pause` health component and push a timeline event
- `packages/gateway/src/backup/backup-service.ts` — backup retention/scheduler tick also skips while paused; the WAL drain stays ungated (RPO durability)
- `packages/gateway/src/serve/build-gateway.ts` — vault sweeps gate on `shouldDeferBackgroundWork() || shouldPauseBackgroundWork()`; the consent-outbox sweep keeps only the load-shed gate (never paused)
- `packages/client/src/gateway-client.ts` — `pauseBackgroundWork(durationMs?)` / `resumeBackgroundWork()` following existing fetch/auth conventions
- `packages/client/src/react/screens/ResourceModeCard.tsx` — L0 pause control: three durations (1 hour = 3 600 000 ms; Until tonight = ms to next local 20:00; Until I resume = indefinite), paused indicator ("Paused until HH:MM" / "Paused until you resume") + Resume; optimistic state via a separate `pauseBusyRef` mirroring the existing `busyRef` discipline; reconciles with `health.metrics.backgroundPause` on poll
- `packages/client/src/react/shell/routes/GatewayRoute.tsx` — stable `useCallback` pause/resume bridges that nudge `useGatewayHealth().refresh` after success (identity-stable across the 1s uptime tick)
- `packages/client/src/react/screens/GatewayScreen.tsx` — passes `resourceProfile` / `backgroundPause` / pause callbacks to the card via the existing conditional-spread idiom

Resource card shows an L1 plain-language budget/effective summary (user units first; knob detail at L2+):

- `packages/client/src/react/screens/resource-summary.ts` — pure formatting helpers + shared DTO types: L1 line `Up to ~{GB} memory · {N} background workers on {M} cores` (GB = workerMaxConcurrent × workerMaxOldGenerationMb, one decimal), singular/plural at 1
- `packages/client/src/react/screens/resource-summary.test.ts` — 11 helper unit tests (GB rounding, singularization, friendly intervals, fsync "not measured")
- `packages/client/src/react/screens/ResourceModeCard.tsx` — renders the L1 summary above the disclosure; hides L1/L2/pause gracefully when the gateway predates `resourceProfile` / `backgroundPause`

L2 expandable "How we sized this" panel shows host facts, derivation, and effective values:

- `packages/client/src/react/screens/ResourceCardDetails.tsx` — collapsed-by-default button+region with `aria-expanded`; host facts (cores, memory GB, storage fsync ms or "not measured") and resolved knobs (workers × heap, warm pool, replication, SQLite durability, sweep/outbox intervals in friendly units, compression qualities)
- `packages/client/src/react/screens/GatewayScreen.module.css` — `.resource*` rules for pause, summary, and details (all referenced; lint:css clean)

Copy attributes sizing to this gateway's host; running vs desired shown while a restart is pending:

- `packages/client/src/react/screens/ResourceModeCard.tsx` — "Sized for this gateway's host" attribution line (never the browser device); the existing running-vs-desired "applies on restart" note from #523 (activeMode vs selected mode) is preserved unchanged
- `packages/client/src/react/screens/ResourceModeCard.test.tsx` — both #523 race-guard specs kept verbatim (stable-loadMode re-render; late loadMode resolve ignored mid-save) + 11 new specs: pause/resume flows, until-tonight math under fake timers, L1 rendering, L2 expand/collapse, graceful absence of the new metrics

One policy path; load-shed / event-loop pressure remain separate from capacity:

- `packages/gateway/src/serve/health-registry.ts` — `shouldDeferBackgroundWork()` is semantically unchanged (event-loop pressure only); pause is a separate explicit signal composed only at the two safe call sites
- `docs/config-ownership.md` — records the structured profile on health metrics and that background pause is runtime-only / hot-applied / in-memory: never persisted, never a durable Resource-mode flip

Receipt + PR(s); Conventional Commits with issue suffix; `bun run check:pr` green: this file; PR opened from branch `claude/resource-contract-528`; gate run recorded under Verification.

## Out of scope

- Phases C–F of #528: per-subsystem actuals + resource receipt in Insights; OS QoS classes, wakeup hygiene, power-context posture (battery / mains / VPS); continuous cgroup/steal-aware baseline; L3 linked/custom knobs
- L2 cgroup-limit and steal-time host facts (arrive with the Phase E probes; L2 shows cores/memory/fsync today)
- Throttling agent-run CPU; watt/joule metering; metered-network posture
- Any change to resolved profile numbers — Phase A/B is legibility + pause only, formulas untouched

## Decisions

- Pause is in-memory and clears on gateway restart — deliberate: it must never become a durable prefs writer or silent mode flip (issue ownership rule 3).
- Pause gates only vault sweeps and the backup retention tick; the consent-outbox sweep and backup WAL drain are never paused (issue design-rec 4: durability and consent are not pausable).
- While paused, a `background-pause` health component reports **degraded** with human copy — deliberately loud so the pause window is visible in diagnostics and the timeline, matching "UI stays loud about pending vs applied".
- Structured data rides `metrics` only; component `detail` stays a plain human string (existing health contract).
- "Until tonight" resolves client-side to the next local 20:00 (the API takes only `durationMs`), keeping the server timezone-free.

## Verification

```sh
bun run --cwd packages/gateway test -- src/serve/health-registry.test.ts src/serve/hardware-profile.test.ts src/serve/resource-mode.test.ts src/routes/resource-routes.test.ts
bun run --cwd packages/client test -- src/react/screens/ResourceModeCard.test.tsx src/react/screens/resource-summary.test.ts
bun run check:pr
```

43 gateway tests passed (4 files) and 24 client tests passed (13 card + 11 helper); the full client suite (1120 tests / 145 files) also passed as a regression check. Gateway typecheck and client typecheck clean; knip, oxlint, lint:css clean; `bun run check:pr` green end-to-end after an oxfmt pass.

## Audit

**Check 1 — What changed faithfully describes the diff**
PASS – The tree shows 16 modified tracked files plus 5 untracked code files (resource-routes.ts/.test.ts, ResourceCardDetails.tsx, resource-summary.ts/.test.ts); every one is named and accurately described in ## What changed, and no file in the diff is omitted. Spot-checks match the code precisely: `toStructuredResourceProfile` in hardware-profile.ts, `formatBackgroundPausedDetail`/`formatBackgroundResumedDetail` in resource-mode.ts, the always-present `metrics.backgroundPause` in health-registry.ts, the `formatBudgetSummary` L1 line, and the GatewayScreen conditional-spread wiring. No receipt claim lacks corresponding code.

**Check 2 — All checked checklist items are realized in the diff**
PASS – (a) health-registry.ts `snapshot()` emits `resourceProfile` (via the metrics source) and `backgroundPause` (always), expiry auto-clearing on read via the injected clock. (b) resource-routes.ts implements POST/DELETE `/centraid/_gateway/resource/pause`, validating `durationMs` as a positive integer ≤ 24h else 400; build-gateway.ts registers it beside the health route (same bearer family). (c) the pause signal gates ONLY vault sweeps and the backup retention tick; `runOutboxSweep` checks `shouldDeferBackgroundWork()` alone and the backup WAL drain stays ungated — confirmed by reading, not the receipt. (d) ResourceModeCard.tsx renders the L1 summary, the ResourceCardDetails L2 collapsible, and the three-duration pause control with a separate `pauseBusyRef`; both #523 race-guard tests remain intact with full bodies. (e) `shouldDeferBackgroundWork` is purely event-loop-driven and untouched.

**Check 3 — Checklist mirrors the issue**
PASS – The seven checklist items map one-to-one onto the issue's five "Legibility (A/B)" acceptance criteria plus the Cross-cutting "one policy path / load-shed separate" item, mostly near-verbatim. The one narrowing is honestly disclosed: the issue's L2 criterion includes cgroup/steal facts "where present"; the receipt drops that clause and lists it explicitly under ## Out of scope as Phase E work. Phases C–F are named out of scope and no checked item overclaims them.

## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**
PASS – The user set a single goal ("implement the above issue and create PR, act as orchestrator and spawn opus subagents") before implementation began; no mid-task human redirects followed, so zero steering rows are required.

**Check 2 — no non-steering message is recorded as a steering event**
PASS – No steering rows recorded; the Accounting steering table is absent/empty because there were no steering events.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-1b8bab16-ec7-1784803773-1 | claude-code | 1b8bab16-ec70-4384-93a6-edd3e44370d3 | #528 | claude-fable-5 | 314 | 664149 | 24909760 | 270088 | 934551 | 46.7192 | 314 | 664149 | 24909760 | 270088 | feat(gateway): structured resource profile on health + hot-apply background paus |
| claude-code-1b8bab16-ec7-1784804226-1 | claude-code | 1b8bab16-ec70-4384-93a6-edd3e44370d3 | #528 | claude-fable-5 | 36 | 21008 | 4030728 | 8961 | 30005 | 4.7417 | 350 | 685157 | 28940488 | 279049 | feat(gateway): structured resource profile on health + hot-apply background paus |
