# Issue #619 — toolchain tightening

<!-- governance: allow-receipt-per-issue Part D is a repository-wide mechanical lint migration across more than one thousand source files. -->

## Checklist

- [x] `lint-types.sh` fails on diagnostics, an invalid rule count, or zero files, covers all 18 eligible workspaces, and documents the oauth-worker exclusion.
- [x] `scripts/lint-tsconfigs.mjs` is in `check:pr`, with all four program-topology invariants green.
- [x] `blob-format` and `design-tokens` builds exclude test artifacts; design-tokens keeps CommonJS output.
- [x] CLI and protocol tests are typechecked through new `tsconfig.test.json` programs and updated `typecheck` scripts.
- [x] `bun run lint` denies warnings, with no remaining `react-hooks/exhaustive-deps` diagnostics.
- [x] Part D rule families are adopted at error with zero findings and no suppressions.
- [x] Item 5 measurements are recorded with explicit adopt/defer decisions.

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
- Part D promotes `eqeqeq`, thrown-value, loop-condition, mutation,
  shadowing, type-import, tsgolint, and catch-name rules to errors. The
  repository-wide mechanical migration resolves every resulting finding with
  no per-site suppressions.
- The JS-plugin spike ran Ultracite's github, sonarjs, and react-doctor preset
  against 2,491 files: 862 rules produced 5,527 findings (including 923
  `github/no-then` and 554 filename-convention findings), so it is deferred
  rather than added to the default lint gate. The type-aware spike likewise
  defers `typescript/no-base-to-string` and `typescript/unbound-method`: both
  report broad schema, fixture, mock, and generated-code findings.
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

governance: allow-receipt-per-issue Part D is a repository-wide mechanical
lint migration across more than one thousand source files; enumerating each
path would obscure the rules, decisions, and verification record above.

## Decisions

Part D is adopted. The import migration uses `import type` wherever a module
is type-only, while retaining `typeof import()` annotations for dynamic Vitest
module seams; `consistent-type-imports` allows that necessary annotation form.

The optional JS-plugin preset is deferred: its 5,527 findings across 2,491
files and extra dependency/runtime cost are too broad for a reliable ratchet.
`typescript/no-base-to-string` and `typescript/unbound-method` are also
deferred after the 18-workspace type-aware spike reported broad findings in
schema-backed values, test fixtures/mocks, and generated Iroh code. Neither
candidate is hidden with a suppression.

## Out of scope

The deferred JS-plugin preset and the two type-aware candidates remain
follow-up work. This change does not alter unrelated gateway database-lock
timing behavior.

## Verification

```sh
bun run lint
bun run lint:types
bun run lint:tsconfigs
bun run typecheck
bun run format:check
bun run test
```

The JS-plugin measurement used Ultracite's opt-in preset with its three
declared plugin dependencies, then removed those temporary dependencies before
the final diff. The type-aware measurement used the same 18-workspace coverage
loop as `lint:types` with the two candidate rules added for the run.
The final full suite completed with 36 successful tasks (including 1,203
gateway tests).

## Steering

PASS — Fresh-context audit of the Codex session found one substantive user
instruction to implement issue #619 and create a PR; no user correction or
redirection occurred.

## Audit

PASS — Fresh-context audit verified that the working diff enables the stated
16 Part D rules at error level, `bun run lint` passes with `--deny-warnings`,
and no per-site lint/type suppression directives were added. The receipt
accurately records the JS-plugin and type-aware candidate deferrals without
claiming they are enabled.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019faa43-8b2-1785269965-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 12678 | 0 | 1199616 | 2450 | 15128 | 0.3683 | 366335 | 0 | 13540096 | 45429 | feat(toolchain): tighten lint and tsconfig gates (#619) |
| codex-019faa43-8b2-1785270078-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 5450 | 0 | 733952 | 1424 | 6874 | 0.2185 | 371785 | 0 | 14274048 | 46853 | feat(toolchain): tighten lint and tsconfig gates (#619) |
| codex-019faa43-8b2-1785270179-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 4331 | 0 | 647168 | 346 | 4677 | 0.1778 | 376116 | 0 | 14921216 | 47199 | feat(toolchain): tighten lint and tsconfig gates (#619) -m governance: allow-too |
| codex-019faa43-8b2-1785273763-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 452606 | 0 | 47645440 | 85633 | 538239 | 14.3274 | 828722 | 0 | 62566656 | 132832 | feat(toolchain): adopt Part D lint rules (#619) -m governance: allow-toolchain-c |
| codex-019faa43-8b2-1785273824-1 | codex | 019faa43-8b2e-7c61-882b-5618d67265fa | #619 | gpt-5.6-terra | 23190 | 0 | 1047296 | 775 | 23965 | 0.3314 | 851912 | 0 | 63613952 | 133607 | feat(toolchain): adopt Part D lint rules (#619) -m governance: allow-toolchain-c |
