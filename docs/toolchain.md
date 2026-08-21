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

Documented exceptions live in the config's `allowlist`, one non-empty `reason` string per entry (the same documented-exception style as `knip.json`); a stale entry — one whose capability gained a production caller or disappeared — is itself a failure, so the list only shrinks. The allowlist is currently **empty** and should stay that way: a failing capability is fixed by wiring the production caller or deleting the export, not by adding an entry.

Do not invoke raw `npx`, global tools, `bunx` guesses, or implicit config discovery. Editors, hooks, local commands, and CI all name the root configs. Pre-commit checks staged files and does not rewrite source files; pre-push runs `check:pr`. The one intentional mutation is governance token accounting: immediately before a commit, its hook appends the frozen cost coordinate to this issue's receipt so the commit and ledger row remain one auditable unit.

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
