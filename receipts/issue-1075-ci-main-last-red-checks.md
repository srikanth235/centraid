# Issue #1075 — three checks still red on main after #1072 and #1073

Follow-up to [#1052](https://github.com/srikanth235/centraid/issues/1052), [#1062](https://github.com/srikanth235/centraid/issues/1062) and [#1072](https://github.com/srikanth235/centraid/issues/1072). On `main` at c8a80038 the required legs, `rung1-on-main` (including the commit-subject step, which passed in 2 s) and `report` are green. Three checks stayed red, each for its own reason. All three files are territory; no law-estate file changes.

## What changed

- `scripts/ci/lane-health.mjs` (+ test) — `lane-health` judges a lane only while the newest completed candidate run still carries it (`liveLanes`, `onlyLive`). Every rule reads a trailing 30-run window, so a job v1 deleted kept its last red streak and its slow samples until the window rolled past them, and `park-required` / `over-budget` fired for lanes nobody can fix or park (rolling issues #1056–#1065: `web-e2e-linux`, `paired-journeys`, `suite`, `mobile-canary-android`, `mobile-ios-smoke`, `lane-gateway-package`, …). A skipped job still counts as live, so path-gating never hides a lane. A newest run with no jobs makes the filter stand down and judge every lane, so a workflow that failed before scheduling anything cannot read as "nothing is red". The streak, pass-rate, escape and duration inputs are filtered; the rules and the quarantine ledger are untouched.
- `.github/actions/setup/action.yml` — the cargo cache key carries `runner.arch`. The cache holds `~/.cargo/bin`, and `prebuilt-core / binary (aarch64-unknown-linux-gnu)` restored the x86_64 entry (same OS, same lockfile) and died with `rustup: cannot execute binary file: Exec format error`. The first run on each architecture is a cold cache.
- `.github/workflows/lane-prebuilt-core.yml` — on macOS the binary job puts `~/.cargo/bin` on `PATH` before the toolchain step. On `prebuilt-core / binary (x86_64-apple-darwin)` `rustup default` succeeded and the next step failed with `rustc: command not found`.
- `CHANGELOG.md` — one `Changed` line under Unreleased.

Both `prebuilt-core` legs are optional (`false` in the matrix) and never gated.

`receipts/issue-1072-ci-main-follow-up.md` says `lane-health`'s park-required rule "needs no edit: it clears after a green candidate". That was wrong for the lanes v1 deleted, which never get a green run to clear them; this change is the correction. The 1072 receipt is frozen and stays as written.

## Verification

```sh
node --test scripts/ci/lane-health.test.mjs   # pass 24, fail 0 (three new tests: a retired lane is not judged; a live red lane still fires park-required; skipped is live, an empty newest run judges every lane)
bun run lint:product                          # 24/24 product gates passed. exit 0
python3 -c 'yaml.safe_load(...)'              # both edited YAML files parse
```

The cause of the aarch64-linux failure is read from the job log (run 36820524218, job 110234968839: `rustup: cannot execute binary file` on a restored `~/.cargo/bin`, cache key `cargo-v1-Linux-…` with no architecture). The Intel macOS failure's cause is read from the log (`rustup default` ok, `rustc: command not found`); that `~/.cargo/bin` is simply absent from `PATH` there is inferred, and the PATH step has not been observed green in CI. `lane-health` has not been run against the live API from this branch.

## Audit

Verdict: PENDING
