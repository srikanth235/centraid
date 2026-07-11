# Issue #351 — Gateway operations audit: data-loss, availability, and observability gaps

## Checklist

- [x] vault schema downgrade guard (`VaultSchemaAheadError`)
- [x] `PRAGMA synchronous = FULL` on file-backed vault DBs
- [x] graceful gateway stop on desktop quit
- [x] crash capture (`uncaughtException`/`unhandledRejection`) to a rotated crash log
- [x] supervised gateway restart with backoff + crash-loop detection
- [x] manual "Restart gateway" action (IPC + Gateway page button)
- [x] boot-failure dialog instead of a blank screen
- [x] rotated JSONL log persistence with boot tail-load
- [x] diagnostics bundle endpoint + save-dialog export
- [x] heartbeat monitor polls `/centraid/_gateway/health`
- [x] degraded-latency threshold (hung-but-listening reads as degraded)
- [x] component-error OS alerts with de-dupe
- [x] vault mount failures surfaced + retried (no permanent silent skip)
- [x] `vaults` probe does a real SQLite read per mounted plane
- [x] `disk` health component with free-space watermarks
- [x] backup status/run HTTP surface
- [x] Gateway page backup card with seal-key nudge
- [x] gateway instance lease (second-gateway split-brain detection)
- [x] `instanceId` exposed via `_gateway/info`
- [x] desktop single-instance lock
- [x] version-skew handshake wired for remote gateways
- [x] launch-at-login setting
- [x] missed-automation-run ledger (recorded, never retro-executed)
- [x] `broker` health probe (needs-auth + overdue token refresh)
- [x] `scheduler` health probe (per-vault tick staleness + missed windows)
- [x] numeric metrics on the health snapshot
- [x] OAuth token-refresh timeout
- [x] outbox external-write timeout
- [x] SSE subscriber cap
- [x] worker admission control
- [ ] ontology-version open-time guard (no single DB-level marker exists — `ontology_version` is stamped per-row, so an open-time compare is a product/data question, not a mechanical check)
- [x] app-engine `_changes` per-app SSE cap (third SSE surface)
- [ ] hard refusal on version skew (surfaced loudly for now; refusal is the documented escalation path)
- [ ] remote/headless self-update + mobile-down UX (distribution / RN-app work, out of this repo pass)

## What changed

- **packages/vault** — vault schema downgrade guard (`VaultSchemaAheadError`):
  `migrate()` now refuses to open a DB whose `PRAGMA user_version` is ahead
  of the running code's migration list (both vault.db and journal.db paths;
  the error carries file/known versions and a user-facing "upgrade the app"
  message, exported from the package index). `openFile()` sets
  `PRAGMA synchronous = FULL` on file-backed vault DBs — durability of each
  commit over throughput for a personal-data vault.
- **apps/desktop main** — graceful gateway stop on desktop quit
  (`before-quit` stops local gateways — WAL checkpoint + close — and the
  phone-link tunnel, capped at 5s); crash capture
  (`uncaughtException`/`unhandledRejection`) to a rotated crash log
  (NDJSON at `<userData>/crash.log`, 2MB rotation, log-and-continue
  posture); supervised gateway restart with backoff + crash-loop detection
  (1s/5s/30s, ≥3 failures in 2min stops retrying and surfaces the state);
  boot-failure dialog instead of a blank screen (gateway boots before the
  window; `dialog.showErrorBox` on failure); the manual "Restart gateway"
  action (IPC + Gateway page button) — a serialized stop→start on the local
  gateway that mints a fresh bearer, invalidates client auth caches, and
  rebroadcasts the gateway-changed event; the heartbeat monitor polls
  `/centraid/_gateway/health` (falling back to `/info` on 404) and adds
  `healthStatus`/`componentIssues`/`latencyDegraded` to the runtime
  snapshot — a degraded-latency threshold (hung-but-listening reads as
  degraded) of 2s sustained over 3 samples, and component-error
  OS alerts with de-dupe fire after 5 sustained minutes (master switch
  shared with the existing down-alert toggle).
- **packages/gateway (logs + diagnostics)** — rotated JSONL log persistence
  with boot tail-load: `GatewayLogStore` optionally appends every entry to
  `<logsDir>/gateway.jsonl` (4MiB rotation × 3 generations), reloads the
  tail into the ring on boot with seq continuity, and counts (never throws
  on) failed writes; opt-in via `GatewayPaths.logsDir` — wired for the CLI
  daemon (`<dataDir>/gateway-logs`) and the desktop embed
  (`gateways/<id>/gateway-logs`). New diagnostics bundle endpoint +
  save-dialog export: `GET /centraid/_gateway/diagnostics` (bearer-gated
  like `/health`) returns version/runtime/health/log-tail/per-vault DB
  sizes with deep key-name redaction (token/secret/credential/…); the
  desktop exports it via `exportGatewayDiagnostics()` through a native
  save dialog.
- **packages/gateway (health depth)** — vault mount failures surfaced +
  retried (no permanent silent skip): `VaultRegistry` records
  `failedMounts()` (schema-ahead flagged,
  duplicate-vault-id included), failed dirs are retried on later scans with
  a 30s backoff instead of being permanently swallowed, and the `vaults`
  probe folds them in as errors; the `vaults` probe does a real SQLite read
  per mounted plane (`PRAGMA user_version` against the live handle) so
  "vaults: ok" means readable, not merely mounted; new `disk` health
  component with free-space watermarks (error <1GiB, degraded <5GiB free on
  the vault root) plus per-vault DB/WAL sizes — statSync only, never the
  blob CAS.
- **backup HTTP surface + card** — backup status/run HTTP surface:
  `GET /centraid/_gateway/backup` (configured flag + per-vault
  lastBackupAt/lastVerifyAt/lastError/running, covering never-backed-up
  vaults too) and `POST /centraid/_gateway/backup/run` (202 trigger,
  serialized against in-flight runs, 409 when unconfigured), riding the
  same bearer gate as `/health`; `BackupService` gained `runAll()`/
  `isRunning()`. The Gateway page backup card with seal-key nudge shows
  per-vault backup/verify ages with a "Back up now" button and a permanent
  reminder that backups are ciphertext without an exported seal key; the
  Overview panel gained the Restart button, the Logs tab the Export
  diagnostics button, and the Components tab now wraps long detail strings
  instead of clipping them. Docs: the backups chapter mentions the card.

- **packages/gateway (instance lease)** — gateway instance lease
  (second-gateway split-brain detection): `gateway.lease` JSON at the vault
  registry root (`instanceId`/pid/hostname/startedAt/renewedAt), renewed
  every 30s, fresh window 90s. A fresh foreign lease at start or a foreign
  rewrite mid-run flips a persistent `instance` health error naming the
  rival and STOPS rewriting while conflicted (split-brain is made loud,
  never auto-resolved — same philosophy as backup generation fencing); a
  stale lease from a crashed process is reclaimed with a distinct detail;
  graceful stop removes only our own lease. `instanceId` exposed via
  `_gateway/info` (additive field) so clients can detect a gateway
  swap-under-them.
- **apps/desktop (wave 2)** — desktop single-instance lock
  (`app.requestSingleInstanceLock()`, second launch focuses the existing
  window); version-skew handshake wired for remote gateways — the
  previously dead `version-handshake.ts` now judges every remote heartbeat,
  adds `versionSkew` to the runtime snapshot and fires an immediate,
  de-duped OS notification (skew is a static build fact, not a transient
  blip; hard refusal is the documented escalation path, not built);
  launch-at-login setting (`launchAtLogin` in settings →
  `app.setLoginItemSettings`, toggle on the Gateway page Alerts tab,
  documented no-op on Linux).
- **packages/automation + gateway (missed runs + probes + metrics)** —
  missed-automation-run ledger (recorded, never retro-executed): the
  in-process scheduler persists `lastTickAt` in the vault's
  `automation_state` KV (sentinel `__scheduler`); a gap > 3× the scheduler
  period computes one missed-window entry per automation per gap (earliest
  fire time, 7-day scan cap) and pushes `automation-runs` degraded — the
  deliberate asymmetry with the self-healing outbox is documented in code.
  New `broker` health probe (needs-auth + overdue token refresh)
  flagging oauth2 tokens >1h past expiry with no refresh, and a
  `scheduler` health probe (per-vault tick staleness + missed windows).
  The webhook fire path now reports to `automation-runs` health (it never
  did — a webhook-triggered connector could fail silently forever).
  Numeric metrics on the health snapshot: `metrics = { rssBytes,
  outboxPending, sseClients, uptimeMs }` (outbox pending counted per vault;
  SSE count summed from the new subscriber-cap accessors).
- **packages/gateway + app-engine (hygiene bounds)** — OAuth token-refresh
  timeout (30s via a shared `timeoutSignal` helper) and outbox
  external-write timeout (60s), each riding the exact pre-existing
  network-failure path (broker: transient retry; outbox: stays approved,
  retried next drain — no new states). SSE subscriber cap (32 per surface)
  on `_logs/events` and `_automations/run/events`: over cap → 503
  `sse_capacity` + `Retry-After: 5`, counts exposed via accessors. Worker
  admission control at the real spawn site (`app-engine`'s handler-runner,
  not vault/host.ts as the audit guessed): 8 concurrent / 16 queued / 10s
  max wait, FIFO; refusal returns a `GATEWAY_BUSY` 503 through the existing
  error shape BEFORE any worker thread spawns.

- **app-engine (`_changes` SSE cap)** — app-engine `_changes` per-app SSE
  cap (third SSE surface): the `/centraid/<appId>/_changes` stream served by
  both the standalone gateway daemon and the desktop's embedded runtime
  accepted unlimited concurrent subscribers, same fd-exhaustion risk as the
  two gateway surfaces. Unlike those (one shared stream, a handful of
  devices), `_changes` is per-app and a user can legitimately have several
  windows of the SAME app open, so the new `ChangesSubscriberCap` is scoped
  PER APPID (16 per app, independent budgets) rather than one global
  counter — a runaway reconnect loop in one app's injected script can't
  starve every other app's stream. Over cap: 503 `sse_capacity` +
  `Retry-After`, same shape as the other two surfaces. `changesSubscriberCount()`
  (summed across apps) is exported from `@centraid/app-engine` and folded
  into the gateway's `sseClients` metric alongside the logs/automations
  counts, so `/health`'s number is now the real total across all three
  surfaces this process serves.

### Files

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/crash-log-core.test.ts`
- `apps/desktop/src/main/crash-log-core.ts`
- `apps/desktop/src/main/crash-log.ts`
- `apps/desktop/src/main/gateway-monitor-core.test.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/gateway-ops-core.test.ts`
- `apps/desktop/src/main/gateway-ops-core.ts`
- `apps/desktop/src/main/gateway-ops.ts`
- `apps/desktop/src/main/gateway-supervisor-core.test.ts`
- `apps/desktop/src/main/gateway-supervisor-core.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/login-item.ts`
- `apps/desktop/src/main/settings-merge.test.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/gateway-client-backup.ts`
- `apps/desktop/src/renderer/gateway-client.ts`
- `apps/desktop/src/renderer/react/screens/BackupCard.module.css`
- `apps/desktop/src/renderer/react/screens/BackupCard.test.tsx`
- `apps/desktop/src/renderer/react/screens/BackupCard.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.module.css`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.tsx`
- `apps/desktop/src/renderer/react/screens/LogsScreen.module.css`
- `apps/desktop/src/renderer/react/screens/LogsScreen.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.module.css`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayRoute.tsx`
- `packages/app-engine/src/handlers/dispatcher.ts`
- `packages/app-engine/src/handlers/handler-runner.test.ts`
- `packages/app-engine/src/handlers/handler-runner.ts`
- `packages/app-engine/src/handlers/worker-admission.ts`
- `packages/app-engine/src/http/changes-sse.test.ts`
- `packages/app-engine/src/http/changes-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/automation/src/fire/in-process-scheduler.test.ts`
- `packages/automation/src/fire/in-process-scheduler.ts`
- `packages/automation/src/fire/scheduler-ledger.test.ts`
- `packages/automation/src/fire/scheduler-ledger.ts`
- `packages/automation/src/index.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/cli/paths.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/diagnostics-routes.ts`
- `packages/gateway/src/routes/gateway-info-routes.ts`
- `packages/gateway/src/routes/logs-routes.test.ts`
- `packages/gateway/src/routes/logs-routes.ts`
- `packages/gateway/src/routes/sse-cap.ts`
- `packages/gateway/src/serve/broker-health.test.ts`
- `packages/gateway/src/serve/broker-health.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/connection-broker.test.ts`
- `packages/gateway/src/serve/connection-broker.ts`
- `packages/gateway/src/serve/disk-health.test.ts`
- `packages/gateway/src/serve/disk-health.ts`
- `packages/gateway/src/serve/fetch-timeout.ts`
- `packages/gateway/src/serve/gateway-diagnostics.test.ts`
- `packages/gateway/src/serve/gateway-diagnostics.ts`
- `packages/gateway/src/serve/gateway-instance-lease.test.ts`
- `packages/gateway/src/serve/gateway-instance-lease.ts`
- `packages/gateway/src/serve/gateway-log-store.test.ts`
- `packages/gateway/src/serve/gateway-log-store.ts`
- `packages/gateway/src/serve/health-registry.test.ts`
- `packages/gateway/src/serve/health-registry.ts`
- `packages/gateway/src/serve/outbox-executor.test.ts`
- `packages/gateway/src/serve/outbox-executor.ts`
- `packages/gateway/src/serve/scheduler-health.test.ts`
- `packages/gateway/src/serve/scheduler-health.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/vault/src/db.test.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `scripts/docs-site/src/content/backups.html`

## Decisions

- `PRAGMA synchronous = FULL` (not NORMAL): personal-data vault with a low
  write rate — per-commit durability wins over throughput.
- Ontology-version open-time guard skipped: `ontology_version` is a per-row
  stamp, not a DB-level marker; there is nothing unambiguous to compare.
- Log persistence is opt-in (`GatewayPaths.logsDir` has no implicit
  default) so tests and disposable embeds keep the pure in-memory ring;
  per-line `appendFileSync` (no batching) is deliberate at human-rate log
  volume.
- Mount-failure retries are gated by a flat 30s backoff because the health
  probe now triggers `rescan()` on every poll (~15s from the desktop) — a
  permanently broken directory must not be reopened on every poll.
- The `vaults` health probe folds `failedMounts` and per-plane readability
  into `error` detail strings; `ComponentHealth.detail` stays a plain
  string (wire shape untouched) — a structured `schemaAhead` flag over
  HTTP is a possible follow-up if the UI wants better-than-string-matching.
- Monitor keeps the existing `status: 'unknown' | 'up' | 'down'` union and
  ADDS `healthStatus`/`componentIssues`/`latencyDegraded` — no renderer
  breakage, degraded is a parallel signal, sticky at last-known value
  while unreachable (same posture as `version`).
- Component-alert threshold (5 min) and degraded-latency threshold (2s)
  are fixed constants behind the existing `gatewayAlertsEnabled` master
  switch — no new settings surface.
- Backup card staleness styling is a simple never-backed-up rule; exact
  2×interval thresholds would need `intervalHours`/`verifyEveryDays` on
  the wire (noted, not silently approximated).
- Crash handlers log-and-continue (never exit on `uncaughtException`) —
  desktop-shell posture, documented inline.
- (wave 2) The instance lease reports health push-style (the `BackupService`
  pattern, not a stateless probe) because conflict state must persist
  across ticks; the lease file lives directly under the vault root, where
  the registry scan already ignores non-directories.
- (wave 2) Missed windows: ONE entry per automation per downtime gap (not
  per missed minute), gap threshold 3× the scheduler period, 7-day scan
  cap; entries are persisted in the vault's `automation_state` KV under the
  `__scheduler` sentinel. An HTTP read surface for the ledger is NOT wired
  yet — `SchedulerLedgerStore.load()` is exported and ready; the health
  probes carry counts + latest in the meantime (known gap).
- (wave 2) No dedicated `webhooks` health component — the webhook route
  holds only in-memory rate-limit state, nothing worth probing; the real
  gap found instead was `webhookFire` never reporting run health, fixed.
- (wave 2) The worker spawn site is `app-engine`'s handler-runner (the
  audit's guess of vault/host.ts was wrong — vault spawns no workers);
  the busy refusal is a factory-built error, not a class, per the
  one-class-per-file lint rule.
- (wave 2) Version-skew alert fires immediately (no sustained window) —
  a build mismatch is a static fact, unlike transient component errors.
- (wave 2) `SchedulerLedgerStore` depends on `SchedulerLedgerKv`, a narrow
  structural subset of `ConversationStore` (just stateGet/stateSet) — the
  test fake satisfies it without casts, so the initial `no-explicit-any`
  suppressions were removed rather than justified.
- (follow-up) `_changes`'s cap lives in `packages/app-engine` (not
  `packages/gateway`, unlike the other two SSE caps) because the dependency
  direction is gateway -> app-engine, not the reverse; the shared-instance
  pattern is the same, just module-scoped one level down the graph.
  `ChangesSubscriberCap` counts per appId in a `Map`, deleting an app's
  entry at zero rather than leaving a stale 0 around indefinitely.

## Out of scope (tracked in #351)

- Ontology-version open-time guard — `ontology_version` is stamped per-row
  (mixed versions legitimately coexist), so there is no single marker to
  compare at open time; needs a product decision first.
- Hard refusal on version skew (surfaced + alerted for now).
- The app-engine per-app `_changes` SSE surface is still uncapped (flagged
  as its own follow-up task — needs per-app rather than global counting).
- Remote/headless gateway self-update and mobile-down UX (Tier 4;
  distribution / RN-app work).
- Bearer-token rotation/expiry for remote enrollment (enrollment redesign;
  the desktop's local bearer now rotates on every gateway restart).

## Verification

```sh
npx turbo run typecheck test build --filter=@centraid/vault \
  --filter=@centraid/gateway --filter=@centraid/backup \
  --filter=@centraid/desktop --filter=@centraid/automation \
  --filter=@centraid/app-engine
```

- The command above: 28/28 tasks green across the six touched packages
  (vault 447 tests, gateway 331→371 across the two waves, backup 108,
  desktop 572, automation and app-engine suites included; +1 pre-existing
  `tsx`-binary skip, +15 interop-gated backup skips). New suites include:
  downgrade-guard + synchronous-pragma tests (vault), log rotation /
  boot-tail / dropped-writes and diagnostics shape + redaction + bearer
  gating (gateway), failed-mount retry/backoff, broken-DB probe, disk
  watermark thresholds (gateway), backup route shapes incl. a real
  end-to-end configured round-trip over a local provider (gateway),
  crash-log, supervisor backoff/crash-loop, health reconciliation +
  component-alert de-dupe, diagnostics-export seams (desktop main),
  backup card / restart / export UI states (desktop renderer); and in
  wave 2: instance-lease conflict/stale/reclaim/stop semantics (7),
  missed-window computation + scheduler/broker probes (29+), version-skew
  detection + alert de-dupe (11), launch-at-login settings merge, hung
  token-endpoint and hung outbox-write timeouts against real
  never-responding servers, SSE cap 503 + count-decrement, and worker
  admission burst/FIFO/queue-timeout tests.
- `serve.test.ts` proves the diagnostics endpoint 401s without the bearer
  and that the gateway's own token never appears in the response body.
- oxlint/oxfmt run scoped to touched files by each workstream; one
  pre-existing unused-import warning in `build-gateway.ts` predates this
  change and was left alone.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-ac2077f8-1-1 | ac2077f8-e15a-46d5-be12-0c583922f047 | #351 | interrupt | structural |  | c2a2303 | 249 | 2026-07-11T04:54:29.307Z |
| steer-ac2077f8-1-2 | ac2077f8-e15a-46d5-be12-0c583922f047 | #351 | interrupt | structural |  | c2a2303 | 285 | 2026-07-11T05:30:46.226Z |
| steer-ac2077f8-1-3 | ac2077f8-e15a-46d5-be12-0c583922f047 | #351 | correction | classifier | PRs merged before E2E verification; state mismatch | c2a2303 | 424 | 2026-07-11T08:42:51.780Z |

## Audit

Fresh-context sub-agent (haiku) verdict at ordinal 81:

- **A1 — What changed matches the diff:** PASS — All files and descriptions in receipt's "What changed" section match current diff (committed + uncommitted). Wave 1 fully realized: vault schema downgrade guard (migrate.ts, db.ts), desktop graceful quit/crash/restart/UI (main.ts, crash-log*.ts, gateway-ops*.ts, gateway-supervisor*.ts, BackupCard.tsx), gateway logs/diagnostics/health/backup (gateway-log-store.ts, gateway-diagnostics.ts, disk-health.ts, backup-routes.ts, vault-registry.ts). Wave 2 fully realized: instance lease + split-brain detection (gateway-instance-lease*.ts), launch-at-login (login-item.ts, settings-merge.ts), version-skew handshake wired (gateway-monitor*.ts), missed-automation ledger (scheduler-ledger*.ts, automations-routes.ts), broker/scheduler probes (broker-health*.ts, scheduler-health*.ts), metrics (gateway-log-store.ts, health-registry.ts), OAuth/outbox/SSE/worker bounds (fetch-timeout.ts, sse-cap.ts, handler-runner.ts, worker-admission.ts, outbox-executor.ts, connection-broker.ts). Follow-up: app-engine `_changes` per-app SSE cap (changes-sse.ts, changes-sse.test.ts, app-engine/index.ts exports `ChangesSubscriberCap` + `changesSubscriberCount()`), per-appId cap=16, release decrement on disconnect, metrics folded into gateway health. Docs: backups.html updated.
- **A2 — checked items realized in the diff:** PASS — All 31 [x] checked items fully realized. Wave 1 (items 1-17): vault schema downgrade + PRAGMA FULL; graceful quit + before-quit handler; crash capture to rotated log; supervised restart with backoff/crash-loop detection; manual Restart IPC+button; boot-failure dialog; rotated JSONL logs + boot tail-load; diagnostics bundle endpoint + export; heartbeat on /health + fallback; degraded-latency threshold 2s/3-sample; component-error OS alerts + de-dupe; vault mount failures retried; vaults probe real SQLite read; disk health + watermarks; backup status/run HTTP; backup card + seal-key nudge. Wave 2 (items 18-30): instance lease + conflict detection; instanceId via /info; desktop single-instance lock; version-skew detection + alert; launch-at-login setting; missed-automation ledger; broker probe for token refresh staleness; scheduler probe for tick staleness + missed windows; numeric metrics object; OAuth token-refresh 30s timeout; outbox external-write 60s timeout; SSE subscriber cap (32/surface) + 503 Retry-After on two gateway surfaces; worker admission 8 concurrent/16 queued/10s timeout. Item 31 (follow-up, now checked): app-engine `_changes` per-app SSE cap — `ChangesSubscriberCap` per-appId=16, count exported as `changesSubscriberCount()` for health metrics, 2 new tests in `changes-sse.test.ts`.
- **A3 — checklist mirrors the issue:** PASS — Receipt's 34-item checklist (31 [x] checked, 3 [ ] deferred) matches issue #351's "Hardening pass checklist (waves 1+2, PR #361)" exactly after syncing the issue body for the newly-completed item: items 1-31 checked (item 31, app-engine `_changes` cap, flipped from unchecked to checked in both the receipt and the issue in this same pass), items 32-34 unchecked with identical deferral rationales (hard refusal on version skew as escalation path; ontology open-time guard as per-row data question; remote/headless self-update + mobile UX as distribution work).

## Steering

Fresh-context sub-agent (haiku) verdict at ordinal 81:

- **B1 — all steering events recorded:** PASS — No new steering events after prior ordinal 424. Transcript human-message review (excluding task notifications, hook feedback, local commands) found ordinal 81 = detailed task specification for the app-engine follow-up work. This is a task specification/context message for work already completed (not a redirect/correction of ongoing work), so not a steering event per governance definition. Accounting Steering table remains valid with three recorded events (steer-ac2077f8-1-1 at 249, steer-ac2077f8-1-2 at 285, steer-ac2077f8-1-3 at 424, all in session ac2077f8-e15a-46d5-be12-0c583922f047). No new rows appended.
- **B2 — no non-steering message recorded as steering:** PASS — Steering table contains only genuine steering events (interrupt/structural at 249, interrupt/structural at 285, correction/classifier at 424, each with clear basis in transcript); no false positives from task notifications, system reminders, or ordinary task requests.
