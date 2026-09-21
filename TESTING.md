# Testing strategy

Centraid's tests protect product flows and invariants, not a test-file count. The strategy is **the gate**: `cargo xtask gate --profile <name>` is the one entrypoint CI runs, and everything below is either a step of it or a proof that only a device can give ([#1020](https://github.com/srikanth235/centraid/issues/1020)). How to run the gate day to day is in [docs/dev-environment.md](docs/dev-environment.md#the-local-gate-loop); the runner's internals are in [crates/xtask/README.md](crates/xtask/README.md).

## The axiom

This repo is written almost entirely by agents, and agents fail in predictable ways. They optimize for the green checkmark. They grade their own homework. They cannot see the whole suite, so they duplicate. They have no memory, so prose conventions decay. And the agent that writes the code writes the tests that _confirm_ it rather than tests that try to _falsify_ it.

Therefore:

> **Every quality claim is either computed by a machine or adversarially verified — never asserted by its author.**

The consequences:

1. **Tests are the spec.** Contracts and committed fixtures are the only statement of intent that survives context loss. The priority is more _named laws_, not more tests.
2. **Never trust a green from the author.** A test that cannot fail is not a test: every structural rule carries a fixture that it **must** catch, and a fixture is regenerated and diffed rather than edited by hand.
3. **Whatever is not mechanically enforced will regress.** Budgets and ceilings live in down-only ledgers, never in prose.
4. **Gates must be cheap and deterministic, or agents route around them.** Randomness comes from a seed, time from a scripted clock, and a failing seed becomes a permanent test.
5. **A skip is loud, and never a pass.** A step that cannot run here says so and names the command that makes it run; in CI, where the workflow installs the tool, a missing tool is a failure.

One flow, one home, proven at the cheapest tier that can falsify it.

## What the machine cannot check

The gates make dishonesty expensive, not impossible. These judgements have no gate, so this is where review attention belongs:

- **Whether a law is worth writing.** A suite of true, trivial laws passes every gate.
- **Whether a test covers what its name claims.** Nothing reads assertions. A test named "pairing survives a partition" that never partitions a network is green.
- **Whether a skip's reason is the real reason.** The gate forces a skip to be loud; it cannot check that the stated cause is true.
- **Whether a deletion was a de-duplication or a loss.** That needs reading both tests.
- **Whether a recorded divergence from a parity fixture is right.** The gate proves the divergence is stated; only a reader can say it should exist.

## The v1 gate profiles (#1020)

Each profile is stated in code as a **concatenation of the one before it** (`local` ⊂ `pr` ⊂ `nightly` ⊂ `release`), so a step can never be in `pr` and missing from `release`; a unit test in [`crates/xtask/src/gate.rs`](crates/xtask/src/gate.rs) holds that. Budgets are in [`contracts/ledgers/gate-budgets.json`](contracts/ledgers/gate-budgets.json) and are enforced: a profile whose steps together overran fails and prints its timing table.

| Profile | Budget | Steps it adds | Where it runs |
| --- | --- | --- | --- |
| `local` | 120 s **warm** | `fmt`, `clippy`, `test` (workspace **minus** `centraid-sim`), `rules`, `ledgers` | By hand, the edit-run loop |
| `pr` | 1500 s | `buf`, `deny`, `ci-policy`, `secrets`, `osv`, `release-build`, `ts-static`, `emitters`, `advisory`, `lockfile`, `artifact-identity`, `prebuilt-core-required`, `call-budget`, `fault-door`; its `test` step runs the **whole** workspace | [`gate.yml`](.github/workflows/gate.yml), every PR and every push to `main` |
| `nightly` | unbounded | `pr` plus `device-lanes` | [`gate-nightly.yml`](.github/workflows/gate-nightly.yml), 05:30 UTC |
| `release` | unbounded | `restore-drill`, `artifact-identity`, `prebuilt-core-required`, `vps-smoke` | By hand before a tag |
| `mobile-jvm` | 420 s | `mobile-jvm` — one step, a superset of nothing | `gate-nightly.yml`'s `mobile-jvm` job; on demand |

`local` is scored **warm or cold**. The runner calls a tree warm only when every workspace member has a linked artifact under the target directory (`CARGO_TARGET_DIR` when set); a cold run is charged to `coldLocalProfileSeconds` in [`compile-time.json`](contracts/ledgers/compile-time.json) and fails where that key states no ceiling. `--cold` forces the cold branch. Leaving `centraid-sim` out of `local` weakens nothing: `pr` runs that crate twice, once in `test` and once as `sim`.

`gate.yml` also runs a `dependency-review` job on pull requests (a GitHub Action over the dependency diff, so it cannot be a gate step). Governance is **not** a step: `.governance/run.sh` runs in [`governance.yml`](.github/workflows/governance.yml) as its own check.

### What the steps prove

| Step | What it runs |
| --- | --- |
| `fmt`, `clippy` | `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings` |
| `test` | `cargo nextest run --workspace` when nextest is installed, otherwise `cargo test --workspace`; the step line says which |
| `rules` | The structural rules: `sql-confinement` (SQL only under `crates/{ontology,vault,search}` and `crates/apps/kit`), `abi-five-symbols`, `no-listening-socket` (the phone dials and accepts nothing; the one exemption is `crates/gateway-server/src/serve.rs`), `commonmain-no-platform-import`. Also `cargo xtask rules` on its own |
| `ledgers` | Every number in `contracts/ledgers/` against the merge base — see [the ledgers](#the-ledgers-915-wave-4-927) |
| `buf` | `buf lint`, then `buf breaking` against the PR base **and** every released tag inside the version window |
| `deny`, `secrets`, `osv`, `lockfile` | `cargo-deny` over [`deny.toml`](deny.toml); gitleaks over the working tree; osv-scanner, CRITICAL only; no `http:` URLs and pinned checksums in `bun.lock` and `Cargo.lock` |
| `ci-policy` | Workflow pins, egress, path filters ([`tests/path-filter-ledger.json`](tests/path-filter-ledger.json)) and `actionlint` over `.github/**` |
| `advisory` | Every step whose name declares it advisory has an owner, an issue and an unexpired `revisitBy`, in [`contracts/ledgers/advisory.json`](contracts/ledgers/advisory.json) or `tests/inventory.json#advisory` |
| `release-build` | `cargo build --workspace --release`, timed against its ledger ceiling |
| `ts-static` | `bun run check:push:static` when TypeScript exists under `crates/`, `contracts/` or `mobile/` |
| `emitters` | Regenerates the design corpus and native theme ([`contracts/tools/`](contracts/tools)), formats, and fails on drift in `copy/`, `design/` or `mobile/` |
| `call-budget` | `cargo test -p centraid-core --test call_budget -- --nocapture`: any bounded read over its ceiling in [`call-budget.json`](contracts/ledgers/call-budget.json) fails, and p50/p95/p99 reach the log |
| `fault-door` | `cargo test -p centraid-core-ffi --features debug-fault --test contract …` — clause 9 of the C ABI against a real panic inside `call`. The only step that turns `debug-fault` on |
| `restore-drill` | The whole durability chain: found a vault, commit, capture, take a generation, commit more, **destroy the live vault, its WAL and its spool**, restore from the object store and the two keys derived from the 24 words, and prove the result is `restore_check`-clean, census-matched and **byte-identical**. It refuses a census of zero rows |
| `artifact-identity` | The stale-core refusal in `crates/core/src/identity.rs` |
| `prebuilt-core-required` | Artifact keys are computable and distinct for every required triple; that the artifacts **exist** is asserted by [`lane-prebuilt-core.yml`](.github/workflows/lane-prebuilt-core.yml) |
| `vps-smoke` | [`deploy/vps/install.sh`](deploy/vps/install.sh) in a clean Docker container: verified install, dry-run unit, vault founding, iroh pairing, WAL tick and backup, `centraid doctor`, restart (`crates/xtask/src/smoke.rs`) |

### What every step prints

Three verdicts, no fourth: `ok`, `FAIL`, and a loud `SKIP` naming the command that turns it into a real run. Output is buffered and printed only on failure, every step prints one line whatever it does, and every step runs even when an earlier one failed. `--lane <name>` narrows a run to one step (or one device lane); a name that matches nothing is an error, never an empty green run.

A failing step writes `command.txt`, `stdout.log` and `stderr.log` (or `findings.txt`) under `target/xtask/<profile>/<step>/`, and both gate workflows upload `target/xtask/**` on failure.

### The evidence contract

Every run writes `target/xtask/<profile>/evidence.json` — profile, hardware class, and one row per step with its seconds, verdict and detail — on success as well as failure, so a step going quiet is visible rather than absent. The hardware class defaults to `ci-linux-x64-4c` and is overridden by `CENTRAID_GATE_HARDWARE` (the device runner sets it).

### Known reds

Two `pr` findings are named rather than hidden, and neither was answered by widening an allowlist — a gate whose first act is to widen its own allowlist has gated nothing:

- `secrets` — gitleaks on `contracts/golden/format-golden.json`'s `dataKeyHex`, the test vector the cross-language format golden is sealed with.
- `osv` — `astro@7.1.5`, CRITICAL, in `bun.lock`.

Both are owner hand-offs (rows 6.2 and 6.3 of [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md)). A false positive is a different thing and is fixed **in the gate**.

## Rust

Each crate carries its own tests; `cargo test -p <crate>` (or `cargo nextest run -p <crate>`) is the unit of iteration. Give every worktree its own `CARGO_TARGET_DIR` ([docs/traps/shared-cargo-target.md](docs/traps/shared-cargo-target.md)). For one debugging session with full debuginfo: `CARGO_PROFILE_DEV_DEBUG=2 cargo test -p centraid-vault`.

- **End-to-end over the real binary.** [`crates/centraid/tests/`](crates/centraid/tests) spawns the binaries for gateway install, the gateway's first run and the wire tests. `no_listener.rs` reads the kernel's own socket table, because a dependency could open a listener without the string ever appearing in this repository — the runtime half of `no-listening-socket`.
- **The C ABI.** `crates/core-ffi` has a contract test per clause of [`crates/core-ffi/CONTRACT.md`](crates/core-ffi/CONTRACT.md); the Kotlin side proves the same ABI from the JVM (see [Mobile](#mobile)).

### Simulation — retired

`crates/sim` proved the convergence of one gateway and N seats under a scripted network. There is
one writer and it is the phone ([#1029](https://github.com/srikanth235/centraid/issues/1029)), so
there is nothing to converge. What replaces the claim is two things that are not simulations: the
**restore drill**, which destroys a live vault and proves the restored file is byte-identical, and
`crates/gateway-core`'s **conformance suite**, which is what "implements the protocol" means.

### Fixtures and parity

Everything under [`contracts/`](contracts/README.md) is generated and diffed, never hand-edited:

- **Golden corpora.** `contracts/golden/issue-1020/` and `issue-929/` are frozen vaults; `crates/ontology/tests/fixtures.rs` regenerates the derived fixtures (the corpus's own `vault-ddl.sql`, the manifests) and fails on drift.
- **The two DDL fixtures answer different questions** (#1029). `contracts/golden/issue-1020/vault-ddl.sql` is the frozen v0 corpus's `sqlite_master`, regenerated by `cargo run -p centraid-ontology --bin export-ddl` and diffed by `crates/ontology/tests/fixtures.rs`. `contracts/schema/vault-ddl.sql` is **the schema a new vault gets** — the `sqlite_master` of a file founded at the ladder head — regenerated by `cargo run -p centraid-vault --bin export-ladder-ddl` and diffed by `crates/vault/tests/ladder_ddl.rs`, which founds a vault to do it. Neither is ever hand-edited. `contracts/golden/format-golden.json` holds the cross-language byte vectors that `crates/media`, `crates/blobs` and `crates/vault` reproduce, and `contracts/protocol/framing-golden.json` is regenerated by `CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-protocol --test framing_golden`.
- **App parity.** `contracts/apps/<app>/` (`rows.json`, `queries.json`, `commands.json`, `scenarios.json`) was generated from the TypeScript implementation before its removal in [#1020](https://github.com/srikanth235/centraid/issues/1020), and is now frozen. Each `crates/apps/<app>/tests/parity.rs` rebuilds the vault from the rows and compares **values and order**. A divergence is either a port bug or a mapping stated at the top of that test file. Rung five's deletions (#1029) left four bundles carrying rows for a table or a column the schema no longer has: the fixture is never edited — the test names what it is skipping through `centraid_apps_kit::contract_vault::FrozenRowMapping`, which refuses a mapping that names something the schema still has, and Docs' and People's parity tests filter the sharing keys out of v0's expected answers with a guard that fails when nothing is filtered.
- **Screens and theme.** `contracts/screens` and the native theme are regenerated by `mobile-jvm` and `emitters` and checked with `git diff --exit-code`.

## Mobile

**`mobile-jvm`** builds `centraid-core-ffi`, runs `./gradlew -p mobile mobileJvm --no-daemon` (`:shared:jvmTest`, `:core:jvmTest` — a real ABI round trip against the real cdylib — and `:shared:koverXmlReport`), regenerates the native theme and screen fixtures, formats, and fails on drift in `design`, `copy`, `mobile` or `contracts/screens`. A missing `mobile/gradlew` **fails**; it does not skip. It does not compile Compose, link Kotlin/Native, or touch a simulator or device. Locally: `cd mobile && ./gradlew mobileJvm`. The on-device checks (`swift test`, device builds, snapshots) and their commands are tabled in [mobile/README.md](mobile/README.md).

**Maestro flows** live in [`mobile/maestro/flows`](mobile/maestro/README.md), with CLI `MAESTRO_VERSION=2.6.1` pinned. Compose `testTag` and SwiftUI `accessibilityIdentifier` use the same string, so one flow drives both platforms; the ids are listed in `mobile/maestro/flows/selectors.md`. No CI runner has a device, so the flows are run by hand: `maestro test mobile/maestro/flows`.

### Device lanes and their runner contract

`device-lanes` has four cells — `ios-transfer-experiment`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass` — named once in `gate.rs` so the workflow matrix and the runner cannot disagree. `gate-nightly.yml` runs them as a matrix on `[self-hosted, macos, devices]` **only** when `vars.CENTRAID_DEVICE_RUNNER == 'true'`; each cell runs `cargo xtask gate --profile nightly --lane <name>`, and an owner with a phone on a laptop runs the same command.

- Without `CENTRAID_DEVICE_RUNNER`, the step is a loud `Skipped` — never a pass.
- With it set, the step **requires** `xcrun devicectl list devices` (a physical iPhone — not `simctl`, which lists simulators) and `adb devices` to list something. A runner that claims the label and has no phone goes **red**.
- `ios-transfer-experiment` checks that the evidence under `receipts/experiments/ios-transfer/` exists, is complete, is recent and did not come from a simulator; the run itself is the overnight protocol in [`mobile/maestro/ios-transfer-experiment.md`](mobile/maestro/ios-transfer-experiment.md).
- `battery-per-background-pass` cannot be automated on either platform and always skips with the owner's manual procedure.

What only a device can measure — the absolute mobile targets, the iOS per-state transfer promise, `kotlinNativeLinkSeconds` — is parked, not gated: the ceilings sit under a leading underscore in [`tests/journeys.json`](tests/journeys.json), where the ratchet cannot see them, until a run on a named reference device promotes them. The hand-offs are in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md).

## The ledgers (#915 Wave 4, #927)

**The gate's ledgers** are the five files under [`contracts/ledgers/`](contracts/ledgers): `gate-budgets`, `compile-time`, `library-size`, `call-budget` and `advisory` (the advisory register). The `ledgers` step compares every JSON file in that directory against the merge base and refuses any number that rose or vanished. `cargo xtask measure --write` is the only writer and only ever lowers a number; a gate run measures and reports but never writes, because a ratchet that records whatever the last run cost is a log. A raise needs an owner ruling ([D-1020-B2](docs/decisions.md#decisions--lane-b2-1020)).

**The repo-wide ledgers under `tests/`** are still read:

| Ledger | Read by |
| --- | --- |
| [`tests/floors.json`](tests/floors.json), [`tests/budgets.json`](tests/budgets.json), [`tests/inventory.json`](tests/inventory.json), [`tests/quarantine.json`](tests/quarantine.json) | Governance law: a change to any of them is a governance event, with the direction table from [`scripts/check-ledgers.mjs`](scripts/check-ledgers.mjs) (`bun run lint:ledgers`). The `advisory` step also reads `tests/inventory.json#advisory`. |
| [`tests/journeys.json`](tests/journeys.json) | The hardware-class vocabulary the gate ledgers are keyed by, the parked device ceilings, and the year-3 volume rows the `crates/apps` fixtures generate. |
| [`tests/path-filter-ledger.json`](tests/path-filter-ledger.json) | The `ci-policy` step's path-filter check. |
| [`tests/design-grammar-matrix.json`](tests/design-grammar-matrix.json) | `packages/design`'s moment-matrix test. |

## Related

- [crates/xtask/README.md](crates/xtask/README.md) — the runner, its rules and its ledgers.
- [docs/toolchain.md](docs/toolchain.md#v1-cargo-xtask-gate-1020) — toolchain pins and the gate's cost.
- [docs/release.md](docs/release.md) — the release lanes and the real-VPS smoke.
- [docs/logs.md](docs/logs.md) — start every debug session here.
