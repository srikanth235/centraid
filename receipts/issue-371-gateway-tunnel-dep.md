# Issue #371 — packages/gateway missing @centraid/tunnel dependency

## Checklist

- [x] Add `"@centraid/tunnel": "workspace:*"` to `packages/gateway/package.json` dependencies

## What changed

- Add `"@centraid/tunnel": "workspace:*"` to `packages/gateway/package.json` dependencies:
  added it alongside the other `@centraid/*` workspace deps. Gateway's
  `src/cli/endpoint-host.ts` imports `startGatewayEndpoint` from
  `@centraid/tunnel` but the package manifest never declared the dependency,
  so turbo's task graph never built `packages/tunnel` first. In a fresh
  worktree (no pre-built `packages/tunnel/dist`), gateway's `vitest run`
  failed with "Failed to resolve entry for package @centraid/tunnel" — vite
  resolves `dist/index.js` per tunnel's package.json `main` field, which
  doesn't exist until `tunnel` builds.

### Files

- `bun.lock`
- `packages/gateway/package.json`

## Decisions

None.

## Out of scope

None — a one-line manifest fix.

## Verification

```sh
rm -rf packages/tunnel/dist
npx turbo run test --filter=@centraid/gateway --force
```

- Confirmed the bug first: with the dependency missing, the forced run in a
  worktree with `packages/tunnel/dist` deleted failed with the "Failed to
  resolve entry for package @centraid/tunnel" error.
- After the fix: 11/11 turbo tasks succeed (tunnel builds automatically
  before gateway), gateway's 378 tests all pass.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ac2077f8-e15-1783796670-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #371 | claude-sonnet-5 | 9770 | 1632601 | 19961701 | 28285 | 1670656 | 12.5643 | 1022749 | 16834443 | 659353457 | 3041001 | fix(gateway): declare @centraid/tunnel as a dependency (#371)endpoint-host.ts im |
| claude-code-ac2077f8-e15-1783796692-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #371 | claude-sonnet-5 | 2 | 1830 | 582171 | 177 | 2009 | 0.1842 | 1022751 | 16836273 | 659935628 | 3041178 | test (#371) |
| claude-code-ac2077f8-e15-1783796724-1 | claude-code | ac2077f8-e15a-46d5-be12-0c583922f047 | #371 | claude-sonnet-5 | 6 | 1501 | 1752484 | 1494 | 3001 | 0.5538 | 1022757 | 16837774 | 661688112 | 3042672 | fix(gateway): declare @centraid/tunnel as a dependency (#371)endpoint-host.ts im |
## Audit

PASS — (1) What changed matches the diff exactly: only `packages/gateway/package.json` and `bun.lock` changed, with the single line `"@centraid/tunnel": "workspace:*"` added to dependencies in both; (2) the checked item is realized: dependency added and verified by test pass (378 tests); (3) receipt Checklist mirrors the issue's: both list identical dependency-addition requirement.

## Steering

PASS — no steering events found in this session window. This is a
single-turn fix requested directly by the user with no advisory input; no
interrupt or correction to record.
