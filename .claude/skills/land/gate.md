# The gate

`cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate. `bun run check` covers TypeScript and is the `ts-static` step of `pr` and above. Run the profile that matches the change before calling it done. CI is in [ci](ci.md) and how tests are written is in [tests](tests.md).

## The profiles

`local`, `pr`, `nightly` and `release` are built by concatenation, so each holds every step of the one before. The step lists are in `crates/xtask/src/gate.rs`.

- **`local`**, the edit-run loop: `fmt`, `clippy`, `test`, `restore-drill`, `rules`, `doc-links`, `ledgers`.
  - `test` runs only the crates the change touches and their dependents, as a nextest filter over `--workspace`. It prints `NARROWED to N of M crates`. A change that selects no crate is a loud `SKIP`, not a pass.
  - `cargo xtask test-plan` shows the selection. `CENTRAID_GATE_TESTS=all` widens it and `CENTRAID_GATE_BASE` names another base. Without nextest the whole workspace runs.
  - `restore-drill` runs every `restore_drill` integration test by name, so the narrowed `test` leaves those binaries out.
- **`pr`** adds `buf`, `deny`, `ci-policy`, `release-build`, `ts-static`, `design`, `lockfile`, `prompt-injection`, `model-record` and `fault-door`. Its `test` runs the whole workspace plus doctests. CI runs this profile.
- **`nightly`** adds `device-lanes`. They need a runner with devices (`CENTRAID_DEVICE_RUNNER=1`) and are a loud `SKIP` elsewhere.
- **`release`** adds `artifact-identity` and `prebuilt-core-required`.
- **`mobile-jvm`** is one step and is not a superset of anything: it builds `centraid-core-ffi`, runs `./gradlew mobileJvm`, then the `design` drift check. It does not compile Compose or touch a device; see [mobile](mobile.md).
- `--lane <name>` runs one step, one device lane, or (on `pr`) one CI lane: `static`, `tests`, `build`, `ts`. The CI lanes are `PR_LANES` in `gate.rs`; together they are exactly the `pr` steps, and a test enforces it. A name that matches nothing is an error. With no `--lane`, `pr` runs every step as before.

## Reading the output

- Every step prints exactly one line: `ok`, `SKIP` or `FAIL`. A `SKIP` names the command that turns it into a real run.
- Every step runs even when an earlier one failed, so one pass shows everything wrong. The last line is `gate <profile>: PASS` or `FAIL` with the failed step names.
- A missing external tool (`cargo-deny`, `buf`, `actionlint`) is a `SKIP` locally and a `FAIL` when `CI` is set.
- A failed step leaves its evidence in `target/xtask/<profile>/<step>/`: `command.txt`, `stdout.log` and `stderr.log`, or `findings.txt` for the internal steps. The one line names the directory.
- The seconds column is information. No step fails for taking long.

## `cargo xtask rules`

It runs the structural rules alone (the `rules` step). Each rule prints one line:

- `ok <rule> — N file(s) scanned, clean`;
- `FAIL <rule> — N finding(s) in M file(s) scanned`, then one indented line per finding, with the file and what to do;
- `PENDING <rule> — <reason>` when the rule's subject is not in the tree yet. It is not a pass.

Lines printed under an `ok` rule are known debt (the `promises` register lists what an app owes), not findings. The rules are file walks, not parse trees. `crates/xtask` is exempt from the two source-scanning rules because it holds their patterns. `crates/xtask/README.md` has the table of rules. When a rule is red, fix the code it names. Do not add a register row to dodge it.

## Counts, not seconds

- No gate step and no test asserts on a duration. The wall-clock budgets were removed by the owner's ruling of 2026-11-04 because they flaked on loaded machines.
- Bound work by construction (keyset pages, `LIMIT`s) and assert on counts: statements, calls, rows. A year-three test may print a timing, never assert on it.
- A `timeout-minutes` on a CI job is a hang backstop, not a budget.

## The budgets that remain

All of them are counts or sizes, and all only fall.

- **Copy ratchet**, `scripts/lint-copy.mjs`. Banned words, `·` joins and word-count caps in the Rust string catalogue (and the assistant's `copy/chat.json` strings), as a per-rule per-file count.
- **Native-controls ratchet**, `scripts/lint-native-controls.mjs`. Platform controls used outside the kit in the iOS and Android sources, counted the same way.
- Both run in `bun run lint:product`. A file over its count fails. A file under its count also fails, so the count must be lowered in the same change. `--print` emits the measured counts.
- **`contracts/ledgers/library-size.json`**: the prebuilt core's stripped size per ABI. A `null` gates nothing.
- **`contracts/ledgers/query-plans.json`**: the statements allowed to scan a big table or sort a paged read. `crates/core/tests/query_plans.rs` reads it.
- The `ledgers` step compares each ledger with its copy at the merge base. A risen number is a finding, and so is a removed one. A gate run never writes a ledger.
- **The backup spool's byte budget**, in `crates/vault/src/backup/spool.rs`: 2 GiB or a tenth of the free space, whichever is smaller. It is code, and tests assert on its bytes.

## Fix the code, not the check

Do not loosen a lint, test, budget or allowlist to get green. A number goes up only when the owner agrees. The ledgers have no waiver path, and adding one is not how a number moves.
