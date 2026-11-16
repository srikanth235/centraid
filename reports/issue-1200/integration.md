# #1200 integration record

The sole implementation branch is `codex/1200-v0-refinement` in `/private/tmp/centraid-1200`; its sole draft PR is #1201. Implementation slices are reviewed individually. The original workspace and its untracked audit evidence remain untouched.

## Owner scope decisions

- Assistant evaluation, frozen-data retrieval, reference replay and quality scoring are excluded. No quality score or target attainment is claimed.
- Docs will not gain **Write a note**. No production code for that proposal was applied. The connected journey uses Docs’ existing Add link picker to reuse a note, then carries that note into Reminders. Only the new reminder and its chosen note relation need an atomic creation path.
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

## Integration evidence still owed

Focused slice results are in the issue and individual reports. A completed local/PR gate on the final head, the mobile JVM gate, matching native builds and required native transition/recovery observations remain pending. Earlier CI results or isolated file-store tests do not establish those later layers.
