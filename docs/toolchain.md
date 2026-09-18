# Toolchain contract

This is the durable command and ownership contract for quality work. Rust, Kotlin and TypeScript are gated by one entrypoint, `cargo xtask gate` ([below](#cargo-xtask-gate-1020)); the TypeScript that remains — `packages/design`, `packages/test-kit`, `desktop/`, `extension/` and the repo tooling scripts — additionally has the Bun-script contract in the first half of this page. Its executable sources of truth are the root `package.json`, `oxlint.config.ts`, and `oxfmt.config.ts`; this document explains the policy without duplicating their rule catalog.

## Toolchain pins

| Toolchain | Pin | Read by |
| --- | --- | --- |
| Rust | `rust-toolchain.toml` (`channel`) | rustup, the gate workflows (which read the channel out of it), and [`flake.nix`](../flake.nix)'s `devShells.default` through `rust-overlay` |
| Gradle, Kotlin, AGP, Wire and the Kotlin test stack | `mobile/gradle/libs.versions.toml`, plus the committed `mobile/gradlew` wrapper with `distributionSha256Sum` | Gradle; `org.gradle.warning.mode=fail` makes a deprecation a red ([mobile/README.md](../mobile/README.md#the-toolchain)) |
| Xcode | `.xcode-version` | the iOS hand-off; nix cannot install Xcode |
| Node | `.node-version` and `package.json#engines.node` | `.github/actions/setup`; `bun run lint:node-version` fails if the two drift |
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
| Task graph execution | pinned Turbo |
| Dead code and dependency hygiene | Knip |
| Runtime behaviour | Vitest and the Playwright suites under `desktop/e2e` and `extension/e2e` |
| DESIGN.md spec conformance | `@google/design.md` (pinned exact) — see `lint:design-md` |
| Second-opinion security / reliability (PR check) | SonarCloud Autoscan — see [SonarCloud Autoscan](#sonarcloud-autoscan) |

Ultracite seeds `core`, `react`, and `vitest` policy. It is not the routine command runner. `toolchain:doctor` is its non-mutating drift check. Optional GitHub, Sonar, and react-doctor JavaScript-plugin presets remain declined as bundles; a future issue may admit one rule at a time through the rubric below.

`@google/design.md` owns _format_ conformance of the root `DESIGN.md` only; it has no view on whether the values are Centraid's real tokens. That truth check is `packages/design/src/design-md.test.ts`, which compares the front matter against `packages/design/src`.

Oxfmt is the sole style owner. Oxlint rules that only restate formatting are off. The pinned TypeScript compiler is the sole owner of compiler diagnostics; Oxlint `--type-check` is not part of any command.

**There is a second linter, and it lints no product source.** ESLint is installed under [`.governance/law/`](../.governance/law/README.md) with its own private, exact-pinned `package.json`, and it is scoped to the governance documents — the generated arrival record and the markdown the constitution governs (`receipts/*.md`, `CONSTITUTION.md`, `docs/decisions.md`, `CHANGELOG.md`). **`bun run lint` never invokes it and it never sees a `.ts` file**; oxlint remains the sole owner of the product's lint policy, and oxlint's own `ignorePatterns` excludes `.governance/**` in the other direction. It exists because a governance directive written as a lint rule gets a rule catalog, severities, per-line suppression with a reason, a machine-readable report and `RuleTester` for free — machinery that would otherwise be hand-rolled in bash. It is reached through `bash .governance/run.sh` (the `law` directive) or `bun run governance:law`, and it carries its own install because the managed `governance.yml` runs no `bun install`.

## TypeScript: stable command API

All callers use repository-pinned binaries through these Bun scripts:

| Command | Contract |
| --- | --- |
| `format` | write Oxfmt output with the root config |
| `format:check` | check Oxfmt output without mutation |
| `lint` | ordinary Oxlint pass, warnings denied |
| `lint:fix` | Oxlint safe fixes only |
| `lint:types` | compiler-compatible type-aware allowlist plus policy fixtures |
| `typecheck` | pinned TypeScript compiler across the workspaces |
| `test:affected` | Vitest for workspaces changed from `origin/main` |
| `check:fast` | format check, ordinary lint, and affected typecheck |
| `check:push:static` | the branch push tier: `format:check`, `lint`, `turbo:lint`, `typecheck:affected`. Also the gate's `ts-static` step |
| `check:push` | the `main` push tier: the gate list in `package.json`, run concurrently, with the static tier gate-stamped |
| `check:pr` | frozen install, `check:push`, full `typecheck`, `lint:types`, `lint:workflow-pins`, diff coverage |
| `lint:design-md` | official DESIGN.md linter over the root `DESIGN.md`: schema, `{token.refs}`, WCAG pairs, canonical section order. Errors fail; warnings are advisory |
| `toolchain:doctor` | non-mutating Ultracite/config drift diagnosis |
| `governance` | the stamped entry point to `.governance/run.sh`, which is itself digest-locked |
| `governance:law` | the law's ESLint pass over the arrival record and the governance documents a change touched |
| `governance:law:test` | the law's rule and generator tests, under `node --test` |

The workspaces with their own `build`, `test` and `typecheck` scripts are `packages/*`, `desktop/electron` and `extension`; run one with `bun run --cwd <dir> <script>`.

### Where the caches live

Nothing a gate or a build caches belongs in the repository. Both directories default under the user's cache home and are overridable by environment, so a container, a CI runner and a laptop can each put them where they belong:

| What | Default | Override | Owner |
| --- | --- | --- | --- |
| Gate stamps (`static`, `governance`) | `${XDG_CACHE_HOME:-~/.cache}/centraid/gate-stamps` | `CENTRAID_GATE_STAMP_DIR`; `CENTRAID_GATE_STAMPS=0` disables stamping | `scripts/ci/gate-stamp.mjs` |
| Turbo filesystem cache, shared by every worktree | `${XDG_CACHE_HOME:-~/.cache}/centraid/turbo` | `TURBO_CACHE_DIR`, then `CENTRAID_TURBO_CACHE_DIR` | `scripts/ci/turbo.mjs` |

Turbo's per-run summaries stay in each checkout's `.turbo/runs`. How the tiers and stamps are used: [dev-environment.md](dev-environment.md#the-local-gate-loop).

## SonarCloud Autoscan

SonarCloud is the second-opinion security and reliability check for product code. It runs Automatic Analysis (Autoscan) on GitHub push/PR through project `srikanth235_centraid`; no CI scanner is used. The PR gate is Sonar way because the Free plan cannot assign a custom gate. Sonar does not use `sonar-project.properties` for scope.

### Ownership and scope

Sonar complements, rather than replaces, Oxfmt, Oxlint, TypeScript, Knip, Vitest, clippy, cargo-deny, Gitleaks, OSV, actionlint, and CodeQL. Do not weaken local policy to satisfy a Sonar style finding.

The analysis-scope exclusions, the duplication-metric exclusions and the coverage exclusions are the `SOURCE_EXCLUSIONS`, `CPD_EXCLUSIONS` and `COVERAGE_EXCLUSIONS` lists in [`scripts/ci/configure-sonarcloud.mjs`](../scripts/ci/configure-sonarcloud.mjs). Scripts, workflows, tests, fixtures, docs, receipts and generated output stay out of product scope. The duplication metric excludes `packages/design/src/roles.ts` because its repeated profile-lowering record shape keeps each role's meaning, contrast obligation, and totality reviewable inline.

### Noise policy

The `NOISE_RULES` list in [`scripts/ci/configure-sonarcloud.mjs`](../scripts/ci/configure-sonarcloud.mjs) silences rules already owned elsewhere or known to be false positives in this repository: style preferences, React prop/index-key pedantry, intentional path inheritance and loopback URLs, locale sorting, and workflow/CLI logging false positives. ReDoS (`S5852`), postMessage origin (`S2819`), download-then-exec (`S8482`), empty tests (`S2187`), real control-flow bugs, and CSP review remain active.

On the Free plan, the custom Centraid profile and gate can be created but cannot be assigned. Keep those copies (without a coverage condition) for a future paid assignment; until then, exclusions and multicriteria protect hygiene/tooling PRs while product PRs fail closed on new BUG/VULNERABILITY findings.

### Re-apply after policy changes

CI applies this on every push to `main` that touches the configurator, weekly, and on manual dispatch — [`.github/workflows/sonarcloud.yml`](../.github/workflows/sonarcloud.yml), gated on the optional `SONAR_TOKEN` secret (skipped with an explicit notice when absent). Analysis itself stays Autoscan; no CI scanner runs. Locally:

```sh
export SONAR_TOKEN=$(security find-generic-password -s sonarqube-cli -w)
bun run scripts/ci/configure-sonarcloud.mjs
bun run scripts/ci/configure-sonarcloud.mjs --resolve-noise
```

The settings apply on the next Autoscan analysis. Dashboard: <https://sonarcloud.io/project/overview?id=srikanth235_centraid>.

## Hooks and suppressions

Do not invoke raw `npx`, global tools, `bunx` guesses, or implicit config discovery. Editors, hooks, local commands, and CI all name the root configs. Pre-commit checks staged files and does not rewrite source files; pre-push runs `check:push:static` on a branch and `check:push` on `main` ([dev-environment.md](dev-environment.md#the-local-gate-loop)). No hook mutates a tracked file: token cost per arrival is not appended to anything, it is read back out of the touched receipt's `## Accounting` section and printed on the generated front page, or printed as `token cost: not recorded` when the author recorded none ([#1005](https://github.com/srikanth235/centraid/issues/1005), [decisions.md](decisions.md#governance-as-a-constitution-1005)).

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

All diagnostics are errors or off; warning debt is not a supported state. Fix code before suppressing a diagnostic. A local suppression stays narrow, references its owning issue as required by the constitution, and explains why the rule is wrong for that site. Never weaken policy merely to make a PR green. The same holds for Rust: `clippy -D warnings` is the gate, and an `#[allow]` carries its reason.

## Runtime profiles and exclusions

The root Oxlint config owns production TypeScript, React/TSX, Vitest, Playwright, Node/Bun scripts, browser workers, and Electron. The Playwright specs under `desktop/e2e` and `extension/e2e` are named `*.e2e.ts`, so the vitest-owned globs never reach them.

Generated output, vendored code, build trees, immutable snapshots, negative lint fixtures, and governance-managed files may be excluded with a concrete owner in the config. Scripts, tests, and e2e code are source and remain in scope. Generated files are regenerated, never hand-edited.

The type-aware compatibility pass is an explicit allowlist. It proves each target opens a non-empty TypeScript program, rejects type-aware-only rules from the resolved ordinary config (including overrides), and runs live negative fixtures for every admitted rule (`scripts/fixtures/lint-types/invalid.ts`). `typescript/no-floating-promises` is source-only because Vitest/Playwright registration calls are intentionally unawaited. `typescript/no-unnecessary-type-assertion` remains off because tsgolint fixes conflict with TypeScript 5.9 under `noUncheckedIndexedAccess` and typed mocks.

## Upgrade policy

Node, Turbo, Ultracite, Oxlint, oxlint-tsgolint, Oxfmt, TypeScript, Knip, and Vitest are exact-pinned. The JavaScript Dependabot stream ignores the coupled toolchain pins. On the first day of every month, `toolchain-upgrade.yml` opens the owned review issue that decides whether to upgrade them. Accepted upgrades land only in a dedicated PR. The PR records:

- versions before and after;
- rules added, removed, or semantically changed;
- whether formatter output changes;
- whether compiler or type-aware semantics change;
- the regenerated `typeAwareOnlyRules` catalog when oxlint-tsgolint changes;
- the full validation result.

Formatter churn is an isolated formatting-only commit. Safe lint fixes are a separate mechanical commit. Behavioural corrections are reviewed per site and never mixed into either sweep.

<a id="v1-cargo-xtask-gate-1020"></a>

## cargo xtask gate (#1020)

The repository is three languages, so its cross-cutting layer cannot live in any one of them: it is a Rust `xtask` crate, and `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the only entrypoint CI runs ([#1020](https://github.com/srikanth235/centraid/issues/1020)). [`crates/xtask/README.md`](../crates/xtask/README.md) is the reference; this section is the state of the loop. The edit-run loop around it is in [dev-environment.md](dev-environment.md#the-local-gate-loop).

**The four profiles, and `mobile-jvm`.** The four are each a superset of the one before, so a step cannot be in `pr` and missing from `release`; `mobile-jvm` stands apart and is a superset of nothing.

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test` (the workspace minus `centraid-sim`), `rules` (the structural rules), `ledgers` (the down-only check) | < 120 s **warm**, < 3200 s **cold** | by hand, on the edit-run loop |
| `pr` | `buf`, `deny` (cargo-deny), `ci-policy` (the workflow and path-filter linters plus actionlint), `secrets` (gitleaks), `osv` (the `bun.lock` advisory inventory), `release-build`, `ts-static` (`bun run check:push:static`), `emitters` (regenerates `copy/`, `design/` and the Kotlin copy table and fails on drift), `desktop-unit` (the desktop seat's pure cores plus its three tsconfigs), `extension-unit` (the Companion's two type programs and its lint — its vitest files ride `desktop-unit`'s project), `advisory` (every step that announces it will never fail carries an owner, an issue and an unexpired date), `lockfile` (**both** lockfiles: TLS-only sources, every registry package pinned by content), `prompt-injection` (the [#842](https://github.com/srikanth235/centraid/issues/842) corpus, named separately so the count is visible in the gate's output), `sim` (25 turmoil seeds), `call-budget` (p95 over 200 calls of one bounded read), `fault-door` (ABI clause 9 against a real panic, the one place the tree is compiled with `debug-fault`) | < 1500 s | [`gate.yml`](../.github/workflows/gate.yml) on every pull request and every push to `main` |
| `nightly` | `sim-nightly` (250 seeds, on top of `pr`'s 25 rather than replacing them), `desktop-e2e` (a real Electron app over a real sidecar, and a `<video>` that seeks inside a blob still arriving), `extension-e2e` (a real headed Chromium, which needs a display), `device-lanes` | unbounded | [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml) at 05:30 UTC |
| `release` | `restore-drill`, `artifact-identity`, `prebuilt-core-required`, `vps-smoke` | unbounded | [`release.yml`](../.github/workflows/release.yml)'s lanes |
| `mobile-jvm` | `mobile-jvm` — `cargo build -p centraid-core-ffi`, then `mobile/gradlew mobileJvm` (`:shared:jvmTest`, `:core:jvmTest` over the real cdylib, `:shared:koverXmlReport`), then the generated-artifact drift check | < 420 s | [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml); on demand from `mobile/`. **Not** a superset of any other profile and not folded into `pr`: a different toolchain with a different cold cost ([D-1020-B2-3](decisions.md#decisions--lane-b2-1020)). A missing `mobile/gradlew` FAILS rather than skips |

`device-lanes` runs `ios-transfer-experiment`, `android-macrobenchmark`, `ios-xctest-metrics` and `battery-per-background-pass`. `gate-nightly.yml` runs them as a matrix (`cargo xtask gate --profile nightly --lane <name>`) on a `[self-hosted, macos, devices]` runner only when `vars.CENTRAID_DEVICE_RUNNER == 'true'`; anywhere else the step is a loud `SKIP`.

The budgets are **enforced, not aspirational**: a profile whose steps together overran its `budgetSeconds` fails, prints the per-step timing table, and says so on its last line as well as in its `BUDGET` line. They live in `contracts/ledgers/gate-budgets.json` alongside `compile-time.json` (clean check, incremental check, single-crate test, release build, the cold `local` profile, and `kotlinNativeLinkSeconds`, still null because no machine in CI links Kotlin/Native and a JVM number in that key is the one thing it exists to prevent), `library-size.json` (the prebuilt core's stripped size per ABI; a triple no machine has built stays null), `call-budget.json` and `advisory.json`. The size and time ledgers are down-only, checked against `git show <merge-base>:<path>`, and written only by `cargo xtask measure --write`, which only ever lowers a ceiling. There is no waiver, deviation or override path, and the one time these numbers rose — the 2026-09-12 re-base for the Rust workspace — it was an owner ruling ([D-1020-B2](decisions.md#decisions--lane-b2-1020)), recorded per key with its measurement and multiplier.

**`local` is scored on the tree the edit-run loop runs on: a warm one** ([D-1020-B2-1](decisions.md#decisions--lane-b2-1020)). The 120 s promise is the developer's feedback time after an edit, not the first build after a clone, and on the measuring container the two differ by fifty times: 41.6 s warm against 1562.4 s cold at ten crates. `cargo xtask gate` tells them apart by asking whether **every** workspace member has a _linked_ artifact in `target/debug/deps` — an `.rmeta` from a previous `cargo check` does not count, so a checked-only tree cannot buy a warm budget — prints `tree warm`/`tree cold` with the reason, and charges a cold `local` run against `coldLocalProfileSeconds` instead. A cold run for which that key states no ceiling **fails**: cold is never the answer that makes a slow gate green. `--cold` forces the cold branch without deleting `target/`. Only `local` has a cold ceiling; every other profile runs in CI on a runner that has never seen the workspace, so its budget has to hold cold or it is not a budget — which is why `pr`'s number is the cold measurement (1420.1 s; the warm run is 575.8 s and a Cargo-cache hit is CI's normal case).

Every step prints one line whatever it does — `ok`, a loud `SKIP` naming the command that turns it into a real run, or `FAIL` — and output is buffered and printed only on failure. **A failing step writes its whole output under `target/xtask/<profile>/<step>/`** (`command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the internal steps) and names the directory in its line; both gate workflows upload `target/xtask/**` on failure. A step whose tool is missing (`buf`, `cargo-deny`, `actionlint`, `gitleaks`, `osv-scanner`) is a `SKIP` locally and a `FAIL` under `CI`, where the workflow installs it.

**The `secrets` step scans the repository, not its build output** ([D-1020-B2-5](decisions.md#decisions--lane-b2-1020)). `gitleaks detect --no-git` is what gives the step its working-tree coverage, and it also walks `target/`, where a built Rust workspace carries PEM headers in `pem-rfc7468`/`pkcs8` doc strings inside `.rmeta` files. gitleaks 8.30 has no `--exclude-path` and no `.gitignore` support, so the step keeps ONE unfiltered scan and classifies its JSON report afterwards: a finding is dropped only where `git check-ignore` matches the file and `git ls-files` does not track it. Both counts are printed, `.gitleaks.toml` is untouched, and a tracked file is never dropped.

**`release` carries no placeholder.** `restore-drill` founds a vault, takes a generation, deletes the live data directory and runs the real `centraid recover` into a fresh one. `vps-smoke` installs the built tarball into a **clean Docker container** through [`deploy/vps/install.sh`](../deploy/vps/install.sh), founds a vault, pairs a seat over iroh, waits for a WAL capture tick, takes a generation with a non-empty tail, runs `centraid doctor`, restarts the container over the same data directory, and then installs the same artifact with a tampered `identity.json` and asserts the refusal. `crates/xtask/src/gate.rs`'s `no_step_in_the_release_profile_is_a_stub` test is what keeps a stub from coming back under a new name. A **real VPS** run is an owner hand-off; the commands and the expected transcript are in [release.md](release.md).

**Two optimised profiles (D-1020-G8).** `release` is what a pull request builds and what `release-build` scores; `dist` is `release` plus thin LTO and `codegen-units = 1` and is what a tag publishes (`lane-prebuilt-core.yml`, `deploy/docker/Dockerfile`). Measured cold: LTO inside `release` put `cargo build --workspace --release` at 1039 s and the debuginfo settings at 747 s, against 379 s for the profile as it stands. The split rests on not spending 70 % of the 1500 s `pr` budget on inlining only the published artifact consumes. The cost is stated too: the binary a pull request builds is not bit-identical to the one a tag ships, so `vps-smoke` smokes `release` and the `dist` artifact is proved by the prebuilt-core lane, which stamps it and reads the stamp back out of the binary.

**The edit-run loop carries line tables, not full DWARF (D-1020-G7).** `[profile.dev]` and `[profile.test]` are `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and dependencies carry `debug = false` beside their `opt-level = 2`. A backtrace still names the file and the line, which is what a red test is read with; what is gone is the type and variable tables for iroh, rustls and SQLite. Measured: a shared `target/` held 16 GB under `debug/`, of which 7.7 GB was 144 test and bin executables; under this profile the same set is 0.50 GB over 39 executables. **A developer who needs full debuginfo for one session sets `CARGO_PROFILE_DEV_DEBUG=2`** for that one command; it is written in [`crates/xtask/README.md`](../crates/xtask/README.md) too. `[profile.release]` takes the same `debug = "line-tables-only"` with `split-debuginfo = "packed"`, so the published symbol file is one file per platform (`centraid.dwp`, `centraid.dSYM`, the `.pdb`) rather than debuginfo welded into the shipped binary.

**OWNER HAND-OFF — the required checks.** `gate` and `dependency-review` — the two jobs in `gate.yml` that run on every pull request, neither path-filtered, so both always report — plus `governance` must be the required checks on `main`. A required check that never reports blocks a pull request forever. Branch protection is configured outside this repository, like the code-owner review requirement.
