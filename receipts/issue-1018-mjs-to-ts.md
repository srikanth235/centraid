# Issue #1018 — migrate maintained `.mjs` source to TypeScript (Slice A)

Umbrella: compiler profile for directly executed Node tooling. No `.mjs` rename in this lane.

## What changed

Root typecheck now includes the repository scripts TypeScript programs. Directly executed Node tooling uses a shared `tsconfig.node.json` profile (`module`/`moduleResolution` NodeNext, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `.ts` import specifiers). Node runs those files with native type stripping (`node path/to/script.ts`). `tsconfig.base.json` application/bundler defaults are unchanged. Compiled package runtime still uses NodeNext `.js` specifiers.

`scripts/tsconfig.json` extends that profile and includes every maintained `scripts/**/*.ts` file except negative lint fixtures and two package-source importers. `scripts/refresh-pricing-snapshot.ts` has a separate bundler/Preserve program (`scripts/tsconfig.pricing.json`) so the NodeNext program does not typecheck `packages/server/src`. `scripts/perf/app-waterfall.run.ts` is excluded from the NodeNext program for the same reason (`tsc --listFiles` pulled `packages/test-kit/src` and failed to resolve compiled package specifiers without `dist/`).

`lint:types` `repository-scripts` `source_ignore` keeps `**/*.{test,spec}.{ts,tsx}` when fixtures/`*.mjs` ignores are applied. `lint:tsconfigs` requires the new programs to stay in root `typecheck` / `typecheck:affected` (extends-base, no removed `moduleResolution`).

## Verification

```sh
tsc -p scripts --listFiles --pretty false
```

297 files. Scripts TypeScript members: `scripts/fuzz/vitest.config.ts`, `scripts/release/vitest.config.ts`, `scripts/test-report/vitest.config.ts`. `packages/server/src` count: 0. `packages/*/src` count: 0. Fixtures absent.

```sh
tsc -p scripts --noEmit
```

Exit 0.

```sh
tsc -p scripts/tsconfig.pricing.json --listFiles --pretty false
```

193 files. Non-lib members: `scripts/refresh-pricing-snapshot.ts`, `packages/server/src/engine/pricing/filter.ts`, `packages/server/src/engine/pricing/types.ts`. Isolated from the NodeNext program.

```sh
tsc -p scripts/tsconfig.pricing.json --noEmit
```

Exit 0. Import `../packages/server/src/engine/pricing/filter.ts` typechecks with `allowImportingTsExtensions` on the bundler program.

```sh
tsc -p tests --noEmit
```

Exit 2, 815 `error TS` diagnostics, identical count after stashing this lane's files. Inherited red: package `dist/` is absent in this worktree (`packages/core/dist/protocol/index.d.ts` missing). Not introduced by this change.

```sh
bun run lint:tsconfigs
```

`tsconfigs: ok (base inheritance, TS7 options, emit/test coverage)`

```sh
node --test scripts/lint-tsconfigs.test.mjs
```

18 pass, 0 fail.

```sh
bun run format:check
```

All matched files use the correct format.

```sh
bun run lint
```

0 warnings, 0 errors.

`npx` was not used. `check:push:static` was not run: `typecheck:affected` includes `tsc -p tests`, which is inherited-red without package `dist/`.

## Baseline (Slice B, identities only)

`scripts:test` was not executed (long). Identity set from root `package.json#scripts["scripts:test"]`:

- vitest: `scripts/release/vitest.config.ts`
- `bun run release:surfaces:test`
- `node --test` files: `scripts/lib/sanitize-connector-svg.test.mjs`, `scripts/design-gallery-fidelity.test.mjs`, `scripts/lint-design-tokens.test.mjs`, `scripts/lint-mobile-design.test.mjs`, `scripts/lint-logical-insets.test.mjs`, `scripts/lint-hairline.test.mjs`, `scripts/lint-workflow-pins.test.mjs`, `scripts/ci/file-tracking-issue.test.mjs`, `scripts/ci/rolling-issue-fallback-body.test.mjs`, `scripts/ci/burn-in.test.mjs`, `scripts/ci/mutation-cap.test.mjs`, `scripts/ci/pr-gate-wall-clock.test.mjs`, `scripts/ci/turbo-floor.test.mjs`, `scripts/ci/write-candidate.test.mjs`, `scripts/ci/resolve-candidate.test.mjs`, `scripts/ci/run-slug.test.mjs`, `scripts/ci/hygiene-gates.test.mjs`, `scripts/ci/collection-tripwire.test.mjs`, `scripts/ci/assert-shard-blobs.test.mjs`, `scripts/ci/advisory-expiry.test.mjs`, `scripts/ci/lane-health.test.mjs`, `scripts/ci/osv-lockfile-scan.test.mjs`, `scripts/lint-e2e-flows.test.mjs`, `scripts/lint-e2e-wiring.test.mjs`, `scripts/lint-mobile-testids.test.mjs`, `scripts/lint-vault-sql.test.mjs`, `scripts/check-mobile-suite-budgets.test.mjs`, `scripts/lint-tsconfigs.test.mjs`, `scripts/lint-turbo-cache.test.mjs`, `scripts/lint-path-filters.test.mjs`, `scripts/ci/turbo-cache-report.test.mjs`, `scripts/lint-css-classes.test.mjs`, `scripts/lint-protocol-routes.test.mjs`, `scripts/lint-law-registry.test.mjs`, `scripts/lint-engine-conformance.test.mjs`, `scripts/lint-engine-conformance-registry.test.mjs`, `scripts/check-mobile-native-state.test.mjs`, `scripts/check-share-reachability.test.mjs`, `scripts/lint-hermes-array-surface.test.mjs`, `scripts/security/dast-scan.test.mjs`, `scripts/security/rust-supply-chain.test.mjs`, `scripts/security/unsafe-edge-audit.test.mjs`, `scripts/security/supply-chain-core.test.mjs`, `scripts/security/dependency-behaviour.test.mjs`, `tests/agent-e2e-compat/lib/skew.test.mjs`, `tests/agent-e2e-compat/lib/upgrade.test.mjs`, `scripts/check-ledgers.test.mjs`, `scripts/check-comment-density-ratchet.test.mjs`, `scripts/lint-app-conformance.test.mjs`, `scripts/lint-product.test.mjs`, `scripts/validate-ui-receipt.test.mjs`, `scripts/ci/gate-classes.test.mjs`, `scripts/ci/gate-stamp.test.mjs`, `scripts/ci/run-gates.test.mjs`, `scripts/ci/turbo.test.mjs`, `scripts/lint-test-reachability.test.mjs`, `scripts/lint-no-nul-bytes.test.mjs`, `scripts/design-gallery-browser.test.mjs`, `scripts/ci/work-counter-gate.test.mjs`, `scripts/lint-journey-ledger.test.mjs`, `scripts/ci/paired-journeys.test.mjs`, `scripts/ci/bisect-journeys.test.mjs`, `scripts/perf/app-waterfall.test.mjs`
- `bun run governance:law:test`

## Changed paths

- `tsconfig.node.json`
- `scripts/tsconfig.json`
- `scripts/tsconfig.pricing.json`
- `package.json`
- `scripts/lint-types.sh`
- `scripts/lint-tsconfigs.mjs`
- `scripts/lint-tsconfigs.test.mjs`
- `docs/toolchain.md`
- `README.md`
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`

## Audit

| Check | Verdict | Notes |
| --- | --- | --- |
| What changed faithfully describes the diff | PASS | Compiler profile, two scripts programs, typecheck wiring, lint-types source_ignore, lint-tsconfigs membership tests, toolchain/README/CHANGELOG match the staged paths. |
| NodeNext program does not typecheck package src | PASS | `tsc -p scripts --listFiles` has 0 `packages/server/src` and 0 `packages/*/src` hits; three scripts `.ts` files only. |
| Extra program is reached by typecheck | PASS | Root `typecheck` and `typecheck:affected` run `tsc -p scripts/tsconfig.pricing.json`. |
| Gates not weakened | PASS | No allowlist/budget/strictness edits; law estate untouched. |

Verdict: PASS

## Slice 1 — `scripts/lib` to TypeScript

Converted `disabled-controls`, `journey-ledger`, `sanitize-connector-svg` and its `node --test` file. Relative first-party imports use `.ts`. JSON from `tests/journeys.json` is parsed as `unknown` and narrowed at `journeyEntry`. Still-`.mjs` consumers import the `.ts` paths. `scripts:test` names `scripts/lib/sanitize-connector-svg.test.ts`.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `tsc -p scripts --listFiles` includes all four `scripts/lib/*.ts` files. `packages/*/src` count: 0.

```sh
node --test scripts/lib/sanitize-connector-svg.test.ts
```

6 pass, 0 fail.

```sh
node --test scripts/lint-engine-conformance.test.mjs
```

38 pass, 0 fail (imports `./lib/disabled-controls.ts`).

```sh
bun run lint
```

0 warnings, 0 errors. `sanitize-connector-svg.test.ts` carries file-level `vitest/*` disables: oxlint's vitest glob matches `*.test.ts` but this file is a `node --test` lane.

### Paths this slice

- `scripts/lib/disabled-controls.ts` (from `.mjs`)
- `scripts/lib/journey-ledger.ts` (from `.mjs`)
- `scripts/lib/sanitize-connector-svg.ts` (from `.mjs`)
- `scripts/lib/sanitize-connector-svg.test.ts` (from `.mjs`)
- `scripts/lint-engine-conformance.mjs`
- `scripts/lint-engine-conformance.test.mjs`
- `scripts/fetch-connector-brand-icons.mjs`
- `scripts/perf/app-waterfall.mjs`
- `scripts/perf/app-weight.mjs`
- `scripts/perf/send-to-first-token.mjs`
- `scripts/ci/paired-journeys.mjs`
- `tests/agent-e2e-mobile/flows/scroll-frames.mjs`
- `tests/journeys.json` (`_comment` reader path)
- `package.json`
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`

## Slice 2a — small `scripts/ci` cluster

Converted `governance-run`, `lockfile-lint`, `node-version`, `turbo` (+ test), `run-slug` (+ test), `hygiene-gates` (+ test). `governance-run` still imports leftover `gate-stamp.mjs`. `hygiene-gates` still asserts `ci.yml` runs `osv-lockfile-scan.mjs` (not in this cluster). `turbo-cache-report.mjs` imports `./turbo.ts`. Direct-run guard on `run-slug` matches `.ts`.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `listFiles` includes the nine converted cluster files. `packages/*/src` count: 0.

```sh
node --test scripts/ci/turbo.test.ts scripts/ci/run-slug.test.ts scripts/ci/hygiene-gates.test.ts
```

14 pass, 0 fail.

```sh
node scripts/ci/node-version.ts
```

`node-version: 24.4.1`

Remaining `scripts/ci/*.mjs`: 42.

## Slice 2b — blob / advisory / bisect cluster

Converted `report-cell-delta`, `assert-shard-blobs` (+ test), `advisory-expiry` (+ test), `rolling-issue-fallback-body` (+ test), `bisect-journeys` (+ test). `advisory-expiry` still imports leftover `../check-ledgers.mjs`. Direct-run usage strings match `.ts`. `package.json` (`coverage:merge`, `test:advisory-expiry`, `scripts:test`), `candidate.yml`, `e2e.yml`, `ci.yml` comments, `vitest.shard.config.ts`, and `docs/decisions.md` **G-split** follow. Inventory/quarantine `_comment` paths left as `.mjs` (ledger estate).

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `tsc -p scripts --listFiles` includes the nine converted cluster files. `packages/*/src` count: 0. Program size: 322 files.

```sh
node --test scripts/ci/assert-shard-blobs.test.ts scripts/ci/advisory-expiry.test.ts scripts/ci/rolling-issue-fallback-body.test.ts scripts/ci/bisect-journeys.test.ts
```

23 pass, 0 fail.

```sh
node scripts/ci/advisory-expiry.ts
```

`advisory-expiry: 2 advisory step(s) owned, dated and unexpired as of 2026-09-11`

Remaining `scripts/ci/*.mjs`: 33.

## Slice 2c — gate-stamp / run-gates cluster

Converted `gate-stamp` (+ test), `run-gates` (+ test), `work-counter-gate` (+ test), `collection-tripwire` (+ test). `governance-run` now imports `./gate-stamp.ts`. `gate-classes.test.mjs` stays `.mjs` and imports `./gate-stamp.ts`. Direct-run usage strings match `.ts`. `package.json` (`check:push`, `check:push:static`, `test:collection-tripwire`, `scripts:test`), `tests/perf/work-counters.perf.test.ts`, `work-counters.expected.json`, `docs/toolchain.md`, `docs/dev-environment.md`, `TESTING.md`, `QUALITY.md`, and `docs/decisions.md` **G-product-bundle** follow.
## Slice pkg-apps — workspace `apps/*/scripts` and `packages/*/scripts`

Converted maintained `.mjs` under `apps/{desktop,extension,web,mobile}/scripts` (including mobile `*.test.mjs`) and `packages/{server,blueprints,tunnel,backup}/scripts`. Did not convert `packages/server/src/**/*.mjs`, root `scripts/**`, e2e, law, or stryker configs. Relative first-party imports use `.ts`. `JSON.parse` is `unknown` and narrowed. No `any` / `@ts-nocheck` / `.mts`.

Each migrated file is in that workspace's typecheck program, not in root `tsc -p scripts`. Package `src` is not in those NodeNext scripts programs. Scripts that import `@centraid/design` use a bundler program with paths (desktop `tsconfig.copy-fonts.json`, extension `tsconfig.scripts.json`), same shape as `scripts/tsconfig.pricing.json`. Mobile scripts use ESNext/bundler because the app `package.json` is not `"type": "module"`. `bench-wal.ts` types live in `bench-wal-mods.ts` so the bench stays under the 625-line ceiling.

Workspace `package.json` invocations, knip `scripts/*.mjs` globs (`.ts` added, `.mjs` kept), `apps/mobile/vitest.projects.ts`, mobile `*.sh` `node …mjs` wrappers, root `perf:runtime-probe`, and `scripts/ci/paired-journeys.mjs` spawn path follow. Ledger `_comment` / `tests/journeys.json` identities left as `.mjs`.

### Compiler programs

| Program | Role |
| --- | --- |
| `apps/web/tsconfig.scripts.json` | NodeNext; web build/dev scripts |
| `apps/extension/tsconfig.scripts.json` | bundler + design src paths; Bun build/package |
| `apps/desktop/tsconfig.scripts.json` | NodeNext + DOM; screenshot scripts |
| `apps/desktop/tsconfig.copy-fonts.json` | bundler; `copy-fonts.ts` → design src |
| `apps/mobile/tsconfig.scripts.json` | ESNext/bundler; mobile scripts + tests |
| `packages/server/tsconfig.scripts.json` | NodeNext; excludes live-harness / probe-all-harnesses (already `.ts`, import `src`) |
| `packages/blueprints/tsconfig.scripts.json` | NodeNext |
| `packages/tunnel/tsconfig.scripts.json` | NodeNext |
| `packages/backup/tsconfig.scripts.json` | NodeNext |

`tsc -p scripts --listFiles` has 0 `apps/*/scripts` and 0 `packages/*/scripts` hits. `tsc -p packages/server/tsconfig.scripts.json --listFiles` has 0 `packages/server/src` hits.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `tsc -p scripts --listFiles` includes the eight converted cluster files. `packages/*/src` count: 0. Program size: 329 files.

```sh
node --test scripts/ci/gate-stamp.test.ts scripts/ci/run-gates.test.ts scripts/ci/work-counter-gate.test.ts scripts/ci/collection-tripwire.test.ts
```

29 pass, 0 fail.

Remaining `scripts/ci/*.mjs`: 25.

## Slice 2d — candidate / turbo-floor cluster

Converted `osv-lockfile-scan` (+ test), `resolve-candidate` (+ test), `write-candidate` (+ test), `turbo-floor` (+ test), `mutation-cap` (+ test), `turbo-cache-report` (+ test). Direct-run usage strings match `.ts`. `hygiene-gates` now asserts `ci.yml` runs `osv-lockfile-scan.ts`. `package.json` (`build:ci`, `build:ci:floored`, `scripts:test`), `ci.yml`, `e2e.yml`, `candidate.yml`, weekly resolve-candidate jobs, `SECURITY.md`, `docs/toolchain.md`, `docs/dev-environment.md`, and `docs/decisions.md` **G-mutation-cap** / **G-turbo-floor-waiver** follow.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `tsc -p scripts --listFiles` includes the twelve converted cluster files. `packages/*/src` count: 0. Program size: 341 files.

```sh
node --test scripts/ci/osv-lockfile-scan.test.ts scripts/ci/resolve-candidate.test.ts scripts/ci/write-candidate.test.ts scripts/ci/turbo-floor.test.ts scripts/ci/mutation-cap.test.ts scripts/ci/turbo-cache-report.test.ts
```

35 pass, 0 fail.

Remaining `scripts/ci/*.mjs`: 13.

## Slice 2e — remaining `scripts/ci` cluster

Converted `burn-in` (+ test), `configure-sonarcloud`, `file-tracking-issue` (+ test), `gate-classes.test`, `lane-health` (+ test), `lane-rules`, `paired-journeys` (+ test), `pr-gate-wall-clock` (+ test). Direct-run usage strings match `.ts`. `configure-sonarcloud` imports `node:process` instead of an empty `export {}` so `unicorn/require-module-specifiers` stays green. `package.json` (`scripts:test`), workflows (`ci.yml`, `candidate.yml`, `e2e.yml`, weekly filer/health/paired/sonar jobs), `tests/journeys.json` `_comment` paths, `SECURITY.md`, `TESTING.md`, `docs/toolchain.md`, `docs/dev-environment.md`, and `docs/decisions.md` **G-rolling-issues** / **G-lane-rules** / **G-pr-gate-budget** / **R-1005-25** follow. `tests/budgets.json` and `tests/quarantine.json` `_comment` paths left as `.mjs` (ledger estate). Live Sonar network skipped.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0. `tsc -p scripts --listFiles` includes the thirteen converted cluster files. `packages/*/src` count: 0. Program size: 356 files.

```sh
node --test scripts/ci/gate-classes.test.ts scripts/ci/paired-journeys.test.ts scripts/ci/pr-gate-wall-clock.test.ts scripts/ci/file-tracking-issue.test.ts scripts/ci/burn-in.test.ts scripts/ci/lane-health.test.ts
```

79 pass, 0 fail.

Remaining `scripts/ci/*.mjs`: 0.


tsc -p apps/web/tsconfig.scripts.json --noEmit
tsc -p apps/extension/tsconfig.scripts.json --noEmit
tsc -p apps/desktop/tsconfig.scripts.json --noEmit
tsc -p apps/desktop/tsconfig.copy-fonts.json --noEmit
tsc -p apps/mobile/tsconfig.scripts.json --noEmit
tsc -p packages/server/tsconfig.scripts.json --noEmit
tsc -p packages/blueprints/tsconfig.scripts.json --noEmit
tsc -p packages/tunnel/tsconfig.scripts.json --noEmit
tsc -p packages/backup/tsconfig.scripts.json --noEmit
```

All exit 0.

```sh
cd apps/mobile && bunx vitest run --project @centraid/mobile \
  scripts/ios-shell-cache.test.ts \
  scripts/js-bundle-fingerprint.test.ts \
  scripts/resolve-ios-simulator.test.ts \
  scripts/sqlite-vec-version.test.ts
```

31 pass, 0 fail.

```sh
bunx vitest run --project @centraid/server \
  packages/server/scripts/check-import-boundary.test.ts \
  packages/server/scripts/bench-support.test.ts
```

11 pass, 0 fail.

`verify-native-state.test.ts` unit cases other than the live L1 index sweep ran in the full scripts project (52 pass). The live L1 test (`trackedGeneratedNativeFiles()` empty) is red in this worktree because `git ls-files apps/mobile/{ios,android}` lists 60 paths; that is this checkout's index, not a conversion defect.

```sh
bun run format:check
bun run lint -- apps/desktop/scripts apps/extension/scripts apps/web/scripts apps/mobile/scripts packages/server/scripts packages/blueprints/scripts packages/tunnel/scripts packages/backup/scripts apps/mobile/vitest.projects.ts
```

Format matched. Lint 0 warnings, 0 errors.

Remaining `.mjs` in the owned trees: 0.

### Paths this slice

- `apps/desktop/scripts/*.ts` (from `.mjs`) + `tsconfig.scripts.json` + `tsconfig.copy-fonts.json`
- `apps/extension/scripts/*.ts` + `tsconfig.scripts.json`
- `apps/web/scripts/*.ts` + `tsconfig.scripts.json`
- `apps/mobile/scripts/*.{ts,sh}` + `tsconfig.scripts.json` + `vitest.projects.ts`
- `packages/server/scripts/*.ts` + `tsconfig.scripts.json`
- `packages/blueprints/scripts/*.ts` + `tsconfig.scripts.json`
- `packages/tunnel/scripts/*.ts` + `tsconfig.scripts.json`
- `packages/backup/scripts/bench-wal.ts` + `bench-wal-mods.ts` + `tsconfig.scripts.json`
- workspace `package.json` files, root `package.json` (`perf:runtime-probe` only), `knip.json`, `scripts/ci/paired-journeys.mjs`
- `CHANGELOG.md`, `receipts/issue-1018-mjs-to-ts.md`

## Slice e2e — agent-e2e harnesses and fixtures

Converted every `.mjs` under `tests/agent-e2e-mobile`, `tests/agent-e2e-pairing`, `tests/agent-e2e-compat`, `tests/agent-e2e-shared`, plus `apps/desktop/tests/e2e/electron-entry.ts`, `tests/perf/fixtures/gateway-idle-server.ts`, and the quality crash-child loader. `packages/server/src/acp/backends/acp/fake-acp-harness.mjs` is not in this lane. Remaining owned e2e `.mjs`: 0.

Oversized splits (under 625):

- `tests/agent-e2e-mobile/lib/harness.mjs` (1182) → `harness-surface.ts` (244), `harness-setup.ts` (241), `harness-maestro.ts` (322), `harness.ts` (555)
- `tests/agent-e2e-pairing/lib/docker-harness.mjs` (1181) → `docker-exec.ts` (380), `docker-isolation.ts` (358), `docker-harness.ts` (560)

`tests/inventory.json#fileSize` dropped the two split `.mjs` rows and lowered `_budget` 131 → 129 (the section's own split rule). `sleeps` renamed `pairing-ticket-hygiene.mjs` → `.ts` at the same count.

`kill-mid-write-child.mjs` was a type-stripping loader around `kill-mid-write-child.ts` (package-src `.js` specifiers). The body is `kill-mid-write-child-run.ts`; the loader is `kill-mid-write-child.ts`. Spawn still runs the loader.

Compiler: `tests/tsconfig.agent-e2e.json` extends `tsconfig.node.json` (NodeNext, `allowImportingTsExtensions`, `erasableSyntaxOnly`). Include is the four `tests/agent-e2e-*` globs. Exclude: `ci-gateway.ts` (package `dist/` imports), pairing `harness.ts` / `device-redeem.ts` / `docker-harness.ts` / pairing flows / `released-binary-skew.ts` (package `dist/` / `@centraid/tunnel`), and `**/*.test.ts` (vitest + `@centraid/test-kit`). The DOM `tests/tsconfig.json` program excludes the NodeNext crash-child loader. Root `typecheck` and `typecheck:affected` run `tsc -p tests/tsconfig.agent-e2e.json`. `lint-tsconfigs` ROOT_TOOLING_PROGRAMS requires that needle when `tests/agent-e2e-shared/harness.ts` exists.

### Verification

```sh
tsc -p tests --noEmit
```

Exit 0.

```sh
tsc -p tests/tsconfig.agent-e2e.json --noEmit
```

Exit 0.

```sh
tsc -p tests/tsconfig.agent-e2e.json --listFiles --pretty false
```

Non-lib members: 48. `packages/*/src` count: 0. `packages/server/src` count: 0.

```sh
node --test tests/agent-e2e-compat/lib/skew.test.ts tests/agent-e2e-compat/lib/upgrade.test.ts
```

22 pass, 0 fail.

```sh
node --test scripts/lint-e2e-flows.test.mjs scripts/lint-e2e-wiring.test.mjs scripts/lint-tsconfigs.test.mjs
```

51 pass, 0 fail.

```sh
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts tests/agent-e2e-shared/harness.test.ts tests/agent-e2e-mobile/lib/harness-prefix.test.ts tests/agent-e2e-mobile/lib/sh-quote.test.ts tests/agent-e2e-mobile/lib/roster.test.ts tests/agent-e2e-mobile/lib/spawn-redaction.test.ts tests/agent-e2e-mobile/lib/failure-class.test.ts tests/agent-e2e-mobile/lib/run-ledger.test.ts tests/agent-e2e-mobile/lib/metro.test.ts
```

85 pass, 0 fail. Full device e2e farm not run.

### Paths this slice

- `tests/tsconfig.agent-e2e.json`
- `tests/agent-e2e-mobile/**/*.ts` (from `.mjs`; harness split)
- `tests/agent-e2e-pairing/**/*.ts` (from `.mjs`; docker-harness split)
- `tests/agent-e2e-compat/**/*.ts`
- `tests/agent-e2e-shared/**/*.ts`
- `apps/desktop/tests/e2e/electron-entry.ts`
- `tests/perf/fixtures/gateway-idle-server.ts`
- `tests/quality/fixtures/kill-mid-write-child.ts` (loader) + `kill-mid-write-child-run.ts` (body)
- `tests/agent-e2e-mobile/roster.json`
- `tests/claims.json` (owner paths)
- `package.json` (`typecheck`, `typecheck:affected`, `scripts:test` two entries)
- `scripts/test-report/vitest.config.ts` (include lines)
- e2e suffix matchers: `scripts/lint-e2e-flows.mjs`, `scripts/lint-e2e-wiring*.mjs`, `scripts/lint-e2e-claims.mjs`, `scripts/lint-mobile-testids.mjs`, `scripts/lint-tsconfigs.mjs`
- spawn: `apps/desktop/tests/e2e/fixtures.ts`, `tests/quality/kill-mid-write.integration.test.ts`, `tests/perf/gateway-request.perf.test.ts`, `apps/mobile/scripts/*.sh`, `.github/workflows/{e2e,candidate,ci,extension-e2e,mobile-alarm-test}.yml`
- `scripts/test-report/derive.mjs` (`roster.ts` + dual-suffix `flowId`), `validate-nightly-wiring.mjs`, `validate-report-registries.mjs`, `sleep-inventory.mjs`, `skip-inventory.mjs`
- `tests/inventory.json` (fileSize split rows + sleeps path)
- `oxlint.config.ts`, `TESTING.md`, `docs/toolchain.md`, `CHANGELOG.md`, `receipts/issue-1018-mjs-to-ts.md`

### Audit

| Check | Verdict | Notes |
| --- | --- | --- |
| Owned e2e `.mjs` remaining | PASS | 0 |
| Oversized split under 625 | PASS | fileSize `_budget` 131 → 129; no new exemption rows |
| NodeNext program does not typecheck package src | PASS | listFiles `packages/*/src` = 0 |
| Extra program reached by typecheck | PASS | both root typecheck scripts |
| Gates not weakened | PASS | dual `.mjs`/`.ts` suffix matchers; no allowlist/budget cuts |
## Slice tooling — release / security / fuzz / mutation / perf / gateway / docs-site / golden-vault / web

Converted the remaining owned tooling trees from `.mjs` to TypeScript (NodeNext, `JSON.parse` as `unknown`, `import type`, no `any` / `@ts-nocheck` / enums). `scripts/release/vitest.config.ts` includes `**/*.test.ts` and excludes `surfaces.test.ts` (still `node --test`). `scripts/fuzz/vitest.config.ts` includes `**/*.test.ts`. `scripts/perf/app-waterfall.run.ts` (and the other package-source importers: `app-waterfall.ts` / `.test.ts`, `send-to-first-token.ts`, release tests that import `@centraid/test-kit`) stay out of the NodeNext program so `tsc -p scripts --listFiles` has 0 `packages/*/src`.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0.

```sh
tsc -p scripts --listFiles --pretty false
```

397 files. `packages/server/src` count: 0. `packages/*/src` count: 0.

```sh
node node_modules/vitest/vitest.mjs run --config scripts/release/vitest.config.ts
```

6 files, 53 pass.

```sh
node --test scripts/release/surfaces.test.ts scripts/gateway-npm/*.test.ts scripts/gateway-package/*.test.ts scripts/security/*.test.ts
```

107 pass, 1 skip (`assemble-runtime` needs gateway dist), 1 inherited fail (`assemble-runtime` closure now sees `packages/server -> packages/model-runtime` — same assertion as HEAD). `scripts/perf/app-waterfall.test.ts` cannot import `@centraid/core/protocol` without package `dist/` (inherited; this worktree has no `packages/*/dist`).

```sh
node node_modules/vitest/vitest.mjs run --config scripts/fuzz/vitest.config.ts
```

4 pass, 10 fail: missing `packages/*/dist` (`bun run build` first). Inherited, same as HEAD.

```sh
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts scripts/mutation/run.test.ts
```

18 pass.

### Paths this slice

- `scripts/release/**/*.ts` (from `.mjs`)
- `scripts/security/**/*.ts` (from `.mjs`)
- `scripts/fuzz/**/*.ts` (from `.mjs`)
- `scripts/mutation/**/*.ts` (from `.mjs`)
- `scripts/perf/{app-waterfall,app-weight,run-waterfall,send-to-first-token,summarize}.ts` (from `.mjs`)
- `scripts/gateway-npm/**/*.ts` (from `.mjs`)
- `scripts/gateway-package/**/*.ts` (from `.mjs`)
- `scripts/docs-site/{assemble,build,smoke}.ts` (from `.mjs`)
- `scripts/golden-vault/build.ts` (from `.mjs`)
- `scripts/web/smoke.ts` (from `.mjs`)
- `package.json`, workflows, Dockerfile, `scripts/tsconfig.json`
- `tests/claims.json`, `tests/journeys.json`, `tests/inventory.json`
- `scripts/test-report/{derive,skip-inventory,validate-app-axes,validate-nightly-wiring}.mjs`, `scripts/test-report/vitest.config.ts`
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`

## Lane MCP — vault stdio proxy + fake ACP harness

Converted the shipped vault MCP stdio proxy to TypeScript so `tsc -p packages/server/tsconfig.json` emits `dist/acp/backends/acp/vault-mcp-stdio-proxy.js`. Removed the verbatim `cp …vault-mcp-stdio-proxy.mjs` from the server build. `vaultMcpStdioProxyPath()` prefers the sibling `.js` emit, refuses raw TypeScript under `node_modules`, and falls back to the `.ts` sibling only for in-repo `node` type stripping.

Converted `fake-acp-harness.mjs` to TypeScript and split vault MCP client/parity into `fake-acp-harness-vault.ts` (562 + 286 lines, both under the 625 ceiling). The fixture is excluded from the emit program (not shipped) and spawned as `.ts`. `tests/inventory.json#fileSize` still names the old `.mjs` path (ledger estate, not this lane).

### Verification

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node packages/server/src/acp/backends/acp/fake-acp-harness.ts --mode=normal
```

JSON-RPC initialize result from `fake-acp`.

```sh
cd packages/server && bunx vitest run \
  src/acp/backends/acp/turn-vault-tools.test.ts \
  src/acp/backends/acp/backend.test.ts \
  src/acp/backends/acp/backend.vault-tools.test.ts \
  src/acp/backends/acp/backend.attachments.test.ts \
  src/acp/backends/acp/backend.model-usage.test.ts \
  src/acp/backends/acp/enumerate-models.test.ts \
  src/acp/backends/acp/capabilities-cache.test.ts \
  src/acp/backends/acp/journey.integration.test.ts \
  src/acp/backends/acp/blueprint-harness-parity.integration.test.ts \
  src/acp/preflight.test.ts
```

10 files, 102 pass, 0 fail.

Isolated `tsc` emit of `vault-mcp-stdio-proxy.ts` keeps the shebang and writes JS. After workspace `dist/` is present, `tsc -p packages/server/tsconfig.test.json --noEmit` has no diagnostics on the proxy, harness, or `turn-vault-tools` files. The server build emits `dist/acp/backends/acp/vault-mcp-stdio-proxy.js` and does not emit the fake harness.

### Paths this slice

- `packages/server/src/acp/backends/acp/vault-mcp-stdio-proxy.ts` (from `.mjs`)
- `packages/server/src/acp/backends/acp/fake-acp-harness.ts` (from `.mjs`)
- `packages/server/src/acp/backends/acp/fake-acp-harness-vault.ts`
- `packages/server/src/acp/backends/acp/turn-vault-tools.ts`
- `packages/server/src/acp/backends/acp/turn-vault-tools.test.ts`
- `packages/server/src/acp/backends/acp/test-fixtures.ts`
- `packages/server/src/acp/backends/acp/enumerate-models.test.ts`
- `packages/server/src/acp/backends/acp/journey.integration.test.ts`
- `packages/server/src/acp/prompt-injection/harness.ts`
- `packages/server/package.json`
- `packages/server/tsconfig.json`
- `vitest.config.ts`
- `knip.json`
- `scripts/perf/send-to-first-token.mjs`
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`

## Slice 3 — `scripts/test-report` to TypeScript

Converted the whole `scripts/test-report` tree (76 `.mjs` → `.ts`, plus `record.ts` and the `ratchet-floors` split `ratchet-budget.ts`). `derive-flows.mjs` remains as a thin CLI shim so the constitution's `coverage-scope-reachability` directive (`node scripts/test-report/derive-flows.mjs --json`) still has a file. NodeNext types by hand: `JSON.parse` stays `unknown`, then `dict` / `bags` / `items` / `finite` from `record.ts`. No `type Loose = any`. `match.groups` is optional. `ratchet-floors.ts` stays under the 625-line ceiling.

`scripts/tsconfig.json` excludes the test-report files that import `@centraid/test-kit` (same reason as `app-waterfall.run.ts`) so `tsc -p scripts --listFiles` does not pull `packages/test-kit/src`. Vitest still runs those files. Root `package.json` test-report scripts, the workflows that invoke them, `apps/web` / `apps/desktop` prepare steps, `scripts/check-ledgers.mjs`, and `scripts/lint-e2e-wiring.mjs` now name `.ts` paths. Vitest include is `**/*.test.ts`.

Lane branch: `issue-1018-lane-test-report`. Merged into `issue-1018-mjs-to-ts`.
## Lane root scripts — remaining `scripts/*.mjs` → TypeScript

Converted the remaining root `scripts/*.mjs` gates (ledgers, product lints, design gallery, engine conformance, share reachability, hygiene, install-gateway) to TypeScript with Node native type stripping. `JSON.parse` is `unknown` then narrowed. Params are annotated outside destructuring. `import type` for type-only names. No `any`, `@ts-nocheck`, `.mts`, or enums.

`lint-engine-conformance` (1554 lines) split under the 625-line ceiling into `kit` / `overlay` / `surface` / `writes` plus the main scanner. `check-ledgers` and `lint-container-opacity` split the same way. Design-gallery / site-tokens stay out of the NodeNext program (`scripts/tsconfig.design.json`) because they import `packages/design/src`.

Not converted: `scripts/lint-oversized-files.mjs` and `scripts/lint-types-rules.mjs` (oxlint.config.ts law imports); `scripts/test-report/**` (already TypeScript on the umbrella; this branch only retargeted comments/imports at converted files). `tests/inventory.json` untouched. `.heic`/`.heif` join `BINARY_EXTS` so preview fixtures are not scanned as text.

### Verification

```sh
tsc -p scripts --noEmit
```

Exit 0.

```sh
tsc -p scripts --listFiles --pretty false
```

403 files. `packages/*/src` count: 0. `scripts/test-report/**/*.mjs` count: 0.

```sh
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts
```

37 files, 518 tests, 0 fail.

## Lane configs — Astro + Stryker to TypeScript

Converted `astro.config.mjs` → `astro.config.ts` and every `packages/**` / `apps/**` `stryker.config.mjs` / `stryker.*.config.mjs` → `.ts` (not `.mts`). Export default shape is unchanged. Catalog and filename tests follow: `scripts/mutation/seeds.ts`, `scripts/mutation/run.test.ts` regex, `scripts/docs-site/build.ts --config`, `apps/oauth-worker/src/mutation-range.test.ts`, plus `deriveStrykerConfigs` / its tests.

CJS packages (`packages/design`, `apps/mobile`) cannot `export default` under the NodeNext scripts program (`verbatimModuleSyntax` TS1295). Membership is `scripts/tsconfig.tool-configs.json` (extends `tsconfig.base.json`, bundler/Preserve, no package src). Root `typecheck` / `typecheck:affected` run `tsc -p scripts/tsconfig.tool-configs.json`. `lint:tsconfigs` requires that program when `astro.config.ts` exists.

Lane branch: `issue-1018-lane-configs`. Merged into `issue-1018-mjs-to-ts`.

### Verification

`bunx astro --version` → astro v7.1.5. `tsc -p scripts --noEmit` exit 0 (`packages/*/src` 0). `tsc -p scripts/tsconfig.tool-configs.json --noEmit` exit 0; `--listFiles` is `astro.config.ts` + 25 `stryker*.config.ts`, no package src. Vitest `run.test.ts` + `derive.test.ts` + `diff-coverage.test.ts`: 36 pass. `node --test scripts/lint-tsconfigs.test.mjs`: 19 pass. `lint:tsconfigs`, `format:check`, `lint` clean.

`docs:build` and full mutation were not run. oauth-worker `mutation-range.test.ts` still fails on inherited line-range drift (`889-969` vs `validEnvironment` at 887); not introduced by the rename.

### Paths this slice

`astro.config.ts`; every `packages/**` / `apps/**` `stryker*.config.ts`; `scripts/mutation/{seeds,run,run.test}.ts`; `scripts/docs-site/build.ts`; `scripts/test-report/{derive,derive.test,diff-coverage.test}.ts`; `apps/oauth-worker/src/mutation-range.test.ts`; `scripts/tsconfig.tool-configs.json`; `scripts/lint-tsconfigs.mjs`; `scripts/lint-tsconfigs.test.mjs`; `package.json`; `CHANGELOG.md`; this receipt.

`packages/*/src` count: 0.

```sh
tsc -p scripts/tsconfig.design.json --noEmit
```

Exit 0.

```sh
node --test scripts/lint-no-nul-bytes.test.ts scripts/lint-app-conformance.test.ts scripts/lint-e2e-flows.test.ts scripts/lint-test-reachability.test.ts scripts/check-ledgers.test.ts scripts/check-comment-density-ratchet.test.ts scripts/lint-product.test.ts scripts/validate-ui-receipt.test.ts scripts/lint-path-filters.test.ts scripts/lint-tsconfigs.test.ts scripts/lint-turbo-cache.test.ts scripts/lint-workflow-pins.test.ts
```

161 pass, 0 fail.

```sh
node --test scripts/lint-e2e-wiring.test.ts scripts/lint-mobile-testids.test.ts scripts/lint-vault-sql.test.ts scripts/check-mobile-suite-budgets.test.ts scripts/lint-css-classes.test.ts scripts/lint-protocol-routes.test.ts scripts/lint-law-registry.test.ts scripts/check-mobile-native-state.test.ts scripts/check-share-reachability.test.ts scripts/lint-hermes-array-surface.test.ts scripts/lint-design-tokens.test.ts scripts/lint-mobile-design.test.ts scripts/lint-logical-insets.test.ts scripts/lint-hairline.test.ts
```

142 pass, 0 fail.

```sh
node --test scripts/lint-engine-conformance.test.ts scripts/lint-engine-conformance-registry.test.ts scripts/lint-journey-ledger.test.ts scripts/ci/gate-classes.test.ts
```

61 pass, 0 fail.

```sh
node --test scripts/design-gallery-fidelity.test.ts scripts/design-gallery-browser.test.ts
```

38 pass, 0 fail.

```sh
bun run format && bun run lint
```

0 warnings, 0 errors.

Remaining root `scripts/*.mjs`: `lint-oversized-files.mjs`, `lint-types-rules.mjs`.

### Paths this slice

- Remaining root `scripts/*.mjs` → `.ts` (except the two oxlint law imports)
- `scripts/lint-engine-conformance-{kit,overlay,surface,writes}.ts`
- `scripts/check-ledgers-{serialize,sections}.ts`
- `scripts/lint-container-opacity-mobile.ts`
- `scripts/design-gallery-{serve,fidelity-types}.ts`, `scripts/site-tokens-rules.ts`, `scripts/tsconfig.design.json`
- `package.json`, workflows, `scripts/lint-types.sh`, `scripts/install-gateway.sh`, `oxfmt.config.ts`
- `tests/claims.json`, `tests/journeys.json` (owner path follow-ups)
- `scripts/test-report/*.mjs` (import/comment retargets only)
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`

## Lane leftovers — oxlint-imported scripts + derive-flows CLI

Deleted the `scripts/test-report/derive-flows.mjs` CLI shim. The constitution's `coverage-scope-reachability` directive and check now shell out to `node scripts/test-report/derive-flows.ts --json`. `oxlint.config.ts` is untouched (law). `scripts/lint-oversized-files.ts` and `scripts/lint-types-rules.ts` are in the NodeNext `scripts` program; tiny `.mjs` re-export shims keep the law imports working until a later law commit retargets them. `JSON.parse` of the file-size ledger is `unknown` then narrowed. Rule catalogs are `string[]`. No type-only imports to write as `import type`. No `any`.

`.governance` was not converted; only `coverage-scope-reachability/check.sh` was retargeted at the `.ts` CLI.

Lane branch: `issue-1018-lane-leftovers`.

### Verification

```sh
tsc -p scripts --noEmit
```

### Paths this slice

- `scripts/test-report/derive-flows.ts` (CLI; `.mjs` shim deleted)
- `scripts/lint-oversized-files.ts` + `.mjs` re-export shim
- `scripts/lint-types-rules.ts` + `.mjs` re-export shim
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh` (path retarget only)
- `CONSTITUTION.md`, `TESTING.md`, `docs/decisions.md`, `docs/coding-standards.md`
- `scripts/lint-types.sh`, `scripts/lint-types-policy.ts`, `scripts/lint-law-registry.ts`
- `CHANGELOG.md`
- `receipts/issue-1018-mjs-to-ts.md`
