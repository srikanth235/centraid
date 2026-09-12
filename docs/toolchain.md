# TypeScript toolchain contract

This is the durable command and ownership contract for TypeScript quality work. The executable source of truth is the root `package.json`, `oxlint.config.ts`, and `oxfmt.config.ts`; this document explains the policy without duplicating their rule catalog.

## One owner per concern

| Concern | Owner |
| --- | --- |
| Reviewed opinionated baseline | Ultracite modular presets |
| Formatting, import sorting, and package metadata sorting | Oxfmt |
| Static correctness and repository lint policy | Oxlint |
| Compiler diagnostics and type correctness | pinned TypeScript |
| Task graph execution | pinned Turbo |
| Dead code and dependency hygiene | Knip |
| Sharing-plane export reachability | `scripts/check-share-reachability.mjs` (`check:reachability`) + `share-reachability.json` |
| Runtime behaviour | Vitest and e2e suites |
| DESIGN.md spec conformance | `@google/design.md` (pinned exact) — see `lint:design-md` |
| Second-opinion security / reliability (PR check) | SonarCloud Autoscan — see [SonarCloud Autoscan](#sonarcloud-autoscan) |

Ultracite seeds `core`, `react`, and `vitest` policy. It is not the routine command runner. `toolchain:doctor` is its non-mutating drift check. Optional GitHub, Sonar, and react-doctor JavaScript-plugin presets remain declined as bundles; a future issue may admit one rule at a time through the rubric below.

`@google/design.md` owns _format_ conformance of the root `DESIGN.md` only; it has no view on whether the values are Centraid's real tokens. That truth check is `packages/design/src/design-md.test.ts`, which compares the front matter against `packages/design/src`. Both run under `check:push`.

Oxfmt is the sole style owner. Oxlint rules that only restate formatting are off. The pinned TypeScript compiler is the sole owner of compiler diagnostics; Oxlint `--type-check` is not part of any command.

**There is a second linter, and it lints no product source.** ESLint is installed under [`.governance/law/`](../.governance/law/README.md) with its own private, exact-pinned `package.json`, and it is scoped to the governance documents — the generated arrival record and the markdown the constitution governs (`receipts/*.md`, `CONSTITUTION.md`, `docs/decisions.md`, `CHANGELOG.md`). **`bun run lint` never invokes it and it never sees a `.ts` file**; oxlint remains the sole owner of the product's lint policy, and oxlint's own `ignorePatterns` excludes `.governance/**` in the other direction. It exists because a governance directive written as a lint rule gets a rule catalog, severities, per-line suppression with a reason, a machine-readable report and `RuleTester` for free — machinery that would otherwise be hand-rolled in bash. It is reached through `bash .governance/run.sh` (the `law` directive) or `bun run governance:law`, and it carries its own install because the managed `governance.yml` runs no `bun install`.

## Stable command API

All callers use repository-pinned binaries through these Bun scripts:

| Command | Contract |
| --- | --- |
| `format` | write Oxfmt output with the root config |
| `format:check` | check Oxfmt output without mutation |
| `lint` | ordinary Oxlint pass, warnings denied |
| `lint:fix` | Oxlint safe fixes only |
| `lint:types` | compiler-compatible type-aware allowlist plus policy fixtures |
| `typecheck` | pinned TypeScript compiler across the monorepo |
| `test:affected` | Vitest for workspaces changed from `origin/main` |
| `check:fast` | format check, ordinary lint, and affected typecheck |
| `check:pr` | frozen install, static policy, typecheck, affected tests, and Knip |
| `check:full` | PR gate plus dependents, coverage, affected mutation/perf, and web/desktop e2e |
| `lint:design-consumers` | one local parity check for desktop/PWA/blueprint CSS and Expo native consumers; both halves remain separate `check:push` gates so CI can run them concurrently |
| `lint:design-md` | official DESIGN.md linter over the root `DESIGN.md`: schema, `{token.refs}`, WCAG pairs, canonical section order. Errors fail; warnings are advisory |
| `toolchain:doctor` | non-mutating Ultracite/config drift diagnosis |
| `check:reachability` | sharing-plane export reachability (see below) |
| `check:push` | the full push tier: 17 gate names run concurrently, with the static tier gate-stamped |
| `check:push:static` | the branch push tier: `format:check`, `lint`, `turbo:lint`, `typecheck:affected` |
| `governance` | the stamped entry point to `.governance/run.sh`, which is itself digest-locked |
| `governance:law` | the law's ESLint pass over the arrival record and the governance documents a change touched |
| `governance:law:test` | the law's rule and generator tests, under `node --test` |

### Where the caches live

Nothing a gate or a build caches belongs in the repository. Both directories default under the user's cache home and are overridable by environment, so a container, a CI runner and a laptop can each put them where they belong:

| What | Default | Override | Owner |
| --- | --- | --- | --- |
| Gate stamps (`static`, `governance`, `governance-deferred`) | `${XDG_CACHE_HOME:-~/.cache}/centraid/gate-stamps` | `CENTRAID_GATE_STAMP_DIR`; `CENTRAID_GATE_STAMPS=0` disables stamping | `scripts/ci/gate-stamp.mjs` |
| Turbo filesystem cache, shared by every worktree | `${XDG_CACHE_HOME:-~/.cache}/centraid/turbo` | `TURBO_CACHE_DIR`, then `CENTRAID_TURBO_CACHE_DIR` | `scripts/ci/turbo.mjs` |

Turbo's per-run summaries stay in each checkout's `.turbo/runs`, which is what `scripts/ci/turbo-cache-report.mjs` reads. Why the tiers and stamps are shaped this way: [dev-environment.md](dev-environment.md#tiers-stamps-and-one-cache-988).

## SonarCloud Autoscan

SonarCloud is the second-opinion security and reliability check for product code. It runs Automatic Analysis (Autoscan) on GitHub push/PR through project `srikanth235_centraid`; no CI scanner is used. The PR gate is Sonar way because the Free plan cannot assign a custom gate. Coverage remains Vitest's responsibility, and Sonar does not use `sonar-project.properties` for scope.

### Ownership and scope

Sonar complements, rather than replaces, Oxfmt, Oxlint, TypeScript, Knip, Vitest, Gitleaks, OSV, Trivy, GHAS, actionlint, and CodeQL. Do not weaken local policy to satisfy a Sonar style finding.

Product scope is `packages/**` and `apps/**`, excluding generated and non-runtime surfaces. The configured exclusions are:

| Path | Owner / reason |
| --- | --- |
| `scripts/**` | CI/tooling CLIs; Oxlint and unit tests |
| `.github/**` | Workflows; actionlint and CodeQL Actions |
| `tests/**`, `**/*.{test,spec}.*`, `**/e2e/**`, `**/fixtures/**` | Test and fixture surface |
| `docs/**`, `receipts/**`, `assets/**` | Non-runtime artifacts |
| `**/dist/**`, `**/generated/**`, visual harness, tunnel native, wasm | Generated or non-TypeScript product |
| Five release-generated recognition `handler.js` bundles | `packages/model-runtime` is the source of truth; local lint, typecheck, and tests own the implementation |

The duplication metric excludes `packages/design/src/roles.ts` because its repeated profile-lowering record shape keeps each role's meaning, contrast obligation, and totality reviewable inline. TypeScript, coverage, and mutation gates still exercise it.

### Noise policy

The `NOISE_RULES` list in [`scripts/ci/configure-sonarcloud.mjs`](../scripts/ci/configure-sonarcloud.mjs) silences rules already owned elsewhere or known to be false positives in this monorepo: style preferences, React prop/index-key pedantry, intentional path inheritance and loopback URLs, locale sorting, and workflow/CLI logging false positives. ReDoS (`S5852`), postMessage origin (`S2819`), download-then-exec (`S8482`), empty tests (`S2187`), real control-flow bugs, CSP review, and vault/gateway sinks remain active.

On the Free plan, the custom Centraid profile and gate can be created but cannot be assigned. Keep those copies (without a coverage condition) for a future paid assignment; until then, exclusions and multicriteria protect hygiene/tooling PRs while product PRs fail closed on new BUG/VULNERABILITY findings in `packages/` and `apps/`.

### Re-apply after policy changes

CI applies this on every push to `main` that touches the configurator, weekly, and on manual dispatch — [`.github/workflows/sonarcloud.yml`](../.github/workflows/sonarcloud.yml), gated on the optional `SONAR_TOKEN` secret (skipped with an explicit notice when absent). Analysis itself stays Autoscan; no CI scanner runs. Locally:

```sh
export SONAR_TOKEN=$(security find-generic-password -s sonarqube-cli -w)
bun run scripts/ci/configure-sonarcloud.mjs
bun run scripts/ci/configure-sonarcloud.mjs --resolve-noise
```

The settings apply on the next Autoscan analysis. Dashboard: <https://sonarcloud.io/project/overview?id=srikanth235_centraid>.

## Sharing-plane export reachability

Knip's dead-export detection stops at workspace entry files: a capability re-exported through `src/index.ts` counts as "used" because the barrel is an entry, and colocated vitest files are entries too. That combination laundered dead sharing-plane capabilities past every gate (issue #750: `declareCommonsCommands` / `commonsCommandsFor` were exported, barrel-re-exported, and called by nothing in production).

`bun run check:reachability` (`scripts/check-share-reachability.mjs`, part of `check:push`) closes the class. For every value export of the modules configured in the root `share-reachability.json` it resolves the transitive importer set — following re-exports through index.ts barrels and workspace package specifiers — and fails unless a production file (non-test source under `packages/` or `apps/`, per the TESTING.md naming conventions) imports the capability in a value position. Test/benchmark/fixture files, type-only imports and usages, and pure import-then-re-export sites do not count as callers. It parses with the repo-pinned TypeScript compiler at syntax level only, so it runs standalone with no build.

**Same-file rule.** A capability used in a value position inside its _own_ declaring module counts as production-reached, provided that module is production code — the same convention as knip's `ignoreExportsUsedInFile`, which this repo already runs. The two gates compose: knip fails on unused **files**, so a module that only reaches itself is either alive (something runs it) or knip deletes the whole file; this gate fails on dead **exports inside live modules**. A same-file value use inside a live production module therefore does execute in production, while the defect class this gate exists for — `declareCommonsCommands`, `pushRouteAssertion`: a capability invoked nowhere, in-file or out — still fails. A declaration's own name is not a use (the usage walk skips top-level declaration name nodes), same-file uses in test modules never rescue anything, and a same-file use in a type position is still type-only. Such a reacher is reported as `<file> (same-file)` so the output stays honest about why it passed.

**Default exports.** `export default` ↔ default-import is a resolved pair: `import ShareSheet from "./ShareSheet"` reaches the target's `default` export, and an unreached one is reported as `<file>#default`. Every screen-level sharing component on the phone is a default export, so without this the gate would have called each of them dead. `export *` does not carry `default` (ES2015 §15.2.3) and neither does the analyzer, and `export default <local>` is a re-export site rather than a same-file use — otherwise every default export would rescue itself.

**Scope.** The configured modules are the sharing plane on all three seats: the server's peer/share/commons/edges routes, the vault's grant and share modules, the blueprint grant and share modules under `packages/blueprints/apps/_shared` plus `apps/people/grant-dashboard.ts`, and the phone's `apps/mobile/src/kit/share`. The `_shared` tree is listed module by module rather than globbed: most of it is not the sharing plane (consent gates, nav, search scaffolding), and `grant-sheet-harness.ts` is a test kit that no production file may reach. The three modules once held out for genuinely dead exports are resolved: `_shared/ShareSheet.tsx` is deleted (the web seat lives in `GrantSheet`), and `grant-plane.ts` and `placement-registry.ts` lost their dead exports and are in the gate ([#883](https://github.com/srikanth235/centraid/issues/883)).

Documented exceptions live in the config's `allowlist`, one non-empty `reason` string per entry (the same documented-exception style as `knip.json`); a stale entry — one whose capability gained a production caller or disappeared — is itself a failure, so the list only shrinks. The allowlist is currently **empty** and should stay that way: a failing capability is fixed by wiring the production caller or deleting the export, not by adding an entry.

Do not invoke raw `npx`, global tools, `bunx` guesses, or implicit config discovery. Editors, hooks, local commands, and CI all name the root configs. Pre-commit checks staged files and does not rewrite source files; pre-push runs `check:pr`. No hook mutates a tracked file: token cost per arrival is no longer appended to anything, it is read back out of the touched receipt's `## Accounting` section and printed on the generated front page, or printed as `token cost: not recorded` when the author recorded none ([#1005](https://github.com/srikanth235/centraid/issues/1005), [decisions.md](decisions.md#governance-as-a-constitution-1005)).

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

Standing declines are filename conventions, `github/no-then`-style syntax preferences, file/function length, blanket cognitive-complexity thresholds, mandatory function-expression styles, formatter duplicates, and optional JavaScript-plugin presets as bundles.

All diagnostics are errors or off; warning debt is not a supported state. Fix code before suppressing a diagnostic. A local suppression stays narrow, references its owning issue as required by the constitution, and explains why the rule is wrong for that site. Never weaken policy merely to make a PR green.

## Runtime profiles and exclusions

The root Oxlint config owns production TypeScript, React/TSX, Vitest, Playwright, Node/Bun scripts, browser workers, Electron, Expo/mobile, blueprint app handlers, and blueprint automation handlers. The automation handler profile disables only `no-await-in-loop`: connector pagination and batching often consume the cursor or token returned by the previous iteration, so those loops are intentionally sequential. Other rules still apply.

Generated output, vendored code, build trees, immutable snapshots, negative lint fixtures, and governance-managed files may be excluded with a concrete owner in the config. Shipped blueprints, handlers, scripts, tests, and e2e code are source and remain in scope. Generated files are regenerated, never hand-edited.

The type-aware compatibility pass is an explicit allowlist. It proves each workspace opens a non-empty TypeScript program, rejects type-aware-only rules from the resolved ordinary config (including overrides), and runs live negative fixtures for all eight admitted rules. It covers workspace `src/` trees, the OAuth worker, blueprint apps and kit, repository scripts and tests, and desktop/web Playwright suites. `typescript/no-floating-promises` is source-only because Vitest/Playwright registration calls are intentionally unawaited. Blueprint apps and kit retain one documented exception: `typescript/no-misused-promises` is omitted because 126 React/DOM callback slots intentionally launch narrated async actions, while the engine CLI cannot retain its useful condition checks and disable only void-return callbacks. `typescript/no-unnecessary-type-assertion` remains off because tsgolint fixes conflict with TypeScript 5.9 under `noUncheckedIndexedAccess` and typed mocks.

## Upgrade policy

Node, Turbo, Ultracite, Oxlint, oxlint-tsgolint, Oxfmt, TypeScript, Knip, and Vitest are exact-pinned. Node's executable contract is duplicated deliberately in `.node-version` and `package.json#engines.node`; `bun run lint:node-version` fails if either drifts or the active runtime differs. The shared CI setup action installs that exact Node release.

The JavaScript Dependabot stream ignores the coupled toolchain pins. On the first day of every month, `toolchain-upgrade.yml` opens the owned review issue that decides whether to upgrade them. Accepted upgrades land only in a dedicated PR. The PR records:

- versions before and after;
- rules added, removed, or semantically changed;
- whether formatter output changes;
- whether compiler or type-aware semantics change;
- the regenerated `typeAwareOnlyRules` catalog when oxlint-tsgolint changes;
- the full validation result.

Formatter churn is an isolated formatting-only commit. Safe lint fixes are a separate mechanical commit. Behavioural corrections are reviewed per site and never mixed into either sweep. Shared infrastructure changes require `check:full`.

## v1: cargo xtask gate (#1020)

The document above is the **TypeScript** toolchain contract and stays exactly that. The v1 tree ([#1020](https://github.com/srikanth235/centraid/issues/1020)) is three languages, so its cross-cutting layer cannot live in any one of them: it is a Rust `xtask` crate, and `cargo xtask gate --profile <local|pr|nightly|release>` is the only entrypoint CI runs for it. [`crates/xtask/README.md`](../crates/xtask/README.md) is the reference; this section is the state of the loop.

**The four profiles.** Each is a superset of the one before, so a step cannot be in `pr` and missing from `release`.

| Profile | Steps it adds | Budget | Where it runs |
| --- | --- | --- | --- |
| `local` | `fmt`, `clippy`, `test`, `rules` (the structural rules), `ledgers` (the down-only check) | < 120 s **warm**, < 3200 s **cold** | by hand, on the edit-run loop |
| `pr` | `buf`, `deny` (cargo-deny), `ci-policy` (the workflow and path-filter linters plus actionlint), `secrets` (gitleaks), `osv` (the `bun.lock` advisory inventory), `release-build`, `ts-static`, `advisory` (every step that announces it will never fail carries an owner, an issue and an unexpired date), `lockfile` (**both** lockfiles: TLS-only sources, every registry package pinned by content) | < 1500 s | [`gate.yml`](../.github/workflows/gate.yml) on every pull request and every push to `main` |
| `nightly` | `v0-oracle` (the v0 suites that read `contracts/`), `device-lanes`, `lane-health` (first-attempt pass rate and chronic red, off the Actions API) | unbounded | [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml) at 05:30 UTC |
| `release` | `restore-drill`, `artifact-identity`, `prebuilt-core-required`, `vps-smoke` | unbounded | [`release.yml`](../.github/workflows/release.yml)'s lanes |
| `mobile-jvm` | none yet — Kotlin/Gradle JVM suites | null, a placeholder | nowhere; the profile REFUSES to run until wave 3 lane E lands it |

The budgets are **enforced, not aspirational**: a profile whose steps together overran its `budgetSeconds` fails, prints the per-step timing table, and says so on its last line as well as in its `BUDGET` line. They live in `contracts/ledgers/gate-budgets.json` alongside `compile-time.json` (clean check, incremental check, single-crate test, release build, the cold `local` profile, and a null `kotlinNativeLinkSeconds` for wave 3 — "compile time is the new Hermes") and `library-size.json` (seeded empty; the prebuilt-core lane fills it in wave 3). All three are down-only, checked against `git show <merge-base>:<path>` the way [`scripts/check-ledgers.mjs`](../scripts/check-ledgers.mjs) checks v0's, and written only by `cargo xtask measure --write`, which only ever lowers a ceiling. There is no waiver, deviation or override path, and the one time these numbers rose — the 2026-09-12 re-base for the Rust workspace — it was an owner ruling ([D-1020-B2](decisions.md#decisions--lane-b2-1020)), recorded per key with its measurement and multiplier. v0's ledgers under `tests/` retire with v0.

**`local` is scored on the tree the edit-run loop runs on: a warm one** ([D-1020-B2-1](decisions.md#decisions--lane-b2-1020)). The 120 s promise is the developer's feedback time after an edit, not the first build after a clone, and on this container the two differ by fifty times: 41.6 s warm against 1562.4 s cold at ten crates. `cargo xtask gate` tells them apart by asking whether **every** workspace member has a _linked_ artifact in `target/debug/deps` — an `.rmeta` from a previous `cargo check` does not count, so a checked-only tree cannot buy a warm budget — prints `tree warm`/`tree cold` with the reason, and charges a cold `local` run against `coldLocalProfileSeconds` instead. A cold run for which that key states no ceiling **fails**: cold is never the answer that makes a slow gate green. `--cold` forces the cold branch without deleting `target/`. Only `local` has a cold ceiling; every other profile runs in CI on a runner that has never seen the workspace, so its budget has to hold cold or it is not a budget — which is why `pr`'s number is the cold measurement (1420.1 s; the warm run is 575.8 s and a Cargo-cache hit is CI's normal case).

Every step prints one line whatever it does — `ok`, a loud `SKIP` naming the command that turns it into a real run, or `FAIL` — and output is buffered and printed only on failure. **A failing step writes its whole output under `target/xtask/<profile>/<step>/`** (`command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the two internal steps) and names the directory in its line; both gate workflows upload `target/xtask/**` on failure.

**The `secrets` step scans the repository, not its build output** ([D-1020-B2-5](decisions.md#decisions--lane-b2-1020)). `gitleaks detect --no-git` is what gives the step its working-tree coverage, and it also walks `target/`, where a built Rust workspace carries PEM headers in `pem-rfc7468`/`pkcs8` doc strings inside `.rmeta` files. gitleaks 8.30 has no `--exclude-path` and no `.gitignore` support, so the step keeps ONE unfiltered scan and classifies its JSON report afterwards: a finding is dropped only where `git check-ignore` matches the file and `git ls-files` does not track it. Both counts are printed, `.gitleaks.toml` is untouched, and a tracked file is never dropped.

**Two `pr` steps are red on inherited tree state, and are there anyway.** `secrets` and `osv` moved onto the PR gate with the other lanes `ci.yml` used to own, and both fail today: `packages/model-runtime/LICENSES.md` trips gitleaks' `generic-api-key` rule (it arrived with [#1011](https://github.com/srikanth235/centraid/issues/1011)) and `astro@7.1.5` in `bun.lock` carries a CRITICAL scored 9.8. A pull-request gate that stops reporting because its target is red today is a weakening, so the steps are present and red; nothing was added to `.gitleaks.toml` or `osv-scanner.toml`. Both are **owner hand-offs** — a reasoned allowlist row naming the LICENSES file (or moving the string) is the owner's call, and the `astro` bump is a dependency change outside #1020's scope.

`release` **carries no placeholder any more.** Wave 2 lane R made `restore-drill` real and wave 3 lane G made `vps-smoke` real: it installs the built tarball into a **clean Docker container** through [`deploy/vps/install.sh`](../deploy/vps/install.sh), founds a vault, pairs a seat over iroh, waits for a WAL capture tick, takes a generation with a non-empty tail, runs `centraid doctor`, restarts the container over the same data directory, and then installs the same artifact with a tampered `identity.json` and asserts the refusal. `crates/xtask/src/gate.rs`'s `no_step_in_the_release_profile_is_a_stub` test is what keeps a stub from coming back under a new name. A **real VPS** run is still an owner hand-off; the commands and the expected transcript are in [release.md](release.md).

**The edit-run loop carries line tables, not full DWARF ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-G7).** `[profile.dev]` and `[profile.test]` are `debug = "line-tables-only"` with `split-debuginfo = "unpacked"`, and dependencies carry `debug = false` beside their `opt-level = 2`. A backtrace still names the file and the line, which is what a red test is read with; what is gone is the type and variable tables for iroh, rustls and SQLite, which nothing here had ever read. It was measured, not guessed: the shared `target/` three wave-3 lanes built into held 16 GB under `debug/`, of which 7.7 GB was 144 test and bin executables — the four `centraid` test binaries were 363–387 MB each. Under the new profile the same set is 0.50 GB over 39 executables and the largest is 43 MB. **A developer who needs full debuginfo for one session sets `CARGO_PROFILE_DEV_DEBUG=2`** for that one command; it is written in [`crates/xtask/README.md`](../crates/xtask/README.md) too. `[profile.release]` takes the same `debug = "line-tables-only"` with `split-debuginfo = "packed"`, so the published symbol file is one file per platform (`centraid.dwp`, `centraid.dSYM`, the `.pdb`) rather than debuginfo welded into the shipped binary.

**The nightly oracle.** From wave 1 the v0 tree is a pinned read-only oracle and `ci.yml` no longer listens on `pull_request` — it runs every one of its lanes on pushes to `main` and on its own nightly schedule instead. No v0 job was deleted or weakened; what changed is when a v0 regression surfaces. What a v1 commit still owes v0 is the `contracts/` oracle suite, which is the `nightly` profile's `v0-oracle` step. The reason is the issue's _Two trees, one CI bill_: running both trees' gates on every pull request would double the bill for one answer.

**OWNER HAND-OFF — branch protection must be repointed.** The required check today is `check`, `ci.yml`'s aggregator, and it will stop reporting on pull requests. The owner must make **`gate`** and **`dependency-review`** — the two jobs in `gate.yml`, neither path-filtered, so both always report — the required checks. **Until that is done, pull requests will block**, because a required check that never reports blocks the pull request forever. Branch protection is configured outside this repository, like the code-owner review requirement.

**Toolchains.** `rust-toolchain.toml` at the repo root is the one version file for the v1 tree; the gate workflows read the channel out of it and [`flake.nix`](../flake.nix)'s `devShells.default` reads the whole file through `rust-overlay`. The flake pins every toolchain except the Android SDK and Xcode, and says so in its header; `.xcode-version` pins Xcode, which nix cannot install. The v0 byte plane keeps its own pin in `apps/web/iroh-wasm/rust-toolchain.toml` and is excluded from the root workspace — two trees, two pins, until wave 6.
