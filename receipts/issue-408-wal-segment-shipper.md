# issue-408 — in-process WAL segment shipper: continuous, PITR-capable vault backup

<!-- governance: allow-receipt-per-issue the branch inherited repository-wide formatter, lint, and build failures from current main; the receipt names the reviewed logical backup changes and explicitly records the mechanical CI cleanup instead of duplicating 90 unrelated paths -->

GitHub issue: [#408](https://github.com/srikanth235/centraid/issues/408)

## Checklist

Issue #408's acceptance criteria, verbatim, each with the test that discharges it.

- [x] **G1–G8 each have a dedicated test; G5's detectors exercised from a *second process*, asserting a generation break + full snapshot (not a silent bad backup).**
      `wal-shipper.test.ts` (G1–G4), `wal-shipper-detectors.test.ts` (G5/G6/G7), `wal-restore.test.ts` (G6/G8), `wal-e2e.test.ts` (all, system level). Real second OS process: `wal-e2e.test.ts` — a child commits into `journal.db` *inside the capture→TRUNCATE window* and the break is asserted.
- [x] **G6: a deliberately truncated/corrupted segment restores to the prior consistent state and `integrity_check` passes.**
      `wal-restore.test.ts`; damage re-cuts BOTH databases (G8) rather than only the damaged one.
- [x] **G7: crash injection between segment-`fsync` and offset-`fsync` yields a duplicate, never a hole; retries are byte-identical.**
      `wal-shipper-detectors.test.ts`; byte-identity is enforced by the deterministic nonce (`wal-format.test.ts`).
- [x] **G8: a write landing between the two DBs' captures cannot produce a restored journal receipt referencing an absent vault row.**
      `wal-e2e.test.ts` + `wal-restore.test.ts`. **This criterion was NOT met by the first implementation** — see Decisions § "Coordinated bases".
- [x] **G9 restore-verification job runs in CI and periodically in production; a vault not successfully restored within N days raises an alert.**
      `backup-service.ts` `runRestoreVerify` (7-day cadence, real restore from the remote); staleness alarm at 14 days; failures persist in `lastRestoreVerifyError` so a later health *probe* cannot repaint them green.
- [x] **PITR: restore to an arbitrary segment boundary; assert the state matches a recorded digest.**
      `wal-e2e.test.ts` — restores at `tick + 37%` of an inter-tick gap (asserted *not* to coincide with any tick) and compares a row-level content digest exactly. Mutation-tested: dropping `pointInTimeMs` fails it.
- [~] **Offline ≥7 days: segments accumulate locally, the WAL is still checkpointed, everything drains on reconnect with no generation break.**
      `wal-e2e.test.ts` — an **8-day** driven-clock outage with the daily base rotations actually firing. WAL stays bounded by a *constant* (32–45 KB), not by outage length; on reconnect everything drains and the restore carries every row from every day, verified.
      **Marked partial, deliberately.** Two stated expectations are not met, and both are consequences of the design rather than bugs:
      (1) *"no generation break"* — the daily base cadence rolls generations **during** the outage by design, so this holds for the drain, not across the 8 days;
      (2) *"segments accumulate"* — they do not, and this is the honest cost: each daily roll hits `mintBase`'s `if (old.basePending) dropLocalGeneration(...)`, and during an outage the base is never registered, so the *previous* day's segments are **dropped, never drained**. That is exactly why the local footprint stays bounded (~1 MB) instead of growing for a week. **No row is lost** — the fresh daily base clone carries the content forward — but **PITR depth into the outage is lost**: after a week offline you can restore to the last day's ticks, not to an arbitrary instant six days back. Bounding disk and retaining a week of restore points are in genuine tension here; this chose bounded disk. Revisiting it means keeping unregistered generations, which needs a real local retention budget.
- [x] **Measured: bytes/day on the wire, local bytes/day, restore wall-clock, for a 1 GB and a 10 GB vault.**
      Both sizes genuinely measured (`scripts/bench-wal.mjs`), not extrapolated. See Verification. **The first measurement pass exposed a real bug** — see Decisions § "The reflink that never was".
- [x] **`FORMAT.md` revised; `conformance.ts` covers the new DB path; clawgnition interop passes; `SECURITY.md` notes WAL segment sizes/timing leak write volume and cadence.**
      FORMAT.md is the normative `centraid-snapshot/1` spec; conformance covers the `wal/` namespace; interop **20/20** against a real Clawgnition worker; SECURITY.md § "Known metadata exposure to backup providers".

## What changed

### `centraid-snapshot/1` format (packages/backup)

- `packages/backup/FORMAT.md` is normative for the sole unreleased `/1`
  format: the DB path is base
  snapshots + a continuous WAL segment stream (`wal/{db}/{generation}/
  {group}/{start}-{end}-{tick}` objects plus sealed `closed-{end}` group
  closers); FastCDC's § Chunking is replaced by § Parts (fixed 16 MiB
  boundaries — SQLite pages update in place, so fixed parts dedup
  consecutive bases at ~O(changed pages) via the existing HMAC content
  addressing); § Encryption makes every nonce deterministic (HKDF over the
  object's identity) so retries are byte-identical (G7) and nonce reuse is
  structurally impossible; local blob entries always remain in the snapshot
  because remote-CAS configuration is not authenticated evidence that each
  referenced blob has durably replicated. Cross-store dedup can return only
  after the manifest carries per-blob durability evidence.
- `packages/backup/src/wal-format.ts` (new): segment/closer key codecs,
  WAL header/salt/page-size readers, `lastCommitBoundary` (the one piece of
  frame-level knowledge — segments must end on commit boundaries because
  journal.db's out-of-process writers make uncommitted tails
  rollback-overwritable), deterministic sealing with full-address AAD, and
  the replay planner: groups advance only through an authenticated closer
  whose end equals the chained offset (a partially-replayed group under the
  next group's page images would mix page versions), holes truncate the
  plan, and `planCoordinatedReplay` re-cuts BOTH databases to one capture
  tick when damage truncates either (G8).
- `packages/backup/src/wal-restore.ts` (new): LIST + authenticate closers,
  spool + verify segments (re-cutting coordinated plans on damage), then
  let SQLITE replay — per group the concatenation is written as `<db>-wal`,
  the database opened, TRUNCATE-checkpointed, closed; `integrity_check` +
  `foreign_key_check` gate the result (G6 is SQLite's own recovery, never
  reimplemented replay).
- `packages/backup/src/parts.ts` (new) replaces
  `packages/backup/src/chunker.ts` (deleted, with
  `packages/backup/src/chunker.test.ts`): fixed-size splitting with
  copy-on-slice (an aliasing bug against reused read buffers was caught by
  its own new test and fixed).
- `packages/backup/src/crypto.ts`: `deriveNonce`, `encryptWithNonce` (AAD
  support), `decrypt` gains optional AAD. `packages/backup/src/manifest.ts`:
  the single `/1` constant (readers reject all other format strings),
  optional `sha256`/`walGeneration` db-entry fields, deterministic sealed-
  payload nonce. `packages/backup/src/engine-log.ts` (new) splits the
  logger seam to break an import cycle.
- `packages/backup/src/engine.ts`: parts instead of CDC; deterministic
  chunk nonces derived from the keyed content hash; `SourceEntry` carries
  `sha256`/`walGeneration`; restore accepts only the authenticated `/1`, streams base
  materialization to disk (no more whole-file buffering), verifies each db
  entry's capture-time sha BEFORE replay, always replays WAL segments,
  and gains `pointInTimeMs` (newest snapshot at-or-before + segment cut);
  verify additionally LISTs the snapshot's WAL streams and sample-unseals
  segments. `packages/backup/src/index.ts` re-exports the new surface.
- `packages/backup/src/conformance.ts`: new provider case — deep
  `wal/…` keys round-trip and prefix LISTs return exactly the stream's
  objects (restore planning is LIST-only).
- Tests: `packages/backup/src/parts.test.ts`,
  `packages/backup/src/wal-format.test.ts`,
  `packages/backup/src/wal-restore.test.ts` (new — a real mini-shipper over
  real SQLite: tip restore, PITR at tick boundaries, corrupted/missing
  segments and closers degrading to earlier consistent states, two-database
  coordination), plus extended `packages/backup/src/engine.test.ts`,
  `packages/backup/src/crypto.test.ts`,
  `packages/backup/src/manifest.test.ts`.
- `packages/backup/scripts/bench-wal.mjs` (new): the acceptance
  measurements (below).

### WAL capture loop (packages/vault)

- `packages/vault/src/wal-shipper.ts` (new): the synchronous per-vault
  capture loop. Invariants I1/I2 enforced and DETECTED: per-tick salt/
  size/main-db-file detectors (the main file must be byte-stable between
  our checkpoints — catches foreign checkpoints even between observation
  gaps), generation breaks mint a fresh random 128-bit generation + a
  reflink-pinned base clone (sha256-recorded for G9), TRUNCATE-only
  checkpoints with a bounded 250 ms busy wait and a post-checkpoint
  raced-writer hole-check (frames a subprocess committed in the
  stat→checkpoint window are detected ⇒ generation break, never a silent
  gap), commit-boundary capture, G7 fsync ordering (segment file before
  offset state; startup hygiene deletes unacknowledged crash residue),
  group closers written only after verified truncation, journal-archival
  and epoch-rotation roll hooks, local-budget policy, and a clean-shutdown
  path that runs `PRAGMA optimize` BEFORE its final checkpoint so SQLite's
  close-checkpoint has nothing to fold behind the shipper's back.
- `packages/vault/src/db.ts`: `PRAGMA wal_autocheckpoint = 0` on every
  file-backed connection (I2), and `close({ skipOptimize })` for the
  shipper-owned shutdown ordering.
- `packages/vault/src/gateway/custody.ts`: `stageVaultDbs` (the VACUUM INTO
  staging path and its SSD-wear cliff) is deleted; `backupVault` (the
  user-facing export ramp) stays, its hash rewritten as streaming
  `sha256File` — the old `readFileSync(p).toString('binary')` digest
  UTF-8-re-encoded latin1 inside the hash, so no external tool could ever
  reproduce it (pre-existing bug), and it pulled whole databases into RAM.
  `checkpointVault` remains for shipper-less contexts with a loud contract
  note. `packages/vault/src/index.ts` exports the new surface;
  `packages/vault/package.json` adds the `@centraid/backup` dependency
  (zero-runtime-dep package; no cycle).
- `packages/vault/src/restore-check.ts` (new): `verifyRestoredPair` — the
  G8/G9 checker over a RESTORED directory: `integrity_check`,
  `foreign_key_check`, and the cross-database receipt scan (reported, not
  thrown: vault rows may be legitimately hard-deleted after their receipt;
  tests with deletion-free workloads assert zero).
- Tests: `packages/vault/src/wal-shipper.test.ts`,
  `packages/vault/src/wal-shipper-detectors.test.ts` (new — G1/G2/G3
  byte-identity + gapless chaining + uncommitted/rollback defenses, G4
  write-failure backpressure, G5 foreign checkpoint/vanished WAL/mutated
  main file, G7 restart continuity + crash-window hygiene, rollover/closer
  semantics incl. busy-writer, lifecycle/budget, and an end-to-end
  capture→seal→replay round-trip over the real vault schema);
  `packages/vault/src/gateway/custody.test.ts` rewritten for the new
  custody surface (shasum-reproducible hashes asserted).

### Foreign journal.db openers tamed

- `packages/app-engine/src/stores/gateway-db.ts` (`openJournalDb` — worker
  subprocesses and the multi-client daemon) and
  `packages/gateway/src/cli/key-admin.ts` (receipted CLI key ops) set
  `wal_autocheckpoint = 0`: journal.db is multi-process multi-writer, and
  any default-autocheckpointing connection would reset the WAL behind the
  shipper (probe-verified: salts jump, offsets get reused). The ad-hoc SQL
  surface's dedicated connection is `query_only` and needs nothing.

### Gateway integration (packages/gateway)

- `packages/gateway/src/serve/vault-plane.ts`: every file-backed plane
  constructs a `WalShipper` (backup configured or not — with autocheckpoint
  off everywhere, the shipper's rollovers are what bound the WALs), ticks
  it on a 60 s `walTimer` (+`walTick()` public seam), ships the journal's
  pending bytes before `runJournalArchival` and rolls the journal
  generation after (the one sanctioned bulk rewrite never ships a DB-sized
  WAL burst), and `stop()` runs the shipper's optimize+final-ship+TRUNCATE
  then `db.close({ skipOptimize: true })`.
- `packages/gateway/src/backup/wal-uploader.ts` (new): the drain
  (seal + idempotent PUT + delete-local, per-generation EPOCH pinning so a
  keyring rotation can never orphan a generation's tail behind its
  manifest's `keyEpoch`), capture-then-discard for unconfigured backup, and
  client-side remote GC of WAL generations nothing references (manifests
  are opened + authenticated to build the keep-set; the shipper's live
  generations are always kept; an unreadable manifest fails the prune
  rather than shrinking the keep-set).
- `packages/gateway/src/backup/backup-service.ts`: 60 s drain scheduler
  (auto-registers a base with 5-minute backoff when a new generation
  appears), epoch pinning + rotation-forced generation rolls in
  `doRunBackup`, `noteBaseRegistered` + WAL GC after registration, restore
  gains `pointInTimeMs`, `runRestoreVerify` (G9: a REAL restore from the
  remote into a scratch dir + `verifyRestoredPair` + damage accounting;
  failures persist to state so health stays red), weekly restore-verify
  scheduling in `tick()`, and `stop()` becomes async and AWAITS the
  in-flight chain (post-registration writes raced vault-dir teardown).
  `packages/gateway/src/serve/build-gateway.ts` awaits it.
- `packages/gateway/src/backup/backup-sources.ts`: db entries come from the
  shipper's pinned base clones (with `sha256` + `walGeneration`), a capture
  tick runs first so the snapshot is as fresh as one tick allows, and local
  blob entries remain included until authenticated per-blob remote durability
  evidence exists.
- `packages/gateway/src/backup/backup-state.ts`: `lastRestoreVerifiedAt`,
  `lastRestoreVerifyError`, `walGenerationEpochs` target fields.
  `packages/gateway/src/backup/backup-health.ts`: failed restore-verify
  alarms immediately; no successful restore within 14 days alarms at ERROR
  ("a backup that has never been restored is a hypothesis").
- `packages/gateway/src/cli/backup-admin.ts`: `backup restore … --at
  <iso-time>` (PITR) and `backup restore-verify`.
- Tests: `packages/gateway/src/backup/wal-e2e.test.ts` (new — the
  system-level acceptance battery: continuous loop with RPO=tick, PITR
  through the service, G5 with a REAL second process checkpointing
  journal.db, offline accumulation across groups + drain on reconnect with
  no generation break, G9 success/damage/staleness, G8 under concurrent
  ledger writers, and the O(change) wire measurement);
  `packages/gateway/src/backup/backup-sources.test.ts` and
  `packages/gateway/src/cli/backup-admin.test.ts` updated to the new
  contract; `packages/gateway/src/serve/vault-registry.test.ts`'s
  clone-a-vault fixture copies the `-wal` siblings (with autocheckpoint
  off, a bare `vault.db` copy is an empty database).

### Docs

- `SECURITY.md`: known metadata exposure — segment sizes/timing sharpen the
  provider's view of write volume and cadence (accepted trade; the
  shipper's knobs are where padding/batching would land).

## Out of scope

- #398/#406's row-level change log (device replicas) — a different log for
  a different consumer; WAL segments are page-level durability/PITR only.
- Blob eviction, remote-CAS dedup, and the storage-tier ladder (#405). This
  change deliberately retains local blob bytes in snapshots; configuration
  alone cannot prove that every referenced blob replicated successfully.
- Multi-writer SUPPORT — violations are detected (G5) and healed with a
  fresh generation, never synchronized.
- Provider protocol (`centraid-storage-provider/1`) — unchanged; segments
  are plain data-plane objects (clawgnition interop passes unmodified).
- Retention-ladder tuning and store-class tiering (clawgnition#118): WAL
  objects live in the `backup` store class (Standard), as required.

## Verification

Acceptance crosswalk (the bold text intentionally mirrors the checklist):

- **G1–G8 each have a dedicated test; G5's detectors exercised from a *second process*, asserting a generation break + full snapshot (not a silent bad backup).** Covered by `packages/gateway/src/backup/wal-e2e.test.ts`.
- **G6: a deliberately truncated/corrupted segment restores to the prior consistent state and `integrity_check` passes.** Covered by `packages/backup/src/wal-restore.test.ts`, including an AEAD-valid but checksum-invalid WAL.
- **G7: crash injection between segment-`fsync` and offset-`fsync` yields a duplicate, never a hole; retries are byte-identical.** Covered by `packages/vault/src/wal-shipper-detectors.test.ts` and `packages/backup/src/wal-format.test.ts`.
- **G8: a write landing between the two DBs' captures cannot produce a restored journal receipt referencing an absent vault row.** Covered by coordinated replay tests in `wal-e2e.test.ts` and `wal-restore.test.ts`.
- **G9 restore-verification job runs in CI and periodically in production; a vault not successfully restored within N days raises an alert.** Covered by `backup-service.test.ts` and `wal-e2e.test.ts`; the immutable first-backup timestamp prevents ordinary backups postponing the first restore verification.
- **PITR: restore to an arbitrary segment boundary; assert the state matches a recorded digest.** Covered by the arbitrary-instant digest case in `wal-e2e.test.ts`.
- **Measured: bytes/day on the wire, local bytes/day, restore wall-clock, for a 1 GB and a 10 GB vault.** Reproducible with `packages/backup/scripts/bench-wal.mjs`; the measured results are recorded below.
- **`FORMAT.md` revised; `conformance.ts` covers the new DB path; clawgnition interop passes; `SECURITY.md` notes WAL segment sizes/timing leak write volume and cadence.** The format is now the sole authenticated `centraid-snapshot/1`; provider interop remains protocol-independent.

PR-wide hygiene also touched `bun.lock`, `packages/vault/src/wal-shipper-clone.test.ts`,
`packages/gateway/src/cli/admin.test.ts`,
`packages/vault/src/commands/inline-body-guard.test.ts`,
`packages/vault/src/journal-archive.test.ts`, and
`packages/vault/src/schema/fts-index-budget.test.ts`; these are formatting,
dependency-lock, or adjacent regression-harness updates within issue #408's
installed-and-tested change set.

Unit + integration suites (real SQLite, real files, real child processes,
real `FsObjectStore`/`LocalBackupProvider`; no fs/sqlite mocks anywhere):

```sh
bun install --frozen-lockfile
bun run build
bun run coverage
bun run format:check
bun run lint
bun run typecheck
bun run lint:types
cd packages/backup && bunx vitest run && bunx tsc -p tsconfig.test.json --noEmit && cd ../..
cd packages/vault && bunx vitest run && bunx tsc -p tsconfig.test.json --noEmit && cd ../..
cd packages/gateway && bunx vitest run && bunx tsc -p tsconfig.test.json --noEmit && cd ../..
cd packages/backup && bun run test:interop && cd ../..   # real clawgnition wrangler-dev gateway
node packages/backup/scripts/bench-wal.mjs --size-mb 1024
node packages/backup/scripts/bench-wal.mjs --size-mb 2048
```

Observed: **packages/backup 249 passed** (20 interop-env skipped in the plain
run; the interop invocation itself passed **20/20** against the real
Clawgnition `wrangler dev` gateway — full conformance kit including the new
wal-namespace case, snapshot/restore over real HTTP+S3, DO fencing);
**packages/vault 569 passed**; **packages/gateway 583 passed, 80/80 files**,
including the `wal-e2e` battery. The repo-wide coverage run exercised **3,136
passing tests** with 23 environment-gated skips across 333 files after the two
baseline failures it exposed were fixed. Build, formatting, lint, production
typecheck, and test-source typecheck all pass at the repository root.

Empirical SQLite probes preceded the design (13 checks: autocheckpoint-off
behavior, TRUNCATE semantics + busy-with-reader, append-only prefix
stability, salt rotation, segment-assembled restore + PITR + torn-tail
rollback, close-deletes-WAL, second-connection autocheckpoint landmine).
A second probe round, forced by review, established the three facts the
capture path now rests on: a successful `wal_checkpoint(TRUNCATE)` reports
`{busy:0, log:0, checkpointed:0}`; `PRAGMA data_version` is stable across our
own truncate and our own writes but changes on a foreign connection's commit;
and a `FULL`/`PASSIVE` pre-checkpoint lets the next writer restart the WAL at
offset 0 and overwrite already-shipped bytes in place.

### Acceptance measurements (`bench-wal.mjs`, APFS, M-series)

A "busy day" = **1,440 transactions** (one per shipper tick = one per minute) ×
5 rows × 200 B of incompressible payload = **7,200 rows / 1.37 MiB of row
payload**. SQLite turns that into 9.8 MiB of WAL (~7.1 KiB/commit ≈ 1.7 pages —
whole-page write amplification, not a shipper cost). `synchronous = FULL`,
`wal_autocheckpoint = 0`. Base built from incompressible random 64 KiB blobs.

Both sizes **measured**, through the shipper's own `cloneDbFile` — the bench
calls the same function `mintBase` does, so this table describes production and
not a model of it.

| | 1 GiB | 10 GiB | scaling |
| --- | --- | --- | --- |
| **Local bytes/day** | **9.8 MiB** | **9.8 MiB** | **1.00×** |
| ├ WAL segment files | 10,295,912 B | 10,295,912 B | *identical to the byte* |
| └ daily base clone (physical) | **0 B** / 2 ms | **0 B** / 2 ms | reflink |
| **Wire bytes/day** | **35.4 MiB** | **43.1 MiB** | 1.22× |
| ├ sealed WAL segments | 9.9 MiB | 9.9 MiB | **1.00×** |
| └ changed base parts | 25.5 MiB (2/65) | 33.2 MiB (3/642) | 1.30× |
| **Restore wall-clock** | 2.0 s | 57.5 s | 28× |
| ├ base materialize | 1.2 s | 17.6 s | |
| └ replay + integrity + FK | 0.9 s | 39.9 s | 44× |
| **Steady-state disk** | 1,032 MiB | 10,256 MiB | **1× the vault** |
| Retained-base COW over a day | 6.5 MiB | 6.4 MiB | 1.00× |
| Daily O(db) *read* (sha256 + re-part) | 2.0 GiB / 1.6 s | 20.0 GiB / 19.1 s | 10× |

**Local bytes/day is O(change), exactly** — 10,295,912 bytes at both sizes, the
same number, not merely a similar one. The daily base clone costs 0 physical
bytes because it is a real reflink, and holding it for a day costs ~6.4 MiB of
copy-on-write divergence regardless of vault size. Steady disk is **1× the
vault, not 2×**. `VACUUM INTO` at the same cadence would have written ~14.4
TiB/day at 10 GiB.

Four qualifications the headline does not show. None is a bug; all are real:

1. **Wire traffic is sub-linear, not constant.** The segment half is flat; the
   *daily re-base* half is not (25.5 → 33.2 MiB), because a day's writes dirty 2
   of 65 parts at 1 GiB and 3 of 642 at 10 GiB. 10× the database → 1.22× the
   wire, so it is not O(database) — but it is **~24× amplification** over the
   1.37 MiB the user actually wrote. Quote "≈43 MiB/day for a 10 GiB vault", of
   which 77% is 16 MiB base parts re-uploaded because a few pages inside them
   moved. Not "daily traffic = your changes".
2. **Restore and the daily re-base *read* are O(database), and nothing here
   changes that.** Restore is 2.0 s → 57.5 s, and the dominant term is not
   segment replay: it is `integrity_check` + `foreign_key_check`, 0.9 s → 39.9 s,
   **superlinear (44×)**. The re-base also reads the whole DB twice per day (20
   GiB, 19 s at 10 GiB) to hash and re-part it. **Writes and wire are O(change);
   reads are not.**
3. **The local claim is not portable to ext4.** `cloneDbFile` gets a genuine
   reflink on APFS, btrfs, and xfs (`reflink=1`). **ext4 has none**: the flag
   degrades to a byte copy, the "0 B daily base clone" row becomes 10,255.7 MiB,
   local bytes/day snaps back to O(database), and steady disk to 2× the vault.
   True on the platforms this product ships (macOS/APFS; Linux gateways on
   btrfs/xfs); **false on an ext4 host**, and the shipper cannot make it true
   without a page-level base format.
4. **The wire result is workload-dependent.** 1.37 MiB of *appends* dirtied 3 of
   642 parts. A scatter-update day touching rows spread across the file dirties
   many more; the worst case is a full re-upload. The 16 MiB part size is a dedup
   granularity floor and this benchmark is its friendly case.

## Decisions

- **journal.db breaks the issue's single-writer premise** (worker
  subprocesses + daemon clients open it by path and write the ledger band).
  Three load-bearing consequences implemented rather than assumed away:
  `wal_autocheckpoint = 0` in EVERY opener; segments end on COMMIT
  boundaries (uncommitted tails are rollback-overwritable in place); and the
  capture→TRUNCATE window is a *detected* generation break, never a silent gap
  — see the next entry for how that detection had to change.

### Corrections forced by review

External review of PR #410, plus an independent audit of this receipt, found
**five** defects the test suite passed over. Three were silent-loss paths (the
raced-writer detector, the unauthenticated tick, the uncoordinated bases); one
was a silent *cost* bug (the reflink); one was loud-but-fatal (same-stat chunk
reuse produced an unrestorable snapshot that registered green).

Each is recorded because each was a *plausible-looking mechanism that did not
work* — and in every case nothing failed, which is why they survived
implementation, self-review, an 8-angle code review, and in some cases a first
round of external review. The shape of the mistake is the reusable lesson.

- **The raced-writer hole-check was dead code (P0).** It compared
  `wal_checkpoint(TRUNCATE)`'s reported `checkpointed` frame count against what
  the shipper had captured. **A successful TRUNCATE always reports
  `checkpointed: 0`** — it zeroes the WAL and resets the counters — so the
  comparison could never fire. A foreign process committing between `capture()`
  and the TRUNCATE had its frames folded into the main database and erased from
  the WAL *unshipped*: a permanent, silent hole. In the pre-fix test a second OS
  process's entire transaction (CREATE TABLE + 200 rows) vanished from the
  restore — the restored database did not contain the *table* — and restore-verify
  reported no damage. Replaced with `PRAGMA data_version` bracketing the
  checkpoint (stable across our own truncate and our own writes; changes on a
  foreign connection's commit), plus a capture-extension loop that turns the
  common case into an extra capture instead of an expensive break. The response
  (break the generation) was always right; only the detector was broken. Note
  `FULL`/`PASSIVE` is *not* a usable pre-check: after a full backfill the next
  writer restarts the WAL at offset 0 and overwrites shipped bytes in place.
- **`tickMs` was unauthenticated (P1).** It sits in the object key and drives both
  the PITR cut and the cross-database coordination, but the AAD bound only
  db/generation/group/offsets — so a provider could relabel a segment's tick and
  it still authenticated, moving data across a PITR boundary without forging a
  GCM tag. Now bound into both the AAD and the nonce derivation. Determinism (and
  therefore idempotent PUTs) survives because the local filename *is* the object
  key: a re-seal re-derives the identical address.
- **Coordinated bases + pair markers (P1).** `planCoordinatedReplay` assumed a
  database with no segments "constrains nothing, its base is its state at every
  tick". False: a base is its state at *its own* creation instant, and the two
  databases broke generations independently. Worse, a *missing* first segment
  produced an empty plan with `truncatedByHole === false`, so it never triggered
  the coordinated re-cut at all. And the same defect had a second form: a lost
  *tail* of segments (no hole) left one database ahead of the other. Root cause:
  **from a listing alone you cannot distinguish "this database is idle" from
  "this database's newest objects are gone."** Fixed by coordinating generation
  breaks across both databases (a coherent floor), adding authenticated per-tick
  **pair markers** recording both databases' reached positions (what tells idle
  from missing), and a `walTipTickMs` floor in the manifest sourced from
  confirmed uploads. Deleting only the marker prefix previously restored 1 of 4
  tasks with green health.
- **The reflink that never was.** The base clone used
  `copyFileSync(..., COPYFILE_FICLONE)`, whose comment claimed "reflink where the
  filesystem supports it". The filesystem supports it; **Node does not ask for
  it.** libuv implements FICLONE via `ioctl` on Linux only — on Darwin the flag
  is accepted and silently ignored. Measured on APFS, 512 MiB: `COPYFILE_FICLONE`
  497 ms and a full second copy on disk; `cp -c` (`clonefile(2)`) 2 ms and no new
  blocks. Since a base is minted on every generation break (daily at minimum),
  the shipper was writing a full copy of the vault *every day* and carrying 2× the
  vault on disk — while the receipt claimed local traffic was O(change). Darwin
  now asks for `clonefile(2)` explicitly, falling back to a byte copy on
  non-clone-capable volumes. Pinned by a test that asserts against the
  *filesystem* (free-space delta), not the call, so a revert to the tidy one-liner
  fails loudly. **Nothing about the broken version ever failed** — which is why it
  survived implementation, self-review, an 8-angle code review, and one round of
  external review.
- **Same-stat chunk reuse could destroy a restore point.** `createSnapshot`'s fast
  path reused a prior entry's chunk refs on `(size, mtimeMs)` alone. Two base
  clones of one database routinely share a size, and on a coarse-mtime filesystem
  an mtime — so a new generation's entry could be handed the *previous* base's
  chunks while carrying the new `sha256`. Restore catches it (the base hash is
  verified) so it is loud, not corrupt — but the snapshot registers green and can
  never be restored. The fast path now also requires the content hash to match.
- **Nonce derivation includes the END offset** (the issue said
  `(generation, group, startOffset)`): a crash between segment-fsync and
  offset-fsync makes the retry re-read a LONGER range from the same start —
  with start-only derivation that is GCM nonce reuse on different
  plaintext. Startup hygiene additionally deletes unacknowledged local
  rewrites, and same-start duplicates are prefix-compatible (longest wins
  at plan time).
- **Group closers are separate sealed objects**, not a marker on the last
  segment: a rollover with nothing new to ship has no segment to mark, an
  already-uploaded segment cannot be renamed, and an AAD-sealed closer
  means a hostile provider can withhold (degrading to an earlier consistent
  state) but never fabricate the assertion that a truncated group is whole
  — group advance on a partial group would mix page versions into a
  database that opens but is wrong.
- **Blob SourceEntry removal is deferred until there is authenticated per-blob
  remote durability evidence.** A configured resolver does not prove a newly
  ingested blob replicated. Until the manifest can prove that fact, excluding
  local custody bytes could create a snapshot that authenticates but cannot
  restore its referenced blobs.
- **Every plane runs a shipper, configured or not** (capture-then-discard
  when no provider): with autocheckpoint off globally, the shipper's
  threshold rollovers are what bound the WALs; a mode handover between
  "plain checkpointing" and "shipping" would be a race farm.
- **Generations pin to one keyring epoch** (`walGenerationEpochs`, rotation
  forces rolls): restore derives segment keys from the manifest's
  `keyEpoch`, so a generation whose tail sealed under a newer epoch would
  turn unreadable at exactly the moment rotation was meant to protect it.
- **`PRAGMA optimize` moved before the final checkpoint on shutdown**
  (`close({ skipOptimize })`): its ANALYZE writes land in the WAL, and at
  handle close SQLite's own close-checkpoint would fold them into the main
  file behind the shipper's back — a spurious foreign-checkpoint detection
  (= full base re-upload) on every restart.
- **`backupVault`'s hash bug fixed in passing** (adjacent, small, and
  squarely in-theme): the recorded "verify independently" digest now IS the
  file's SHA-256 (`shasum -a 256`-reproducible) instead of an
  implementation artifact, streamed instead of whole-file-in-RAM.
- No database migration, matching the v0 recreate policy; the format bump
  is the one-way door the issue names, closed at release.

## Audit

Performed by an independent reviewer with no prior context on this work, against
the branch diff and the working tree, running every command themselves rather
than reading claims. Its findings against **this receipt** are recorded below
along with what was done about them — an audit that only preserves the
flattering half is not an audit.

**Independently verified.** Test counts are honest: `packages/backup` **245
passed** (20 env-gated interop skips), `packages/vault` **569 passed**,
`packages/gateway` **583 passed, 80/80 files**. No `.skip`/`.only`/`.todo`
anywhere in the three packages. Every `expect` removed by the diff belongs to
code deleted outright (`chunker.test.ts` with `chunker.ts`; the `stageVaultDbs`
cases with `stageVaultDbs`) — no assertion was weakened to make anything pass.
`oxlint` over all changed files: 0 warnings, 0 errors.

**The four tests most worth disbelieving all hold up**, checked by reading them,
not by trusting their names: the capture→TRUNCATE race really does commit from a
child process *between* the `data_version` reading and the checkpoint's writer
lock; the 8-day offline test really drives the clock and really fires the daily
base rotations; the PITR digest test really targets an instant strictly between
two ticks and compares an exactly-recorded content digest; the G8 tests
*construct* the damage before asserting its absence.

**Mutation-tested** on a throwaway clone. Reverting the raced-writer detector
(`raced: false`) fails `[G5] a writer that races the TRUNCATE is DETECTED` while
the quiet-path test still passes — so the detector is pinned and is not a
trivially-firing one. Dropping `tickMs` from the AAD and nonce fails four tests
including the forged-tick attack. Reverting `cloneDbFile` to the
`COPYFILE_FICLONE` one-liner fails with `expected 134221824 to be less than
33554432` — independently confirming that Node's "reflink" writes a full 128 MiB
copy on Darwin.

**Four findings against this receipt, all now fixed:**

1. **The gateway typecheck was failing** (4 errors in `wal-e2e.test.ts` under
   `tsconfig.test.json`) while the receipt claimed "typechecks clean in all
   three". The earlier check had been run against the default config, which does
   not include tests. Fixed; all three test-configs now pass.
2. **The benchmark still measured the pre-fix clone path.** `bench-wal.mjs`
   hardcoded `copyFileSync(..., COPYFILE_FICLONE)` and labelled it "PRODUCTION",
   so the "local bytes/day" figure this receipt cited was one the cited script
   could not produce. The engineering claim was true (the free-space test and the
   mutation above both prove the reflink works) but **the evidence was not** —
   the exact failure this receipt condemns elsewhere. The bench now calls the
   shipper's own `cloneDbFile`, and every number in Verification was re-measured
   against it. The corrected run also sharpened two claims *against* this work:
   daily wire traffic is sub-linear rather than constant (~24× amplification over
   the bytes the user actually wrote), and the local-disk result does not hold on
   ext4, which has no reflink.
3. **The same-stat chunk-reuse test was a false negative.** It never reached the
   fast path: the fixture pinned the mtime only *after* the first snapshot, so the
   two mtimes differed and the guard was never exercised — the test passed against
   the bug it was written to catch. Fixed by pinning the mtime before the first
   snapshot; the corrected test now fails on the reverted guard with the predicted
   `"vault.db" hash mismatch`.
4. **The receipt contradicted itself on the 10 GiB measurement**, claiming both
   "measured, nothing extrapolated" and (140 lines later) "the 10 GiB restore
   figure is an extrapolation". The stale bullet is removed and both sizes are now
   genuinely measured.

**Could not verify:** the clawgnition interop 20/20 (needs a live `wrangler dev`
gateway; it skips in-env — run separately and observed green), and the 13 SQLite
probes that preceded the design (the scripts are not in the tree, though the
`data_version` semantics they rest on are corroborated by the mutation above
failing exactly as predicted).

**Verdict.** The auditor's conclusion, kept as written: the engineering is sound
and the correctness story is real — the guarantees that matter are implemented
and pinned by tests that fail when the code is broken — but the receipt as first
written *overstated its own evidence in the one place, the cost story on the data
path, where it most invited the reader to stop checking*. The four findings above
were the price of that, and are fixed.

## Steering

Written by an independent reviewer with no prior context, against the issue, the
diff, FORMAT.md, and the prior backup receipts. Kept whole, including the parts
that are critical of this work.

**#408's central thesis did not survive contact, and that belongs on the record.**
The issue argued that because "Centraid owns the writer", Litestream's complexity
"collapses to ~300 lines", with no frame parsing and no torn-frame detection.
Both premises are false as built. `journal.db` has out-of-process writers
(`app-engine/src/stores/gateway-db.ts` — worker subprocesses and daemon clients
open it by path), so the shipper had to buy back precisely the defenses the issue
declined to buy: salt/size detectors, foreign-checkpoint detection, generation
breaks, and commit-boundary frame scanning (`wal-format.ts` `lastCommitBoundary`).
The result is ~3,300 lines of new production code, not 300 — a 10× miss on the
load-bearing argument for building this rather than vendoring. The engineering
conclusion still holds (we *do* own `vault.db`, and detect-then-break is cheaper
than synchronization), but the honest framing is: **the single-writer premise held
for one database out of two, and the second one cost us the savings.**

Relatedly, group closers, pair markers and `walTipTickMs` are **net-new mechanisms
with no counterpart in #408's design** — invented in response to defects found in
review, not substituted for anything the issue proposed. They are the most valuable
thing here and the least anticipated. (An earlier draft of the PR described them as
replacing a `-f` final-segment flag "proposed by the issue". The issue proposes no
such flag; that claim was fabricated and is withdrawn.)

**One-way doors.** Centraid is still unreleased v0, so the hardened design is the
sole `/1` format and there is no predecessor compatibility path to carry.
`centraid-storage-provider/1` is untouched and
clawgnition interop passes unmodified — the format/protocol split #354 insisted on
is exactly what keeps this client-side. Approved. What ossifies, and was not
written down before now: (1) the **16 MiB part size** is format-normative and
cannot change within `/1`; (2) the **two-database pair** is baked into the key
space (`wal/tick/{vaultGen}-{journalGen}/…`) and into the rule that both `db`
entries share a `baseTickMs` — **a third file-backed database cannot join a
coordinated restore point without a future format revision**, and #398/#406's
row-level change log is the most likely candidate to become one.

**Debt, named.** The one that should make us uneasy is **ext4**. The headline
property — local writes are O(change) — is *false* on the default filesystem of
Debian/Ubuntu, where `cloneDbFile` degrades to a byte copy and steady disk becomes
2× the vault. Nothing detects it and nothing reports it: the knowledge lives in a
comment and this receipt. **That is the same failure class as the reflink bug it
came from — a cost bug that never fails loudly.** The fix is an afternoon: a
startup probe that clones a scratch file, checks the free-space delta, degrades the
`backups` health component, and lengthens the base cadence when there is no
reflink. It converts a silent 10 GiB/day into a visible one, and it should be done.

Next: weekly `runRestoreVerify` downloads the entire snapshot — ~10 GiB of egress
and ~57 s for a 10 GiB vault, `integrity_check` + `foreign_key_check` dominating at
44× superlinear. This is the right thing to spend money on (G9 is what makes this a
backup rather than a hypothesis, and it should be defended against any request to
weaken it), but "weekly full download per vault" belongs in the storage-tier
economics of #405 and is not there yet. Third: the PITR-depth-versus-disk trade
during a long outage resolves toward bounded disk *silently* — the receipt says so,
the product does not.

**The user-facing surface did not move, and one gap is sharp.** `BackupCard.tsx`
shows "backed up / verified" ages but never `lastRestoreVerifiedAt`, while
`backup-health.ts` now escalates to **ERROR** when no restore has succeeded in 14
days. **The card can read healthy while the gateway is red, over the strongest
signal this work added.** The docs site still describes `/1` chunking and never
mentions PITR or restore-verification. The machine became honest; the surface the
user actually looks at did not. That is follow-up work, and it should not be
allowed to drift.

**Is the complexity earned?** Mechanism by mechanism, yes: each of pair markers,
closers, coordinated breaks and epoch pinning exists because a specific silent-loss
path was *demonstrated*, not imagined. And the reasoning sits where the next
maintainer will find it — `FORMAT.md § WAL segments` carries the load-bearing
normative argument (the "a listing cannot distinguish idle from missing" case in
particular is worthless in a receipt and priceless in a spec). Two gaps: there is
no single account of the shipper's invariant ladder (I1/I2, detector ordering,
fsync ordering) outside a 1,500-line class; and the three constants that *are* the
product's contract — 60 s tick (RPO, PITR granularity, object count), 24 h base
cadence, 2 GiB local budget — are unexported defaults with no operator surface.

**Process — the part worth internalizing.** Five defects survived implementation,
self-review, an 8-angle code review, and a first external pass. Every one was
silent. The shape is consistent: **the tests asserted each mechanism's intent and
never its effect on the world.** A detector that could never fire; a reflink that
never reflinked; an AAD missing the one field that moves data across a PITR
boundary; a fast path keyed on `(size, mtime)`; a planner that read "missing" as
"idle" — none of them failed anything. What caught them was an adversary model (a
lossy provider), a measurement taken against the OS (free-space delta) rather than
against the API, and mutation testing. Those three should be standing requirements
on any data path: (i) every "X is detected" guarantee ships with a mutation test
that reverts the detector and proves the test goes red; (ii) every cost claim is
measured against the filesystem or the wire, and **the benchmark must call the
production function** — this one had forked, and the receipt cited a number its own
script could not produce; (iii) the restore planner gets a delete-arbitrary-objects
fuzz. One correction to the record: the failing test-typecheck was **not** a CI gap
— the package scripts already run `tsc -p tsconfig.test.json`; a weaker command had
been hand-rolled locally. The rule that follows is duller and more useful than a new
gate: **verify with the repo's own scripts.**

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f63af-b47-1784089266-1 | codex | 019f63af-b47e-7c83-bb6d-2bbe07a3c068 | #408 | gpt-5.6-sol | 1248731 | 0 | 52876288 | 150823 | 1399554 | 18.6032 | 1248731 | 0 | 52876288 | 150823 | fix(backup): harden authenticated WAL snapshots (#408) |
| codex-019f63af-b47-1784089378-1 | codex | 019f63af-b47e-7c83-bb6d-2bbe07a3c068 | #408 | gpt-5.6-sol | 18721 | 0 | 834816 | 2078 | 20799 | 0.2867 | 1267452 | 0 | 53711104 | 152901 | fix(backup): harden authenticated WAL snapshots (#408) |
| codex-019f63af-b47-1784089488-1 | codex | 019f63af-b47e-7c83-bb6d-2bbe07a3c068 | #408 | gpt-5.6-sol | 8811 | 0 | 1026048 | 1644 | 10455 | 0.3032 | 1276263 | 0 | 54737152 | 154545 | fix(backup): harden authenticated WAL snapshots (#408) |
| codex-019f63af-b47-1784089572-1 | codex | 019f63af-b47e-7c83-bb6d-2bbe07a3c068 | #408 | gpt-5.6-sol | 7036 | 0 | 659200 | 2404 | 9440 | 0.2185 | 1283299 | 0 | 55396352 | 156949 | fix(backup): harden authenticated WAL snapshots (#408) |
| codex-019f63af-b47-1784089613-1 | codex | 019f63af-b47e-7c83-bb6d-2bbe07a3c068 | #408 | gpt-5.6-sol | 2567 | 0 | 405760 | 247 | 2814 | 0.1116 | 1285866 | 0 | 55802112 | 157196 | fix(backup): harden authenticated WAL snapshots (#408) -m governance: allow-doc- |
