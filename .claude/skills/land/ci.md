# CI

`.github/workflows/gate.yml` is the only workflow that listens on `pull_request`. It also runs on every push to `main` and on `workflow_dispatch`. Nothing in it is path-filtered, because a filtered-out job reports no status and a required check that never reports blocks the PR. For the profiles themselves see [gate](gate.md).

## The jobs

- **`lane`** (shown as `gate-<lane>`): a matrix job, ubuntu, 60 minutes each, `fail-fast: false`, running `cargo xtask gate --profile pr --lane <lane>` for `static`, `tests`, `build` and `ts` in parallel. Which steps a lane holds is `PR_LANES` in `crates/xtask/src/gate.rs`, and only there: `static` is the cheap checks, `tests` is every cargo-test step (`test` with nextest and the doctests, `restore-drill`, `prompt-injection`, `model-record`, `fault-door`) on one dev build; it is not sharded, because `test` is about 1130 s of which about 70 s is running tests and each shard would compile the workspace again, `build` is `release-build`, `ts` is `ts-static`. A unit test fails if a `pr` step is in no lane or two, or if the workflow matrix and `PR_LANES` differ, so a new `pr` step needs a lane. Full history is fetched, because `buf breaking` compares against `main` and the released tags.
- **`gate`**: the required check. It runs `if: always()` after every `lane` and fails unless all of them succeeded. Never rename it.
- **Tool pins** (nextest with a SHA-256 check, actionlint, buf, cargo-deny) are in `.github/actions/gate-tools`, used by `lane` and by `nightly.yml`'s `gate` job. Change them there only.
- **Caches**: `tests` uses the key `gate`, and `static`, `build` and `ts` have `gate-static`, `gate-build` and `gate-xtask`, so no lane's `target/` evicts another's. Caches are saved from `main`, and from a pull request only by `tests` (`save_pr` in the matrix, `cargo-cache-save-pr` in the setup action), because its cold compile is what made PR runs take 50 to 70 minutes against about 24 warm. GitHub scopes a PR's cache to its own ref: `main`'s is the fallback and a PR can never replace it. The other lanes stay main-only so the 10 GB pool is not filled (#637).
- **`engine`**: the on-device chat's llama.cpp build is too slow for the `pr` profile, so this job runs `clippy` and `cargo test` over `centraid-assist-llama` and `centraid-core-ffi` with the `llama` feature on. The real-model tests are `#[ignore]`d because they need a GGUF file the repo does not carry.
- **`ios`**: macOS, 90 minutes. It builds the simulator core with llama, compiles the Swift app, runs XCTest and compiles HealthSeeder.
- **`android`**: ubuntu, 45 minutes. It runs `compileDebugKotlin` on the runner's SDK, which type-checks the Compose shell without packaging the native libraries, and one shared-fixture unit test (`BackupCheckControlsTest`).
- **`dependency-review`**: pull requests only. It reads the PR's dependency diff and fails on high severity or an AGPL or GPL-3.0 licence in a new dependency.
- **`pr-title`**: pull requests, except Dependabot. It runs `.githooks/commit-msg` over the title, because a squash merge's subject is the PR title. The form is `type(scope): subject (#N)`.
- `crates/xtask/README.md` names `gate`, `engine`, `dependency-review` and `pr-title` as the required checks. Branch protection is set outside the repository, so renaming a job is an owner change.

## One push cancels the run in flight

The workflow has `concurrency: group: gate-<PR number, or the ref>` with `cancel-in-progress: true`. A new push to a PR cancels that PR's running jobs and starts again. Pushes to `main` share the group for the ref, so a later push cancels an earlier one. A cancelled run is not a failure to investigate. Push once the change is ready and do not stack small pushes.

## `crates/xtask/src/ci.rs`

- It is the `ci-policy` and `lockfile` steps of the gate.
- `action_pins` reads every `.yml` under `.github/`. Every `uses:` that is not a local `./` path must end in a 40-hex commit SHA. A tag or branch is a finding with the file and line. Keep the trailing `# vX.Y.Z` comment.
- `ci-policy` then runs `actionlint`. It is a `SKIP` locally if the binary is missing, and a `FAIL` in CI.
- `lockfile` checks `bun.lock` (no plain `http:` package URL, integrity markers present) and `Cargo.lock` (every registry package has a `checksum`, and the source is crates.io or an https git URL).

## Where the failure detail lives

1. The job log shows the one line per step and, for a failed step, the last line of stderr and the artifact directory. A step that runs a command buffers its output and prints none of it. The `rules`, `doc-links`, `design`, `ledgers` and `lockfile` steps, and the pin check of `ci-policy`, do print their findings.
2. A failing lane uploads the artifact **`gate-pr-<lane>-artifacts`** (for example `gate-pr-tests-artifacts`; `target/xtask/**`, kept 7 days). Inside, the paths start at the profile: `pr/test/stderr.log` for the test step, and `pr/<step>/command.txt`, `stdout.log` and `stderr.log` for any command step. `findings.txt` is the evidence for the internal steps. If xtask itself fails to compile there is no artifact: read the job log.
3. Download it with `gh run download <run-id> -n gate-pr-<lane>-artifacts`.
4. `ios` uploads `ios-verification` (compiler and test logs, the `.xcresult`) every time. `android` and `engine` upload nothing, so their detail is the job log.
5. To reproduce a failed step, run `cargo xtask gate --profile pr --lane <step>`; to reproduce a whole lane, `--lane <lane>` .

## Other workflows

`nightly.yml` runs at 05:30 UTC (its `gate` job is still one job): `gate --profile nightly`, `gate --profile mobile-jvm` and the prebuilt-core lane. Its artifacts are `nightly-gate-artifacts` and `nightly-mobile-jvm-artifacts`. When all three pass it moves `refs/candidates/latest`, which `release.yml` requires a tag to point at. `codeql.yml`, `trainer.yml` and the `lane-*.yml` and `release.yml` files are separate and are not part of the PR gate.
