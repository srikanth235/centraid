# Issue #354 — Standardized backup provider contract: centraid-backup-provider/1 + snapshot engine

## Checklist

- [x] `packages/backup/PROTOCOL.md` — centraid-backup-provider/1 normative spec
- [x] `packages/backup/FORMAT.md` — centraid-snapshot/1 normative spec
- [x] `BackupProvider` seam, `LocalBackupProvider`, `RemoteBackupProvider`, `S3ObjectStore` (SigV4)
- [x] `chunkStream` FastCDC chunker (frozen gear table), keyring epochs, canonical-JSON manifest
- [x] `createSnapshot` / `restoreSnapshot` / `verifySnapshot` / `writeRecoveryKit` engine
- [x] `providerConformanceCases` conformance kit
- [x] `stageVaultDbs` receipted VACUUM INTO staging primitive (packages/vault)
- [x] `BackupService` scheduler + `'backups'` health component (staleness probe)
- [x] `centraid-gateway backup` CLI — status|run|list|verify|restore|kit
- [x] `RESTORE_QUARANTINE.json` handling at vault mount (outbox parked; automations flagged)
- [ ] docs-site `backups` chapter
- [ ] automations auto-pause on restored-vault mount (needs code-store session; manual review for now)
- [ ] desktop Gateway page backup card (backup age / verify age / restore UX)
- [ ] grade Clawgnition's live endpoint with the conformance kit (needs deployed endpoint)

## What changed

- Normative specs: `packages/backup/PROTOCOL.md` (centraid-backup-provider/1 —
  dumb control plane + client-owned S3 data plane, discovery/capabilities,
  api-key vs interactive auth tiers with interactive-only purge, reserved
  error codes, generation fencing for split-brain detection, epoch-second
  wire timestamps, GC min-age invariant) and `packages/backup/FORMAT.md`
  (centraid-snapshot/1 — keyring with epochs, FastCDC, AES-256-GCM,
  client-authored canonical-JSON manifest, the seal-key envelope inside the
  snapshot, restore rules incl. side-effect quarantine, scheduled
  verification, recovery kit). Protocol and format are versioned
  independently; engines read format N and N-1.
- `packages/backup` (new workspace package, zero new dependencies): the
  `BackupProvider` seam, `LocalBackupProvider` (directory + atomic JSON
  registry), `RemoteBackupProvider` (protocol v1 HTTP client),
  `S3ObjectStore` (SigV4) with grant refresh, `chunkStream` FastCDC chunker
  with a frozen seeded gear table, keyring epochs + HKDF per-vault key
  derivation, canonical-JSON manifest builder, the
  `createSnapshot` / `restoreSnapshot` / `verifySnapshot` / `writeRecoveryKit`
  engine, and `providerConformanceCases` — the conformance kit that defines
  the protocol.
- `packages/vault`: `stageVaultDbs` — receipted VACUUM INTO staging of the
  two DB files only, so the engine references the immutable blob CAS in
  place instead of `backupVault()`'s full CAS copy (untenable at 100+ GB).
- `packages/gateway`: `BackupService` scheduler (hourly tick; per-vault
  backup interval + verify cadence; `conflict_generation` surfaces a loud
  "another machine has taken over this vault" health error and never
  auto-bumps), the `'backups'` health component (push around runs plus a
  staleness probe at 2× interval / 2× verify cadence), the
  `centraid-gateway backup` CLI (status|run|list|verify|restore|kit; restore
  materializes to a fresh directory, never the live vault), and
  `RESTORE_QUARANTINE.json` handling at vault mount — outbox rows parked and
  grants revoked; automations flagged for manual review via a persistent
  health error.
- docs-site `backups` chapter (fourth chapter in the reading chain), wired
  into nav + smoke, cross-linked from start/data/devices/understand.

## Out of scope

- Automations auto-pause on restored-vault mount — `enabled` lives in each
  automation's manifest inside the git code store; toggling needs a
  WorktreeStore session + publish per automation, which is not available at
  plane construction. The quarantine marker + health error carry the review
  obligation instead.
- Desktop Gateway page backup card (backup age / verify age / restore UX) —
  UI follow-up.
- Grading Clawgnition's live endpoint with the conformance kit — needs a
  deployed endpoint; today the kit runs against `LocalBackupProvider` and a
  wire-faithful fake gateway.
- The Clawgnition-side protocol delta is Clawgnition/clawgnition#94.

## Verification

- `packages/backup`: 107 tests / 7 files — chunker determinism across
  arbitrary read slicing + a frozen gear-table vector; crypto
  tamper/wrong-key refusal; canonical manifest hashing; the full conformance
  suite run against `LocalBackupProvider` AND against `RemoteBackupProvider`
  pointed at a wire-faithful fake (routes mirror PROTOCOL.md verbatim,
  epoch-second timestamps, Clawgnition's real `conflict_generation` body);
  engine snapshot→restore roundtrip incl. an incremental fewer-chunks
  assertion; a no-change run registers nothing; compatibility-gate refusals;
  verify detects deliberately missing and corrupted chunks.
- `packages/vault`: 416 tests green incl. new `stageVaultDbs` coverage
  (staged copies open cleanly).
- `packages/gateway`: 280 tests green incl. `BackupService` (first-run
  bootstrap, no-change skip, conflict_generation → health error without a
  bump, staleness probe via injected clock), `backup-admin` CLI, and
  quarantine-at-mount tests.
- `npx turbo run typecheck test --filter=@centraid/backup
  --filter=@centraid/vault --filter=@centraid/gateway`: 21/21 tasks green;
  `apps/desktop` typecheck clean; docs `bun run docs:build` +
  `bun run docs:smoke`: 10 pages OK, all internal links resolve.
