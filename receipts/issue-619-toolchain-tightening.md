# Issue #619 — toolchain tightening

## Checklist

- [x] `lint-types.sh` fails on diagnostics, an invalid rule count, or zero files, covers all 18 eligible workspaces, and documents the oauth-worker exclusion.
- [x] `scripts/lint-tsconfigs.mjs` is in `check:pr`, with all four program-topology invariants green.
- [x] `blob-format` and `design-tokens` builds exclude test artifacts; design-tokens keeps CommonJS output.
- [x] CLI and protocol tests are typechecked through new `tsconfig.test.json` programs and updated `typecheck` scripts.
- [x] `bun run lint` denies warnings, with no remaining `react-hooks/exhaustive-deps` diagnostics.
- [ ] Part D rule families are adopted at error with zero findings and no suppressions.
- [x] Item 5 measurements are recorded with an explicit defer decision for the unreviewably broad Part D migration.

## What changed

- `lint-types.sh` fails on diagnostics, an invalid rule count, or zero files,
  covers all 18 eligible workspaces, and documents the oauth-worker exclusion.
- `scripts/lint-tsconfigs.mjs` is in `check:pr`, with all four program-topology
  invariants green.
- `blob-format` and `design-tokens` builds exclude test artifacts;
  design-tokens keeps CommonJS output.
- CLI and protocol tests are typechecked through new `tsconfig.test.json`
  programs and updated `typecheck` scripts.
- `bun run lint` denies warnings, with no remaining
  `react-hooks/exhaustive-deps` diagnostics.
- Item 5 measurements are recorded with an explicit defer decision for the
  unreviewably broad Part D migration.
- `scripts/lint-types.sh`, `scripts/lint-tsconfigs.mjs`, root `package.json`, and `.github/workflows/ci.yml` make the type-aware pass authoritative, add the tsconfig topology guard to local/CI PR gates, and deny lint warnings.
- `packages/blob-format/{package.json,tsconfig.json,tsconfig.test.json}`, `packages/design-tokens/{package.json,tsconfig.json,tsconfig.test.json}`, and `packages/blueprints/{package.json,tsconfig.json}` keep compiled tests out of distributable output; `apps/web/tsconfig.json` removes the TS7-incompatible baseUrl setting.
- `packages/cli/{package.json,tsconfig.json,tsconfig.test.json,src/cli.branches.test.ts}` and `packages/protocol/{package.json,tsconfig.json,tsconfig.test.json,src/handshake-direct.test.ts}` add test-inclusive programs and repair stale fetch mock typings uncovered by them.
- Type-aware diagnostics are fixed in `packages/backup/src/object-store.ts`, `packages/design-tokens/src/tile.ts`, and the client sources `packages/client/src/react/blueprints/kit-inline.ts`, `packages/client/src/react/screens/{SettingsConnectionsScreen.tsx,SettingsDiagnosticsScreen.tsx,SettingsProvidersScreen.tsx,resource-summary.ts}`, `packages/client/src/react/shell/gatewaySwitcher.ts`, `packages/client/src/react/shell/useAsyncData.ts`, and `packages/client/src/react/shell/routes/{AppSettingsController.tsx,AssistantRoute.tsx,ConnectFlow.tsx,InlineAppRoute.tsx,builder/BuilderShell.tsx}`.
- The 19 hook-dependency warnings are resolved in `packages/blueprints/apps/docs/components/Editor.tsx`, `packages/blueprints/apps/locker/app-root.tsx`, `packages/blueprints/apps/notes/components/Editor.tsx`, `packages/blueprints/apps/photos/components/{Editor.tsx,Slideshow.tsx}`, and the client sources above; `oxlint.config.mjs` promotes `react/exhaustive-deps` to an error.

Changed files:

```
.github/workflows/ci.yml
apps/web/tsconfig.json
oxlint.config.mjs
package.json
packages/backup/src/object-store.ts
packages/blob-format/package.json
packages/blob-format/tsconfig.json
packages/blob-format/tsconfig.test.json
packages/blueprints/apps/docs/components/Editor.tsx
packages/blueprints/apps/locker/app-root.tsx
packages/blueprints/apps/notes/components/Editor.tsx
packages/blueprints/apps/photos/components/Editor.tsx
packages/blueprints/apps/photos/components/Slideshow.tsx
packages/blueprints/package.json
packages/blueprints/tsconfig.json
packages/cli/package.json
packages/cli/src/cli.branches.test.ts
packages/cli/tsconfig.json
packages/cli/tsconfig.test.json
packages/client/src/react/blueprints/kit-inline.ts
packages/client/src/react/screens/SettingsConnectionsScreen.tsx
packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx
packages/client/src/react/screens/SettingsProvidersScreen.tsx
packages/client/src/react/screens/resource-summary.ts
packages/client/src/react/shell/gatewaySwitcher.ts
packages/client/src/react/shell/routes/AppSettingsController.tsx
packages/client/src/react/shell/routes/AssistantRoute.tsx
packages/client/src/react/shell/routes/ConnectFlow.tsx
packages/client/src/react/shell/routes/InlineAppRoute.tsx
packages/client/src/react/shell/routes/builder/BuilderShell.tsx
packages/client/src/react/shell/useAsyncData.ts
packages/client/tsconfig.json
packages/design-tokens/package.json
packages/design-tokens/src/tile.ts
packages/design-tokens/tsconfig.json
packages/design-tokens/tsconfig.test.json
packages/protocol/package.json
packages/protocol/src/handshake-direct.test.ts
packages/protocol/tsconfig.json
packages/protocol/tsconfig.test.json
scripts/lint-types.sh
scripts/lint-tsconfigs.mjs
```

## Decisions

Part D remains deferred. Re-enabling the measured rules required over 1,000 changed files; after automatic fixes, 335 dynamic type-import changes and 131 shadowing diagnostics still required manual, semantic review. This is too broad to conceal in the A–C enforcement patch, so the rules remain explicitly off and the draft does not claim to close #619.

## Out of scope

The Part D rule-family migration and the JS-plugin preset spike remain follow-up work. The draft also does not alter the unrelated, timing-sensitive gateway database-lock test that failed during full validation.

## Verification

```sh
bun run lint
bun run lint:types
bun run lint:tsconfigs
bun run typecheck
bun run format:check
```

The focused `packages/client` kit-inline test and CLI/protocol affected tests pass. `bun run check:pr:full` completed 5,578 passing tests but failed one unrelated timing-sensitive gateway database-lock integration assertion (`gateway-db-lock.integration.test.ts:109`, missing `holderPid` after SIGKILL).

## Steering

PASS — Fresh-context audit of the Codex session found one substantive user
instruction to implement issue #619 and create a PR; no user correction or
redirection occurred.

## Audit

PASS — Fresh-context audit found that `## What changed` faithfully covers the
staged toolchain gates, tsconfig/test-program changes, surfaced diagnostics,
and exhaustive-deps cleanup. Each checked checklist item is realized in the
staged diff. The seven-item checklist mirrors issue #619's acceptance criteria;
Part D is correctly unchecked and explicitly deferred.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019faa43-8b2-1785269965-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 12678 | 0 | 1199616 | 2450 | 15128 | 0.3683 | 366335 | 0 | 13540096 | 45429 | feat(toolchain): tighten lint and tsconfig gates (#619) |
| codex-019faa43-8b2-1785270078-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 5450 | 0 | 733952 | 1424 | 6874 | 0.2185 | 371785 | 0 | 14274048 | 46853 | feat(toolchain): tighten lint and tsconfig gates (#619) |
| codex-019faa43-8b2-1785270179-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 4331 | 0 | 647168 | 346 | 4677 | 0.1778 | 376116 | 0 | 14921216 | 47199 | feat(toolchain): tighten lint and tsconfig gates (#619) -m governance: allow-too |
