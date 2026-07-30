# Issue #639 — Agent-optimized TypeScript toolchain

## Checklist

- [ ] The ownership table is implemented: Ultracite presets, Oxfmt formatting, Oxlint lint policy, TypeScript compiler diagnostics, Knip hygiene, Vitest/e2e behavior
- [ ] `oxlint.config.ts` and `oxfmt.config.ts` are the only root configs for their tools, and every invocation passes `-c` explicitly
- [ ] `ultracite`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `typescript`, `knip`, and `vitest` are exact-pinned
- [ ] Ultracite is used through reviewed modular presets plus non-mutating `toolchain:doctor`; routine format/lint scripts invoke Oxfmt/Oxlint directly
- [ ] Oxfmt is the sole style owner, import sorting leaves side-effect imports ordered, and every ignore has a concrete ownership reason
- [ ] Oxlint denies warnings, errors on unused disable directives, avoids formatter overlap, and uses explicit file/runtime profiles
- [ ] Optional JS-plugin presets remain declined as bundles and the rule-adoption rubric is documented
- [ ] Normal automation uses only Oxfmt writes and Oxlint safe `--fix`; suggestions/dangerous fixes are absent from scripts, hooks, and CI
- [ ] Type-aware linting is either compiler-aligned or constrained by a documented compatibility allowlist; TypeScript remains authoritative
- [ ] `no-unnecessary-type-assertion` is enabled only if compiler alignment and clean build/typecheck prove it safe; otherwise it is explicitly disabled
- [ ] The four formerly hollow type-aware rules each fire on a live fixture and are enforced in exactly one pass
- [ ] A mechanical guard prevents type-aware-only rules from being declared in a pass where they cannot execute
- [ ] Source, tests, scripts, e2e, workers, and executable blueprint handlers are linted; only generated/vendor/negative-fixture exclusions remain
- [ ] Sequential blueprint pagination has a narrow handler-profile decision without disabling other lint rules
- [ ] `format`, `format:check`, `lint`, `lint:fix`, `lint:types`, `typecheck`, `test:affected`, `check:fast`, `check:pr`, `check:full`, and `toolchain:doctor` form a documented stable command API
- [ ] Pre-commit and pre-push are deterministic and check-only; local and CI gates call the same scripts
- [ ] `AGENTS.md` documents tool ownership and workflow without duplicating the generated rule catalog
- [ ] Mechanical formatting, safe lint fixes, and behavioral corrections are isolated in separate commits
- [ ] One issue receipt mirrors this checklist and records the chosen type-aware state plus all intentional profile exceptions

## What changed

- Established the command and ownership contract in `package.json`, `docs/toolchain.md`, `AGENTS.md`, `README.md`, `TESTING.md`, `docs/dev-environment.md`, and `docs/coding-standards.md`.
- Migrated the single root configurations to `oxlint.config.ts` and `oxfmt.config.ts`, removed `oxlint.config.mjs`, `oxfmt.config.mjs`, and `packages/blueprints/.oxlintrc.json`, and pinned editor behavior in `.vscode/settings.json` and `.vscode/extensions.json`.
- Made `scripts/lint-staged.sh`, `scripts/lint-types.sh`, `.governance/packs/srikanth235/centraid/directives/format-check/check.sh`, and `.governance/packs/srikanth235/centraid/directives/lint-check/check.sh` name the root configuration explicitly; `.github/workflows/ci.yml` now invokes the same `package.json` lint script as local gates.
- Updated `packages/blueprints/README.md` to point at the root-owned lint profile.
- Added this durable record at `receipts/issue-639-agent-optimized-typescript-toolchain.md`.
- Removed the stale `react/no-array-index-key` suppression from
  `packages/client/src/react/screens/SettingsConnectionsScreen.tsx` in a
  dedicated safe-lint commit before the formatting sweep, because the new
  check-only staged hook correctly rejects unused directives.

## Out of scope

- Optional GitHub, Sonar, and react-doctor JavaScript-plugin presets.
- Oxlint `--type-check` and replacement of TypeScript compiler diagnostics.
- Unrelated product refactors.

## Decisions

- Chose the compatibility state: TypeScript 5.9.3 remains authoritative and type-aware linting is restricted to a proven allowlist.
- Blueprint connector pagination keeps a narrow `no-await-in-loop` exception because each page token depends on the prior response.
- The visual-harness mock retains a fixture-specific legacy-JavaScript profile; it is linted for runtime correctness without a risky style rewrite of fixture data.
- Removed one already-stale lint suppression before the formatter sweep so the
  change could remain isolated while satisfying the newly strict staged gate.

## Verification

```sh
bun install --frozen-lockfile
bun run toolchain:doctor
bun run format:check
bun run lint
bun run lint:types
bun run typecheck
bun run test:affected
bun run knip
bun run check:fast
bun run check:pr
bun run check:full
```

## Audit

PASS — fresh-context audit confirmed the staged contract diff, checklist mirror, and path coverage.

## Steering

PASS — fresh-context audit found no interrupt or correction after the initial task instruction.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fb2ae-33d-1785410230-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 260545 | 0 | 10923264 | 23528 | 284073 | 3.7351 | 260545 | 0 | 10923264 | 23528 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410282-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 3318 | 0 | 849920 | 488 | 3806 | 0.2281 | 263863 | 0 | 11773184 | 24016 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410329-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 4054 | 0 | 643328 | 487 | 4541 | 0.1783 | 267917 | 0 | 12416512 | 24503 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785410642-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 15914 | 0 | 3290368 | 3162 | 19076 | 0.9098 | 283831 | 0 | 15706880 | 27665 | build(toolchain): establish agent command contract (#639) -m governance: allow-t |
| codex-019fb2ae-33d-1785411162-1 | codex | 019fb2ae-33d0-7211-98ee-651403742929 | #639 | gpt-5.6-sol | 37575 | 0 | 4226304 | 6155 | 43730 | 1.2428 | 321406 | 0 | 19933184 | 33820 | chore(lint): remove stale suppression (#639) |
