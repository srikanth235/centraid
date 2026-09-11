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

## Slice 3 — `scripts/test-report` to TypeScript

Converted the whole `scripts/test-report` tree (76 `.mjs` → `.ts`, plus `record.ts` and the `ratchet-floors` split `ratchet-budget.ts`). `derive-flows.mjs` remains as a thin CLI shim so the constitution's `coverage-scope-reachability` directive (`node scripts/test-report/derive-flows.mjs --json`) still has a file. NodeNext types by hand: `JSON.parse` stays `unknown`, then `dict` / `bags` / `items` / `finite` from `record.ts`. No `type Loose = any`. `match.groups` is optional. `ratchet-floors.ts` stays under the 625-line ceiling.

`scripts/tsconfig.json` excludes the test-report files that import `@centraid/test-kit` (same reason as `app-waterfall.run.ts`) so `tsc -p scripts --listFiles` does not pull `packages/test-kit/src`. Vitest still runs those files. Root `package.json` test-report scripts, the workflows that invoke them, `apps/web` / `apps/desktop` prepare steps, `scripts/check-ledgers.mjs`, and `scripts/lint-e2e-wiring.mjs` now name `.ts` paths. Vitest include is `**/*.test.ts`.

Lane branch: `issue-1018-lane-test-report`. Not merged into the umbrella.

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

