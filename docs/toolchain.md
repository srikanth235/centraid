# Toolchain contract

This is the durable command and ownership contract for quality work. Rust, Kotlin and TypeScript are gated by one entrypoint, `cargo xtask gate` ([below](#cargo-xtask-gate-1020)); the TypeScript that remains — `packages/design`, `packages/test-kit` and the repo tooling scripts — additionally has the Bun-script contract in the first half of this page. Its executable sources of truth are the root `package.json`, `oxlint.config.ts`, and `oxfmt.config.ts`; this document explains the policy without duplicating their rule catalog.

## Toolchain pins

| Toolchain | Pin | Read by |
| --- | --- | --- |
| Rust | `rust-toolchain.toml` (`channel`) | rustup, `.github/actions/setup` (`rustup toolchain install` with no argument), and [`flake.nix`](../flake.nix)'s `devShells.default` through `rust-overlay` |
| Gradle, Kotlin, AGP, Wire and the Kotlin test stack (`:core`) | `mobile/gradle/libs.versions.toml`, plus the committed `mobile/gradlew` wrapper with `distributionSha256Sum` | Gradle; `org.gradle.warning.mode=fail` makes a deprecation a red ([mobile/README.md](../mobile/README.md#the-toolchain)) |
| Xcode | `.xcode-version` | the iOS hand-off; nix cannot install Xcode |
| `cmake` and a C++17 compiler | `flake.nix` (`cmake`); the ubuntu-latest image; Xcode's toolchain and the Android NDK on a phone build | llama.cpp (`llama-cpp-sys-2`), the on-device chat's engine, and only where it is compiled: `centraid-core-ffi`'s `llama` feature, i.e. a phone's core, `mobile/scripts/android-core.sh`, the prebuilt-core lane's Android and iOS legs and the `engine` job in `gate.yml`. `cargo xtask gate` compiles none of it ([R-CHAT-10](decisions.md#the-assistant)) |
| llama.cpp's converter and `llama-quantize`, at upstream commit `26394b4e6749a41c3633db040e0987500a5f7013` | `experiments/toolchat/native/train/to_gguf.py` (`LLAMA_CPP_COMMIT`), from a checkout of that commit | turning a checkpoint into the GGUF the phone loads. It is the commit `llama-cpp-sys-2` 0.1.158 vendors, so a file it writes is one the engine reads: a bump of the binding moves `LLAMA_CPP_COMMIT` with it ([R-1088-18](decisions.md#the-assistant)) |
| Node | `.node-version`, mirrored in `package.json#engines.node` | `.github/actions/setup` reads `.node-version`; a bump moves both |
| Bun | `package.json#packageManager` | `.github/actions/setup` |
| TypeScript and the TS tools | exact versions in the root `package.json` (`typescript` via the workspace catalog) | every Bun script below |

The flake pins every toolchain except the Android SDK and Xcode, and says so in its header.

## TypeScript: one owner per concern

| Concern | Owner |
| --- | --- |
| Reviewed opinionated baseline | Ultracite modular presets |
| Formatting, import sorting, and package metadata sorting | Oxfmt |
| Static correctness and repository lint policy | Oxlint |
| Compiler diagnostics and type correctness | pinned TypeScript |
| Runtime behaviour | Vitest, and the Rust suites the gate runs |
| Whether `DESIGN.md`'s front matter is Centraid's real tokens | `packages/design/src/design-md.test.ts`, which compares it against `packages/design/src` |

Ultracite seeds `core`, `react`, and `vitest` policy through `oxlint.config.ts`. It is not a command runner. Optional GitHub, Sonar, and react-doctor JavaScript-plugin presets remain declined as bundles; a future issue may admit one rule at a time through the rubric below.

Oxfmt is the sole style owner. Oxlint rules that only restate formatting are off. The pinned TypeScript compiler is the sole owner of compiler diagnostics; Oxlint `--type-check` is not part of any command. Oxlint is the only linter.

## TypeScript: stable command API

All callers use repository-pinned binaries through these Bun scripts:

| Command | Contract |
| --- | --- |
| `format` | write Oxfmt output with the root config |
| `format:check` | check Oxfmt output without mutation |
| `lint` | ordinary Oxlint pass, warnings denied |
| `lint:fix` | Oxlint safe fixes only |
| `lint:site-tokens` | the site's generated token CSS matches `packages/design` (`site:tokens` rewrites it) |
| `typecheck` | pinned TypeScript compiler across the workspaces |
| `test` | every workspace's Vitest suite |
| `scripts:test` | the release scripts' Vitest suite and the `node --test` suites under `scripts/` |
| `check` | `format:check`, `lint`, `typecheck`, `test`, `scripts:test`, in that order. Also the gate's `ts-static` step |

The workspaces with their own `build`, `test` and `typecheck` scripts are `packages/*`; run one with `bun run --cwd <dir> <script>`. `docs:*` build and serve the documentation site, `release:*` are the release scripts ([release.md](release.md)) and `gateway:install` is the gateway installer.

## Hooks and suppressions

Do not invoke raw `npx`, global tools, `bunx` guesses, or implicit config discovery. Editors, hooks, local commands, and CI all name the root configs. The `pre-commit` hook runs `oxfmt --check` and `oxlint` over the staged files and rewrites nothing; `commit-msg` checks the subject shape ([dev-environment.md](dev-environment.md#the-local-gate-loop)).

`lint:fix` never enables suggestions or dangerous fixes. The strings `--fix-suggestions` and `--fix-dangerously` do not belong in scripts, hooks, or CI. Oxfmt writes are the only routine style mutation.

## Rule-adoption rubric

A rule is enabled only when every answer is yes:

1. Does it detect correctness, safety, maintainability, performance, or accessibility risk rather than taste?
2. Does its diagnostic lead to an actionable resolution?
3. Are false positives rare in the file profile where it runs?
4. Does it have an explicit runtime and scope?
5. Does its cost fit the gate that runs it?
6. For a type-aware rule, does it agree with the pinned TypeScript compiler?
7. If it fixes code, is the fix tier known and the behavioural risk understood?

Standing declines are filename conventions, `github/no-then`-style syntax preferences, blanket cognitive-complexity thresholds, mandatory function-expression styles, formatter duplicates, and optional JavaScript-plugin presets as bundles. File length is not a decline: `max-lines` is enforced at 625 ([coding-standards.md](coding-standards.md#file-length-mechanically-enforced)).

All diagnostics are errors or off; warning debt is not a supported state. Fix code before suppressing a diagnostic. A local suppression stays narrow, references its owning issue, and explains why the rule is wrong for that site. Never weaken policy merely to make a PR green. The same holds for Rust: `clippy -D warnings` is the gate, and an `#[allow]` carries its reason.

## Runtime profiles and exclusions

The root Oxlint config owns the production TypeScript, Vitest and the Node/Bun scripts that remain.

Generated output, vendored code, build trees, immutable snapshots and negative lint fixtures may be excluded with a concrete owner in the config. Scripts, tests, and e2e code are source and remain in scope. Generated files are regenerated, never hand-edited.

## Upgrade policy

Node, Ultracite, Oxlint, Oxfmt, TypeScript, and Vitest are exact-pinned. Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) groups the coupled lint, format and test engines (`ultracite`, `oxlint`, `oxfmt`, `typescript`, `vitest`) into one PR of their own, because an engine bump can change what the gate reports. That PR records:

- versions before and after;
- rules added, removed, or semantically changed;
- whether formatter output changes;
- whether compiler semantics change;
- the full validation result.

Formatter churn is an isolated formatting-only commit. Safe lint fixes are a separate mechanical commit. Behavioural corrections are reviewed per site and never mixed into either sweep.

<a id="v1-cargo-xtask-gate-1020"></a>

## cargo xtask gate (#1020)

The repository is three languages, so its cross-cutting layer cannot live in any one of them: it is a Rust `xtask` crate, and `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the only entrypoint CI runs ([#1020](https://github.com/srikanth235/centraid/issues/1020)). [`crates/xtask/README.md`](../crates/xtask/README.md) is the reference; this section is the state of the loop. The edit-run loop around it is in [dev-environment.md](dev-environment.md#the-local-gate-loop).

**The four profiles, and `mobile-jvm`.** The four are each a superset of the one before, so a step cannot be in `pr` and missing from `release`; `mobile-jvm` stands apart and is a superset of nothing.

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test` (**the crates the change touches and their dependents**, selected by `crates/xtask/src/select.rs` and run as `cargo nextest run --workspace -E 'package(=…) \| …'` plus `cargo test --doc` where nextest is installed; the whole workspace when the change touches a workspace-wide input or no base is found, and under plain `cargo test` without nextest), `restore-drill` (the product's promise, on every loop), `rules` (the structural rules), `doc-links` (every relative markdown link and in-repo anchor resolves), `ledgers` (the down-only check) | < 120 s **warm**, < 3200 s **cold** | by hand, on the edit-run loop |
| `pr` | `buf`, `deny` (cargo-deny), `ci-policy` (every `uses:` under `.github/**` pinned to a full commit SHA, then actionlint), `secrets` (gitleaks), `osv` (the `bun.lock` advisory inventory), `release-build`, `ts-static` (`bun run check`), `emitters` (regenerates `design/`, the native theme and the kit's words and fails on drift, including a new untracked file under them), `lockfile` (**both** lockfiles: TLS-only sources, every registry package pinned by content), `call-budget` (p95 over 200 calls of one bounded read), `search-budget` (p95 per query of eleven, on five surfaces, over the year-3 search vault, in a release build), `fault-door` (ABI clause 9 against a real panic, the one place the tree is compiled with `debug-fault`) | < 1500 s | [`gate.yml`](../.github/workflows/gate.yml) on every pull request and every push to `main` |
| `nightly` | `pr` plus `device-lanes` (real attached devices) | unbounded | [`nightly.yml`](../.github/workflows/nightly.yml) at 05:30 UTC, where `device-lanes` skips loudly |
| `release` | `artifact-identity`, `prebuilt-core-required` | unbounded | [`release.yml`](../.github/workflows/release.yml)'s lanes |
| `mobile-jvm` | `mobile-jvm` — `cargo build -p centraid-core-ffi` (no `llama` feature: the JVM tests load no model), then `mobile/gradlew mobileJvm` (`:core:jvmTest` over the real cdylib), then the generated-artifact drift check | < 420 s | [`nightly.yml`](../.github/workflows/nightly.yml); on demand from `mobile/`. **Not** a superset of any other profile and not folded into `pr`: a different toolchain with a different cold cost ([D-1020-B2-3](decisions.md#governance-and-the-pr-gate)). A missing `mobile/gradlew` FAILS rather than skips |

**The on-device engine is checked outside the gate.** `gate.yml`'s `engine` job runs beside `gate`, unfiltered, with no budget of its own: `cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings`, then `cargo test` over the same packages and feature. It exists because llama.cpp is a cold `cmake` build of about five minutes that the `pr` profile's 1,500 s ceiling has no room for, so `centraid-assist-llama`'s `engine` and `centraid-core-ffi`'s `llama` features are off in the profile's `--workspace` builds and on here ([R-CHAT-10](decisions.md#the-assistant)). The profile still compiles, lints and tests the engine-free half of `centraid-assist-llama` and the ABI's `NO_ENGINE` behaviour; `cargo deny --all-features` still sees `llama-cpp-2` in the graph.

`device-lanes` runs `backup-measurement`, `android-macrobenchmark`, `ios-xctest-metrics` and `battery-per-background-pass`. No workflow runs them: they are run by hand on a machine with one iPhone and one Android attached, one lane at a time, as `CENTRAID_DEVICE_RUNNER=1 cargo xtask gate --profile nightly --lane <name>`. Without `CENTRAID_DEVICE_RUNNER` the step is a loud `SKIP`.

The budgets are **enforced, not aspirational**: a profile whose steps together overran its `budgetSeconds` fails, prints the per-step timing table, and says so on its last line as well as in its `BUDGET` line. They live in `contracts/ledgers/gate-budgets.json` alongside `compile-time.json` (clean check, incremental check, single-crate test, release build, the cold `local` profile, and `kotlinNativeLinkSeconds`, still null because no machine in CI links Kotlin/Native and a JVM number in that key is the one thing it exists to prevent), `library-size.json` (the prebuilt core's stripped size per ABI; a triple no machine has built stays null), `call-budget.json`, `search-budget.json` and `query-plans.json`. The size and time ledgers are down-only, checked against `git show <merge-base>:<path>`, and written only by `cargo xtask measure --write`, which only ever lowers a ceiling. There is no waiver, deviation or override path, and the one time these numbers rose — the 2026-09-12 re-base for the Rust workspace — it was an owner ruling ([D-1020-B2](decisions.md#governance-and-the-pr-gate)), recorded per key with its measurement and multiplier.

**`local`'s `test` step is narrowed; `pr`'s is not** (hand-off 6.5). The whole-workspace run was almost all of a loop that took 290 to 500 s against a 120 s budget, and the owner ruled that the loop tests the crates a change touches plus their reverse dependents while `pr` keeps the workspace. The rule, its fallbacks and what it deliberately does not do are the module doc of [`crates/xtask/src/select.rs`](../crates/xtask/src/select.rs); `cargo xtask test-plan` prints the selection for the current change. The budget in `gate-budgets.json` did not move.

**`local` is scored on the tree the edit-run loop runs on: a warm one** ([D-1020-B2-1](decisions.md#governance-and-the-pr-gate)). The 120 s promise is the developer's feedback time after an edit, not the first build after a clone, and on the measuring container the two differ by fifty times: 41.6 s warm against 1562.4 s cold at ten crates. `cargo xtask gate` tells them apart by asking whether **every** workspace member has a _linked_ artifact in `target/debug/deps` — an `.rmeta` from a previous `cargo check` does not count, so a checked-only tree cannot buy a warm budget — prints `tree warm`/`tree cold` with the reason, and charges a cold `local` run against `coldLocalProfileSeconds` instead. A cold run for which that key states no ceiling **fails**: cold is never the answer that makes a slow gate green. `--cold` forces the cold branch without deleting `target/`. Only `local` has a cold ceiling; every other profile runs in CI on a runner that has never seen the workspace, so its budget has to hold cold or it is not a budget — which is why `pr`'s number is the cold measurement (1420.1 s; the warm run is 575.8 s and a Cargo-cache hit is CI's normal case).

Every step prints one line whatever it does — `ok`, a loud `SKIP` naming the command that turns it into a real run, or `FAIL` — and output is buffered and printed only on failure. **A failing step writes its whole output under `target/xtask/<profile>/<step>/`** (`command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the internal steps) and names the directory in its line; `gate.yml` and `nightly.yml` upload `target/xtask/**` on failure. A step whose tool is missing (`buf`, `cargo-deny`, `actionlint`, `gitleaks`, `osv-scanner`) is a `SKIP` locally and a `FAIL` under `CI`, where the workflow installs it.

**The `secrets` step scans the repository, not its build output** ([D-1020-B2-5](decisions.md#governance-and-the-pr-gate)). `gitleaks detect --no-git` is what gives the step its working-tree coverage, and it also walks `target/`, where a built Rust workspace carries PEM headers in `pem-rfc7468`/`pkcs8` doc strings inside `.rmeta` files. gitleaks 8.30 has no `--exclude-path` and no `.gitignore` support, so the step keeps ONE unfiltered scan and classifies its JSON report afterwards: a finding is dropped only where `git check-ignore` matches the file and `git ls-files` does not track it. Both counts are printed, `.gitleaks.toml` is untouched, and a tracked file is never dropped.

**No step is a placeholder.** `restore-drill`, in every profile, backs a vault up to a store, destroys the vault, its spool and its ledger, restores it, and proves the census, the `db_hash` and every row equal the lost vault's before it claims the next writer epoch and proves the old writer refused ([#1080](https://github.com/srikanth235/centraid/issues/1080)). There is no container smoke: a gateway's end-to-end is its own conformance suite, run over the wire against a real server on a loopback port, and the drill. `crates/xtask/src/gate.rs`'s `no_step_in_the_release_profile_is_a_stub` test is what keeps a stub from coming back under a new name. A **real VPS** run is an owner hand-off; the commands and the expected transcript are in [release.md](release.md).

**Two optimised profiles (D-1020-G8).** `release` is what a pull request builds and what `release-build` scores; `dist` is `release` plus thin LTO and `codegen-units = 1` and is what a tag publishes (`lane-prebuilt-core.yml`, `deploy/docker/Dockerfile`). Measured cold: LTO inside `release` put `cargo build --workspace --release` at 1039 s and the debuginfo settings at 747 s, against 379 s for the profile as it stands. The split rests on not spending 70 % of the 1500 s `pr` budget on inlining only the published artifact consumes. The cost is stated too: the binary a pull request builds is not bit-identical to the one a tag ships, so the `dist` artifact is proved by the prebuilt-core lane, which stamps it and reads the stamp back out of the binary.

**The edit-run loop carries line tables, not full DWARF (D-1020-G7).** `[profile.dev]` and `[profile.test]` are `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and dependencies carry `debug = false` beside their `opt-level = 2`. A backtrace still names the file and the line, which is what a red test is read with; what is gone is the type and variable tables for tokio, rustls and SQLite. Measured: a shared `target/` held 16 GB under `debug/`, of which 7.7 GB was 144 test and bin executables; under this profile the same set is 0.50 GB over 39 executables. **A developer who needs full debuginfo for one session sets `CARGO_PROFILE_DEV_DEBUG=2`** for that one command; it is written in [`crates/xtask/README.md`](../crates/xtask/README.md) too. `[profile.release]` takes the same `debug = "line-tables-only"` with `split-debuginfo = "packed"`, so the published symbol file is one file per platform (`centraid.dwp`, `centraid.dSYM`, the `.pdb`) rather than debuginfo welded into the shipped binary.

**OWNER HAND-OFF — the required checks.** `gate`, `engine`, `native-python`, `dependency-review` and `pr-title` — the jobs in `gate.yml` that run on every pull request, none path-filtered, so all always report — must be the required checks on `main`. A required check that never reports blocks a pull request forever. Branch protection is configured outside this repository, like the code-owner review requirement ([v1-handoffs.md](release/v1-handoffs.md)).
