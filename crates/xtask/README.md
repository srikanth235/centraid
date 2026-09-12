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

## The four profiles (and one placeholder)

Each profile is a **superset** of the one before, stated in code as concatenation rather than as a copied list, so a step can never be in `pr` and missing from `release` (there is a test for exactly that).

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test`, `rules`, `ledgers` | < 120 s **warm**, < 3000 s **cold** | the pre-push loop, by hand |
| `pr` | `buf`, `deny`, `ci-policy`, `secrets`, `osv`, `release-build`, `ts-static` | < 1500 s | `.github/workflows/gate.yml`, every PR and every push to `main` |
| `nightly` | `v0-oracle`, `device-lanes` | unbounded | `.github/workflows/gate-nightly.yml`, 05:30 UTC |
| `release` | `restore-drill`, `vps-smoke` | unbounded | wave 2 R and wave 3 G wire it to the release lane |
| `mobile-jvm` | none — a ledger placeholder, not a superset of anything | null | nowhere yet; it **refuses** and names wave 3 lane E |

The budgets live in [`contracts/ledgers/gate-budgets.json`](../../contracts/ledgers/gate-budgets.json) and are **enforced**: a profile whose steps together overran its `budgetSeconds` fails, prints the timing table, and says `FAIL — over budget` on its last line. They are down-only, like every other gate knob in this repo; the one time they rose was the 2026-09-12 re-base for the Rust workspace, under an owner ruling recorded as [D-1020-B2](../../docs/decisions.md#decisions--lane-b2-1020).

**`local` is scored warm or cold, and they are different numbers.** The 120 s promise is the developer's feedback time after an edit, not the cost of the first build after a clone — 24.0 s against 1394.6 s on this container at nine crates. The runner asks whether **every** workspace member has a *linked* artifact in `target/debug/deps` (a `.rlib` or an extensionless executable): an `.rmeta` from a previous `cargo check` does not count, so a tree that has only been checked cannot buy a warm budget while its `test` step still has to compile and link everything. A *stale* incremental tree does read as warm, on purpose — that is the tree the loop runs on, and rebuilding the delta is what the budget promises. Each run prints `tree warm` or `tree cold` with the reason; `--cold` forces the cold branch without deleting `target/`. A cold `local` run is charged against `coldLocalProfileSeconds` in `compile-time.json` and **fails** if that key states no ceiling, because cold must never be the answer that makes a slow gate green. No other profile has a cold ceiling: they run in CI on a runner that has never seen the workspace, so their budgets hold cold or they are not budgets.

`mobile-jvm` is in the ledgers and not in the step lists. Running it prints a refusal naming wave 3 lane E, which lands the Kotlin Multiplatform shared module and the Gradle suites, measures `budgetSeconds` and `kotlinNativeLinkSeconds`, and sets them both. A profile with no steps that scored itself green would report "the Kotlin suites passed" before one exists.

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

### The `ci-policy`, `secrets` and `osv` steps

These are not v0's gates — they are standing checks over `.github/**`, `tests/path-filter-ledger.json`, the working tree and `bun.lock`, and they ran in `ci.yml`'s `static`, `gates`, `gitleaks` and `osv-scanner` lanes on every pull request. Taking the `pull_request:` trigger off that file would have taken them off pull requests, which is weakening a gate rather than moving one, so they moved here.

| Step | What it runs | Verdict today |
| --- | --- | --- |
| `ci-policy` | `lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters`, `actionlint` — the gates that guard this very workflow | green, under a second |
| `secrets` | `gitleaks detect` over the working tree (#671) | **inherited red** |
| `osv` | `scripts/ci/osv-lockfile-scan.mjs`, CRITICAL-only (#671) | **inherited red** |

**Inherited red is named, never hidden** (D-1020-B1). Two of these three fail on tree state that arrived before #1020: `packages/model-runtime/LICENSES.md` trips gitleaks' `generic-api-key` rule (it came with #1011/#1012), and `astro@7.1.5` in `bun.lock` carries a CRITICAL scored 9.8. Neither is fixed from here and nothing was added to `.gitleaks.toml` or `osv-scanner.toml` — a gate whose first act is to widen its own allowlist has gated nothing. Both are **owner hand-offs**: a reasoned allowlist row naming the LICENSES file (or moving the offending string) is the owner's call, and the `astro` bump is a dependency change outside #1020's scope. The steps are here and red rather than absent, because a pull-request gate that stops reporting because its target is red today is a weakening.

`dependency-review` moved too, as its own job in `gate.yml`: it is a GitHub Action reading the PR's dependency diff through the API rather than a command over the tree, so it cannot be a step of `cargo xtask gate`.

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
| `compile-time.json` | clean check, incremental check, single-crate test, release build, the cold `local` profile, and a null `kotlinNativeLinkSeconds` for wave 3 — "compile time is the new Hermes" |
| `library-size.json` | the prebuilt core's size per ABI. **Seeded empty**: an empty ledger gates nothing and says so, and wave 3 lane G fills it from the first artifact |

The comparison mirrors [`scripts/check-ledgers.mjs`](../../scripts/check-ledgers.mjs): the base copy is read with `git show <merge-base>:<path>`, and "the base has no such file" means the entry is new and passes — without that fallback the very commit that introduces a ledger could not pass its own gate. A number that rose is a finding, and so is a number that was **removed**, because deleting a ceiling is the widest possible widen.

What each ledger stores is a ceiling with **stated headroom**, not the last measurement. The workspace held one crate in wave 1 and holds nine now, so a ceiling pinned to today's number would fail the first time a crate landed, and the author would learn to widen ledgers instead of fixing loops. Each entry's `headroom` quotes its measurement, the state of the tree it was taken on, and the multiplier that produced the ceiling.

**There is no waiver, deviation or override path here, and adding one is not how a number moves.** `scripts/check-ledgers.mjs` has an `approvedDeviation` mechanism for v0's ledgers; these have none, because a waiver added before the first widen is asked for is an invitation. The numbers rose once, on 2026-09-12, under an owner ruling quoted per key — not through a mechanism — and the ratchet code is exactly as strict as it was: `ledger.rs`'s `a_risen_number_is_a_finding` still fails a raise against an existing base copy. That re-base passed the `ledgers` step only because `origin/main` carries no `contracts/ledgers/` yet, so the base copy is `None` and every entry reads as new. Once #1020 merges, these numbers are the baseline and they only fall.

**A gate run never writes a ledger.** `cargo xtask measure --write` is the only writer, and it only ever _lowers_ `budgetSeconds`, printing one note per key saying what it did. A ratchet that records whatever the last run cost is a log.

## Where the numbers came from

On this container (4 vCPU, 15 GB — the `ci-linux-x64-4c` hardware class in `tests/journeys.json`), with `CENTRAID_GATE_HARDWARE` overridable so a self-hosted device runner can score itself. The wave-1 column is a workspace of **one** crate over clap and serde_json; the 2026-09-12 column is **nine** crates over iroh, quinn, tokio, prost and rusqlite-bundled, which is why the ceilings were re-based ([D-1020-B2](../../docs/decisions.md#decisions--lane-b2-1020)):

| Measurement                                        | Wave 1 | 2026-09-12    | Ceiling   |
| -------------------------------------------------- | ------ | ------------- | --------- |
| `gate --profile local`, **warm**                   | —      | 24.0 s        | 120 s     |
| `gate --profile local`, **cold**                   | 4.9 s  | 1394.6 s      | 3000 s    |
| `gate --profile pr`, cold                          | 16.8 s | 1420.1 s      | 1500 s    |
| `gate --profile pr`, warm                          | —      | 575.8 s       | 1500 s    |
| `cargo check --workspace`, clean                   | 17.4 s | 541.7 s       | 1200 s    |
| `cargo check --workspace`, one line in an app crate | 0.1 s  | 0.6 s         | 10 s      |
| `cargo test -p centraid-net`, repeated             | 10.4 s | 2.4 s         | 60 s      |
| `cargo build --workspace --release`, clean         | 28.9 s | 240.3-666.6 s | 1400 s    |

Two numbers that are not ceilings and are worth knowing. A cold `local` run spends 587.6 s in `clippy` and 806.5 s in `cargo test --workspace` — the same dependency graph compiled twice, once for check units and once for artifacts to link against. And alternating `cargo test -p centraid-net` with `cargo test --workspace` costs 185.8 s / 161.7 s each way against 2.4 s for either command repeated, because one package's feature resolution is not the workspace's union, so the two commands invalidate each other's artifacts.
