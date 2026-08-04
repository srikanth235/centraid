# Issue #684 — audit and refresh stale repository documentation

GitHub issue: [#684](https://github.com/srikanth235/centraid/issues/684)

## Checklist

- [x] Verify durable documentation claims against current repository behavior.
- [x] Refresh current docs concisely and delete obsolete plans.
- [x] Run documentation and repository quality gates.

## What changed

- **Verify durable documentation claims against current repository behavior.**
  `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `docs/decisions.md`,
  `docs/dev-environment.md`, `docs/glossary.md`, `docs/logs.md`,
  `docs/recovery/pairing.md`, `docs/release.md`, and
  `docs/release/oauth-assist-google.md` now describe the detached gateway,
  iroh pairing, the Personal default vault, and current client topology.
  `packages/app-engine/README.md` and `packages/gateway/README.md` describe
  their current runtime responsibilities. `docs/refactors/README.md` and
  `docs/refactors/inline-system-apps.md` retain the completed refactor as
  history while making its status unambiguous.
- **Refresh current docs concisely and delete obsolete plans.**
  `apps/desktop/tests/e2e/COVERAGE_REPORT.md` and
  `apps/desktop/tests/e2e/SCENARIOS.md` now match the seven-spec, 55-test
  desktop E2E suite. `tests/agent-e2e-mobile/README.md`,
  `tests/agent-e2e-mobile/flows/template-gate.md`,
  `tests/agent-e2e-pairing/AGENTS.md`,
  `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.md`, and
  `tests/onboarding-scenarios.md` match current first-run, pairing, and
  mobile test behavior. Deleted `docs/plans/skills-package-plan.md`,
  `docs/plans/test-gap-closure-2026-07.md`, and
  `docs/plans/test-report-zero-grey-587.md` because their implementation
  plans are obsolete.
- **Run documentation and repository quality gates.** The rewritten and
  removed documentation has no broken diff whitespace or internal links; the
  documentation build, smoke test, formatting check, and full push gate pass.

## Decisions

- Audit active Markdown documentation, not historical receipts. Keep
  release/history records that are intentionally time-bound.
- Delete only plans whose stated work is obsolete; retain completed refactor
  records as historical context.

## Out of scope

- Audit or rewrite existing receipts.
- Change product behavior, APIs, or test implementation.

## Verification

```sh
git diff --check
bash .governance/packs/governance-kit/foundation/directives/internal-doc-links/check.sh
bun run docs:build
bun run docs:smoke
bun run check:push
```

All commands passed. `bun run check:push` completed 25 of 25 gates.

## Audit

PASS — The documentation-only diff fulfills the issue checklist: the listed
files correct current runtime and E2E claims, obsolete plans are deleted, and
the recorded checks cover documentation integrity and repository quality.

## Steering

PASS — No human redirect or correction occurred during the audit. The request
to create issue #684 and its draft PR followed the repository policy surfaced
by the audit and kept the agreed scope intact.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fbde3-b00-1785600718-1 | codex | 019fbde3-b002-7dc3-bcf9-7e43c8977f18 | #684 | gpt-5.6-terra | 834107 | 0 | 22848768 | 67323 | 901430 | 8.8073 | 834107 | 0 | 22848768 | 67323 | docs: refresh stale repository documentation (#684) |
| codex-019fbde3-b00-1785600893-1 | codex | 019fbde3-b002-7dc3-bcf9-7e43c8977f18 | #684 | gpt-5.6-terra | 18198 | 0 | 564224 | 4353 | 22551 | 0.2518 | 852305 | 0 | 23412992 | 71676 | docs: refresh stale repository documentation (#684) -m governance: allow-doc-int |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
