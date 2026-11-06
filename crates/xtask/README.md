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
cargo xtask doc-links                # every relative markdown link and in-repo anchor resolves
cargo xtask test-plan                # which crates `local`'s `test` step would run, and why (--reads: the table it trusts)
cargo xtask repo-root                # which tree the path-based rules will scan
cargo xtask artifact-key --triple <t>  # the prebuilt core's cache key
```

## The tree a run scans is **the current directory's**

Every path-based rule — `sql-confinement`, `no-listening-socket`, `abi-five-symbols`, `ts-static`, `commonmain-no-platform-import` — reads files under one root, and that root is resolved when the binary RUNS: `git rev-parse --show-toplevel` from the current directory, then a walk up for the `rust-toolchain.toml` + `Cargo.toml` pair only the root carries, then the compile-time manifest path with a warning on stderr.

A root baked in at compile time (`env!("CARGO_MANIFEST_DIR")`) would be wrong under a shared `CARGO_TARGET_DIR`: the cached binary belongs to whichever worktree built it last, the gate scans **that** worktree, and the failure direction is _reports clean_ ([#1020](https://github.com/srikanth235/centraid/issues/1020)). `cargo xtask repo-root` prints the answer in one line, and `crates/xtask/tests/repo_root.rs` runs the compiled binary from a second checkout and asserts it reports that checkout.

## The profiles

Each of `local`, `pr`, `nightly` and `release` is a **superset** of the one before, stated in code as concatenation rather than as a copied list, so a step can never be in `pr` and missing from `release` (there is a test for exactly that).

| Profile | Steps it adds | Where it runs |
| --- | --- | --- |
| `local` | `fmt`, `clippy`, `test` (**only the crates the change touches, and their dependents** — see below), `restore-drill`, `rules`, `doc-links`, `ledgers` | by hand, before a push |
| `pr` | `buf`, `deny`, `ci-policy`, `release-build`, `ts-static`, `design`, `lockfile`, `fault-door` — and its `test` step runs the **whole** workspace | `.github/workflows/gate.yml`, every PR and every push to `main` |
| `nightly` | `device-lanes` | `.github/workflows/nightly.yml`, 05:30 UTC |
| `release` | `artifact-identity`, `prebuilt-core-required` (and `restore-drill`, inherited from `local`) | the release workflows |
| `mobile-jvm` | `mobile-jvm` — one step, not a superset of anything | `.github/workflows/nightly.yml`; on demand from `mobile/` |

**`local`'s `test` step runs the crates the change touches, and the crates that depend on them; every other profile runs the whole workspace** (hand-off 6.5, the owner's ruling of 2026-10-15). The loop took 290 to 500 s and `cargo nextest run --workspace` was nearly all of it, so the step now asks [`src/select.rs`](src/select.rs) which crates a change can affect:

- **The changed files** are those that differ from the merge base with `origin/main` (then `main`): committed, staged, unstaged and untracked. `CENTRAID_GATE_BASE=<commit or tree>` names a different base (a commit is compared at its merge base with `HEAD`; a tree is taken exactly, and an untracked file identical to the tree's copy is not a change).
- **A path inside a crate** selects that crate. **A path some crate reads from outside its own directory** selects the crates whose sources name it — `contracts/`, `copy/`, `design/`, `experiments/`, the one Swift file the assistant embeds. That table is _derived_ by scanning every crate's string literals (comments skipped, since doc comments name paths freely), never listed, and `cargo xtask test-plan --reads` prints it. It over-approximates on purpose: a missed read skips a test, an extra one costs seconds.
- **Every selected crate pulls in its dependents**, through Cargo (every dependency kind, so a dev-dependency counts) and through a source that `include_str!`s another crate's file.
- **A documentation edit selects nothing**: no crate reads `docs/`, `scripts/` or the workflows, and the step says `NARROWED to 0` and is a loud `SKIP` rather than a pass.
- **The whole workspace runs** when a changed path is the root `Cargo.toml` or `Cargo.lock`, the toolchain pin, `.cargo/`, `.config/`, **any** crate manifest (a manifest can move a feature on a crate that does not depend on it, because one `--workspace` build unifies features), `crates/xtask`'s code (the runner decides this selection; its README does not), or when no base can be found — narrowing against nothing would be a guess.

The step says so in three places: a banner before its line naming every crate and why it is in, a `NARROWED to N of M crates (…)` prefix on the line itself (which is the `evidence.json` row), and `target/xtask/local/test/selection.txt`. `CENTRAID_GATE_TESTS=all` widens a local run to the whole workspace.

**The narrowing is a nextest filter over `--workspace`, not `-p`.** `cargo nextest run --workspace -E 'package(=a) | package(=b)'` builds the same units `clippy` and `restore-drill` build; `-p a -p b` resolves features for those packages alone, which is a different feature set, and alternating the two is the 162 to 186 s each way measured in [Why `--workspace --test` and not `-p`](#why---workspace---test-and-not--p). So the saving is in what runs, not in what compiles, and without `cargo-nextest` the step runs the whole workspace and says why.

**The drills run once per loop.** `restore_drill` is an ordinary integration test of `centraid-vault` and `centraid`, so a narrowed selection that reaches either would run both drills in `test` and again in the `restore-drill` step that follows (about a minute and a half of CPU each time). A narrowed `test` therefore filters the `restore_drill` binaries out and says so in its line, and `restore-drill` still runs both by name in the same gate run, so the promise is proved on every loop as before. `--lane test` keeps them, and `pr` and the whole-workspace fallback are unchanged.

**What narrowing does not prove.** A change to a crate runs that crate's tests and its dependents', not the other crates'. A read the derivation did not see — a path assembled at run time from pieces no literal names — is caught only by `pr`, which CI runs over every crate on every pull request.

**No profile fails for taking long** (owner ruling 2026-11-04). The wall-clock budgets that used to be enforced here — a per-profile ceiling in `gate-budgets.json`, the warm/cold `local` scoring against `coldLocalProfileSeconds`, the compile-time ceilings (`releaseBuildSeconds` and the rest of `compile-time.json`), the `call-budget` and `search-budget` p95 steps and `cargo xtask measure` — are removed: they flaked on a shared or loaded machine (a `search-budget` p95, a `write_costs` call ceiling and the `pr` profile's 1500 s all failed in one afternoon while several gates ran at once) and blocked unrelated changes. `cargo xtask gate` still prints each step's seconds and a total, as information. What stays is a hang backstop, not a budget: each CI job's `timeout-minutes`. Work that must stay bounded is bounded by construction (keyset pages, `LIMIT`s) and by tests that **count** work — statements, calls, rows — never seconds.

`mobile-jvm` is the Kotlin half, and it is **not** a superset of anything. Its one step builds `centraid-core-ffi` (without the `llama` feature: no Kotlin spec loads a model, and llama.cpp's cold build is too slow for this profile), runs `./gradlew -p mobile mobileJvm` (`:core:jvmTest` — a real ABI round trip against the real cdylib), then regenerates the committed native design tables and fails on drift. It is kept out of `pr` because Kotlin/Gradle is a different toolchain with a different cold cost (D-1020-B2-3).

**A missing mobile tree FAILS, it does not skip.** What the step does not do, it says rather than passing over: it does not compile Compose, does not link Kotlin/Native, does not run a simulator and does not touch a device. Those are `nightly`'s `device-lanes` — four lanes (`backup-measurement`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass`) that run only on a machine with one iPhone and one Android attached and `CENTRAID_DEVICE_RUNNER=1` set (`cargo xtask gate --profile nightly --lane <name>`), and are a loud `Skipped` otherwise — and the hand-off table in [`mobile/README.md`](../../mobile/README.md).

`restore-drill` runs `cargo test --workspace --test restore_drill` — `centraid-vault`'s drill of the snapshot plane against the in-memory store, and `centraid`'s drill of the phone's core against the real gateway harness: back up a real library, lose the phone, restore from the 24 words at writer epoch 2, compare every row, and see the old phone refused `VAULT_MOVED` ([#1080](https://github.com/srikanth235/centraid/issues/1080)). It is a `local` step, so every profile carries it.

### The `fault-door` step

The one step that compiles the tree with a feature on: `cargo test --workspace --features centraid-core-ffi/debug-fault --test contract a_real_panic_inside_call_poisons_the_handle_through_the_abi`. It is `--workspace` rather than `-p centraid-core-ffi` for the reason in the last paragraph of this file: under the workspace's feature resolution the feature rebuilds four units (`centraid-core`, `centraid-core-ffi`, their build scripts, the `contract` binary), where `-p` re-resolved the graph and rebuilt 164. `restore-drill` names its target across `--workspace` for the same reason. `debug-fault` makes an `act` on `debug`/`panic` panic inside `Handle::call`, which is how clause 9 of the C ABI gets proved against the real library rather than against a shell's fake. It exports no symbol (`abi-five-symbols` still counts five) and is off in every other step and every release profile; a default build answers that act as one on an unknown app, and `the_fault_door_is_absent_from_a_default_build` asserts that. Its first run found `centraid_next_event` answering `TIMEOUT` on a poisoned handle instead of `PANICKED`.

## What every step prints

Three verdicts, no fourth:

```
  ok    clippy              3.1s  cargo clippy --workspace --all-targets -- -D warnings
  SKIP  deny                0.0s  cargo-deny is not on PATH — … `cargo install cargo-deny --locked`
  FAIL  test                1.4s  `cargo test --workspace` exited 101 — … · artifact: target/xtask/pr/test
```

Output is buffered and printed only on failure; **every step prints one line whatever it does**, because a silent gate is not a gate. Every step runs even when an earlier one failed, so one pass tells you everything that is wrong.

### Failure artifacts

A failing step writes its whole output under `target/xtask/<profile>/<step>/` — `command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the two internal steps — and the step's one line names the directory. `gate.yml` and `nightly.yml` upload `target/xtask/**` on failure.

### The `deny` step's posture

`cargo-deny` is a separate binary. When it is absent the step **loud-skips with the install command locally** and **fails in CI**, where the workflow installs it and a missing binary is therefore an infrastructure failure. The contract exists because a guarded skip that could be mistaken for a pass is worse than no lane at all. The policy is the repo's one shared [`deny.toml`](../../deny.toml); there is no per-crate copy to drift.

`cargo nextest` gets the same treatment in the other direction: `test` uses `cargo nextest run --workspace` (with the filter above on `local`) when the binary is on PATH and `cargo test --workspace` when it is not, and the step's line says which one ran. nextest never runs doctests, so its branch is followed by `cargo test --workspace --doc` over the libraries it just built: the two branches run the same tests, and a doctest written tomorrow is not silently skipped because the runner changed. `gate.yml` installs a pinned, checksum-verified nextest release binary, because it runs the ~150 test binaries concurrently rather than back to back — the one part of the `test` step that is not compilation ([#1047](https://github.com/srikanth235/centraid/issues/1047)).

### The `ci-policy` and `lockfile` steps

Standing checks over `.github/**` and the lockfiles, run on every pull request.

| Step | What it runs | Verdict today |
| --- | --- | --- |
| `ci-policy` | every third-party `uses:` under `.github/` pinned to a 40-hex commit SHA (`ci::action_pins`), then `actionlint` | green, under a second |
| `lockfile` | `bun.lock`: no `http:` package URL, integrity markers present; `Cargo.lock`: every registry `[[package]]` pinned by `checksum` and sourced over TLS (`ci::lockfile`) | green |

**Inherited red is named, never hidden** (D-1020-B1): a step whose target is red today stays on the gate and red, rather than leaving it.

`engine` is its own job in `gate.yml` for the opposite reason: it is a command over the tree, but a cold llama.cpp build (about five minutes) is too slow for the `pr` profile, so `centraid-core-ffi`'s `llama` feature is off in every step above and the job checks the engine with it on: `cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings` and `cargo test` over the same. The `mobile-jvm` step builds the cdylib without the feature too.

`dependency-review` is its own job in `gate.yml`: it is a GitHub Action reading the PR's dependency diff through the API rather than a command over the tree, so it cannot be a step of `cargo xtask gate`.

### The `doc-links` step

Every relative link and in-repo anchor in the repository's markdown resolves — the statute for "broken internal links are bugs" (Q-1005-1). It is a `local` step, so every profile carries it, and it costs about a third of a second: no network, so `http:`, `https:`, `mailto:` and every other scheme are skipped. It checks inline links and images, reference definitions, and `href`/`src` in embedded HTML, outside fenced code, inline code and HTML comments; the file part must be a file or directory **git knows about** (a file git ignores resolves here and 404s everywhere else, and a case difference resolves on macOS and breaks on Linux), and a `#fragment` into a markdown file must be a heading's GitHub slug or an explicit `id`/`name`. Line anchors (`#L10`) and fragments into other file types are skipped.

What it does not read is only the append-only record, where a finding could never be fixed. Links _into_ a frozen section are still checked, and the step's line names every skip. There is no allowlist of findings and no narration tripwire: "history is cited, never narrated" is a judgement a scanner cannot make, and one that tried would teach authors to phrase around it. The rule is the module doc of [`src/doc_links.rs`](src/doc_links.rs); `cargo xtask doc-links` runs it alone.

### The `ts-static` step

`bun run check`: `oxfmt --check` and `oxlint` over the tree, then `tsc` and vitest in each workspace under `packages/`, then the release scripts' tests. The pre-commit hook runs the format and lint halves over the staged files.

## Required checks

Branch protection's required checks are **`gate`**, **`engine`**, **`dependency-review`** and **`pr-title`**, the jobs in [`gate.yml`](../../.github/workflows/gate.yml). Branch protection is configured outside the repository, the same way the code-owner review requirement is; a required check that never reports blocks every pull request, which is the failure #557 was written about, so renaming any of them is an owner change to branch protection in the same breath. (`native-python`, the trainer's CPU suite, was removed from this list when the Python data tooling was retired, #1171; the suite now runs from `.github/workflows/trainer.yml`, not on pull requests.)

## `cargo xtask artifact-key` (#1020, D-1020-G2)

The prebuilt core's cache key. `--triple` is required; `--features`, `--profile` and `--explain` are optional. The exact rule — what is in the key, what is deliberately not, and both halves of the `Cargo.lock` case — is the module doc of [`src/artifact.rs`](src/artifact.rs).

## Debuginfo, and the one-command escape hatch (#1020, D-1020-G7)

`[profile.dev]` and `[profile.test]` carry `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and dependencies carry `debug = false`. A backtrace still names the file and the line. The measurement that decided it is in the root `Cargo.toml`'s comment: 7.7 GB of test executables became 0.50 GB, and the biggest single one went from 387 MB to 43 MB.

**When you need the full type and variable tables for one debugging session:**

```bash
CARGO_PROFILE_DEV_DEBUG=2 cargo test -p centraid-vault
```

One command, one crate, nothing committed. Do not put it in a script — a profile change that is always on is the profile, and this one was measured out on purpose.

## The structural rules

Four of them, one per invariant in the issue's _Execution plan → Invariants_, and the native shells' rules beside them ([`src/native_rules.rs`](src/native_rules.rs), [#1135](https://github.com/srikanth235/centraid/issues/1135)), which hold over the SwiftUI and Compose sources what no machine here compiles. They are **file walks and hand-rolled scanners, not parse trees**: the issue rules that tree-sitter owns structural rules, and it is not here yet because every rule is answerable from string literals, attribute lines and import lines, and a parser would cost the `local` budget more than the precision is worth today. The commit that adds tree-sitter is the one where a rule needs to know what an expression _means_.

| Rule | What it asserts |
| --- | --- |
| `sql-confinement` | a SQL keyword in a string literal appears only under `crates/{ontology,vault,search}` and `crates/apps/kit` |
| `abi-five-symbols` | `crates/core-ffi` exports exactly five `extern "C"` symbols |
| `no-listening-socket` | no listener (`TcpListener::bind`, an offered ALPN, an `accept`) outside the one allowlisted gateway file |
| `commonmain-no-platform-import` | no `android.`/`java.`/`platform.`/`kotlinx.cinterop` import under `mobile/core/src/commonMain` |
| `no-kmp-shared` | no `mobile/shared`, no `:shared` Gradle module or task, no `import CentraidShared`, no `dev.centraid.shared`, no `CentraidShared` framework in a build, workflow or script |
| `no-command-request` | no `command.proto`, no import of it and no `Command` arm in `Request.kind`: a write is a screen's `act` |
| `native-accessibility` | every Compose `Icon`/`Image` carries a `contentDescription`, a `null` one says `// decorative`, and every SwiftUI `Image(systemName:)` has an `accessibilityLabel` or `accessibilityHidden(true)` |
| `no-tasks-namespace` | no `tasks` directory, app id or `tasks.` prefix in a shell's production sources, and no `copy/tasks.json` |
| `native-spells-no-screen-id` | no shell source spells a screen id a Rust `Registry::with` registers |
| `native-names-no-command` | no shell or JVM-binding production source names a command of `contracts/schema/vault-commands.txt` |
| `screens-per-app-layout` | under `crates/screens/src`, an app's screens name no other app's module and the kit names no app |
| `healthkit-read-only` | every HealthKit authorization shares nothing, nothing saves or deletes a HealthKit object, the entitlement's access list is empty, no write reason is declared, and the reader's kinds are `health/kinds.rs`'s |
| `health-connect-read-only` | the manifest asks only `READ_*`, the reader asks only what it declares, nothing writes, the permission sheet is built in the reader and launched only from `ScreenEffects.kt`, and every exercise type the kind table maps is named |
| `walker-platform-law` | the camera-roll performer never copies a library original (only a hand-off the member asked for — Share, Download, Edit — does, through `exportOriginal` / `copyLibraryOriginal`), forces iCloud on, reads a deletion as news, reads `OffsetTime` or sizes from `available()`; once a shell performs `RollPage`, it makes the platform calls the walk needs |
| `first-launch-asks-nothing` | the first-launch view types no app-id list and asks the phone for no permission |
| `native-shell-parity` ([`src/native_parity.rs`](src/native_parity.rs), [#1152](https://github.com/srikanth235/centraid/issues/1152)) | every field of the `*_screens.proto` and `screens.proto` messages (oneof arms in, enum values out) is read by both the Compose and the SwiftUI shell, or is a row of the register ([`src/native_parity_register.rs`](src/native_parity_register.rs)) as `Platform` (the other platform has no such thing, with why), `Gap` (a lane owes the read; lane `F` is read by neither and waits for the owner to expose or delete it), `RustOnly` (Rust writes it and reads it back, or hands it from one screen or service to another) or `Runtime` (the runtime originates or consumes it); an unregistered one-sided or unread field, a row whose gap has closed, a `RustOnly` or `Runtime` row whose field a shell now spells, a row whose observed side disagrees and a row naming no field all fail. The match is by field name, not by message, comments cut |

A rule whose subject directory is absent prints `PENDING` with the reason rather than passing silently.

**`crates/xtask` is exempt from the two source-scanning rules** because it holds their patterns: the SQL keyword table and the listener patterns are string literals in this crate, so scanning the runner with its own rules would report the rules themselves. It is one named directory, it ships in no artifact, and it opens no socket. Every rule has a unit test with a fixture that **must** be caught — a rule with no demonstrated red is a claim, not a gate.

## The ledgers

Two files under [`contracts/ledgers/`](../../contracts/ledgers), both down-only, both checked by the `ledgers` step in every profile:

| Ledger | Holds |
| --- | --- |
| `library-size.json` | the prebuilt core's stripped size per ABI. A `null` gates nothing and says so; `x86_64-unknown-linux-gnu` carries the first measured artifact |
| `query-plans.json` | the query-plan allowlist `crates/core/tests/query_plans.rs` reads: the statements allowed to scan a big table or sort a paged read, each with its home and reason, and the scan floor |

No ledger holds a wall-clock number. `gate-budgets.json`, `compile-time.json`, `call-budget.json` and `search-budget.json` were removed by the owner's ruling of 2026-11-04 (see [The profiles](#the-profiles)).

The base copy is read with `git show <merge-base>:<path>`, and "the base has no such file" means the entry is new and passes — without that fallback the very commit that introduces a ledger could not pass its own gate. A number that rose is a finding, and so is a number that was **removed**, because deleting a ceiling is the widest possible widen.

**There is no waiver, deviation or override path here, and adding one is not how a number moves**: a waiver added before the first widen is asked for is an invitation. `ledger.rs`'s `a_risen_number_is_a_finding` fails a raise against an existing base copy.

**A gate run never writes a ledger.** A ratchet that records whatever the last run cost is a log.

## Why `--workspace --test` and not `-p`

Alternating `cargo test -p <one crate>` with `cargo test --workspace` costs minutes each way (185.8 s and 161.7 s were measured against 2.4 s for either command repeated), because one package's feature resolution is not the workspace's union, so the two commands invalidate each other's artifacts. That is why `restore-drill` and `fault-door` name their targets across `--workspace`, and why `local`'s narrowing is a nextest filter and not `-p`.
