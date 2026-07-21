# issue-495 — reduce workspace count and eliminate the remaining knip suppressions

18 workspaces (15 packages + 3 apps) carried more structure than v0 needs.
Three packages existed without a boundary that paid for itself, and knip still
carried two `ignoreDependencies` suppressions. This folds each package into its
sole consumer and resolves both suppressions at their root, so the tree is
**15 workspaces (12 packages + 3 apps)** and `knip.json` has **zero dependency
suppressions**.

## Checklist

- [x] packages/skills is folded into packages/gateway as src/skills and the package is deleted.
- [x] packages/data-plane is folded into packages/tunnel as a Rust-only crate and stops being a Bun workspace.
- [x] packages/tsconfig is folded into root tsconfig files and the package is deleted.
- [x] The @centraid/test-kit knip suppression is eliminated by relocating its only gateway/vault-coupled file to tests/helpers and declaring test-kit in every consumer.
- [x] The pagefind knip suppression is eliminated by using the pagefind Node API instead of bun x pagefind.
- [x] knip.json carries zero ignoreDependencies and the full gate stays green.

## What changed

**skills → gateway.** packages/skills is folded into packages/gateway as
src/skills and the package is deleted. The five source files moved to
`packages/gateway/src/skills/` (`index.ts`, `compose.ts`, `compose.test.ts`,
`authoring-prompt.ts`, `ui-grounding.ts`) and the two `SKILL.md` catalogs to
`packages/gateway/skills/` (`authoring-centraid-apps/`, `automation-authoring/`).
`compose.ts`'s `skillsDir()` was re-pointed to `../../skills` so it resolves
identically from `src` (vitest) and `dist` (daemon), and `"skills"` was added to
the gateway package.json `files` allow-list. Gateway's `unified-conversation-runner.ts`
imports `../skills/index.js`; comment pointers in `agents-routes.ts` and
`app-engine/src/conversation/runner-core.ts` were updated. `@centraid/skills`
was removed from gateway deps (`@centraid/design-tokens` added, previously
transitive), and the `packages/skills` project was dropped from `vitest.config.ts`
and `scripts/lint-types.sh`. Deleted: `packages/skills/{README.md,package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts}`.

**data-plane → tunnel.** packages/data-plane is folded into packages/tunnel as a
Rust-only crate and stops being a Bun workspace. The crate moved to
`packages/tunnel/data-plane/` (Cargo.toml, Cargo.lock, README.md, all `src/*.rs`,
`tests/golden.rs`, `fixtures/`, `scripts/`); deleting its `package.json` removed
it from the `packages/*` Bun workspace glob while the Cargo crate name
`centraid-data-plane` is preserved. `packages/tunnel/native/Cargo.toml`'s path dep
is now `../data-plane`. The old data-plane test/lint scripts were ported into
`packages/tunnel/package.json` (`test:data-plane`, `build:data-plane`,
`lint:data-plane`, a top-level `lint` so `turbo lint` still runs cargo fmt/clippy).
`.github/workflows/ci.yml` cache paths and the verify-lane
`bun run --cwd packages/tunnel test:data-plane` were repointed, and the stale
`e2e.yml` build-filter comment was refreshed. The two Node-side golden tests that
read `format-golden.json` — `packages/backup/src/rust-golden.test.ts` and
`packages/vault/src/rust-golden.test.ts` — had their fixture `new URL(...)` paths
repointed from `../../data-plane/fixtures/` to `../../tunnel/data-plane/fixtures/`
so the cross-language golden still resolves after the crate moved.

**tsconfig → root.** packages/tsconfig is folded into root tsconfig files and the
package is deleted. `base.json`/`electron.json`/`expo.json` moved to root as
`tsconfig.base.json`/`tsconfig.electron.json`/`tsconfig.expo.json` (nothing in
them was location-sensitive — pure compilerOptions), with the inter-file
`extends` fixed to `./tsconfig.base.json`. All 19 consuming tsconfigs
(`packages/*/tsconfig*.json`, `apps/*/tsconfig*.json` at `../../`, `tests/tsconfig.json`
at `../`) were repointed, `@centraid/tsconfig` was removed from 15 package.jsons,
and the workspace deleted. The root `"."` knip workspace gained
`ignoreUnresolved: ["react","react-native"]` because `tsconfig.expo.json`'s
`types` are now scanned at the root.

**test-kit suppression eliminated.** The @centraid/test-kit knip suppression is
eliminated by relocating its only gateway/vault-coupled file to tests/helpers
and declaring test-kit in every consumer. `factories.ts` (the sole file importing
`@centraid/gateway`/`@centraid/vault`, and consumed only by root `tests/`) moved
to `tests/helpers/factories.ts`; its three consumers (`tests/perf/vault-write.perf.test.ts`,
`tests/scale/backup-restore.scale.test.ts`, `tests/scale/ontology.scale.test.ts`)
import it relatively, and its now-redundant smoke test was dropped from
`packages/test-kit/src/test-kit.test.ts`. test-kit thus becomes a zero-workspace-dep
leaf (gateway/vault removed from its package.json), and `@centraid/test-kit: workspace:*`
was declared as a devDependency in all 12 consumers (`apps/{desktop,mobile,web}`,
`packages/{agent-runtime,app-engine,automation,backup,blueprints,client,gateway,tunnel,vault}`).
This removes the cycle that previously forced the ignore (test-kit sat atop the
graph depending on gateway/vault).

**pagefind suppression eliminated.** The pagefind knip suppression is eliminated
by using the pagefind Node API instead of bun x pagefind. `scripts/docs-site/build.mjs`
now `import * as pagefind from 'pagefind'` and calls `createIndex({ forceLanguage:
'en', includeCharacters: '._:/<>-' })` → `addDirectory({ path: outDir })` →
`writeFiles({ outputPath })` → `close()`, at exact flag parity with the old CLI
call. The dependency is now a traceable import the lockfile pins.

**Result.** knip.json carries zero ignoreDependencies and the full gate stays green.
The `ignoreDependencies` key was removed entirely, and both `ignoreWorkspaces`
entries (data-plane, tsconfig) are gone.

## Full file inventory

Skills fold: `packages/gateway/src/skills/index.ts`, `packages/gateway/src/skills/compose.ts`,
`packages/gateway/src/skills/compose.test.ts`, `packages/gateway/src/skills/authoring-prompt.ts`,
`packages/gateway/src/skills/ui-grounding.ts`, `packages/gateway/skills/authoring-centraid-apps/SKILL.md`,
`packages/gateway/skills/automation-authoring/SKILL.md`, `packages/gateway/package.json`,
`packages/gateway/src/runs/unified-conversation-runner.ts`, `packages/gateway/src/routes/agents-routes.ts`,
`packages/app-engine/src/conversation/runner-core.ts`, `vitest.config.ts`, `scripts/lint-types.sh`,
`packages/skills/README.md`, `packages/skills/package.json`, `packages/skills/tsconfig.json`,
`packages/skills/tsconfig.test.json`, `packages/skills/vitest.config.ts`.

Data-plane fold: `packages/tunnel/data-plane/Cargo.toml`, `packages/tunnel/data-plane/Cargo.lock`,
`packages/tunnel/data-plane/README.md`, `packages/tunnel/data-plane/fixtures/format-golden.json`,
`packages/tunnel/data-plane/scripts/generate-golden.ts`, `packages/tunnel/data-plane/src/cbsf.rs`,
`packages/tunnel/data-plane/src/format.rs`, `packages/tunnel/data-plane/src/http_plane.rs`,
`packages/tunnel/data-plane/src/http_plane_tests.rs`, `packages/tunnel/data-plane/src/iroh_relay.rs`,
`packages/tunnel/data-plane/src/iroh_wire.rs`, `packages/tunnel/data-plane/src/lib.rs`,
`packages/tunnel/data-plane/src/main.rs`, `packages/tunnel/data-plane/src/ticket.rs`,
`packages/tunnel/data-plane/tests/golden.rs`, `packages/tunnel/native/Cargo.toml`,
`packages/tunnel/package.json`, `packages/data-plane/package.json`, `.github/workflows/ci.yml`,
`.github/workflows/e2e.yml`, `packages/backup/src/rust-golden.test.ts`,
`packages/vault/src/rust-golden.test.ts`.

Tsconfig fold: `tsconfig.base.json`, `tsconfig.electron.json`, `tsconfig.expo.json`,
`packages/tsconfig/package.json`, `tests/tsconfig.json`,
`apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.react.json`, `apps/mobile/tsconfig.json`,
`apps/web/tsconfig.json`, `packages/agent-runtime/tsconfig.json`, `packages/app-engine/tsconfig.json`,
`packages/automation/tsconfig.json`, `packages/backup/tsconfig.json`, `packages/blob-format/tsconfig.json`,
`packages/blueprints/tsconfig.json`, `packages/blueprints/tsconfig.apps.json`, `packages/blob-format/package.json`, `packages/client/tsconfig.json`,
`packages/design-tokens/tsconfig.json`, `packages/gateway/tsconfig.json`, `packages/test-kit/tsconfig.json`,
`packages/tunnel/tsconfig.json`, `packages/vault/tsconfig.json`.

test-kit + pagefind: `tests/helpers/factories.ts`, `packages/test-kit/package.json`,
`packages/test-kit/src/test-kit.test.ts`, `tests/perf/vault-write.perf.test.ts`,
`tests/scale/backup-restore.scale.test.ts`, `tests/scale/ontology.scale.test.ts`,
`scripts/docs-site/build.mjs`, `apps/desktop/package.json`, `apps/mobile/package.json`,
`apps/web/package.json`, `packages/agent-runtime/package.json`, `packages/app-engine/package.json`,
`packages/automation/package.json`, `packages/backup/package.json`, `packages/blueprints/package.json`,
`packages/client/package.json`, `packages/vault/package.json`.

Config + docs: `knip.json`, `AGENTS.md`, `ARCHITECTURE.md`, `README.md`,
`docs/glossary.md`, `docs/plans/gateway-low-end-and-rust-plane.md`,
`packages/design-tokens/package.json`.

## Decisions

- **Each package folded into its sole consumer, not merged arbitrarily.** skills,
  data-plane, and tsconfig each had exactly one real consumer (gateway, tunnel,
  the root respectively), so the fold loses no boundary. `agent-runtime`,
  `blob-format`, `backup`, `automation`, `tunnel`, `design-tokens`, and
  `test-kit` were deliberately kept — they have multiple consumers or a genuine
  domain/native-build boundary.
- **factories.ts was relocated, not test-kit split.** The only gateway/vault
  coupling in test-kit was one file consumed solely by root `tests/`. Moving it
  to `tests/` (already able to depend on gateway/vault, and knip-ignored) severs
  the cycle without a package split. The relocated file's `createTestVault` smoke
  test was dropped as redundant — the three perf/scale tests that call the factory
  fail if it breaks.
- **pagefind via Node API, not a resolve() shim.** The API supports exact flag
  parity (`forceLanguage`, `includeCharacters`, `addDirectory`, `writeFiles`), so
  it is a cleaner elimination than resolving the binary path — no subprocess, and
  the docs build was run to confirm it emits `dist/docs-site/pagefind/pagefind.js`.
- **Root tsconfigs referenced by relative `extends`.** This trades a workspace for
  depth-coupled paths, but the depth is uniform (all packages/apps are two levels
  deep) and it is a standard monorepo pattern; the workspace + 15 deps + a knip
  ignore removed is the better trade in v0.

## Out of scope

- Merging `agent-runtime` into gateway (a real ACP-runner seam, docs/runners.md).
- Splitting `test-kit` into leaf + fixtures packages — unnecessary once factories.ts moved.
- Any behavior change to the folded code — these are pure relocations.

## Verification

Full typecheck is cycle-free and green (27 turbo tasks + `tsc -p tests`):

```sh
bun run typecheck
```

knip is clean with zero dependency suppressions:

```sh
bun run knip
```

The docs build runs the pagefind Node API and emits the static index:

```sh
bun run docs:build && ls dist/docs-site/pagefind/pagefind.js
```

Touched suites pass (test-kit 4, gateway src/skills 4; the tunnel data-plane
crate builds and its contract suites pass):

```sh
bun run --cwd packages/test-kit test
bunx vitest run --root packages/gateway src/skills
bun run --cwd packages/tunnel test:data-plane
```

## Steering

**PASS.** The user directed this work with three sequential task approvals, each before execution: (a) "go ahead do it and fold it into this PR" (approving the three workspace merges); (b) after being told two knip suppressions remained, "fix them" (approving the test-kit relocation and pagefind Node-API switch). These are task approvals, not mid-task corrections or redirects — no human-steering correction occurred. The `### Steering` ledger table is correctly empty.

## Audit

**PASS.** The attestation initially found one file-coverage blocker, now resolved: **`packages/blob-format/package.json`** was staged (removed `@centraid/tsconfig` dependency, one of the "15 package.jsons") but omitted from the inventory, which listed only its sibling `packages/blob-format/tsconfig.json`. The missing path has been added to the "Tsconfig fold" section of the inventory, so all 15 `@centraid/tsconfig`-removal package.jsons are now accounted for and every staged path appears in the receipt prose. No other coverage gaps were found; all `[x]` checklist items were verified against the staged tree.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5ac9baf3-ae7-1784648909-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #495 | claude-opus-4-8 | 1051 | 6150517 | 124449551 | 676761 | 6828329 | 117.5898 | 2315 | 10204326 | 251441338 | 1444725 |  |
| claude-code-5ac9baf3-ae7-1784649003-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #495 | claude-opus-4-8 | 13 | 24101 | 611410 | 8466 | 32580 | 0.6681 | 2328 | 10228427 | 252052748 | 1453191 |  |
| claude-code-5ac9baf3-ae7-1784650314-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #495 | claude-opus-4-8 | 1593 | 6885848 | 163298810 | 928336 | 7815777 | 147.9023 | 3921 | 17114275 | 415351558 | 2381527 | fix(tests): repoint golden-fixture paths after data-plane fold (#495)The data-pl |
| claude-code-5ac9baf3-ae7-1784650374-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #495 | claude-opus-4-8 | 6 | 11257 | 254893 | 776 | 12039 | 0.2172 | 3927 | 17125532 | 415606451 | 2382303 | fix(tests): repoint golden-fixture paths after data-plane fold (#495)The data-pl |
