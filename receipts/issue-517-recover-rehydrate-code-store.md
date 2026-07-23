# issue-517 — Code-tree backup: restore rehydration + upload-side bundle optimization

GitHub issue: [#517](https://github.com/srikanth235/centraid/issues/517)

Two problems in how the storage protocol treats the vault's git code store,
both found auditing the git-as-filesystem path.

**1. Restore never rehydrated the code store (data loss).** Backup captured it
as a `git bundle --all` that `restoreSnapshot` wrote to `<vaultDir>/apps.bundle`,
but nothing consumed it — `recover()` never cloned it into `code/apps.git`, and
`WorktreeStore.init()` just `git init --bare`s an empty repo when `apps.git/HEAD`
is absent. Recovered vaults came up with data intact and an EMPTY code store
(every published app's code gone) — the "data with no apps" placebo FORMAT.md
warns about.

**2. The bundle was repacked + re-chunked every tick.** `bundleCodeStore` wrote
`apps.bundle` into the per-tick-wiped `staging/` dir, so it looked new every
tick: a full-history `git pack-objects` repack (git's default `pack.threads` is
not byte-deterministic on a grown repo), a full re-read/re-chunk, and — when the
pack bytes drifted — a wholesale re-upload, for a code store that changes far
less than the backup cadence. The engine's own `(size, mtime)` reuse fast path
could never engage because the file was never stable.

## Checklist

- [x] `rehydrateCodeStore` clones the restored `apps.bundle` into `code/apps.git` and removes it
- [x] `rehydrateCodeStore` runs in `recover()`'s adopt phase after `placeSealKey`, no-op when no bundle
- [x] the code bundle is written to a persistent per-vault `code-bundle` dir, reused untouched while a ref digest is unchanged
- [x] regeneration gates on `codeRefsDigest` and uses `-c pack.threads=1`
- [x] the dead `staging/` seam is removed (`resetStagingDir` gone, `AssembleOptions` takes one `bundleDir`)
- [x] the `git-bundle` row in FORMAT.md documents the restore-side clone
- [x] recovery integration test proves the restored vault keeps its code store and app
- [x] unit test proves reuse-when-unchanged and regenerate-on-ref-change

## What changed

- `packages/gateway/src/backup/recover-internals.ts` — new `rehydrateCodeStore(vaultDir, log)`, mirroring `placeSealKey`. `rehydrateCodeStore` clones the restored `apps.bundle` into `code/apps.git` and removes it — a `git clone --bare` that restores `main` + every `<app>/v*` tag + session branch, `HEAD -> main`.
- `packages/gateway/src/backup/recover.ts` — `rehydrateCodeStore` runs in `recover()`'s adopt phase after `placeSealKey`, no-op when no bundle (guarded by `existsSync(apps.bundle)`).
- `packages/gateway/src/backup/backup-sources.ts` — the code bundle is written to a persistent per-vault `code-bundle` dir, reused untouched while a ref digest is unchanged (sidecar `apps.bundle.refs`); regeneration gates on `codeRefsDigest` and uses `-c pack.threads=1` for byte-deterministic packs + cross-tick part dedup. As part of this, the dead `staging/` seam is removed (`resetStagingDir` gone, `AssembleOptions` takes one `bundleDir`) — `bundleCodeStore` was its last writer.
- `packages/gateway/src/backup/backup-service.ts` — passes `<backupDir>/code-bundle/<vaultId>` and drops the per-tick staging create/teardown (the bundle dir is deliberately kept between ticks).
- `packages/gateway/src/backup/backup-sources.test.ts` — assemble callers pass `bundleDir`; new reuse/regenerate unit test; the old "staging wiped" test reframed to "db bases read in place, nothing written without a code store".
- `packages/gateway/src/backup/backup.integration.test.ts` — the "no-change semantics" test now asserts an idle vault no-ops and a code publish re-registers.
- `packages/gateway/src/backup/recover.integration.test.ts` — `seedMachineA` publishes a real app; the blank-machine recovery test asserts the restored code store + app.
- `packages/gateway/src/backup/wal.integration.test.ts` — its `assembleSourceEntries` caller passes `bundleDir`.
- `packages/backup/FORMAT.md` — the `git-bundle` row in FORMAT.md documents the restore-side clone.

## Out of scope

- Base + incremental (delta) bundles with a format bump — deferred until code-store size justifies it (design already proven by the WAL base+segment path).
- Backing up uncommitted builder-session worktree edits (only committed at publish; not captured by `--all`). Separate coverage gap.

## Decisions

- **Collapsed the ephemeral `staging/` dir instead of keeping it as a general seam.** Once the bundle moved to the persistent `code-bundle` dir, staging had zero writers (db bases are pinned clones, blobs/seal-key read in place). Keeping a wiped-every-tick dir nothing writes to is dead dual-pathing (coding-standards: "refactors look like edits, not new layers"), so `stagingDir`/`resetStagingDir` were deleted rather than left as a YAGNI seam. Prompted by a mid-work question from the operator.
- **Reuse-gate on a ref digest, not on re-hashing the bundle.** Hashing would require generating the bundle first, defeating the goal of skipping the repack; `for-each-ref` + HEAD is the cheap pre-check that a bundle's bytes are a pure function of.
- **Deferred base+incremental bundles.** The bigger upload win (delta bundles) needs a snapshot-format bump; held until code-store size actually justifies it.

## Verification

Full gate and the code-tree tests:

```sh
bun run check:pr   # green: 15/15 tasks, 829 gateway tests pass
cd packages/gateway && ../../node_modules/.bin/vitest run \
  src/backup/backup-sources.test.ts src/backup/backup.integration.test.ts \
  src/backup/backup-service.contract.test.ts src/backup/wal.integration.test.ts \
  src/backup/recover.integration.test.ts src/worktree-store/
```

- The recovery integration test proves the restored vault keeps its code store and app: it asserts `code/apps.git/HEAD` exists, `apps.bundle` is gone, the `todo/v1` tag survived, and a fresh `WorktreeStore().init()` + `listApps()` returns `['todo']`. Red/green confirmed — with `rehydrateCodeStore` disabled it fails at the `code/apps.git/HEAD` assertion.
- The unit test proves reuse-when-unchanged and regenerate-on-ref-change: an unchanged code store keeps a byte-identical bundle mtime (reuse logged), and a second publish changes the digest and regenerates the bundle carrying both apps.

## Steering

- Verdict: PASS
- Evidence: User message #5 ("please focus on optimizations first and then we can single commit") redirected the agent's approach after an interrupt (event 94 in the transcript), forming a genuine steering correction. Messages #1–4 were task setup or clarifications. Message #6 was a clarifying question about code structure. Message #7 ("collapse them please!") was a direct response to that question, not a mid-task redirect. Only the interrupt+correction pair (events 93–94) constituted steering.

## Audit

- What-changed fidelity: PASS — Receipt accurately describes all staged changes (rehydrateCodeStore function, recover.ts wiring, persistent bundleDir in backup-sources.ts and backup-service.ts, test updates, FORMAT.md documentation) with no material omissions or misrepresentations.
- Checklist realized in diff: PASS — All [x] items are present: rehydrateCodeStore exists, wired into recover() adopt phase, integration test updated, FORMAT.md documents clone--bare, persistent code-bundle dir created, ref digest check via for-each-ref implemented, pack.threads=1 in effect, unit tests cover reuse/regenerate, resetStagingDir removed.
- Checklist mirrors issue: PASS — Receipt checklist directly mirrors issue #517's two problems and fixes: restore rehydration (problem 1), persistent bundle with ref-digest checking (problem 2), and staging cleanup (collapse). Out-of-scope items align (base+incremental bundles, builder edits).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-021eea34-2ad-1784778288-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 6421 | 609282 | 19538322 | 111608 | 727311 | 16.3995 | 6421 | 609282 | 19538322 | 111608 | fix(gateway): rehydrate app code store from apps.bundle on recovery (#517)Backup |
| claude-code-021eea34-2ad-1784779689-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 304 | 192213 | 37162142 | 149090 | 341607 | 23.5112 | 6725 | 801495 | 56700464 | 260698 | fix(gateway): rehydrate code store on recovery + stop repacking the bundle every |
| claude-code-021eea34-2ad-1784780022-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 18 | 20754 | 2792109 | 8888 | 29660 | 1.7481 | 6743 | 822249 | 59492573 | 269586 | fix(gateway): rehydrate code store on recovery + stop repacking the bundle every |
| claude-code-021eea34-2ad-1784780066-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 6 | 3738 | 847890 | 789 | 4533 | 0.4671 | 6749 | 825987 | 60340463 | 270375 | wip |
| claude-code-021eea34-2ad-1784780120-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 6 | 4872 | 851628 | 1863 | 6741 | 0.5029 | 6755 | 830859 | 61192091 | 272238 | wip |
| claude-code-021eea34-2ad-1784780355-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 36 | 47951 | 5914758 | 42288 | 90275 | 4.3145 | 6791 | 878810 | 67106849 | 314526 | fix(gateway): rehydrate code store on recovery + stop repacking the bundle every |
| claude-code-021eea34-2ad-1784780407-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 6 | 13407 | 917829 | 741 | 14154 | 0.5613 | 6797 | 892217 | 68024678 | 315267 | wip |
| claude-code-021eea34-2ad-1784780469-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 8 | 6695 | 1243522 | 3552 | 10255 | 0.7524 | 6805 | 898912 | 69268200 | 318819 | fix(gateway): rehydrate code store on recovery + stop repacking the bundle every |
| claude-code-021eea34-2ad-1784780616-1 | claude-code | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | claude-opus-4-8 | 17 | 32654 | 3185201 | 17856 | 50527 | 2.2432 | 6822 | 931566 | 72453401 | 336675 | fix(gateway): rehydrate code store on recovery + stop repacking the bundle every |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-021eea34-1-1 | 021eea34-2ade-4a12-8874-417ae71b237a | #517 | correction | classifier | Focus on optimizations first, then single commit | fix(gateway): rehydrate code store on recovery + stop repacking the bundle ever… | 94 | 2026-07-23T03:46:35.455Z |
