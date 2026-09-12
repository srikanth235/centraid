# `cargo xtask` — the v1 tree's cross-cutting gate

`cargo xtask gate --profile <local|pr|nightly|release>` is the **only** entrypoint CI runs for the v1 tree ([#1020](https://github.com/srikanth235/centraid/issues/1020)). Rule two of this repository is "never compromise on tooling", and v1 is three languages: anything that must hold across Rust, Kotlin and TypeScript cannot live inside any one of them, so it lives here.

```bash
cargo xtask gate --profile local     # the edit-run loop
cargo xtask gate --profile pr        # what every pull request satisfies
cargo xtask gate --profile nightly   # pr + the v0 oracle + the device lanes
cargo xtask gate --profile release   # nightly + the restore drill + the VPS smoke
cargo xtask rules                    # the structural rules alone
cargo xtask measure --write          # the edit-run loop, into the compile-time ledger
```

## The four profiles

Each profile is a **superset** of the one before, stated in code as concatenation rather than as a copied list, so a step can never be in `pr` and missing from `release` (there is a test for exactly that).

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test`, `rules`, `ledgers` | < 120 s | the pre-push loop, by hand |
| `pr` | `deny`, `ci-policy`, `release-build`, `ts-static` | < 900 s | `.github/workflows/gate.yml`, every PR and every push to `main` |
| `nightly` | `v0-oracle`, `device-lanes` | unbounded | `.github/workflows/gate-nightly.yml`, 05:30 UTC |
| `release` | `restore-drill`, `vps-smoke` | unbounded | wave 2 R and wave 3 G wire it to the release lane |

The budgets live in [`contracts/ledgers/gate-budgets.json`](../../contracts/ledgers/gate-budgets.json) and are **enforced**: a profile whose steps together overran its `budgetSeconds` fails and prints the timing table. They are down-only, like every other gate knob in this repo.

`release` **fails today, on purpose.** `restore-drill` and `vps-smoke` are steps that exit with `not implemented: lands in wave N`, so the profile cannot report green for a release nobody has proven restorable. A placeholder that skipped would be worse than no step at all.

## What every step prints

Three verdicts, no fourth:

```
  ok    clippy              3.1s  cargo clippy --workspace --all-targets -- -D warnings
  SKIP  deny                0.0s  cargo-deny is not on PATH — … `cargo install cargo-deny --locked`
  FAIL  test                1.4s  `cargo test --workspace` exited 101 — … · artifact: target/xtask/pr/test
```

Output is buffered and printed only on failure; **every step prints one line whatever it does**, because a silent gate is not a gate (the same posture as [`scripts/ci/run-gates.mjs`](../../scripts/ci/run-gates.mjs), which the TypeScript gates run through). Every step runs even when an earlier one failed, so one pass tells you everything that is wrong.

### Failure artifacts

A failing step writes its whole output under `target/xtask/<profile>/<step>/` — `command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the two internal steps — and the step's one line names the directory. Both gate workflows upload `target/xtask/**` on failure.

### The `deny` step's posture

`cargo-deny` is a separate binary. When it is absent the step **loud-skips with the install command locally** and **fails in CI**, where the workflow installs it and a missing binary is therefore an infrastructure failure. That is exactly the contract [`scripts/security/rust-supply-chain.mjs`](../../scripts/security/rust-supply-chain.mjs) states for the v0 crates, and it exists because a guarded skip that could be mistaken for a pass is worse than no lane at all. The policy is the repo's one shared [`deny.toml`](../../deny.toml); there is no per-crate copy to drift.

`cargo nextest` gets the same treatment in the other direction: `test` uses `cargo nextest run --workspace` when the binary is on PATH and `cargo test --workspace` when it is not, and the step's line says which one ran.

### The `ci-policy` step, and the two lanes that are NOT here

`ci-policy` runs `lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters` and `actionlint`. These are not v0's gates — they are standing checks over `.github/**` and `tests/path-filter-ledger.json`, and they are the gates that guard this very workflow. They ran in `ci.yml`'s `static` and `gates` jobs on every pull request, so taking the `pull_request:` trigger off that file would have taken them off pull requests: that would be weakening a gate rather than moving one, so they moved here. They cost under a second.

Two more `ci.yml` pull-request lanes belong here by the same argument and are **not** here yet, named so the gap is visible rather than quiet: `gitleaks` (secret scanning over the working tree) and `osv-scanner` (the `bun.lock` advisory inventory). Both are **already red on the tree as it stands** — `packages/model-runtime/LICENSES.md` trips gitleaks' `generic-api-key` rule, and `astro@7.1.5` in `bun.lock` carries a CRITICAL — so adding them in wave 1 would import another change's red into every pull request rather than gate anything. Each is two lines (`step(...)` plus an `external` call) once those two are fixed; the wave 1 receipt carries both as findings.

`dependency-review` did move, as its own job in `gate.yml`: it is a GitHub Action reading the PR's dependency diff through the API rather than a command over the tree, so it cannot be a step of `cargo xtask gate`.

### The `ts-static` step

There is no TypeScript in the v1 tree yet (`crates/`, `contracts/`, `mobile/`, `desktop/`, `extension/`), so the step loud-skips and names the command it will run — `bun run check:push:static` — the moment a `.ts` file appears in any of them. It deliberately does **not** run v0's static gate over the v0 tree: #1020 rules v0's gates off pull requests from wave 1, and re-running them here under a different name would be the same CI bill with the ruling pasted over it.

### Governance is NOT a step here

`.governance/run.sh` already runs in [`governance.yml`](../../.github/workflows/governance.yml) on every pull request as its own required check. Duplicating it inside the `pr` profile would charge the budget twice for one answer and give a single failure two places to be reported from. The law is enforced; it is just not enforced from here.

## OWNER HAND-OFF: the required check moves

Branch protection's required check today is **`check`**, the single aggregator job in [`ci.yml`](../../.github/workflows/ci.yml). #1020 takes the `pull_request:` trigger off that workflow — v0's gates now run on pushes to `main` and nightly, as the pinned oracle — so **`check` will stop reporting on pull requests**. A required check that never reports blocks the pull request forever, which is the exact failure #557 was written about.

The owner must switch branch protection's required checks from `check` (ci.yml) to **`gate`** and **`dependency-review`**, the two jobs in gate.yml. Until that is done, pull requests will block. Nothing in this repository can do it: branch protection is configured outside the repository, the same way the code-owner review requirement is ([docs/dev-environment.md](../../docs/dev-environment.md#the-local-gate-loop)).

## The structural rules

Four of them, one per invariant in the issue's _Execution plan → Invariants_. They are **file walks and hand-rolled scanners, not parse trees**: the issue rules that tree-sitter owns structural rules, and it is not here yet because all four are answerable from string literals, attribute lines and import lines, and a parser would cost the `local` budget more than the precision is worth today. The commit that adds tree-sitter is the one where a rule needs to know what an expression _means_.

| Rule | What it asserts | State in wave 1 |
| --- | --- | --- |
| `sql-confinement` | a SQL keyword in a string literal appears only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` | applied; scans 0 files today, because `crates/xtask` is the only crate and is exempt (below) |
| `abi-five-symbols` | `crates/core-ffi` exports exactly five `extern "C"` symbols | PENDING — the crate lands in wave 2 lane D |
| `no-listening-socket` | no `TcpListener::bind` outside a `#[cfg(feature = "blob-door")]` block | applied; 0 files today, same exemption |
| `commonmain-no-platform-import` | no `android.`/`java.`/`platform.`/`kotlinx.cinterop` import under `mobile/shared/src/commonMain` | PENDING — `mobile/` lands in wave 3 lane E |

A PENDING rule prints the wave that lands its subject. The rules are written now rather than alongside the code they constrain, because a rule added afterwards has to be argued for and a rule that was always there is simply true.

**`crates/xtask` is exempt from the two source-scanning rules** because it holds their patterns: the SQL keyword table and the listener patterns are string literals in this crate, so scanning the runner with its own rules would report the rules themselves. It is one named directory, it ships in no artifact, and it opens no socket. Every rule has a unit test with a fixture that **must** be caught — a rule with no demonstrated red is a claim, not a gate.

## The ledgers

Three files under [`contracts/ledgers/`](../../contracts/ledgers), all down-only, all checked by the `ledgers` step in every profile:

| Ledger | Holds |
| --- | --- |
| `gate-budgets.json` | the per-profile feedback-time ceiling |
| `compile-time.json` | clean check, incremental check, single-crate test and release build — "compile time is the new Hermes" |
| `library-size.json` | the prebuilt core's size per ABI. **Seeded empty**: an empty ledger gates nothing and says so, and wave 3 lane G fills it from the first artifact |

The comparison mirrors [`scripts/check-ledgers.mjs`](../../scripts/check-ledgers.mjs): the base copy is read with `git show <merge-base>:<path>`, and "the base has no such file" means the entry is new and passes — without that fallback the very commit that introduces a ledger could not pass its own gate. A number that rose is a finding, and so is a number that was **removed**, because deleting a ceiling is the widest possible widen.

What each ledger stores is a ceiling with **stated headroom**, not the last measurement. The workspace is one crate today and a dozen after wave 2, so a ceiling pinned to today's number would fail the first time a crate landed, and the author would learn to widen ledgers instead of fixing loops. The wave-1 measurements are quoted in each entry's `headroom` and in the receipt.

**A gate run never writes a ledger.** `cargo xtask measure --write` is the only writer, and it only ever _lowers_ `budgetSeconds`, printing one note per key saying what it did. A ratchet that records whatever the last run cost is a log.

## Where the numbers came from

Wave 1, on this container (4 vCPU, 15 GB — the `ci-linux-x64-4c` hardware class in `tests/journeys.json`), with `CENTRAID_GATE_HARDWARE` overridable so a self-hosted device runner can score itself:

| Measurement                                 | Wave 1 | Ceiling   |
| ------------------------------------------- | ------ | --------- |
| `gate --profile local`, after `cargo clean` | 4.9 s  | 120 s     |
| `gate --profile pr`, after `cargo clean`    | 16.8 s | 900 s     |
| `gate --profile nightly`, warm              | 8.7 s  | unbounded |
| `cargo check --workspace`, clean            | 17.4 s | 180 s     |
| `cargo check --workspace`, one line changed | 0.1 s  | 10 s      |
| `cargo test -p xtask`                       | 10.4 s | 60 s      |
| `cargo build --workspace --release`, clean  | 28.9 s | 600 s     |
