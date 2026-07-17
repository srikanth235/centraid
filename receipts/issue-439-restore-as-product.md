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
- [ ] R1 — the recovery verb: service-layer recover() and the blank-machine e2e
- [ ] R6 — CLI recover wrapper
- [ ] R5 — adopt-time inventory reconcile and seal-key restore-verify
- [ ] R1 surface — recover job model, progress SSE, pre-vault recover routes
- [ ] UI — fresh-gateway onboarding recovery flow
- [ ] R4 — orphan-grace GC invariant

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
