# Issue #1075 — three checks still red on main after #1072 and #1073

Follow-up to [#1052](https://github.com/srikanth235/centraid/issues/1052), [#1062](https://github.com/srikanth235/centraid/issues/1062) and [#1072](https://github.com/srikanth235/centraid/issues/1072). On `main` at c8a80038 the required legs, `rung1-on-main` (including the commit-subject step, which passed in 2 s) and `report` are green. Three checks stayed red, each for its own reason. All three files are territory; no law-estate file changes.

## What changed

- `scripts/ci/lane-health.mjs` (+ test) — `lane-health` judges a lane only while the newest completed candidate run still carries it (`liveLanes`, `onlyLive`). Every rule reads a trailing 30-run window, so a job v1 deleted kept its last red streak and its slow samples until the window rolled past them, and `park-required` / `over-budget` fired for lanes nobody can fix or park (rolling issues #1056–#1065: `web-e2e-linux`, `paired-journeys`, `suite`, `mobile-canary-android`, `mobile-ios-smoke`, `lane-gateway-package`, …). The newest completed run that has any job decides (a run cancelled by the concurrency group lists none and says nothing about which lanes exist); when no run has a job the filter stands down and judges every lane. A job skipped at job level is still listed by the jobs API; a matrix or reusable-workflow job skipped as a whole is listed under the caller's name only, so its expanded lanes would read as absent (not the case in `candidate.yml` today). The streak, pass-rate, escape and duration inputs are filtered; the rules and the quarantine ledger are untouched.
- `.github/workflows/candidate.yml` + `scripts/ci/lane-health.mjs` — `--exclude-lane lane-health`: the scorer is not a lane it judges. Its red is "a rule fired", which the findings already carry; judged by its own history it could never clear, because its streak breaks only on a green `lane-health` and it is red while the streak stands (the audit found this in run 36820523744). The exemption is named in the workflow, not implied.
- `.github/actions/setup/action.yml` — the cargo cache key carries `runner.arch`. It also splits the two macOS legs (arm64, Intel) and the two Windows legs (x64, arm64), which used to share one entry each; the macOS PATH step below depends on that split. The cache holds `~/.cargo/bin`, and `prebuilt-core / binary (aarch64-unknown-linux-gnu)` restored the x86_64 entry (same OS, same lockfile) and died with `rustup: cannot execute binary file: Exec format error`. The first run on each architecture is a cold cache.
- `.github/workflows/lane-prebuilt-core.yml` — on macOS the binary job puts `~/.cargo/bin` on `PATH` before the toolchain step. On `prebuilt-core / binary (x86_64-apple-darwin)` `rustup default` succeeded and the next step failed with `rustc: command not found`.
- `CHANGELOG.md` — one `Changed` line under Unreleased.

Both `prebuilt-core` legs are optional (`false` in the matrix) and never gated.

`receipts/issue-1072-ci-main-follow-up.md` says `lane-health`'s park-required rule "needs no edit: it clears after a green candidate". That was wrong for the lanes v1 deleted, which never get a green run to clear them; this change is the correction. The 1072 receipt is frozen and stays as written.

## Verification

```sh
node --test scripts/ci/lane-health.test.mjs   # pass 26, fail 0 (five new tests: a retired lane is not judged; a live red lane still fires park-required; skipped is live and no jobs anywhere judges every lane; a cancelled newest run does not switch the filter off; the scorer is never judged by its own history)
bun run lint:product                          # 24/24 product gates passed. exit 0
python3 -c 'yaml.safe_load(...)'              # both edited YAML files parse
```

The cause of the aarch64-linux failure is read from the job log (run 36820524218, job 110234968839: `rustup: cannot execute binary file` on a restored `~/.cargo/bin`, cache key `cargo-v1-Linux-…` with no architecture). The Intel macOS failure's cause is read from the log (`rustup default` ok, `rustc: command not found`); that `~/.cargo/bin` is simply absent from `PATH` there is inferred, and the PATH step has not been observed green in CI. `lane-health` has not been run against the live API from this branch.

## Known limits

- Renaming a red lane now drops its old name at once, and the new name needs three fresh reds (`PARK_AFTER_REDS`) before `park-required` fires. Before, the old name kept firing until it left the window. The `report` job's own red flag still fires on every red lane, so the gap is the three runs, not silence.
- The `ios` job in `lane-prebuilt-core.yml` (release-only, `macos-latest`) has no PATH step; it runs on the image of the arm64 leg that was green.
- The PATH step runs on the arm64 macOS leg as well, where it is harmless.

## Audit

Verdict: PENDING

Round 1: REFUTED. The audit found that `lane-health` stayed red under the first version of this change (it judged itself, finding fixed above by `--exclude-lane`), that a cancelled newest run switched the filter off (fixed: the newest run with jobs decides), that "skipped is live" was stated too broadly (comment and receipt narrowed), and that the receipt and CHANGELOG overclaimed (both reworded; the rename gap, the cache split and the iOS job are now listed). The cache key and the macOS PATH step were found sound. Round 2 is pending.
