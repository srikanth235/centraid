# Receipt — Issue #528: resource contract — budgets, actuals, and courtesy (Phases A–F)

Issue: https://github.com/srikanth235/centraid/issues/528

Full scope of the resource contract in one PR: L1 budget/effective summary + structured profile on health (A), hot-apply "Pause background work" + L2 "How we sized this" (B), per-subsystem actuals + resource receipt in Insights (C), OS QoS, wakeup hygiene, and power-context posture (D), cgroup/steal-aware budget presets over the granted share (E), and L3 linked/custom knobs in durable prefs (F).

## Checklist

- [x] Resource card shows an L1 plain-language budget/effective summary (user units first; knob detail at L2+)
- [x] Health/metrics expose a structured profile + budget (host facts, class, mode, resolved knobs) suitable for UI
- [x] Pause background work available at L0, hot-applied, with duration options and a visible "paused" state on health
- [x] L2 expandable "How we sized this" panel shows host facts, derivation, and effective values
- [x] Copy attributes sizing to this gateway's host; running vs desired shown while a restart is pending
- [x] Per-subsystem actuals (CPU-seconds, RSS, bytes replicated/uploaded, activity time, background wakeups) collected at negligible overhead
- [x] Resource receipt surfaced in Insights alongside cost; agent-run usage included and labeled even though unthrottled
- [x] All reported figures are measured proxies; copy explains why watts are not shown
- [x] Agent-run child processes run at background OS priority with a documented per-platform mapping; worker-thread QoS documented as a non-portable explicit deferral
- [x] Idle wakeup target documented and measurable via the receipt; known offenders audited — gateway loops already adaptive, client 1s uptime ticker now visibility-gated
- [x] Host power context detected (battery / mains / headless server); battery and thermal UI render only when the host has a battery — never on a VPS
- [x] On battery hosts: posture defers heavy background work, low-battery floor pauses it, thermal pressure backs off — visible on health, never a silent durable mode change
- [x] On server hosts: the posture slot surfaces server-relevant facts (steal time) instead of battery chrome
- [ ] Metered-network posture — deferred: neither Node nor Electron's powerMonitor exposes a metered-network signal today; revisit when a platform signal exists
- [ ] Per-event opt-out for posture deferrals (a "keep working on battery" override) — deferred: needs product design; pause/resume and mode remain the user levers
- [x] Baseline derived from measured host signals and cgroup/container quotas and steal time, with documented clamps
- [x] Modes act as budget presets over the granted share; existing hard bounds and env overrides still apply
- [x] SQLite NORMAL (or other durability trades) only on intentional, explicit policy — never mere small-host auto-detection
- [x] Unit tests: small host, large host, slow storage, cgroup-limited host, high-steal host, mode presets, posture transitions
- [x] Migration note for existing users on fixed-table presets
- [x] P0 knobs (worker concurrency, worker memory) in Advanced UI; P1 (warm pool, replication concurrency) as scoped
- [x] Linked by default; override marks Custom and persists in prefs; env-pinned knobs locked and attributed
- [x] Save/restart semantics match the mode path; soft warnings vs host truth; hard reject only invalid ranges
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
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx` — `HealthMetricsDTO` gains `resourceProfile?` / `backgroundPause?` (and later `powerContext?`)

Pause background work available at L0, hot-applied, with duration options and a visible "paused" state on health:

- `packages/gateway/src/routes/resource-routes.ts` — `POST /centraid/_gateway/resource/pause` (`durationMs` optional; positive integer ≤ 24h else 400; absent ⇒ indefinite) and `DELETE …/pause` (resume); 405 otherwise; same host bearer gate as health
- `packages/gateway/src/routes/resource-routes.test.ts` — valid/no-body/24h-ceiling, invalid durations + malformed JSON 400, DELETE, 405, other-path passthrough
- `packages/gateway/src/serve/resource-mode.ts` — `formatBackgroundPausedDetail` / `formatBackgroundResumedDetail` human copy beside the load-shed helpers; pause/resume flip a `background-pause` health component and push a timeline event
- `packages/gateway/src/backup/backup-service.ts` — backup retention/scheduler tick also skips while paused; the WAL drain stays ungated (RPO durability)
- `packages/client/src/gateway-client.ts` — `pauseBackgroundWork(durationMs?)` / `resumeBackgroundWork()` following existing fetch/auth conventions
- `packages/client/src/react/screens/ResourceModeCard.tsx` — L0 pause control: three durations (1 hour; Until tonight = next local 20:00; Until I resume = indefinite), paused indicator + Resume via a separate `pauseBusyRef`; reconciles with `health.metrics.backgroundPause` on poll
- `packages/client/src/react/shell/routes/GatewayRoute.tsx` — stable `useCallback` pause/resume bridges that nudge `useGatewayHealth().refresh` after success
- `packages/client/src/react/screens/GatewayScreen.tsx` — passes `resourceProfile` / `backgroundPause` / pause callbacks to the card via the existing conditional-spread idiom

Resource card shows an L1 plain-language budget/effective summary (user units first; knob detail at L2+):

- `packages/client/src/react/screens/resource-summary.ts` — pure formatting helpers + shared DTO types: L1 line `Up to ~{GB} memory · {N} background workers on {M} cores`; later extended with receipt formatters, power-posture helpers, and knob helpers (Phases C/D/F below)
- `packages/client/src/react/screens/resource-summary.test.ts` — helper unit tests (GB rounding, singularization, friendly intervals, fsync "not measured")
- `packages/client/src/react/screens/ResourceModeCard.tsx` — renders the L1 summary above the disclosure; hides L1/L2/pause gracefully when the gateway predates the new metrics

L2 expandable "How we sized this" panel shows host facts, derivation, and effective values:

- `packages/client/src/react/screens/ResourceCardDetails.tsx` — collapsed-by-default button+region with `aria-expanded`; host facts and resolved knobs in friendly units
- `packages/client/src/react/screens/GatewayScreen.module.css` — `.resource*` rules for pause, summary, details, posture, and the L3 knob rows (all referenced; lint:css clean)

Copy attributes sizing to this gateway's host; running vs desired shown while a restart is pending:

- `packages/client/src/react/screens/ResourceModeCard.tsx` — "Sized for this gateway's host" attribution line; the running-vs-desired "applies on restart" note from #523 preserved unchanged
- `packages/client/src/react/screens/ResourceModeCard.test.tsx` — both #523 race-guard specs kept verbatim + specs for pause, L1, L2, and graceful absence

Per-subsystem actuals (CPU-seconds, RSS, bytes replicated/uploaded, activity time, background wakeups) collected at negligible overhead:

- `packages/gateway/src/serve/resource-accounting.ts` — pure `ResourceAccounting` (injectable clock/cpuUsage/rss readers): per-subsystem counters (worker pool, replication, backup, sweeps, agent runs), process CPU-seconds + current/peak RSS computed lazily at snapshot reads, rolling-hour background-timer-fire window; no timers of its own — zero standing overhead
- `packages/gateway/src/serve/resource-accounting.test.ts` — counters, clamping, peak-RSS monotonicity, rolling-hour window under a fake clock, DTO-shape conformance
- `packages/gateway/src/serve/build-gateway.ts` — constructs the accounting at boot; wires sweep/replication/backup/outbox hooks; wraps `RunTurnFn` (`accountRunTurn`) for builder/assistant/ask conversation runners so agent-run wall-clock is recorded in a `finally`; publishes `metrics.resourceUsage`
- `packages/gateway/src/serve/vault-plane.ts` / `packages/gateway/src/serve/vault-registry.ts` — thread `onSweepPass` / `onReplicationPass` hooks; replication passes sum replicated blob bytes
- `packages/gateway/src/backup/backup-service.ts` — `onDrainAccounted({bytesUploaded, durationMs})` fired per WAL drain
- `packages/app-engine/src/handlers/worker-admission.ts` — cumulative `totalAcquired` + `totalBusyMs` (exact per-task duration sum) surfaced via `workerAdmissionStats()`; injectable clock
- `packages/app-engine/src/handlers/handler-runner.contract.test.ts` — updated stats shape + clock-driven cumulative-counter spec
- `packages/gateway/src/serve/health-registry.ts` / `health-registry.test.ts` — `HealthMetrics.resourceUsage?` flows through the metrics source

Resource receipt surfaced in Insights alongside cost; agent-run usage included and labeled even though unthrottled:

- `packages/client/src/react/screens/ResourceReceiptPanel.tsx` + `ResourceReceiptPanel.module.css` — the receipt card: accounting window, process CPU/memory, per-subsystem rows; the agent-runs row is explicitly labeled "Measured, not limited by Conserve"
- `packages/client/src/react/screens/ResourceReceiptPanel.test.tsx` — subsystem rows, formatting spot-checks, agent-run label, wakeups shown/omitted, absent-DTO graceful state
- `packages/client/src/react/screens/InsightsScreen.tsx` — mounts the receipt panel beside cost transparency
- `packages/client/src/react/shell/routes/InsightsRoute.tsx` / `InsightsRoute.test.tsx` — fetches gateway health as a tolerated third arm of the existing `Promise.all`; a health failure never breaks Insights
- `packages/client/src/react/screen-contracts.ts` — `InsightsBridgeProps.resourceUsage?`
- `packages/client/src/centraid-api.d.ts` — `CentraidResourceUsage` on both `CentraidHealthMetrics` declarations

All reported figures are measured proxies; copy explains why watts are not shown:

- `packages/client/src/react/screens/ResourceReceiptPanel.tsx` — honesty footnote: measured CPU time, bytes, and activity only; watts are not shown because they cannot be measured from software alone; agent-run CPU is labeled not separately measurable yet (`cpuSeconds: null` in v1, never fabricated)
- `packages/client/src/react/screens/resource-summary.ts` — receipt row builders carry the honest labels; no derived wattage anywhere

Agent-run child processes run at background OS priority with a documented per-platform mapping; worker-thread QoS documented as a non-portable explicit deferral:

- `packages/agent-runtime/src/low-priority.ts` — optional `niceness` parameter (default 10) on `lowPriorityCommand` (`nice`/`ionice` wrapping); per-platform mapping documented (macOS nice + App Nap, Linux nice/ionice/SCHED_IDLE note, Windows `CENTRAID_CHILD_PRIORITY` passthrough with EcoQoS deferred); worker_threads per-thread priority documented as non-portable in Node — explicit deferral, no tid hacks
- `packages/agent-runtime/src/low-priority.test.ts` — niceness parameter + existing wrapping specs

Idle wakeup target documented and measurable via the receipt; known offenders audited — gateway loops already adaptive, client 1s uptime ticker now visibility-gated:

- `packages/gateway/src/serve/power-context.ts` — module doc records the idle target (≤ 120 background timer fires/hour, measured by `backgroundTimerFiresLastHour`) and the audited timer inventory (outbox 60s adaptive, lease 60s, backup 1h unref'd, sweeps 1–2h, SSE heartbeats per-open-stream unref'd — no standing sub-minute idle wakeup)
- `packages/client/src/react/shell/routes/visibility-ticker.ts` + `visibility-ticker.test.ts` — SSR-safe ticker that pauses while `document.visibilityState === 'hidden'` and catches up on return
- `packages/client/src/react/shell/routes/GatewayRoute.tsx` — the 1s uptime ticker (the audit's client-side offender) now runs through the visibility ticker

Host power context detected (battery / mains / headless server); battery and thermal UI render only when the host has a battery — never on a VPS:

- `packages/gateway/src/serve/power-context.ts` — `PowerContextState` DTO, `PowerContextMonitor` (no timers; lazy 60s-throttled reads; 120s client-push staleness; injectable probes): darwin `pmset` / linux `/sys/class/power_supply` boot probe, linux `/proc/stat` steal sampling; `battery: null` whenever no battery exists, which gates all battery chrome
- `packages/gateway/src/serve/power-context.test.ts` — posture rules, staleness decay, battery-absent null gating, steal delta math, probe-failure tolerance, transition events
- `packages/gateway/src/routes/resource-routes.ts` / `resource-routes.test.ts` — `POST`/`DELETE /centraid/_gateway/resource/power-context` with strict validation (the desktop pushes battery/thermal state; Electron owns the battery signal)
- `apps/desktop/src/main/power-context-push.ts` — push helper + `powerMonitor` listener registration (`isOnBatteryPower`, macOS thermal state; Electron exposes no battery percent, so `batteryPercent: null`)
- `apps/desktop/src/main.ts` / `apps/desktop/src/main/gateway-monitor.ts` — push piggybacks on the existing 5s heartbeat tick; power transitions nudge an immediate tick
- `packages/client/src/react/screens/PowerPostureNote.tsx` + `PowerPostureNote.test.tsx` — battery chrome strictly gated on `battery !== null`; host-attribution sub-line ("On this gateway's host")

On battery hosts: posture defers heavy background work, low-battery floor pauses it, thermal pressure backs off — visible on health, never a silent durable mode change:

- `packages/gateway/src/serve/power-context.ts` — pure `evaluatePosture`: discharging ⇒ on-battery defer; percent < 20 discharging ⇒ low-battery; thermal serious/critical ⇒ thermal; posture never writes prefs or mode
- `packages/gateway/src/serve/build-gateway.ts` — posture deferral composed into the vault-sweep gate and threaded to backup as `shouldDeferPosture`; `power-posture` health component reports `ok` with human detail on transitions (courtesy, not a fault — desktop down-alerts never fire on it)
- `packages/gateway/src/serve/resource-mode.ts` — `formatPowerPostureDeferringDetail` / `formatPowerPostureNormalDetail`
- `packages/gateway/src/backup/backup-service.ts` / `packages/gateway/src/backup/backup-service.contract.test.ts` — retention tick honors `shouldDeferPosture`; WAL drain stays ungated (durability)
- `packages/client/src/react/screens/ResourceModeCard.tsx` — mounts the posture note under the L1 summary

On server hosts: the posture slot surfaces server-relevant facts (steal time) instead of battery chrome:

- `packages/client/src/react/screens/PowerPostureNote.tsx` — `kind === 'server'` with steal ≥ 5% renders "Shared host: N% CPU steal observed — sizing accounts for the share you actually get"; mains and low-steal servers render nothing; battery/thermal strings are unreachable when `battery === null`
- `packages/client/src/react/screens/resource-summary.ts` — `powerPostureLine` pure helper + `PowerContextState` client mirror

Baseline derived from measured host signals and cgroup/container quotas and steal time, with documented clamps:

- `packages/gateway/src/serve/host-limits.ts` — boot probe: cgroup v2 `cpu.max`/`memory.max` with v1 fallback (quota/period, `limit_in_bytes`, 2^63 sentinel ignored) + one cumulative steal read reusing the Phase D `/proc/stat` sampler; failure-tolerant, injectable reader
- `packages/gateway/src/serve/host-limits.test.ts` — v2/v1/"max"/sentinel/garbage/missing parsing + steal percent conversion
- `packages/gateway/src/serve/hardware-profile.ts` — optional `cgroupCpuLimit` / `cgroupMemoryLimitBytes` / `stealPercent` inputs; `effectiveCores = min(cores, ceil(quota))`, `effectiveMemory = min(totalmem, limit)`; steal ≥ 10% biases class to constrained; additive `budget` / `cgroupLimitedCpu` / `cgroupLimitedMemory` / `stealPercent` on the structured profile; share framing in `formatHardwareProfileDetail`
- `packages/gateway/src/serve/build-gateway.ts` — `probeHostLimits()` at boot feeds the same single resolver

Modes act as budget presets over the granted share; existing hard bounds and env overrides still apply:

- `packages/gateway/src/serve/hardware-profile.ts` — inline mode ternaries replaced by the named `BUDGET_PRESETS` table over the granted share; env clamps unchanged
- `packages/gateway/src/serve/hardware-profile.budget.test.ts` — pre-refactor snapshot (5 hosts × 4 modes) captured against the OLD code and passing byte-identical after the refactor: plain hosts resolve exactly as before; only cgroup-limited/high-steal hosts change

SQLite NORMAL (or other durability trades) only on intentional, explicit policy — never mere small-host auto-detection:

- `packages/gateway/src/serve/hardware-profile.ts` / `hardware-profile.test.ts` — verified already-safe (`sqliteSynchronous` consults only explicit env/owner-Conserve policy, never the auto-detected class) and locked in with tests: cgroup-limited and high-steal hosts in Auto keep `FULL`

Unit tests: small host, large host, slow storage, cgroup-limited host, high-steal host, mode presets, posture transitions:

- `packages/gateway/src/serve/hardware-profile.budget.test.ts` — small/large/slow-storage × 4 modes snapshot
- `packages/gateway/src/serve/hardware-profile.test.ts` — cgroup-limited (16 raw cores, quota 2 ⇒ sized as 2-core, `cgroupLimitedCpu: true`), cgroup memory limit, steal 15% constrained bias, steal-below-threshold no-op, absent probes ⇒ identical behavior, presets, durability
- `packages/gateway/src/serve/power-context.test.ts` — posture transitions (battery %, thermal, staleness, battery-less hosts)

Migration note for existing users on fixed-table presets:

- `CHANGELOG.md` — `[Unreleased]` `### Changed`: sizing is cgroup- and steal-aware; container-limited or high-steal hosts may resolve lower knobs to match the actually-granted share; plain hosts unchanged
- `docs/config-ownership.md` — baseline inputs now include cgroup quotas and steal time, probed at boot, feeding the same single resolver; knob prefs keys + precedence recorded

P0 knobs (worker concurrency, worker memory) in Advanced UI; P1 (warm pool, replication concurrency) as scoped:

- `packages/client/src/react/screens/ResourceAdvancedKnobs.tsx` — the L3 rung: collapsed-by-default "Advanced" region; four knob rows (P0 worker concurrency + worker memory MB; P1 warm pool + replication concurrency) with running value, state tag, numeric input, Save / Reset-to-Linked; `busyRef` guard against late-load clobbering
- `packages/client/src/react/screens/ResourceAdvancedKnobs.test.tsx` — Linked/Custom/env-locked states, bounds rejection, soft warnings, save/clear pref writes, absent sources/bounds ⇒ section hidden, collapse/expand
- `packages/client/src/react/screens/GatewayAlertsTab.tsx` — behavior-identical extraction of the Alerts tab from GatewayScreen to stay under the 500-line cap
- `packages/client/src/react/screens/GatewayScreen.tsx` — Alerts tab delegated to the extraction; knob-prefs pass-through wiring (498 → 426 lines)
- `packages/client/src/react/shell/routes/GatewayRoute.tsx` — stable `loadKnobPrefs`/`saveKnobPrefs` bridges over `getUserPrefs`/`saveUserPrefs`, translating to the `gateway.resource.*` namespace (`null` clears)

Linked by default; override marks Custom and persists in prefs; env-pinned knobs locked and attributed:

- `packages/gateway/src/serve/hardware-profile.ts` — `resolveKnob` replaces `integerOverride`: per-knob precedence env > prefs > preset with `{value, source}`; additive `sources` (with exact `envVar` when env-pinned) and `bounds` on the structured profile; `RESOURCE_KNOB_BOUNDS` exported
- `packages/gateway/src/serve/resource-mode.ts` / `packages/gateway/src/serve/resource-mode.test.ts` — `RESOURCE_KNOB_PREF_KEYS` (`gateway.resource.workerMaxConcurrent` / `workerMaxOldGenerationMb` / `workerPoolSize` / `replicationConcurrency`) + `parseResourceKnobPrefs` accepting only safe positive integers
- `packages/gateway/src/serve/build-gateway.ts` — knob prefs read from the already-loaded PrefsStore and passed as `prefsOverrides` into the one resolver
- `packages/gateway/src/serve/hardware-profile.test.ts` — prefs beat preset, lose to env; garbage prefs ignored; sources/bounds attribution
- `packages/client/src/react/screens/ResourceAdvancedKnobs.tsx` — env-locked rows disabled with lock + env var name; Linked placeholder shows resolved value; Custom shows saved override
- `packages/client/src/centraid-api.d.ts` — additive `sources`/`bounds` on `CentraidResourceProfile`

Save/restart semantics match the mode path; soft warnings vs host truth; hard reject only invalid ranges:

- `packages/client/src/react/screens/ResourceAdvancedKnobs.tsx` — hard rejects (non-integer, ≤ 0, out of published `bounds`) disable Save with inline errors; soft warnings (workers > host cores; workers × memory > half of host memory) never block; after save/clear a quiet "Applies on the next gateway restart" line mirrors the mode path
- `packages/client/src/react/screens/resource-summary.ts` — `validateKnobDraft` / `knobSoftWarnings` / `knobPending` pure helpers

One policy path; load-shed / event-loop pressure remain separate from capacity:

- `packages/gateway/src/serve/health-registry.ts` — `shouldDeferBackgroundWork()` semantically unchanged (event-loop pressure only); pause and power posture are separate explicit signals composed only at the safe call sites (vault sweeps, backup retention) — the consent-outbox sweep and backup WAL drain are never paused or posture-deferred
- `packages/gateway/src/serve/hardware-profile.ts` — budgets, presets, prefs overrides, and env all resolve through `resolveGatewayHardwareProfile`; no second policy system

Receipt + PR(s); Conventional Commits with issue suffix; `bun run check:pr` green: this file; PR #530 grown in place on branch `claude/resource-contract-528` (full scope folded into the one PR, no stacked PRs); gate run recorded under Verification.

## Out of scope

- Metered-network posture: no metered signal is exposed by Node or Electron's powerMonitor today; deferred until a platform signal exists
- Per-event posture opt-out (a "keep working on battery" override): needs product design; deferred
- Throttling agent-run CPU (v1 measures and labels only, per the issue); watt/joule metering (never — honest proxies only)
- Client-side respect (SSE polling cadence, mobile wake behavior) — follow-on issue per the issue's own scope
- Calendar-style quiet-hours UI; full hot-apply of worker ceilings (pause + posture only)
- Per-subsystem disk-bytes-written: proxied by bytes uploaded (backup) and bytes replicated (replication); a general write-bytes counter per subsystem is not collected in v1
- Agent-run CPU-seconds: `null` in v1 (child rusage is not cheaply readable cross-platform); wall-clock activity and run counts are measured

## Decisions

- Pause is in-memory and clears on gateway restart — it must never become a durable prefs writer or silent mode flip (issue ownership rule 3).
- Pause and power posture gate only vault sweeps and the backup retention tick; the consent-outbox sweep and backup WAL drain are never gated (durability and consent are not pausable).
- The `background-pause` health component reports **degraded** (deliberately loud, user-initiated); the `power-posture` component reports **ok** with informative detail (courtesy, not a fault) so desktop down-alerts never fire on posture.
- Accounting adds zero standing overhead: no new timers; CPU/RSS are read lazily when health is polled; the rolling wakeup window is fed by existing timer fires.
- Agent-run accounting wraps the conversation-runner `RunTurnFn` (builder/assistant/ask); the fire-and-forget auto-titler and automation live-dispatch paths are not yet accounted (no reachable seam) — a known, disclosed gap, not silent.
- Phase E is a semantics refactor with a snapshot guard: plain hosts resolve byte-identically; only container-limited or high-steal hosts change (that is the migration note).
- Knob prefs accept only safe positive integers; `workerPoolSize: 0` remains a preset/env concept (prefs cannot pin 0), matching the client's ≤ 0 hard-reject.
- Desktop→gateway power signals ride an HTTP route with 120s staleness decay because spawn env is process-scoped; Electron owns the battery signal and pushes on transitions plus the existing 5s heartbeat.

## Verification

```sh
bun run --cwd packages/gateway test        # 952 passed, 6 skipped (incl. power-context 21, resource-accounting 11, host-limits, budget snapshot 20, knob attribution)
bun run --cwd packages/client test         # 1151 passed / 149 files (receipt panel, posture note, advanced knobs, visibility ticker; both #523 race guards intact)
bun run --cwd packages/app-engine test && bun run --cwd packages/agent-runtime test
bun run check:pr
```

Gateway 952 passed / 6 skipped; client 1151 passed / 149 files; agent-runtime 241 passed; typecheck clean in gateway, client, app-engine, agent-runtime, and apps/desktop; oxlint / lint:css / knip clean; `bun run check:pr` green end-to-end (exit code captured directly, untracked vendored kit files parked during the format stage).

## Audit

Fresh-context audit (auditor did not write the code or the receipt; verified against `git show 580a4d42 589dc09b`, the uncommitted `git diff`, and the files on disk). The untracked `packages/blueprints/kit/*` files are pre-existing unrelated WIP and were excluded.

**Check 1 — "What changed" faithfully describes the diff**
PASS. Every changed/created file in the A+B commits and the uncommitted C–F tree (blueprints/kit excluded) is named in `## What changed` with an accurate description; cross-referencing the 33-file uncommitted diff-stat plus the A (11-file) and B (12-file) commit trees against the section left no file unmentioned. Ten-plus load-bearing claims verified against code: (1) `ResourceAccounting` has no `setInterval`/`setTimeout` of its own — CPU/RSS are read lazily in `snapshot()` and each `record*` hook, the rolling-hour window is a timestamp array pruned on record/read (resource-accounting.ts:91-222). (2) `accountRunTurn` wraps all three conversation runners — builder via `runTurn: accountRunTurn(options.runTurn ?? runTurn)` (build-gateway.ts ~1631), assistant and ask via `runTurn: accountedRunTurn` (build-gateway.ts ~2284, ~2369). (3) The `power-posture` health component is reported with `health.reportOk(...)`, never degraded (build-gateway.ts, and `formatPowerPostureDeferringDetail`/`NormalDetail` are courtesy copy). (4) The WAL drain and the consent-outbox sweep are not gated by pause or posture — vault sweeps gate on `shouldDeferBackgroundWork() || shouldPauseBackgroundWork() || powerContext.isDeferringBackgroundWork()`, but `runOutboxSweep` checks only `health.shouldDeferBackgroundWork()`, and BackupService's WAL `drainWalFiles` is unconditional while only the retention `runScheduled` tick reads the three predicates (backup-service.ts:1401-1485). (5) The budget snapshot literals in hardware-profile.budget.test.ts match `BUDGET_PRESETS` byte-for-byte (conserve 2×128/pool0/repl1/br5/gz6, balanced 8×256/pool2/repl3/br10/gz9, performance 12×384/pool4/repl4). (6) `resolveKnob` precedence is env > prefs > preset, with a garbage env value falling through to prefs, not silently to preset (hardware-profile.ts:166-191). (7) Env-locked knob rows render `disabled` with a lock glyph and the exact `facts.envVar` (ResourceAdvancedKnobs.tsx:188-210). (8) The visibility ticker suspends on `document.visibilityState === 'hidden'` and fires once on return, SSR-safe (visibility-ticker.ts:33-47). (9) `WorkerAdmission` tracks cumulative `totalAcquired`/`totalBusyMs` via a FIFO acquire-timestamp queue with an injectable clock (worker-admission.ts:80-150). (10) InsightsRoute adds `getGatewayHealth().catch(() => null)` as a tolerated third `Promise.all` arm so a health failure never breaks Insights. (11) `background-pause` reports `reportDegraded` (health-registry.ts:291), matching the Decisions note. (12) `GatewayScreen.tsx` is 426 lines after the behavior-identical `GatewayAlertsTab` extraction (127 lines), matching the "498 → 426" claim. No claim was found to misdescribe code.

**Check 2 — all CHECKED checklist items are realized in the diff**
PASS. Each `[x]` maps to implementing code. Adversarial spot-checks: "negligible overhead / no new poll" — accounting adds no timer; CPU/RSS read at the existing health-poll cadence; the wakeup window is fed by pre-existing timer fires (recordBackgroundTimerFire from outbox/backup/sweep hooks). "Never a silent durable mode change" — `evaluatePosture` and the PowerContextMonitor never write prefs or touch mode; the posture only composes into the read-only deferral gate. "SQLite NORMAL only on explicit policy, never small-host auto-detection" — `sqliteSynchronous` is NORMAL only when `CENTRAID_SQLITE_SYNCHRONOUS` says so or `requested==='constrained' || (requested===undefined && resourceMode==='conserve')`; it never consults the auto-detected `class` (hardware-profile.ts:370-378), and hardware-profile.test.ts locks cgroup-limited and high-steal Auto hosts at FULL. "Byte-identical plain hosts" — hardware-profile.budget.test.ts exists (5 hosts × 4 modes) and passes 20/20 under an isolated `env: {}`; it resolves against the post-refactor resolver, so plain-host numbers are proven unchanged. "Both #523 race-guard specs kept verbatim" — the `git diff e473006c HEAD` of ResourceModeCard.test.tsx shows no `+/-` on the "does not re-fetch when the parent re-renders with a stable loadMode" and "ignores a late loadMode resolve while a save is in flight" `it()` blocks (only the shared `mount` helper gained optional props). Targeted test runs are green: gateway resource-accounting/power-context/host-limits/hardware-profile/resource-mode/resource-routes/backup-service.contract = 122 passed / 11 files; client ResourceModeCard/ResourceReceiptPanel/PowerPostureNote/ResourceAdvancedKnobs/visibility-ticker/InsightsRoute/resource-summary = 83 passed / 10 files. The QoS item is realized as a real wiring, not a stub: `lowPriorityCommand` (now with the documented `niceness` param) is invoked at every ACP spawn site (backends/acp/backend.ts:146, enumerate-models.ts:80, probe-capabilities.ts:92, preflight.ts:192).

**Check 3 — checklist honestly mirrors the issue's acceptance criteria**
PASS. Every acceptance criterion in `gh issue view 528` (Legibility A/B ×5, Accountability C ×3, Courtesy/energy D ×7, Ground-truth E ×5, Power knobs F ×3, Cross-cutting ×2) appears in the checklist. Exactly two are deliberately left `[ ]` and each is disclosed with a reason both inline and in `## Out of scope`: metered-network posture (no Node/Electron signal) and the per-event "keep working on battery" posture opt-out (needs product design). The two narrowings are disclosed rather than hidden: disk-bytes-written is narrowed to "bytes uploaded (backup) + bytes replicated (replication)" and stated in `## Out of scope`; the QoS criterion ("OS background QoS on macOS/Windows/Linux for background work") is narrowed in the checklist wording itself to agent-run child processes with worker-thread QoS and Windows EcoQoS documented as explicit non-portable deferrals — the item text does not claim full worker-pool/Windows coverage, so it is not an overclaim. The battery-posture criterion's "per-event opt-out" clause is honestly split off into the separate unchecked item rather than folded into the checked line. No checked item overclaims relative to the issue. One minor tension worth recording (not refuting): the issue's *design recommendation* #9 ("existing users keep their prior effective values until they touch the card; no silent changes") is effectively overturned for cgroup-limited/high-steal hosts, which resolve to lower knobs at the next boot with only the CHANGELOG as notice; this is disclosed as the migration note and is defensible as correcting a host whose old sizing measured the raw machine instead of the granted share, and design rec #9 is explicitly overridable — but the receipt could have named the override rationale directly. The acceptance criterion actually gated on ("Migration note for existing users on fixed-table presets") is satisfied by the CHANGELOG `[Unreleased] ### Changed` entry and docs/config-ownership.md. Note: I did not independently re-run the full `bun run check:pr` (long-running); the Verification section's green claim rests on the author's run plus the targeted suites re-run here, all passing.

## Steering

**Check 1 — every human-steering event is recorded**
PASS. One human redirect occurred and it is recorded here: after the initial goal (implement #528 and open a PR via orchestrated subagents — delivered as Phases A+B in commits 580a4d42 / 589dc09b with PR #530 opened), the user issued a mid-task scope redirect — "complete the entire scope of the issue and fold it into this PR (not stacked PRs); write to memory; act as orchestrator and spawn subagents." That turned a partial (A+B) delivery into the full A–F scope grown in place on the one PR/branch, which is exactly what the uncommitted C–F working tree and this rewritten full-scope receipt reflect. No other human redirect occurred during the session.

**Check 2 — no non-steering message recorded as steering**
PASS. Only the single mid-task scope-redirect above is recorded. No routine acknowledgements, clarifications, or tool-permission responses were misclassified as steering events.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-1b8bab16-ec7-1784803773-1 | claude-code | 1b8bab16-ec70-4384-93a6-edd3e44370d3 | #528 | claude-fable-5 | 314 | 664149 | 24909760 | 270088 | 934551 | 46.7192 | 314 | 664149 | 24909760 | 270088 | feat(gateway): structured resource profile on health + hot-apply background paus |
| claude-code-1b8bab16-ec7-1784804226-1 | claude-code | 1b8bab16-ec70-4384-93a6-edd3e44370d3 | #528 | claude-fable-5 | 36 | 21008 | 4030728 | 8961 | 30005 | 4.7417 | 350 | 685157 | 28940488 | 279049 | feat(gateway): structured resource profile on health + hot-apply background paus |
| claude-code-1b8bab16-ec7-1784804275-1 | claude-code | 1b8bab16-ec70-4384-93a6-edd3e44370d3 | #528 | claude-fable-5 | 4 | 1664 | 454342 | 744 | 2412 | 0.5124 | 354 | 686821 | 29394830 | 279793 | feat(client): resource card budget summary, sizing panel, and pause control (#52 |
| claude-code-aa0d5e54-559-1784810074-1 | claude-code | aa0d5e54-559c-44f9-a288-6184b51ff25b | #528 | claude-fable-5 | 214 | 689265 | 13128805 | 204267 | 893746 | 31.9601 | 214 | 689265 | 13128805 | 204267 | feat(gateway): resource actuals, power posture, cgroup-aware budgets, knob prefs |
| claude-code-aa0d5e54-559-1784810120-1 | claude-code | aa0d5e54-559c-44f9-a288-6184b51ff25b | #528 | claude-fable-5 | 6 | 3708 | 600837 | 1653 | 5367 | 0.7299 | 220 | 692973 | 13729642 | 205920 | feat(gateway): resource actuals, power posture, cgroup-aware budgets, knob prefs |
| claude-code-aa0d5e54-559-1784810183-1 | claude-code | aa0d5e54-559c-44f9-a288-6184b51ff25b | #528 | claude-fable-5 | 12 | 9574 | 1214151 | 4026 | 13612 | 1.5352 | 232 | 702547 | 14943793 | 209946 | feat(gateway): resource actuals, power posture, cgroup-aware budgets, knob prefs |
