# #1200 integration record

The sole implementation branch is `codex/1200-v0-refinement` in `/private/tmp/centraid-1200`; its sole draft PR is #1201. Implementation slices are reviewed individually. The original workspace and its untracked audit evidence remain untouched.

## Owner scope decisions

- Assistant evaluation, frozen-data retrieval, reference replay and quality scoring are excluded. No quality score or target attainment is claimed.
- The recommendation to narrow v0's definition of success is excluded. All nine apps and their existing depth remain in scope.
- Docs will not gain **Write a note**. Its proposed production code was never applied. Other uncommitted connected-workflow additions and favorite badges were removed after the owner clarified that this work should fix bugs and clean up existing behavior. Existing links, actions and routes remain the verification surface; this PR adds no new workflow.
- All work remains in the same PR; the issue stays open while required integration and native evidence are missing.

## Disk cleanup and build guard

On 16 November 2026, root stopped the local gate during workspace test compilation after the owner reported low disk space. Formatting and workspace all-target Clippy had passed. The test step and the full gate did not finish; interruption is not a pass.

The task-owned Cargo debug directory had grown to roughly 47 GiB: about 21 GiB of incremental data and 26 GiB of dependencies/test artifacts. Root confirmed there were no remaining Cargo/compiler processes, acquired the target lock, and removed only this task's generated build caches. Source, worktrees, reports, test logs and Xcode result bundles were preserved. Free space recovered from approximately 255 MiB to 47.5 GiB, then measured 48.6 GiB at guard review.

Every subsequent local build, test or generator uses:

```sh
python3 /private/tmp/centraid-1200-build-guard.py -- <command> <arguments>
```

The guard requires 30 GiB free before starting, monitors a 20 GiB free-space floor and a 15 GiB task-artifact cap, and terminates only its own launched process group when a limit or measurement failure occurs. It checks the task Cargo target, the integration worktree's real target/Gradle outputs, and the designated task Xcode build directory. It does not clean files itself. Two-second polling can briefly overshoot a limit; this is resource monitoring, not a duration assertion in a test.

The wrapper sets `CARGO_TARGET_DIR=/private/tmp/centraid-1200-target`, `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_PROFILE_TEST_DEBUG=0`. These are local build settings; repository test, lint, query and size budgets remain unchanged. One Cargo/build lease is still required, and dependent builds start only after shared source reaches a coherent checkpoint.

Reviewed guard SHA-256: `f86fea9cebc22051108fe468c499b9bebb9675fdd9efb1212b1f29fabd7fb068`.

Root reviewed the guard and independently ran its real environment-check no-op. The delegate also verified preflight refusal for low space and oversized artifacts, forced monitor termination of a disposable process group (including a child that handles TERM by exiting successfully), final-snapshot refusal, and filesystem-measurement failure. Guard refusal returns 125 and interruption returns 130; a child reporting success cannot turn a disk-limit stop into a pass.

## Integration verification checkpoint

The focused Docs Drive suite passes 31/31 after replacing the obsolete confirmation oracle with the existing direct Trash/Undo contract. The real mobile JVM gate passes 45/45 after replacing an obsolete unknown-status fixture with genuinely unassigned codes. Full `bun run check`, workspace formatting, scoped xtask Clippy and all 27 structural rules passed for the docs/test batch.

Matching native cores and shells were built from runtime source `7d22a64fe2241cc84b59c3a283630f1a96d462dd`; the later docs/test changes do not alter runtime source. Root reviewed iOS simulator and Android emulator onboarding, Home, task Trash/Undo and person Trash/Undo results. The exact counts, tool versions, artifact hashes and limits are in `native-verification.md`. The visual docs rebuild and root's browser review are recorded in `docs-rebuild.md`.

The first CI run on that revision failed one obsolete Docs Drive test; its native iOS, Android and engine jobs passed. `ci-native-review.md` preserves that failure and the local corrective evidence. The PR's checks and the umbrella issue are the authoritative record of subsequent CI on the published head. Full-app OS notification callbacks, isolation and independent recovery require their own native observations; file-store and screen-flow passes do not establish them.
