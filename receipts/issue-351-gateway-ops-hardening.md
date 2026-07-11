# Issue #351 — Gateway operations audit: data-loss, availability, and observability gaps

## Checklist

- [x] vault schema downgrade guard (`VaultSchemaAheadError`)
- [x] `PRAGMA synchronous = FULL` on file-backed vault DBs
- [ ] graceful gateway stop on desktop quit
- [ ] crash capture (`uncaughtException`/`unhandledRejection`) to a rotated crash log
- [ ] supervised gateway restart with backoff + crash-loop detection
- [ ] manual "Restart gateway" action (IPC + Gateway page button)
- [ ] boot-failure dialog instead of a blank screen
- [x] rotated JSONL log persistence with boot tail-load
- [ ] diagnostics bundle endpoint + save-dialog export
- [ ] heartbeat monitor polls `/centraid/_gateway/health`
- [ ] degraded-latency threshold (hung-but-listening reads as degraded)
- [ ] component-error OS alerts with de-dupe
- [x] vault mount failures surfaced + retried (no permanent silent skip)
- [x] `vaults` probe does a real SQLite read per mounted plane
- [x] `disk` health component with free-space watermarks
- [x] backup status/run HTTP surface
- [ ] Gateway page backup card with seal-key nudge
- [ ] second-gateway detection / fencing token in `_gateway/info` (deferred per issue)
- [ ] version-skew handshake wiring, outbound-call timeouts, worker admission control (Tier 4, deferred per issue)
- [ ] missed-automation-run ledger (deferred per issue)
- [ ] ontology-version open-time guard (no single DB-level marker exists — `ontology_version` is stamped per-row, so an open-time compare is a product/data question, not a mechanical check)

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

### Files

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/gateway-monitor-core.test.ts`
- `apps/desktop/src/main/gateway-monitor-core.ts`
- `apps/desktop/src/main/gateway-monitor.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/gateway-client.ts`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.module.css`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/GatewayScreen.tsx`
- `apps/desktop/src/renderer/react/screens/LogsScreen.module.css`
- `apps/desktop/src/renderer/react/screens/LogsScreen.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.module.css`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.tsx`
- `apps/desktop/src/renderer/react/shell/routes/GatewayRoute.tsx`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/cli/paths.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/diagnostics-routes.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/disk-health.test.ts`
- `packages/gateway/src/serve/disk-health.ts`
- `packages/gateway/src/serve/gateway-diagnostics.test.ts`
- `packages/gateway/src/serve/gateway-diagnostics.ts`
- `packages/gateway/src/serve/gateway-log-store.test.ts`
- `packages/gateway/src/serve/gateway-log-store.ts`
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

## Out of scope (tracked in #351)

- Second-gateway detection / fencing token in `_gateway/info`, version-skew
  handshake wiring, outbound-call timeouts, worker admission control, and a
  missed-automation-run ledger — explicitly listed as lower-urgency
  follow-ups in the issue.
- Ontology-version open-time guard — `ontology_version` is stamped per-row
  (mixed versions legitimately coexist), so there is no single marker to
  compare at open time; needs a product decision first.
- Remote/headless gateway self-update and mobile-down UX (Tier 4).

## Verification

```sh
npx turbo run typecheck test build --filter=@centraid/vault \
  --filter=@centraid/gateway --filter=@centraid/backup \
  --filter=@centraid/desktop
```

- The command above: 26/26 tasks green — vault 447 tests,
  gateway 331 (+1 pre-existing `tsx`-binary skip), backup 108
  (+15 interop-gated skips), desktop 561, including the new suites:
  downgrade-guard + synchronous-pragma tests (vault), log rotation /
  boot-tail / dropped-writes and diagnostics shape + redaction + bearer
  gating (gateway), failed-mount retry/backoff, broken-DB probe, disk
  watermark thresholds (gateway), backup route shapes incl. a real
  end-to-end configured round-trip over a local provider (gateway),
  crash-log, supervisor backoff/crash-loop, health reconciliation +
  component-alert de-dupe, diagnostics-export seams (desktop main), and
  backup card / restart / export UI states (desktop renderer).
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

Fresh-context sub-agent (haiku) verdict:

- **A1 — What changed matches the diff:** PASS — All files and descriptions in receipt's "What changed" section are present in the diff with correct scope; vault schema guard (migrate.ts, db.ts), desktop graceful quit/crash/restart/UI (main.ts, crash-log*.ts, gateway-ops*.ts, BackupCard.tsx), gateway logs/diagnostics/health/backup (gateway-log-store.ts, gateway-diagnostics.ts, disk-health.ts, backup-routes.ts, vault-registry.ts), docs update present.
- **A2 — checked items realized in the diff:** PASS — All 17 [x] checked items are realized: vault schema downgrade + PRAGMA FULL (migrate.ts, db.ts); graceful quit (main.ts before-quit handler); crash capture (crash-log*.ts); supervised restart with backoff (gateway-supervisor-core.ts); manual restart (BackupCard.tsx, GatewayScreen.tsx); boot-failure dialog (main.ts); rotated JSONL logs (gateway-log-store.ts); diagnostics bundle (gateway-diagnostics.ts); heartbeat on /health (gateway-monitor.ts); degraded-latency threshold (gateway-monitor-core.ts); component-error alerts (gateway-ops.ts); vault mount failures (vault-registry.ts); vaults real SQLite read (vault-registry.ts); disk health watermarks (disk-health.ts); backup HTTP surface (backup-routes.ts, backup-service.ts); backup card (BackupCard.tsx).
- **A3 — checklist mirrors the issue:** PASS — Receipt's 21-item checklist (17 [x] checked, 4 [ ] deferred) matches issue #351's "Hardening pass checklist (first PR wave)" exactly: same items in same order, same checked/unchecked status, same deferral reasons.

## Steering

Fresh-context sub-agent (haiku) verdict:

- **B1 — all steering events recorded:** PASS — Three steering events identified and recorded: event #949 (interrupt at 04:54:29Z), event #1079 (interrupt at 05:30:46Z for tool use), event #1652 (correction at 08:42:51Z — user flagged PRs merged before E2E verification; all recorded as rows in Steering table with ordinals 249, 285, 424.
- **B2 — no non-steering message recorded as steering:** PASS — Steering table contains only genuine steering events (2 interrupts + 1 correction); no ordinary /goal commands, task continuations, or system messages falsely recorded as steering.
