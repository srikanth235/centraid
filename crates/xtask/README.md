# `cargo xtask` — the cross-cutting gate

`cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the **only** gate entrypoint CI runs ([#1020](https://github.com/srikanth235/centraid/issues/1020)). Rule two of this repository is "never compromise on tooling", and the product is three languages: anything that must hold across Rust, Kotlin and TypeScript cannot live inside any one of them, so it lives here.

```bash
cargo xtask gate --profile local     # the edit-run loop
cargo xtask gate --profile pr        # what every pull request satisfies
cargo xtask gate --profile nightly   # pr + the deep sim, the e2e runs and the device lanes
cargo xtask gate --profile nightly --lane <name>   # one step, or one device lane
cargo xtask gate --profile release   # nightly + the restore drill + the VPS smoke
cargo xtask gate --profile mobile-jvm  # the Kotlin half, on its own
cargo xtask rules                    # the structural rules alone
cargo xtask repo-root                # which tree the path-based rules will scan
cargo xtask measure --write          # the edit-run loop, into the compile-time ledger
cargo xtask artifact-key --triple <t>  # the prebuilt core's cache key
cargo xtask photos-sample            # regenerate contracts/apps/photos/sample/manifest.json
```

## The tree a run scans is **the current directory's**

Every path-based rule — `sql-confinement`, `no-listening-socket`, `abi-five-symbols`, `ts-static`, `commonmain-no-platform-import` — reads files under one root, and that root is resolved when the binary RUNS: `git rev-parse --show-toplevel` from the current directory, then a walk up for the `CONSTITUTION.md` + `Cargo.toml` pair only the root carries, then the compile-time manifest path with a warning on stderr.

A root baked in at compile time (`env!("CARGO_MANIFEST_DIR")`) would be wrong under a shared `CARGO_TARGET_DIR`: the cached binary belongs to whichever worktree built it last, the gate scans **that** worktree, and the failure direction is _reports clean_ ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `cargo xtask repo-root` prints the answer in one line, and `crates/xtask/tests/repo_root.rs` runs the compiled binary from a second checkout and asserts it reports that checkout.

## The target directory is `CARGO_TARGET_DIR`'s, for the same reason

Everything that asks _what has been built_ — the warm/cold verdict, `measure`'s two cold keys, `vps-smoke`'s release binary — resolves the target directory as cargo does: `CARGO_TARGET_DIR` when it is set, otherwise `<root>/target`. Reading `<root>/target` under a shared target directory is wrong in both directions: a fully linked workspace would print `tree cold`, and a _stale_ `<root>/target` would read `tree warm` for a tree whose real target directory had never been built — and `measure` would time a warm build as a first build, into a down-only ledger ([#1020](https://github.com/srikanth235/centraid/issues/1020)). Each run's `tree` line prints the absolute `debug/deps` it scanned, so the answer is never implied.

## The profiles

Each of `local`, `pr`, `nightly` and `release` is a **superset** of the one before, stated in code as concatenation rather than as a copied list, so a step can never be in `pr` and missing from `release` (there is a test for exactly that).

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test` (**minus `centraid-sim`** — see below), `rules`, `ledgers` | < 120 s **warm**, < 3200 s **cold** | the pre-push loop, by hand |
| `pr` | `buf`, `deny`, `ci-policy`, `secrets`, `osv`, `release-build`, `ts-static`, `emitters`, `desktop-unit`, `extension-unit`, `advisory`, `lockfile`, `prompt-injection`, `sim`, `call-budget`, `fault-door` — and its `test` step runs the **whole** workspace, sim included | < 1500 s | `.github/workflows/gate.yml`, every PR and every push to `main` |
| `nightly` | `sim-nightly`, `desktop-e2e`, `extension-e2e`, `device-lanes` | unbounded | `.github/workflows/gate-nightly.yml`, 05:30 UTC |
| `release` | `restore-drill`, `artifact-identity`, `prebuilt-core-required`, `vps-smoke` | unbounded | the release workflows |
| `mobile-jvm` | `mobile-jvm` — one step, not a superset of anything | < 420 s | `.github/workflows/gate-nightly.yml`; on demand from `mobile/` |

**`local`'s `test` step leaves out `centraid-sim`, and nothing is weakened by it** ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-CL9). The sim crate's three suites are ~29 s of the profile's warm 150.7 s — `crates/sim/tests/seeds.rs` alone is 22.9 s for three tests — and `pr` runs that crate **twice**: once inside its own unexcluded `cargo test --workspace`, and again as the `sim` step at 25 seeds (`nightly` adds `sim-nightly` on top of both). So the deterministic simulation, #1020's primary sync proof, is exercised by every gate that gates a merge, and what changed is that a developer editing an app crate stops paying for it on every save. Editing `crates/sim` itself means running `cargo test -p centraid-sim`, which is exactly what the `sim` step runs. This is the profile table's own statement of the move; it is not a skip inside a test.

The budgets live in [`contracts/ledgers/gate-budgets.json`](../../contracts/ledgers/gate-budgets.json) and are **enforced**: a profile whose steps together overran its `budgetSeconds` fails, prints the timing table, and says `FAIL — over budget` on its last line. They are down-only, like every other gate knob in this repo; the one time they rose was the 2026-09-12 re-base for the Rust workspace, under an owner ruling recorded as [D-1020-B2](../../docs/decisions.md#decisions--lane-b2-1020).

**`local` is scored warm or cold, and they are different numbers.** The 120 s promise is the developer's feedback time after an edit, not the cost of the first build after a clone — 41.6 s against 1562.4 s on this container at ten crates. The runner asks whether **every** workspace member has a _linked_ artifact in the target directory's `debug/deps` (a `.rlib` or an extensionless executable): an `.rmeta` from a previous `cargo check` does not count, so a tree that has only been checked cannot buy a warm budget while its `test` step still has to compile and link everything. A _stale_ incremental tree does read as warm, on purpose — that is the tree the loop runs on, and rebuilding the delta is what the budget promises. Each run prints `tree warm` or `tree cold` with the reason; `--cold` forces the cold branch without deleting `target/`. A cold `local` run is charged against `coldLocalProfileSeconds` in `compile-time.json` and **fails** if that key states no ceiling, because cold must never be the answer that makes a slow gate green. No other profile has a cold ceiling: they run in CI on a runner that has never seen the workspace, so their budgets hold cold or they are not budgets.

`mobile-jvm` is the Kotlin half, and it is **not** a superset of anything. Its one step builds `centraid-core-ffi`, runs `./gradlew -p mobile mobileJvm` (`:shared:jvmTest`, `:core:jvmTest` — a real ABI round trip against the real cdylib — and `:shared:koverXmlReport`), then regenerates the committed native theme and screen fixtures and fails on drift. It is kept out of `pr` because Kotlin/Gradle is a different toolchain with a different cold cost, and one ceiling answering for two build systems answers for neither (D-1020-B2-3). `budgetSeconds` is 420 s, measured when the step became real; `kotlinNativeLinkSeconds` in `compile-time.json` stays **null** on purpose — no machine here links Kotlin/Native, and filling it with a JVM number is the one thing that key exists to prevent.

**A missing mobile tree FAILS, it does not skip.** What the step does not do, it says rather than passing over: it does not compile Compose, does not link Kotlin/Native, does not run a simulator and does not touch a device. Those are `nightly`'s `device-lanes` — four lanes (`ios-transfer-experiment`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass`) that `gate-nightly.yml` runs only on a `[self-hosted, macos, devices]` runner when `vars.CENTRAID_DEVICE_RUNNER == 'true'`, and a loud `Skipped` otherwise — and the hand-off table in [`mobile/README.md`](../../mobile/README.md).

`restore-drill` runs `cargo test -p centraid --test restore_drill` and records its wall clock as evidence under the step's artifact directory (the release budget is unbounded by ruling). `vps-smoke` installs the published tarball in a clean container, founds a vault, pairs a seat, takes a backup, restarts and checks a tampered identity is refused; when it cannot run it reports why, and a skip the step cannot justify is a failure.

### The `fault-door` step

The one step that compiles the tree with a feature on: `cargo test -p centraid-core-ffi --features debug-fault --test contract a_real_panic_inside_call_poisons_the_handle_through_the_abi`. `debug-fault` makes a `Command` named `debug.panic` panic inside `Handle::call`, which is how clause 9 of the C ABI gets proved against the real library rather than against a shell's fake. It exports no symbol (`abi-five-symbols` still counts five) and is off in every other step and every release profile; a default build answers `debug.panic` as an unregistered command, and `the_fault_door_is_absent_from_a_default_build` asserts that. Its first run found `centraid_next_event` answering `TIMEOUT` on a poisoned handle instead of `PANICKED`.

## What every step prints

Three verdicts, no fourth:

```
  ok    clippy              3.1s  cargo clippy --workspace --all-targets -- -D warnings
  SKIP  deny                0.0s  cargo-deny is not on PATH — … `cargo install cargo-deny --locked`
  FAIL  test                1.4s  `cargo test --workspace` exited 101 — … · artifact: target/xtask/pr/test
```

Output is buffered and printed only on failure; **every step prints one line whatever it does**, because a silent gate is not a gate (the same posture as [`scripts/ci/run-gates.mjs`](../../scripts/ci/run-gates.mjs), which the TypeScript static gates run through). Every step runs even when an earlier one failed, so one pass tells you everything that is wrong.

### Failure artifacts

A failing step writes its whole output under `target/xtask/<profile>/<step>/` — `command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the two internal steps — and the step's one line names the directory. Both gate workflows upload `target/xtask/**` on failure.

### The `deny` step's posture

`cargo-deny` is a separate binary. When it is absent the step **loud-skips with the install command locally** and **fails in CI**, where the workflow installs it and a missing binary is therefore an infrastructure failure. That is the same contract [`scripts/security/rust-supply-chain.mjs`](../../scripts/security/rust-supply-chain.mjs) states, and it exists because a guarded skip that could be mistaken for a pass is worse than no lane at all. The policy is the repo's one shared [`deny.toml`](../../deny.toml); there is no per-crate copy to drift.

`cargo nextest` gets the same treatment in the other direction: `test` uses `cargo nextest run --workspace` when the binary is on PATH and `cargo test --workspace` when it is not, and the step's line says which one ran.

### The `ci-policy`, `secrets` and `osv` steps

Standing checks over `.github/**`, `tests/path-filter-ledger.json`, the working tree and `bun.lock`, run on every pull request.

| Step | What it runs | Verdict today |
| --- | --- | --- |
| `ci-policy` | `lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters`, `actionlint` — the gates that guard this very workflow | green, under a second |
| `secrets` | `gitleaks detect` over the working tree with `.gitleaks.toml` (#671); findings in files git does not track are reported and dropped | no inherited finding recorded |
| `osv` | `scripts/ci/osv-lockfile-scan.mjs`, CRITICAL-only (#671) | **inherited red** |

**Inherited red is named, never hidden** (D-1020-B1). `osv` fails on tree state that predates #1020: `astro@7.1.5` in `bun.lock` carries a CRITICAL scored 9.8. It is not fixed from here and nothing was added to `osv-scanner.toml` — a gate whose first act is to widen its own allowlist has gated nothing. The `astro` bump is an **owner hand-off**, a dependency change outside #1020's scope. The step is here and red rather than absent, because a pull-request gate that stops reporting because its target is red today is a weakening.

`dependency-review` is its own job in `gate.yml`: it is a GitHub Action reading the PR's dependency diff through the API rather than a command over the tree, so it cannot be a step of `cargo xtask gate`.

### The `ts-static` step

When any `.ts`/`.tsx`/`.mts`/`.cts` file exists under `crates/`, `contracts/`, `mobile/`, `desktop/` or `extension/` — which `desktop/`, `extension/` and `contracts/tools/` make true — the step runs `bun run check:push:static` (format check, lint and affected typecheck through `scripts/ci/run-gates.mjs`). With none, it loud-skips and names that command.

### Governance is NOT a step here

`.governance/run.sh` already runs in [`governance.yml`](../../.github/workflows/governance.yml) on every pull request as its own required check. Duplicating it inside the `pr` profile would charge the budget twice for one answer and give a single failure two places to be reported from. The law is enforced; it is just not enforced from here.

## Required checks

Branch protection's required checks are **`gate`** and **`dependency-review`**, the two jobs in [`gate.yml`](../../.github/workflows/gate.yml). Branch protection is configured outside the repository, the same way the code-owner review requirement is ([docs/dev-environment.md](../../docs/dev-environment.md#the-local-gate-loop)); a required check that never reports blocks every pull request, which is the failure #557 was written about, so renaming either job is an owner change to branch protection in the same breath.

## The steps re-homed from `scripts/ci/**` (#1020, D-1020-G3)

Gates about the shape of CI and about the supply chain rather than the product. Each keeps the rule of the script it names.

| Step | Profile | From | What it holds |
| --- | --- | --- | --- |
| `advisory` | `pr` | `scripts/ci/advisory-expiry.mjs` | a step whose NAME declares it advisory carries an owner, an issue and an unexpired `revisitBy`. A past date fails; a row naming a step that no longer exists fails too. Rows live in `contracts/ledgers/advisory.json` |
| `lockfile` | `pr` | `scripts/ci/lockfile-lint.mjs` | no `http:` package URL and integrity markers present in `bun.lock`; every registry `[[package]]` in `Cargo.lock` pinned by `checksum` and sourced over TLS. A workspace member with no `source` is not a finding — its bytes are in the tree |
| the evidence row | every profile | `scripts/test-report/write-evidence.mjs` | one row per step in `target/xtask/<profile>/evidence.json`, written on success as well as failure, so the per-PR test report has a row for the gate that decides a pull request |

## `cargo xtask artifact-key` (#1020, D-1020-G2)

The prebuilt core's cache key. `--triple` is required; `--features`, `--profile` and `--explain` are optional. The exact rule — what is in the key, what is deliberately not, and both halves of the `Cargo.lock` case — is the module doc of [`src/artifact.rs`](src/artifact.rs) and the operator-facing half is in [`docs/release.md`](../../docs/release.md).

## Debuginfo, and the one-command escape hatch (#1020, D-1020-G7)

`[profile.dev]` and `[profile.test]` carry `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and dependencies carry `debug = false`. A backtrace still names the file and the line. The measurement that decided it is in the root `Cargo.toml`'s comment and in [`docs/toolchain.md`](../../docs/toolchain.md): 7.7 GB of test executables became 0.50 GB, and the biggest single one went from 387 MB to 43 MB.

**When you need the full type and variable tables for one debugging session:**

```bash
CARGO_PROFILE_DEV_DEBUG=2 cargo test -p centraid-vault
```

One command, one crate, nothing committed. Do not put it in a script — a profile change that is always on is the profile, and this one was measured out on purpose.

## The structural rules

Four of them, one per invariant in the issue's _Execution plan → Invariants_. They are **file walks and hand-rolled scanners, not parse trees**: the issue rules that tree-sitter owns structural rules, and it is not here yet because all four are answerable from string literals, attribute lines and import lines, and a parser would cost the `local` budget more than the precision is worth today. The commit that adds tree-sitter is the one where a rule needs to know what an expression _means_.

| Rule | What it asserts | | --- | --- | --- | | `sql-confinement` | a SQL keyword in a string literal appears only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` | | `abi-five-symbols` | `crates/core-ffi` exports exactly five `extern "C"` symbols | | `no-listening-socket` | no `TcpListener::bind` outside a `#[cfg(feature = "blob-door")]` block | | `commonmain-no-platform-import` | no `android.`/`java.`/`platform.`/`kotlinx.cinterop` import under `mobile/shared/src/commonMain` or `mobile/core` |

A rule whose subject directory is absent prints `PENDING` with the reason rather than passing silently.

**`crates/xtask` is exempt from the two source-scanning rules** because it holds their patterns: the SQL keyword table and the listener patterns are string literals in this crate, so scanning the runner with its own rules would report the rules themselves. It is one named directory, it ships in no artifact, and it opens no socket. Every rule has a unit test with a fixture that **must** be caught — a rule with no demonstrated red is a claim, not a gate.

## The ledgers

Three files under [`contracts/ledgers/`](../../contracts/ledgers), all down-only, all checked by the `ledgers` step in every profile:

| Ledger | Holds |
| --- | --- |
| `gate-budgets.json` | the per-profile feedback-time ceiling |
| `compile-time.json` | clean check, incremental check, single-crate test, release build, the cold `local` profile, and a null `kotlinNativeLinkSeconds` |
| `library-size.json` | the prebuilt core's stripped size per ABI. A `null` gates nothing and says so; `x86_64-unknown-linux-gnu` carries the first measured artifact |

The comparison follows [`scripts/check-ledgers.mjs`](../../scripts/check-ledgers.mjs): the base copy is read with `git show <merge-base>:<path>`, and "the base has no such file" means the entry is new and passes — without that fallback the very commit that introduces a ledger could not pass its own gate. A number that rose is a finding, and so is a number that was **removed**, because deleting a ceiling is the widest possible widen.

What each ledger stores is a ceiling with **stated headroom**, not the last measurement. A ceiling pinned to today's number would fail the first time a crate landed, and the author would learn to widen ledgers instead of fixing loops. Each entry's `headroom` quotes its measurement, the state of the tree it was taken on, and the multiplier that produced the ceiling.

**There is no waiver, deviation or override path here, and adding one is not how a number moves.** `scripts/check-ledgers.mjs` has an `approvedDeviation` mechanism for the `tests/` ledgers; these have none, because a waiver added before the first widen is asked for is an invitation. The numbers rose once, on 2026-09-12, under an owner ruling quoted per key — not through a mechanism — and the ratchet code is exactly as strict as it was: `ledger.rs`'s `a_risen_number_is_a_finding` still fails a raise against an existing base copy. That re-base passed the `ledgers` step only because `origin/main` carries no `contracts/ledgers/` yet, so the base copy is `None` and every entry reads as new. Once #1020 merges, these numbers are the baseline and they only fall.

**A gate run never writes a ledger.** `cargo xtask measure --write` is the only writer, and it only ever _lowers_ `budgetSeconds`, printing one note per key saying what it did. A ratchet that records whatever the last run cost is a log.

## Where the numbers came from

On this container (4 vCPU, 15 GB — the `ci-linux-x64-4c` hardware class in `tests/journeys.json`), with `CENTRAID_GATE_HARDWARE` overridable so a self-hosted device runner can score itself. The first column is a workspace of **one** crate over clap and serde_json; the 2026-09-12 column is **nine** crates over iroh, quinn, tokio, prost and rusqlite-bundled, which is why the ceilings were re-based ([D-1020-B2](../../docs/decisions.md#decisions--lane-b2-1020)):

| Measurement | One crate | 2026-09-12 | Ceiling |
| --- | --- | --- | --- |
| `gate --profile local`, **warm** | — | 24.0-41.6 s | 120 s |
| `gate --profile local`, **cold** | 4.9 s | 1394.6-1562.4 s | 3200 s |
| `gate --profile pr`, cold | 16.8 s | 1420.1 s | 1500 s |
| `gate --profile pr`, warm | — | 575.8 s | 1500 s |
| `cargo check --workspace`, clean | 17.4 s | 541.7 s | 1200 s |
| `cargo check --workspace`, one line in an app crate | 0.1 s | 0.6 s | 10 s |
| `cargo test -p centraid-net`, repeated | 10.4 s | 2.4 s | 60 s |
| `cargo build --workspace --release`, clean | 28.9 s | 240.3-666.6 s | 1400 s |

Two numbers that are not ceilings and are worth knowing. A cold `local` run spends 587.6-626.1 s in `clippy` and 806.5-935.6 s in `cargo test --workspace` — the same dependency graph compiled twice, once for check units and once for artifacts to link against. And alternating `cargo test -p centraid-net` with `cargo test --workspace` costs 185.8 s / 161.7 s each way against 2.4 s for either command repeated, because one package's feature resolution is not the workspace's union, so the two commands invalidate each other's artifacts.
