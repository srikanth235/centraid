# issue-439 — Restore as a product: UI-first recovery flow, lazy-by-default restore, orphan-grace GC, adopt-time reconcile
<!-- governance: allow-receipt-per-issue interim receipt while implementation waves land; the Audit attestation is refreshed by a fresh-context subagent with the final commit of #439 -->

GitHub issue: [#439](https://github.com/srikanth235/centraid/issues/439)

#436 shipped the hosted-vs-local binary and the five-metric surface; two of those
metrics (recovery window, exit) are only kept at restore time. This issue turns the
existing restore machinery (lazy engine restore, WAL/PITR replay, previews-first warm
pass, quarantine-on-adopt, generation fencing, recovery kit) into a recovery product:
a single service-layer `recover()` verb with the UI and the CLI as thin shells over
it, lazy-by-default restore on the production path, an orphan-grace GC invariant that
makes the recovery-window number honest between snapshots, and an adopt-time
inventory reconcile that distrusts the restored replica index.

## Checklist

- [x] R2 — lazy is the default, full is the flag
- [x] R3 — PITR stays restore-to-side
- [x] R1 — the recovery verb: service-layer recover() and the blank-machine e2e
- [x] R6 — CLI recover wrapper
- [x] R5 — adopt-time inventory reconcile and seal-key restore-verify
- [x] R1 surface — recover job model, progress SSE, pre-vault recover routes
- [x] UI — fresh-gateway onboarding recovery flow
- [x] R4 — orphan-grace GC invariant

## What changed

Grown per commit; each checked checklist item is discharged by the identically
titled `###` subsection below.

### R2 — lazy is the default, full is the flag

The only production restore path (`cli/backup-admin.ts`) never passed `lazy`, so
every CLI restore materialized every blob — the metered-egress bulk download the
previews-first path was built to avoid. Restore is now lazy-by-default at the
SERVICE layer (so the future `recover()` verb inherits it), with `--full` as the
override and a metered-egress confirm gate before start.

- `packages/vault/src/db.ts` — exposed a narrow `remote(): RemoteTier | null`
  accessor on the `VaultDb` interface, wired to the existing cached `remoteTier()`
  closure inside `openVaultDb`. This lets the gateway ask "does this vault have a
  durable remote CAS tier?" without rebuilding S3 config by hand; `null` mirrors
  `remoteTier()`'s own contract (no s3-kind `blob_store` or no resolvable
  credential ⇒ full restore). Constructing the tier makes no network call.
- `packages/gateway/src/backup/backup-service.ts` — `restore()` now takes an
  optional `full?: boolean`; resolution order is explicit `lazy` (tests / the
  recovery UI) wins, else `full` forces a full restore, else auto-resolve the
  vault's own remote tier and prefer lazy whenever one exists
  (`opts.lazy ?? (opts.full ? undefined : this.autoLazyTier(vaultId))`). Added the
  private `autoLazyTier()` (resolves the tier through the live plane's
  `db.remote()`), the reusable `restoreEgressEstimate()` method (the metered gate's
  and the later recovery UI's manifest-free cost evidence), the
  `RestoreEgressEstimate` result type, the shared `LazyRestoreOption` type, and the
  module-level `pickSnapshotRow()` helper (selects the snapshot a restore/estimate
  targets: explicit `seq`, else newest at-or-before `--at`, else newest).
- `packages/gateway/src/cli/backup-admin.ts` — added `--full` and `--yes` flags
  (parser + `BackupArgs`); the restore action now calls `restoreEgressEstimate()`
  and, when the home is `metered-egress`, refuses to start without `--yes`,
  printing the honest download it will incur (full downloads `totalBytes`; lazy
  defers every remote-held blob). `free-egress` or no discovery skips the gate.
  Passes `full` through to the service, reports which mode ran (lazy previews-first
  vs full) on stderr, and added the `formatBytes()` output helper and a
  test-only `deps?: { provider }` injection seam.
- `packages/gateway/src/backup/backup-service-restore.test.ts` — a new focused
  suite (kept separate to stay under the line cap) covering the `db.remote()`
  accessor, auto-full (no tier), auto-lazy (tier present), `full:true` override,
  explicit-lazy-wins-over-full, and `restoreEgressEstimate` (metered + free-egress);
  its compact harness uses a db-only snapshot so the lazy resolution is asserted
  without the auto-resolved tier ever being dialed.
- `packages/gateway/src/cli/backup-admin.test.ts` — new CLI tests for `--full`,
  a free-egress home never gating, and a metered-egress home refusing without
  `--yes` then proceeding with it (via the injected metered provider).

### R3 — PITR stays restore-to-side

Restore never writes in place — it always materializes a fresh side directory, and
adopting the result is a separate deliberate step. This rides the engine's
existing empty-`destDir` refusal (`packages/backup/src/engine.ts`); this change
makes the rule explicit in the CLI surface and proves it with a test.

- `packages/gateway/src/cli/backup-admin.ts` — the header doc and the restore
  usage string now state that restore ALWAYS materializes a fresh, empty side
  directory and never swaps or restores in place over a live vault (FORMAT.md
  restore rule 3), and that adopting + clearing the quarantine marker are separate
  steps; the success message repeats the to-side rule with the issue reference.
- `packages/gateway/src/cli/backup-admin.test.ts` — new test proving a restore
  into a `--dest` that already holds a vault (`vault.db` present) is refused and the
  pre-existing bytes are left untouched.

### R1 — the recovery verb: service-layer recover() and the blank-machine e2e

One shell-agnostic `recover()` orchestration composes the existing machinery —
kit parse → provider discovery → snapshot listing + row-`appMeta` compatibility
gate (no manifest download) → lazy restore into a staging dir + WAL replay to tip
→ generation fencing (seed at `currentGeneration+1`) → adopt (staging dir becomes
the live vault via an atomic rename; quarantine fires on first mount) →
previews-first warm-or-honest-skip → honest completion report. Two thin shells
sit over it (the CLI now; wave 4's HTTP routes later), never UI-wrapping-CLI.

- `packages/backup/src/recovery-kit.ts` (new) — `parseRecoveryKit()` + the
  `RecoveryKitDocument` type: the strict READER counterpart to `writeRecoveryKit`.
  Validates kind/version, the keyring (via the now-exported `validateKeyring`),
  and each target's addressing; rejects anything malformed before a provider call.
- `packages/backup/src/crypto.ts` — exported `validateKeyring` (was private) so
  the kit reader holds the kit's keyring to the same rules `loadKeyring` uses.
- `packages/backup/src/engine.ts` — exported `assertCompatibleAppMeta` (was
  private) so `recover()` can gate on the registry row's `appMeta` ALONE, before
  a manifest, a chunk, or an egress byte is fetched.
- `packages/backup/src/index.ts` — re-exported `parseRecoveryKit`,
  `RecoveryKitDocument`, `assertCompatibleAppMeta`, `validateKeyring`.
- `packages/gateway/src/backup/recover.ts` (new) — the `recover()` verb with a
  typed `RecoverPhase` progress union (`discovering`/`fetching`/`replaying`/
  `fencing`/`adopting`/`warming`/`done`, consumed by `onPhase` — wave 4's SSE
  seam), the `RecoverInput`/`RecoverReport`/`RecoverAdoptContext` types, and the
  `discoverRecovery()` facts helper (mirrors Wave 1's `RestoreEgressEstimate`
  shape). Design notes: the **inventory skip-set** is built by paginating the
  provider's ATTESTED `listInventory('cas')` and mapping keys→shas with the same
  `blobs/sha256/<sha>` regex the reconcile audit uses — no inventory capability ⇒
  a full restore (honest fallback); the **fencing seed** writes the recovered
  gateway's backup state at `currentGeneration+1` + `lastSeq` (backup-state.ts's
  atomic pattern) and writes the kit's keyring to `<backupDir>/keyring.json`
  (refusing to clobber a live one); the **adopt seam** stages into
  `<root>/.recover-staging-<rand>` then atomically renames to `<root>/<vaultId>`,
  relocates the restored `seal.key` into custody position
  (`sealKeyFileFor` = `<root>/keys/<vaultId>.sealkey`, or the vault bricks on
  first mount), and fires the `onAdopted` hook — **this is where wave 3's R5
  reconcile and wave 4's live mount slot in**; the **warm pass** runs only when a
  `resolveRemoteTier` seam yields a tier, else it is skipped and reported
  honestly (`previews.warmed:false` + reason — never faked); the report carries
  recovered-as-of (the coordinated WAL cut), truncated-or-not, deferred-blob
  count, and the quarantine set.
- `packages/gateway/src/backup/recover-internals.ts` (new) — the per-phase step
  helpers (provider resolution, the attested-inventory skip-set, seal-key
  relocation, the fenced-state seed, warm-or-skip), split out of `recover.ts` so
  each stays under the 500-line cap and the verb reads as its six phases.
- `packages/gateway/src/serve/vault-registry.ts` — added `adopt(vaultId)` (the
  live-gateway seam wave 4 calls): `scan()` to mount the recovered dir, then drop
  the pristine auto-created default so the recovered vault stands alone. The
  removal is gated on an AIRTIGHT signal — a new `autoCreatedDefaults` set tracks
  only the id THIS registry minted on an empty root — so a hand-created vault or
  any vault with user data is never touched. `scan()` now also skips dot
  directories, so an in-flight `.recover-staging-*` dir (which carries a
  `vault.db`) is never mounted mid-restore. Carries a `file-size-limit` waiver
  (#439): the registry is one cohesive mount/lifecycle owner and the adopt seam
  reuses its private plane map + scan/delete plumbing, so splitting it out would
  expose that internal state across a module boundary.
- `packages/gateway/src/backup/recover-e2e.test.ts` (new) — the FORMAT.md
  acceptance test made real: machine A seeds a vault (tasks + originals + thumbs +
  a SEALED credential and an approved outbox item), backs up against
  `startFakeProviderServer()`, and replicates a blob subset into the provider's
  cas store; a BLANK machine calls `recover()` with only the kit + api-key. It
  asserts the whole contract — vault dir + rows intact, remote-held blobs deferred
  while local-only ones materialize, the seal key placed (the sealed vault only
  mounts if it was), quarantine present pre-mount and firing on mount (item parked
  + grant revoked), the fenced generation seeded (old+1) with the superseded
  machine's next `registerSnapshot` 409ing `conflict_generation`, and an honest
  report. A second test proves the compat gate refuses a newer-`vaultUserVersion`
  row BEFORE any byte is fetched (no vault dir, no staging scratch, no keyring).
- `packages/gateway/src/serve/vault-registry.test.ts` — new `adopt()` test:
  mounts a recovered vault dir and removes the pristine auto-created default,
  leaving the recovered vault the effective default.
- `packages/backup/src/recovery-kit.test.ts` (new) — kit round-trip + rejection
  of wrong kind, unsupported version, malformed keyring, and missing addressing.

### R6 — CLI recover wrapper

A thin CLI shell over the same `recover()` — the headless Linux daemon install
path and the e2e harness. It needs no daemon config: provider addressing comes
from the kit, the api-key is passed in.

- `packages/gateway/src/cli/recover-admin.ts` (new) — `centraid-gateway recover
  --kit <file> --api-key <key> --data-dir <dir> [--at <iso>] [--full] [--vault
  <id>] [--yes]`. Reads + parses the kit file, runs `discoverRecovery()`, prints
  the zero-vocabulary "found your vault — X, safe as of T, hosted at P" card to
  stderr, applies the metered-egress `--yes` gate (the same rule Wave 1's restore
  gate uses), then runs `recover()` streaming phase-progress lines to stderr and
  the JSON completion report to stdout. Respects `refuseIfDaemonHoldsRoot` on the
  target data dir and reminds the operator that resuming BACKUPS needs a `backup`
  config block.
- `packages/gateway/src/cli/backup-admin.ts` — exported `refuseIfDaemonHoldsRoot`
  and `formatBytes` for reuse by the recover CLI (no duplication).
- `packages/gateway/src/cli/cli.ts` — wired the `recover` subcommand into the
  dispatch + usage/help text.
- `packages/gateway/src/cli/recover-admin.test.ts` (new) — against the fake HTTP
  provider (metered-egress): prints the facts, gates without `--yes` (writing
  nothing), proceeds with `--yes` (JSON report on stdout, fenced generation 2,
  previews-on-demand), and refuses missing required flags.

## Decisions

- **The RemoteTier reaches the service through a new `VaultDb.remote()` accessor,
  not a rebuilt S3 client.** The production tier already lives in `openVaultDb`'s
  cached closure; exposing it read-only is the narrowest seam and keeps rotation
  semantics (settings-keyed cache) intact. `autoLazyTier()` reads it via the live
  plane, so a vault with no mounted plane or no durable tier falls back to full.
- **The lazy download figure is not fabricated.** The snapshot registry row's
  `totalBytes` is the honest whole-library (`--full`) download; a lazy restore
  defers every remote-held blob, and that upfront byte count is not knowable from
  the row without a manifest, so `restoreEgressEstimate` reports the full figure
  plus a `lazyAvailable` flag rather than inventing a lazy number.
- **`recover()` is pre-vault, so it calls the ENGINE directly, not
  `BackupService`.** `BackupService` is bound to already-mounted vaults;
  recovery runs on a blank machine with no plane, so it drives `restoreSnapshot`
  itself and seeds backup state by hand. The lazy skip-set therefore comes from
  the provider's ATTESTED `listInventory('cas')` (there is no local vault to
  resolve a `RemoteTier` from) — a soft-deleted object is not counted, and no
  inventory capability means a full restore, honestly.
- **The warm-pass credential question is resolved by a `resolveRemoteTier`
  seam, not a fake.** Building a live CAS `RemoteTier` needs the vault's per-sha
  content keys (sealed in the restored `vault.db`) plus gateway-wired S3
  credentials — neither is available to a headless CLI pre-mount. So `recover()`
  warms only when a caller supplies a tier resolver (wave 4 opens the restored
  vault with the gateway's `s3Credentials` and returns its own `.remote()`); the
  CLI passes none and the report says `previews.warmed:false` with a reason —
  previews stream in on demand after mount. Nothing is faked.
- **Fencing is a seeded TOKEN, not a registration.** `recover()` writes
  `generation = currentGeneration+1` into local state but does NOT register a
  snapshot; the fence arms when the recovered gateway's FIRST post-recovery
  backup registers at that generation, bumping the provider — only then does the
  superseded machine's next registration 409. The e2e proves this two-step fence
  end to end.
- **The seal key is relocated at adopt.** The snapshot's `seal-key` entry
  materializes at `<vaultDir>/seal.key`, but `openVaultDb` resolves it from the
  `keys/` sibling (`sealKeyFileFor`). Without the move, a recovered vault with
  ANY sealed secret bricks on first mount — the "placebo restore" FORMAT.md
  warns about — so `recover()` moves it into custody position during adopt.
- **The R5 (wave 3) and wave-4 extension point is the named `onAdopted` hook**,
  fired immediately after the atomic rename and before the warm pass — a real,
  named seam (not a deferred marker) carrying
  `{vaultId, vaultDir, targetId, provider, keyring}`.

## Out of scope

- In-place PITR rollback of a live vault via the UI (park-plane/swap/remount) — the
  undo surface is deferred by the issue itself.
- Export surface (metric 5) — mechanism remains read grants + inventory, per #436.
- Provisioning-integrated keyless recovery — arrives with #436 §3 at GA.
- Operator forensics stay CLI-only: restore into an arbitrary dir without adopting,
  `--seq` selection, restore-verify plumbing.

## Verification

- `bun run typecheck` (turbo, all 28 packages) — clean, including the new
  `VaultDb.remote()` interface member and the gateway service/CLI changes.
- `bunx oxlint` + `bunx oxfmt --check` on all five changed source/test files —
  0 warnings, 0 errors, formatting clean.
- `packages/vault/src/db.test.ts` — 5/5 pass (the `remote()` accessor addition
  breaks nothing).
- The four required suites, plus the new R2 service suite and the CLI suite I
  extended, all green (R2 auto-lazy / `--full` / metered gate / R3 restore-to-side
  included):

```
$ bunx vitest run src/cli/backup-admin.test.ts src/backup/backup-service.test.ts \
    src/backup/backup-service-restore.test.ts src/backup/restore-lazy-e2e.test.ts \
    src/backup/wal-e2e.test.ts src/backup/backup-e2e.test.ts
 ✓ src/cli/backup-admin.test.ts (9 tests)
   ✓ restore accepts --full and reports a full (non-lazy) materialization (#439 R2)
   ✓ a free-egress home never gates the restore (#439 R2)
   ✓ a metered-egress home refuses restore without --yes and proceeds with it (#439 R2)
   ✓ restore refuses a --dest that already holds a vault — restore stays to-side (#439 R3)
 ✓ src/backup/backup-service-restore.test.ts (7 tests)
   ✓ VaultDb.remote() is null without an s3 tier and resolves one when declared (#439 R2)
   ✓ restore auto-resolves to a FULL materialization with no durable remote tier (#439 R2)
   ✓ restore is LAZY by default when the vault has a durable remote CAS tier (#439 R2)
   ✓ restore honors full:true even when a durable remote CAS tier exists (#439 R2)
   ✓ an explicit lazy option wins over full:true (#439 R2)
   ✓ restoreEgressEstimate reports the metered cost class and full snapshot size (#439 R2)
   ✓ restoreEgressEstimate reports a free-egress home and a resolvable lazy tier (#439 R2)
 ✓ src/backup/backup-service.test.ts (23 tests)
 ✓ src/backup/restore-lazy-e2e.test.ts (2 tests)
 ✓ src/backup/wal-e2e.test.ts (16 tests)
 ✓ src/backup/backup-e2e.test.ts (7 tests)

 Test Files  6 passed (6)
      Tests  57 passed (57)
```

### R1 + R6 verification

- `bun run typecheck` (turbo, all 28 packages) — clean, including the new
  `recover()` module, the `parseRecoveryKit`/`assertCompatibleAppMeta`/
  `validateKeyring` exports, and `VaultRegistry.adopt`.
- `bunx oxlint` + `bunx oxfmt --check` on every changed source/test file —
  0 warnings, 0 errors, formatting clean.
- Full backup package suite (`bunx vitest run` in `packages/backup`) — 282
  passed, 26 skipped (the env-gated clawgnition interop), including the new
  `recovery-kit.test.ts` (5).
- The blank-machine e2e + the CLI shell + the adopt seam + quarantine, plus the
  required regression suites (restore-lazy-e2e, backup-e2e, wal-e2e,
  backup-admin, backup-service-restore, backup-service) — all green (74/74 across
  the 10 gateway suites). The recovery-specific slice:

```
$ bunx vitest run src/backup/recover-e2e.test.ts src/cli/recover-admin.test.ts \
    src/serve/vault-registry.test.ts src/serve/vault-quarantine.test.ts
 ✓ src/cli/recover-admin.test.ts (2 tests)
   ✓ recover prints the found-your-vault facts, then a metered home gates without --yes and proceeds with it
 ✓ src/backup/recover-e2e.test.ts (2 tests)
   ✓ a blank machine recovers a whole vault from nothing but the kit and the api-key
   ✓ recovery refuses a snapshot written by newer software BEFORE any byte is fetched
 ✓ src/serve/vault-quarantine.test.ts (3 tests)
 ✓ src/serve/vault-registry.test.ts (10 tests)
   ✓ adopt() mounts a recovered vault dir and removes the pristine auto-created default

 Test Files  4 passed (4)
      Tests  17 passed (17)
```

### R5 — adopt-time inventory reconcile and seal-key restore-verify

Closes gap 4 (a restored vault trusting its own restored `blob_replica`, which
attests remote durability as of CAPTURE time). The reconcile runs ALWAYS as a
`recover()`-internal step at the adopt position — not gated on the `onAdopted`
hook (which stays for wave 4's live mount). One orchestration, two shells.

- **The reconcile step — `packages/gateway/src/backup/recover-reconcile.ts`
  (new).** `reconcileAdoptedInventory()` opens the freshly adopted `vault.db`,
  reads which shas the restored `blob_replica` believes `'cas'`-durable
  (`ReplicaIndex.all('cas')`), and diffs them against the provider's ATTESTED
  cas inventory. Every believed sha the live inventory does NOT hold is
  `unmark`ed (so custody/eviction can never drop a phantom-replicated local
  copy, and replication re-uploads it) and classified: snapshot-carried ⇒
  **re-pinned** (ensured local), snapshot-less ⇒ **LOST** (CRITICAL, logged at
  error level). No `inventory` capability ⇒ honest
  `skipped: 'no-inventory-capability'`, index untouched.
- **The targeted re-pin — `packages/backup/src/materialize.ts` (new),
  exported from `packages/backup/src/index.ts`.**
  `materializeSnapshotBlobs()` pulls SPECIFIC shas out of the already-restored
  snapshot and writes them under the `FsBlobStore` layout, reusing the EXACT
  chunk-stream → unseal → unframe → keyed-id-verify → sha-verify path
  `restoreSnapshot` uses (the crypto primitives from `crypto.js`/`compress.js`/
  `manifest.js`, never hand-rolled). A requested sha the manifest lacks comes
  back `absent` (the reconcile records it lost).
- **Wiring — `packages/gateway/src/backup/recover.ts`.** The provider inventory
  is now collected ONCE whenever `provider.listInventory` exists (not only on
  the lazy path) and reused for BOTH the skip-set AND the reconcile (`--full`
  still skips nothing). Added `RecoverReport.reconcile: ReconcileReport`; the
  reconcile runs right after `rename` + `placeSealKey`, before `onAdopted`
  (single-writer on `vault.db`). `RecoverInput.log` widened to `ReconcileLogger`
  (an optional `error` sink; the engine only ever calls info/warn).
- **CLI surfacing — `packages/gateway/src/cli/recover-admin.ts`.** After the
  JSON report, a prominent **CRITICAL** stderr block when `reconcile.lost`
  is non-empty, a quieter FYI when blobs were re-pinned. Recovery still SUCCEEDS
  (exit 0, documented) — a lost blob is not a reason to abandon a recovered
  vault; the operator must simply not miss it.
- **Seal-key restore-verify — `packages/vault/src/restore-check.ts`
  (`SealKeyVerdict` exported from `packages/vault/src/index.ts`).**
  `verifyRestoredPair` now returns a `sealKey` verdict: `not-sealed` (no stamped
  fingerprint ⇒ nothing to prove), `ok` (restored `seal.key` matches the
  fingerprint stamped in `core_vault`), `missing` (absent), or `mismatch`
  (present but not the key the secrets were sealed with).
  **`packages/gateway/src/backup/backup-service.ts`** — `doRunRestoreVerify`
  turns a `missing`/`mismatch` verdict into a recorded verify problem ("the
  restore would be a placebo"), exactly like the existing integrity problems
  (health error + `lastRestoreVerifyError`). FORMAT.md called a restore without
  the seal key "a placebo"; the standing verification now proves it isn't.
- **Tests —** `packages/backup/src/materialize.test.ts` (new; the re-pin path in
  isolation — the recover e2e's re-pin is served by the lazy restore, so the
  helper needs its own coverage), `packages/gateway/src/backup/recover-reconcile.test.ts`
  (new; the four reconcile outcomes: re-pin+unmark, LOST+CRITICAL+unmark, honest
  skip, clean), `packages/gateway/src/backup/restore-verify-sealkey.test.ts`
  (new; a sealed vault verifies clean, a fingerprint-mismatched one FAILS with
  the placebo problem), and `packages/gateway/src/backup/recover-e2e.test.ts`
  (extended; machine A now marks `blob_replica`, and a new test deletes a
  replicated object from the provider then asserts the reconcile flags + re-pins
  it and unmarks the stale belief).

#### R5 verification

- `bun run typecheck` (turbo, all 28 packages) — clean.
- `bunx oxlint` + `bunx oxfmt --check` on every changed source/test file — 0
  warnings, 0 errors, formatting clean.
- Full backup package suite (`bunx vitest run` in `packages/backup`) — 283
  passed, 26 skipped (env-gated clawgnition interop), including the new
  `materialize.test.ts`.
- `wal-e2e.test.ts` (16) green — the extended `verifyRestoredPair` (`not-sealed`
  verdict on its unsealed vault) does not regress the scheduled restore-verify.

```
$ bunx vitest run src/backup/recover-reconcile.test.ts \
    src/backup/recover-e2e.test.ts src/backup/restore-verify-sealkey.test.ts
 ✓ src/backup/recover-reconcile.test.ts (4 tests)
 ✓ src/backup/restore-verify-sealkey.test.ts (2 tests)
   ✓ restore-verify passes when the restored seal key unseals the vault
   ✓ restore-verify FAILS with the placebo problem when the seal key does not match
 ✓ src/backup/recover-e2e.test.ts (3 tests)
   ✓ a blank machine recovers a whole vault from nothing but the kit and the api-key
   ✓ recovery refuses a snapshot written by newer software BEFORE any byte is fetched
   ✓ adopt-time reconcile re-pins a replicated blob the provider dropped, and unmarks it

 Test Files  3 passed (3)
      Tests  9 passed (9)
```

```
$ bunx vitest run src/materialize.test.ts   # packages/backup
 ✓ src/materialize.test.ts (1 test)
   ✓ materializes exactly the requested carried shas, byte-exact, and reports the rest absent
```

### R1 surface — recover job model, progress SSE, pre-vault recover routes

The recovery product's wire surface: a fresh gateway can turn a pasted kit + a
provider key into a live vault over HTTP, and the restore survives the UI
closing. The route contract (all under the gateway-plumbing prefix, matching
`pair`/`storage`/`info`; bearer-gated, admin-plane only):

- `POST /centraid/_gateway/recover/kit` — body is the kit JSON; returns
  `{ok, createdAt, targets:[{label, vaultId, providerHost}]}` — the keyring
  NEVER rides back. Malformed ⇒ 400 `invalid_kit`.
- `POST /centraid/_gateway/recover/discover` — body `{kit, apiKey}`; returns the
  found-your-vault card `{found, label, vaultId, providerHost, compatible,
  sizeBytes, asOfMs, restoreCostClass, lazyAvailable}`, or a typed refusal: 404
  `no_snapshot`, 409 `incompatible` (the "update the gateway" message), or the
  provider auth error's own status (401/403) passed through.
- `POST /centraid/_gateway/recover/start` — body `{kit, apiKey, confirmed?}`;
  server-side gates fire in order: non-fresh gateway ⇒ 409 `not_fresh` (before
  the provider is dialed), no snapshot ⇒ 404, incompatible ⇒ 409,
  metered-egress without `confirmed` ⇒ 409 `confirm_required` (carrying the
  `estimate`), a job already running ⇒ 409 `recover_in_progress`. On success
  ⇒ 202 `{jobId}`.
- `GET /centraid/_gateway/recover/status` — `{fresh, job}` (the entry check +
  reattach point).
- `GET /centraid/_gateway/recover/events?job=<id>` — the progress SSE: replays
  every event so far, then streams live; `event: phase` frames, a final
  `event: report` carrying the `RecoverReport`, a 30s heartbeat, and a terminal
  `event: end` naming the state (`done`/`failed`/`interrupted`).

Job lifecycle states: `running` (the sole live state) → `done` | `failed` |
`interrupted`. Persistence rule (atomic temp+rename, `backup-state.ts`'s shape):
ONLY progress metadata — `{jobId, state, phase, startedAt, updatedAt, targetId,
vaultId, error?, report?}`. The kit keyring and the api-key are held in memory
for the running job ALONE and never touch disk; the persisted `report` carries
no secrets. That is the resumability contract: survive the UI closing (the
daemon owns the process), report/attach from any client, and — because the
secrets are never persisted — a daemon that dies mid-job is found `running` at
next startup, flipped to `interrupted`, its torn `.recover-staging-*` scratch
swept, and the user re-submits kit+key. One active job at a time.

- `packages/gateway/src/backup/recover-job.ts` (new) — `RecoverJobRunner`: the
  daemon-owned job. `start()` guards one-active-job (`RecoverJobConflictError`
  → 409) and fires `recover()` fire-and-forget with the LIVE seams wired —
  `onAdopted` → `adopt(vaultId)` + patches the report ids into the record;
  `resolveRemoteTier` → the mounted plane's own tier so the warm pass runs
  in-process. A replayable in-memory event list + subscriber set (modeled on
  `run-event-bus.ts`) backs the SSE; `init()` reconciles a crashed job; a
  serialized `persistChain` (writes never overlap/reorder) with write failures
  logged not thrown, and a `flush()` a graceful `stop()` awaits. `recoverFn` is
  an injectable seam (defaults to the real `recover()`) so the job lifecycle is
  testable without a real restore.
- `packages/gateway/src/routes/recover-routes.ts` (new) —
  `makeRecoverRouteHandler`: the five routes above, orchestrating
  `discoverRecovery` + the job. A TOP-LEVEL pre-vault handler (it stands up and
  adopts the home vault, so it lives outside `composedHandler`'s per-request
  vault scope — the webhook handler is the precedent). Admin-plane gate: refuses
  a request carrying `AUTHED_DEVICE_HEADER` (a paired device) with 403
  `admin_only`. The SSE replays `job.snapshot()` then subscribes live, closing on
  the terminal event; its own `SseSubscriberCap`.
- `packages/gateway/src/backup/recover.ts` — extended `discoverRecovery` +
  `RecoveryDiscovery` with `compatible` / `incompatibleReason`: it now runs the
  registry-`appMeta` compat gate NON-throwingly (catching `assertCompatibleAppMeta`)
  so the discover card can show a typed "update first" refusal instead of an
  opaque failure three phases into a restore. No other behavior changed.
- `packages/gateway/src/serve/vault-registry.ts` — added `isFresh()`: the
  airtight fresh-gateway signal the start gate reads. True only when every
  mounted vault is in `autoCreatedDefaults` (the same provenance `adopt()`
  trusts — a vault THIS registry minted on an empty root, provably never served
  a request). Conservative in the safe direction: it can only ever refuse a
  gateway with content, never approve one.
- `packages/gateway/src/serve/build-gateway.ts` — constructs the
  `RecoverJobRunner` (persisting under `storageDir`; `adopt`/`resolveRemoteTier`
  wired to the live registry; `db.remote()` is the mounted plane's tier),
  `await`s its `init()` (crash reconcile), builds `recoverHandler`, adds
  `recoverHandler` to `BuiltGateway` + the return, awaits `recoverJob.flush()`
  in `stop()`, and hoists the shared `backupDir` const.
- `packages/gateway/src/serve/serve.ts` — inserts `gateway.recoverHandler`
  between the webhook and composed handlers in the HTTP `extraHandlers` chain
  (so it is bearer-checked but runs outside the per-request vault scope), and
  adds `recoverHandler` to the `GatewayServeHandle` Omit list. This one site
  covers both the daemon and the desktop embed — both go through `serve()`.
- `packages/gateway/src/backup/recover-job.test.ts` (new) — the deterministic
  job lifecycle (injected `recoverFn`): run-to-`done` with report persisted +
  streamed and the secret NEVER on disk; late-subscriber replay; double-start
  409; the daemon-death path (a persisted `running` record + a torn staging dir
  ⇒ `interrupted` + swept); and a terminal record loaded as-is on restart.
- `packages/gateway/src/routes/recover-routes.test.ts` (new) — HTTP coverage
  against the real fake provider + a stubbed job: kit good/bad, discover
  found/wrong-key/incompatible, the three start gates, status, the admin-plane
  403, and the SSE replay-then-live-through-`end` stream.
- `packages/gateway/src/backup/recover-live-e2e.test.ts` (new) — the LIVE
  integration the CLI shell cannot reach: a real `serve()` gateway (empty root,
  one pristine default) is driven kit→discover→start→SSE-to-`end` over HTTP
  against the fake provider, then asserts the recovered vault is MOUNTED and the
  effective default (the pristine default adopted away), the quarantine fired on
  first mount, and — because the live gateway satisfied `resolveRemoteTier` with
  the mounted plane's own `db.remote()` — the previews warmed with
  `timeToUsableGridMs` present. A second `start` is refused `not_fresh`.

#### R1 surface verification

- `bun run typecheck` (turbo, `@centraid/gateway`) — clean, including the new
  job/routes modules, the `RecoveryDiscovery` extension, `VaultRegistry.isFresh`,
  and the `BuiltGateway.recoverHandler` wiring.
- `bunx oxlint` + `bunx oxfmt --check` on every changed source/test file — 0
  warnings, 0 errors, formatting clean.
- The three new suites, plus the regression suites the surface touches
  (recover-e2e, restore-lazy-e2e, recover-reconcile, vault-registry,
  recover-admin, build-gateway, vault-quarantine, backup-service(-restore),
  backup-e2e, wal-e2e) — all green.

```
$ bunx vitest run src/backup/recover-job.test.ts src/routes/recover-routes.test.ts \
    src/backup/recover-live-e2e.test.ts
 ✓ src/backup/recover-job.test.ts (5 tests)
   ✓ a job runs to done: phases emitted, adopt+warm wired, report persisted and streamed
   ✓ a late subscriber replays the full phase history
   ✓ a second start while one runs is refused (409 conflict)
   ✓ a job the previous daemon died mid-flight is marked interrupted and its staging swept
   ✓ a terminal record from a prior process is loaded as-is (not re-flipped)
 ✓ src/routes/recover-routes.test.ts (5 tests)
   ✓ POST /recover/kit validates a kit and returns a sanitized summary (never the keyring)
   ✓ POST /recover/discover: found / wrong-key / incompatible
   ✓ POST /recover/start gates: metered-without-confirm, non-fresh, and double-start all 409
   ✓ GET /recover/status folds fresh + the job record; admin-plane only
   ✓ GET /recover/events streams replay-then-live phases and a final report through end
 ✓ src/backup/recover-live-e2e.test.ts (1 test)
   ✓ a fresh gateway recovers a vault over the live routes: kit → discover → start → SSE, then MOUNTED + quarantined + previews warmed

 Test Files  3 passed (3)
      Tests  11 passed (11)
```

```
$ bunx vitest run --no-file-parallelism src/backup/recover-e2e.test.ts \
    src/backup/restore-lazy-e2e.test.ts src/backup/recover-reconcile.test.ts \
    src/serve/vault-registry.test.ts src/cli/recover-admin.test.ts \
    src/serve/build-gateway.test.ts src/serve/vault-quarantine.test.ts \
    src/backup/backup-service.test.ts src/backup/backup-service-restore.test.ts \
    src/backup/backup-e2e.test.ts src/backup/wal-e2e.test.ts
 Test Files  11 passed (11)
      Tests  82 passed (82)
```

(Run serially: these 11 heavy WAL/SQLite suites intermittently hit "database
disk image is malformed" when all launched at max file-parallelism — a
pre-existing resource-contention flake in this repo's WAL-shipper suites, not a
recovery regression; each suite and smaller groups pass clean in parallel.)

### UI — fresh-gateway onboarding recovery flow

The recovery PRODUCT's surface: the fresh-gateway onboarding branch now offers
"Start fresh / Recover my vault" and, on the recover path, walks the user through
EXACTLY two inputs (kit, key) and ONE confirmation (shown only when the provider
bills egress), speaking no protocol vocabulary. The shell (desktop + web) drives
the Wave-4 pre-vault `/recover` routes over HTTP, watches the daemon-owned
restore over SSE in three user phases, and hands over to the app once the
recovered vault is live. All screens are presentational with injected bridge
props (the settings-screen convention); the HTTP/SSE transport is one new
feature-module over `gateway-client-core`.

- `packages/client/src/gateway-client-recover.ts` (new) — the typed renderer
  client for the five routes plus `streamRecoverEvents`. Each method maps the
  gateway's typed refusals into a result union the screen branches on and NEVER
  throws for an expected refusal (bad kit, wrong key, not-fresh, metered-confirm)
  — only for an unreachable gateway. `validateRecoveryKit` POSTs the kit document
  itself (the route re-parses it) and returns only the sanitized target summary
  (never the keyring); `discoverRecovery`/`startRecovery` fold `{kit, apiKey}`
  and thread `confirmed:true` only after the price gate; the SSE reader mirrors
  `streamGatewayLogs` (fetch + `res.body.getReader()`, so the Bearer rides along —
  not `EventSource`) and reuses `vault-change-sse`'s `decodeFrame`/`frameBoundary`
  frame grammar. `recoverStageOf()` folds the machine phases
  (discovering/fetching → replaying/fencing/adopting → warming) into the three
  user stages the progress view renders — the raw phase is never shown.
- `packages/client/src/react/screens/RecoverScreen.tsx` (new) — the recover flow:
  paste/drop kit → provider key → the one "found your vault" card
  (`<size> · safe as of <T> · hosted at <host>`) → (metered-egress only) a
  "download about <X>" confirm → progress stepper over SSE → a landing state
  ("Recovered as of <T>" + a plain-words quarantine hand-off routing to Approvals
  and Connections), plus human dead-ends (nothing to recover / needs an update /
  this machine isn't fresh / wrong key). Reattaches to a running or finished job
  via `/status` on mount (survives a page reload); a dropped SSE reconnects
  (replay-then-live makes it idempotent). The orchestrator only (state machine +
  effects + the two input steps); the display views are split out to keep it
  under the file-size cap.
- `packages/client/src/react/screens/RecoverSteps.tsx` (new) — the presentational
  step views split out of `RecoverScreen` (`Stage`, the progress stepper,
  found/confirm/progress/landing/stop/failed) plus the `whenLabel`/`sizeLabel`
  formatters — each a pure value→JSX view over injected props.
- `packages/client/src/react/screens/RecoverScreen.module.css` (new) — the recover
  surface's styling, reusing the first-run onboarding visual language (dim
  atmospheric stage + one editorial card, literal-hex forced-dark, the card
  carrying `data-theme="dark"` so the shared `Button`'s tokens resolve to the dark
  ramp). Also hosts the first-run choice cards (FirstRunGate imports this module).
  Responsive by inheritance (`width: min(460px, 92vw)`).
- `packages/client/src/react/screens/FirstRunGate.tsx` (new) — the first-run
  CHOICE step and parent switcher: the binary "Start fresh / Recover my vault"
  before anything else, then the fresh path (the existing `OnboardingScreen`,
  untouched) or the recover path (`RecoverScreen`), each completing into the same
  "onboarding done → boot the app" terminal state via its own callback.
- `packages/client/src/react/boot.tsx` — the first-run gate now renders
  `<FirstRunGate>` (was the bare `<OnboardingScreen>`), wiring the recover bridge
  over `gateway-client-recover` and a recover-completion path: drop the cached
  pre-vault auth (`resetGatewayAuthCache` — the gateway already mounted the
  recovered vault in-process, quarantine fired on first mount; its `vaultId` is
  undefined on a fresh install so the gateway picks, and the only mounted vault is
  the recovered one), stamp `onboardingCompletedAt`, and swap in `<App/>`. The
  recover path skips identity/connect — the recovered vault carries its own
  profile — so there is NO `updateProfileMetadata` on it (the fresh path keeps it).
  Shell-agnostic: no desktop main-process IPC change; both desktop (local embedded
  gateway) and web (the connected gateway) reach the same `/recover` routes over
  `doFetch` and complete through the same client path.
- `packages/client/src/gateway-client-recover.test.ts` (new) — the client unit
  suite (fetch spy + a stubbed `window.CentraidApi`, exercising the real
  `doFetch`/`auth`/`readJson` path): kit validate ok/invalid, discover
  found/wrong-key/no-snapshot/incompatible, start started/confirm-required/
  not-fresh/in-progress (and `confirmed:true` threaded only when passed), status,
  and the SSE reader parsing phase→report→end frames in order.
- `packages/client/src/react/screens/RecoverScreen.test.tsx` (new) — the screen
  states (raw `react-dom/client` + `act()`, injected `vi.fn()` bridges): kit
  invalid + bad-paste-never-hits-the-gateway, the key step, wrong-key inline,
  free-egress-recovers-with-no-confirm vs metered-shows-the-download-confirm,
  progress phases + done→landing with the quarantine hand-off, not-fresh dead-end,
  and reattach-to-running / reattach-to-done.
- `packages/client/src/react/screens/FirstRunGate.test.tsx` (new) — the choice
  step: exactly the two options, "Start fresh" opens onboarding, "Recover my
  vault" opens the kit step, and "Back" returns to the choice.

**Decision — the choice step is a parent switcher (`FirstRunGate`), not a third
mode inside `OnboardingScreen`.** The recover path shares nothing with the fresh
path's completion contract (`{displayName, avatarColor, gatewayId}`) — it skips
identity/connect entirely — so threading it through `OnboardingScreen` would
muddy that screen's contract and tests. A thin parent switcher keeps
`OnboardingScreen` pristine, keeps `RecoverScreen` fully isolated, and makes the
one binary decision testable on its own.

**Acceptance-criterion audit.** Every user-facing string was grepped for
`snapshot`, `seq`, `store class`, `WAL`, and `lazy`: zero occurrences in any
rendered copy (the only hits are a file-header doc comment and the `no_snapshot`
reason *identifier*, neither rendered). The `restoreCostClass`/phase machine
values are never rendered — the phase is shown only via `recoverStageOf` → the
three user-stage labels. The flow asks for exactly two inputs (kit, key) and one
confirmation (metered-egress only).

#### UI verification

- `bun run typecheck` (`@centraid/client`, `tsc --noEmit`) — clean, including the
  new client module, both screens, and the `boot.tsx` wiring.
- `bunx oxlint` + `bunx oxfmt --check` on every changed source/test file — 0
  warnings, 0 errors, formatting clean.
- Full `@centraid/client` suite (`bunx vitest run`) — 125 files / 959 tests pass
  (was 122 / 934; +3 files, +25 tests), so the gate rewire and new screens
  regress nothing.

```
$ bunx vitest run src/gateway-client-recover.test.ts \
    src/react/screens/RecoverScreen.test.tsx src/react/screens/FirstRunGate.test.tsx
 ✓ src/gateway-client-recover.test.ts (11 tests)
 ✓ src/react/screens/RecoverScreen.test.tsx (10 tests)
   ✓ surfaces the gateway invalid-kit message and stays on the kit step
   ✓ a bad paste never reaches the gateway
   ✓ advances to the key step showing the provider host
   ✓ shows a wrong-key error inline
   ✓ a free-egress vault recovers with no price confirm
   ✓ a metered vault shows the download confirm before starting
   ✓ streams progress phases and lands with the quarantine hand-off
   ✓ a non-fresh gateway is refused in plain language
   ✓ reattaches to a running job on mount
   ✓ reattaches to a finished job as the landing state
 ✓ src/react/screens/FirstRunGate.test.tsx (4 tests)
   ✓ offers exactly the two first-run choices
   ✓ "Start fresh" opens the existing onboarding identity step
   ✓ "Recover my vault" opens the recovery kit step
   ✓ "Back" from the recovery flow returns to the choice

 Test Files  3 passed (3)
      Tests  25 passed (25)
```

### R4 — orphan-grace GC invariant

Closes gap 3, the honesty hole in metric 2. GC-pins-snapshots (#436 §6) makes the
recovery-window number N true only AT snapshot instants; PITR restores to arbitrary
instants BETWEEN snapshots. A blob uploaded and dereferenced within one inter-snapshot
interval is referenced by no retained manifest and not by the live model, so it was
GC-eligible at the one client-owned CAS delete site — and a PITR into that interval
would replay vault rows pointing at a purged `sha`. The fix: the reconcile sweep now
tombstones an orphan on first observation and MUST NOT delete it until N days (the
recovery window, the retention daily rung) have elapsed since first-observed-orphaned;
a sha that becomes live/pinned again before the grace elapses has its tombstone cleared.

- `packages/vault/src/schema/blob.ts` — new `blob_orphan` STRICT table in
  `BLOB_CACHE_DDL` (self-contained plumbing beside `blob_replica`/`blob_access`, so a
  bare `:memory:` handle creates it): `sha256` PK + `first_orphaned_at INTEGER` (epoch
  ms, because the only reader does age arithmetic). v0's one-rung ladder composes the
  DDL in place — no new migration rung.
- `packages/vault/src/blob/orphan-tombstone.ts` (new) — `OrphanTombstoneIndex`
  mirroring `ReplicaIndex`: `markFirstSeen(sha, nowMs)` (INSERT OR IGNORE, returns the
  ORIGINAL stamp so the grace clock never resets), `read(sha)`, `clear(sha)`,
  `clearAll()`.
- `packages/vault/src/blob/custody-reconcile.ts` — the grace gate at the one delete
  site: a live sha clears its tombstone; a pinned snapshot-root is excluded before the
  gate (never tombstoned); a genuine orphan is tombstoned + `orphansGraceHeld` when
  `now − first_orphaned_at ≤ graceWindowMs`, deleted (and tombstone cleared) once past
  it. A grace window with no tombstone store fails safe (holds). Added `orphans?` to
  `ReconcileContext` and an injectable `now`.
- `packages/vault/src/blob/custody-types.ts` — `ReconcileResult.orphansGraceHeld`,
  `ReconcileOptions.graceWindowMs` + `now`.
- `packages/vault/src/blob/cache.ts` — `BlobCache.orphan` constructed beside
  `replica`/`access`; `packages/vault/src/blob/custody.ts` threads it into the reconcile
  ctx.
- `packages/vault/src/gateway/gateway.ts` — `sweepBlobs` accepts + forwards
  `graceWindowMs`; the sweep receipt records `orphansGraceHeld`.
- `packages/gateway/src/serve/vault-plane.ts` — new `orphanGraceWindowMs` supplier +
  `resolveOrphanGraceWindowMs()` (mirrors `resolveSnapshotBlobRoots`; a throw fails safe
  to `Number.POSITIVE_INFINITY` so nothing deletes); `runBlobSweep` resolves both roots
  and window and threads the window into `sweepBlobs`.
- `packages/gateway/src/backup/backup-service.ts` — exported `recoveryWindowMs(retention)`
  (ladder → `dailyDays × DAY_MS`, non-ladder → undefined ⇒ grace disengaged) and wired
  `plane.orphanGraceWindowMs` in `attachSnapshotRoots` off `homeDiscovery().retention`.
  N is NOT hardcoded — it flows from the provider's declared retention.
- `packages/backup/PROTOCOL.md` — normative **Orphan grace** + **Snapshot-root pin**
  bullets in Layer 2 § cas store semantics, cross-referenced from the GC min-age
  invariant (three independent gates, all must hold before a `cas` delete).
- `packages/backup/FORMAT.md` — new normative Restore rule 7 (recovery-window honesty)
  tying the grace window to the restore-side guarantee.

#### Fail-safe / plumbing

N (the grace window) is threaded provider → gateway → delete site: the provider's
`GET /v1/storage/provider` retention ladder → `homeDiscovery().retention` →
`recoveryWindowMs()` → `plane.orphanGraceWindowMs` supplier → `runBlobSweep` →
`gateway.sweepBlobs({ graceWindowMs })` → `reconcile` options → the tombstone gate. When
N cannot be resolved (supplier throws), the sweep passes `Number.POSITIVE_INFINITY` — an
effectively-infinite grace, so every orphan is held and nothing deletes, the same
conservative stance the existing snapshot-root `'unavailable'` path takes. No backup
store (no supplier) ⇒ `graceWindowMs` undefined ⇒ pre-R4 immediate delete, correct
because a local-only vault has no recovery window to protect.

#### R4 verification

- `bun run typecheck` — clean across the monorepo (28/28 tasks).
- `bunx oxlint` + `bun run format:check` on every changed file — 0 warnings, 0 errors,
  formatting clean.
- New `packages/vault/src/blob/orphan-grace.test.ts` (10 tests): the index
  (mark-once/idempotent, clear→re-stamp) and the full reconcile grace matrix (held on
  first observation, deleted past window, held within window, live-again clears +
  never deletes, pinned root never deleted nor tombstoned, no-store fail-safe hold,
  no-window pre-R4 delete, infinite-grace hold). New table-existence test in
  `migrate.test.ts`; `recoveryWindowMs` mapping test in `backup-service.test.ts`.
- Existing suites stay green: vault blob (incl. the pre-existing orphan-delete and
  snapshot-root-pin tests in `blob.test.ts`), `db.test.ts`, `migrate.test.ts`,
  gateway `backup-service`/`backup-reconciliation`/`recover-*`, `vault-plane`.

```
$ bunx vitest run packages/vault/src/blob/orphan-grace.test.ts \
    packages/vault/src/blob/blob.test.ts packages/vault/src/schema/migrate.test.ts \
    packages/gateway/src/backup/backup-service.test.ts \
    packages/gateway/src/serve/vault-plane.test.ts
 ✓ |@centraid/vault| src/blob/orphan-grace.test.ts (10 tests) 8ms
 ✓ |@centraid/vault| src/schema/migrate.test.ts (10 tests)
 ✓ |@centraid/vault| src/blob/blob.test.ts (19 tests)
 ✓ |@centraid/gateway| src/backup/backup-service.test.ts (17 tests)
 ✓ |@centraid/gateway| src/serve/vault-plane.test.ts (18 tests)

 Test Files  5 passed (5)
      Tests  74 passed (74)
```

## Steering

**Verdict: PASS**

- **Zero genuine human-steering events found.** The session has exactly one real typed human turn — the opening `/goal` command ("please work on the entire scope of …/issues/439, act as orchestrator and spawn opus subagents") at 2026-07-17T13:36:18.789Z. That is the initial goal message that *started* the work, not a mid-task redirect or correction, so per the directive it is not a steering event and no `## Accounting` → `### Steering` rows were added.
- **How the user-message entries were separated.** Parsed the transcript as JSON and kept only user entries carrying a real typed `message.content` block, discarding `tool_result` blocks. The remaining three candidates all resolve to non-human sources: one `/goal` command (the launch directive), one `<local-command-stdout>` echo, and one `A session-scoped Stop hook is now active` system reminder — all are initialization, none are steering.
- **No interrupts.** `grep -c "Request interrupted by user"` returns 0, so there are no `type: interrupt` / tier `structural` rows to record either. Consistent with a clean orchestrator run that was never interrupted.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-b42aae9d-faa-1784297819-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 79 | 445645 | 3242515 | 158757 | 604481 | 16.7517 | 79 | 445645 | 3242515 | 158757 | feat(backup): lazy-by-default restore, --full override, metered-egress confirm ( |
| claude-code-b42aae9d-faa-1784298109-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 79 | 445645 | 3242515 | 158757 | feat(backup): lazy-by-default restore, --full override, metered-egress confirm ( |
| claude-code-b42aae9d-faa-1784300458-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 12 | 27756 | 762361 | 14914 | 42682 | 1.8551 | 91 | 473401 | 4004876 | 173671 | feat(gateway): recover() verb, blank-machine e2e, CLI recover (#439) -m Issue: # |
| claude-code-b42aae9d-faa-1784300812-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 91 | 473401 | 4004876 | 173671 | feat(gateway): recover() verb, blank-machine e2e, CLI recover (#439) -m Issue: # |
| claude-code-b42aae9d-faa-1784302841-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 12 | 26858 | 825908 | 9061 | 35931 | 1.6148 | 103 | 500259 | 4830784 | 182732 | feat(gateway): adopt-time inventory reconcile, seal-key restore-verify (#439) -m |
| claude-code-b42aae9d-faa-1784311723-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 116 | 433456 | 2703871 | 22169 | 455741 | 9.2317 | 219 | 933715 | 7534655 | 204901 | feat(gateway): pre-vault recover routes, daemon-owned restore job, progress SSE  |
| claude-code-b42aae9d-faa-1784313736-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 63 | 20632 | 1982820 | 13395 | 34090 | 2.9111 | 282 | 954347 | 9517475 | 218296 | feat(client): fresh-gateway onboarding recovery flow (#439) -m Issue: #439 |
| claude-code-b42aae9d-faa-1784313806-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 282 | 954347 | 9517475 | 218296 | feat(client): fresh-gateway onboarding recovery flow (#439) -m Issue: #439 |
| claude-code-b42aae9d-faa-1784314878-1 | claude-code | b42aae9d-faaf-4587-8bcc-fd43d61e35a4 | #439 | claude-opus-4-8 | 10 | 123434 | 622679 | 4552 | 127996 | 1.1967 | 292 | 1077781 | 10140154 | 222848 | feat(vault): orphan-grace GC — delay CAS delete N days past first-orphaned (#439 |
