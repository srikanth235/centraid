<!-- governance: allow-receipt-per-issue CI repair receipt preserves the already-reviewed PR scope while the branch history is consolidated. -->

# issue-721 — Mobile Photos offline and temporal-grain pass

Issue: [#721](https://github.com/srikanth235/centraid/issues/721)

## Checklist

- [x] Preserve the reviewed PR implementation
- [x] Repair the branch so required CI gates can evaluate it

## What changed

The reviewed PR implementation is preserved while its seven commits are
consolidated into one receipt-bearing commit. The seven files reported by CI
as unformatted were normalized with the pinned Oxfmt version. The follow-up
static CI pass also receives explicit cases for the two silent replica states,
keeping the status switch exhaustive under the repository type-aware lint.

## Out of scope

No product behavior was changed as part of this CI repair.

## Verification

```sh
bun run format:check
```

## Decisions

The history was consolidated because the governance directive evaluates every
non-merge commit in the PR range and each original commit lacked a receipt.

## Audit

**Verdict: PASS.** This receipt records a CI-only branch repair; the reviewed
product diff remains unchanged.

## Steering

**Verdict: PASS.** The user’s request remained “get PR CI green”; no redirect
or correction was issued during this repair.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fdbbe-44e-1786098231-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 76396 | 0 | 750080 | 3443 | 79839 | 0.4302 | 76396 | 0 | 750080 | 3443 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098278-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 5684 | 0 | 314368 | 663 | 6347 | 0.1027 | 82080 | 0 | 1064448 | 4106 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098426-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 17882 | 0 | 774912 | 1016 | 18898 | 0.2537 | 99962 | 0 | 1839360 | 5122 | fix(ci): make PR 722 governance and format compliant (#721) |
| codex-019fdbbe-44e-1786098942-1 | codex | 019fdbbe-44eb-7a20-a8c6-da96d2b3badd | #721 | gpt-5.6-luna | 77970 | 0 | 5221888 | 6124 | 84094 | 1.5923 | 177932 | 0 | 7061248 | 11246 | fix(mobile): make replica status switch exhaustive (#721) |
