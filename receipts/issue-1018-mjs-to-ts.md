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
