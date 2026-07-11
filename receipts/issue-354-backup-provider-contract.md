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
- [x] docs-site `backups` chapter
- [x] grade Clawgnition's live endpoint with the conformance kit (wrangler dev, real D1)
- [x] full-story E2E: seeded vault (real blobs/app/sealed value/outbox item) → real backup → real CLI restore → adopted as a live vault
- [x] fix cross-process registry staleness in `LocalBackupProvider` (generation fencing was silently broken across processes)
- [x] fix `manifestKey` prefix bug + the matching conformance-kit fixture bug (found by a real provider rejecting it)
- [x] fix seal-key-entry-on-every-vault bug in `backup-sources.ts` (found by the first real test of that module)
- [ ] automations auto-pause on restored-vault mount (needs code-store session; manual review for now)
- [ ] desktop Gateway page backup card (backup age / verify age / restore UX)

## What changed

- `packages/backup/PROTOCOL.md` — centraid-backup-provider/1 normative spec,
  and `packages/backup/FORMAT.md` — centraid-snapshot/1 normative spec.
  PROTOCOL.md (centraid-backup-provider/1) covers: dumb control plane +
  client-owned S3 data plane, discovery/capabilities, api-key vs interactive
  auth tiers with interactive-only purge, reserved error codes, generation
  fencing for split-brain detection, epoch-second wire timestamps, GC
  min-age invariant. FORMAT.md (centraid-snapshot/1) covers: keyring with
  epochs, FastCDC, AES-256-GCM, client-authored canonical-JSON manifest, the
  seal-key envelope inside the snapshot, restore rules incl. side-effect
  quarantine, scheduled verification, recovery kit. Protocol and format are
  versioned independently; engines read format N and N-1.
- `packages/backup` (new workspace package, zero new dependencies) ships the
  `BackupProvider` seam, `LocalBackupProvider`, `RemoteBackupProvider`,
  `S3ObjectStore` (SigV4); `chunkStream` FastCDC chunker (frozen gear
  table), keyring epochs, canonical-JSON manifest; and
  `providerConformanceCases` conformance kit — in detail:
  the `BackupProvider` seam, `LocalBackupProvider` (directory + atomic JSON
  registry), `RemoteBackupProvider` (protocol v1 HTTP client),
  `S3ObjectStore` (SigV4) with grant refresh, `chunkStream` FastCDC chunker
  with a frozen seeded gear table, keyring epochs + HKDF per-vault key
  derivation, canonical-JSON manifest builder, the
  `createSnapshot` / `restoreSnapshot` / `verifySnapshot` / `writeRecoveryKit`
  engine, and `providerConformanceCases` — the conformance kit that defines
  the protocol.
- `stageVaultDbs` receipted VACUUM INTO staging primitive (packages/vault):
  `packages/vault`'s VACUUM INTO staging of the two DB files only, so the
  engine references the immutable blob CAS in place instead of
  `backupVault()`'s full CAS copy (untenable at 100+ GB).
- `BackupService` scheduler + `'backups'` health component (staleness
  probe); `centraid-gateway backup` CLI — status|run|list|verify|restore|kit;
  `RESTORE_QUARANTINE.json` handling at vault mount (outbox parked;
  automations flagged) — all three land in `packages/gateway`: the
  `BackupService` scheduler (hourly tick; per-vault backup interval + verify
  cadence; `conflict_generation` surfaces a loud "another machine has taken
  over this vault" health error and never auto-bumps), the `'backups'`
  health component (push around runs plus a staleness probe at 2× interval /
  2× verify cadence), the `centraid-gateway backup` CLI
  (status|run|list|verify|restore|kit; restore materializes to a fresh
  directory, never the live vault), and `RESTORE_QUARANTINE.json` handling
  at vault mount — outbox rows parked and grants revoked; automations
  flagged for manual review via a persistent health error.
- docs-site `backups` chapter (fourth chapter in the reading chain), wired
  into nav + smoke, cross-linked from start/data/devices/understand.
- Bug fixes found during the follow-up honesty pass: fix cross-process
  registry staleness in `LocalBackupProvider` (generation fencing was
  silently broken across processes); fix `manifestKey` prefix bug + the
  matching conformance-kit fixture bug (found by a real provider rejecting
  it); fix seal-key-entry-on-every-vault bug in `backup-sources.ts` (found
  by the first real test of that module) — plus grade Clawgnition's live
  endpoint with the conformance kit (wrangler dev, real D1) and the
  full-story E2E: seeded vault (real blobs/app/sealed value/outbox item) →
  real backup → real CLI restore → adopted as a live vault. In detail: a
  follow-up honesty pass closed the gap between "unit tested" and
  "end-to-end tested" the first round left: fixed `LocalBackupProvider`
  caching `registry.json` in memory (generation fencing silently could not
  work across processes — two independent provider instances on one
  rootDir now observe each other's writes), fixed `createSnapshot`
  registering a bare `manifests/...` key instead of the target-prefixed
  form PROTOCOL.md requires (a real provider 400s the bare form; the
  conformance kit had the identical bug in its own fixtures), fixed
  `backup-sources.ts` including a seal-key entry on every vault regardless
  of whether anything was ever sealed (gate on the real seal fingerprint,
  not file existence — this module had zero prior test coverage), added
  `backup-sources.test.ts` against a real vault with real blobs/app/sealed
  data, added `backup-e2e.test.ts` (no injected seams: real
  `BackupService` → real CLI restore → adopted as a live vault, data/
  blobs/sealed-value/quarantine/code-store all verified), and added
  `interop-clawgnition.test.ts` — an env-gated suite that boots the real
  Clawgnition gateway under `wrangler dev` and runs the full conformance
  kit plus a real snapshot/restore/verify/fencing round trip against it.
  That run found and closed two real Clawgnition-side bugs, tracked at
  Clawgnition/clawgnition#94.

## Out of scope

- Automations auto-pause on restored-vault mount — `enabled` lives in each
  automation's manifest inside the git code store; toggling needs a
  WorktreeStore session + publish per automation, which is not available at
  plane construction. The quarantine marker + health error carry the review
  obligation instead.
- Desktop Gateway page backup card (backup age / verify age / restore UX) —
  UI follow-up.
- The Clawgnition-side protocol delta is Clawgnition/clawgnition#94.

## Verification

- `packages/backup`: 108 tests / 9 files (local) — chunker determinism
  across arbitrary read slicing + a frozen gear-table vector; crypto
  tamper/wrong-key refusal; canonical manifest hashing; the full conformance
  suite run against `LocalBackupProvider`; engine snapshot→restore roundtrip
  incl. an incremental fewer-chunks assertion; compatibility-gate refusals;
  verify detects deliberately missing and corrupted chunks; two independent
  `LocalBackupProvider` instances on one rootDir observing each other's
  generation writes.
- `interop-clawgnition.test.ts` (15 tests, `CLAWGNITION_INTEROP=1`, skips
  cleanly otherwise): the full conformance kit plus a real snapshot→restore
  round trip, verify catching real chunk loss, generation fencing incl.
  replay-before-fencing, a read-mode grant, and account/usage/generation
  shape — all run against a real `wrangler dev` Clawgnition Worker with
  local D1 and a real coordinator DO, zero fakes of either side's code. Run
  clean twice from a fresh boot.
- `packages/gateway`: 290 tests / 50 files green incl. `backup-e2e.test.ts`
  (7 tests, real seeded vault → real backup → real CLI restore → adopted
  live vault: mounts, data/blobs/sealed-value round-trip, quarantine parks
  a real staged outbox item, code store re-clones; plus incremental delta,
  verify-catches-damage, real fencing, and pre-download restore refusal) and
  `backup-sources.test.ts` (3 tests, real blob/git/seal-key assembly —
  previously zero coverage).
- `packages/vault`: 416 tests green incl. `stageVaultDbs` coverage.
- `npx turbo run typecheck test build --filter=@centraid/backup
  --filter=@centraid/vault --filter=@centraid/gateway`: 21/21 tasks green.
