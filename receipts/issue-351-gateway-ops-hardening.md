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
  window; `dialog.showErrorBox` on failure); the heartbeat monitor polls
  `/centraid/_gateway/health` (falling back to `/info` on 404) and adds
  `healthStatus`/`componentIssues`/`latencyDegraded` to the runtime
  snapshot — a degraded-latency threshold (2s sustained over 3 samples)
  means a hung-but-listening gateway reads as degraded, and component-error
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
  retried: `VaultRegistry` records `failedMounts()` (schema-ahead flagged,
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

- `npx turbo run typecheck test build --filter=@centraid/vault
  --filter=@centraid/gateway --filter=@centraid/backup
  --filter=@centraid/desktop`: 26/26 tasks green — vault 447 tests,
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
