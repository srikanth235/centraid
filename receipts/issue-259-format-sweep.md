# Issue #259 — repo format sweep: make `oxfmt --check` green

https://github.com/srikanth235/centraid/issues/259

`bun run format:check` failed on main for ~45 files, keeping `bun run ci` red
for every branch. This is the formatting-only half of the cleanup; the oxlint
errors are tracked and fixed separately.

## Checklist
- [x] Exclude duaility-ontology.html from oxfmt via ignorePatterns
- [x] Reformat the offending sources with oxfmt (no semantic changes)

## What changed

**Exclude duaility-ontology.html from oxfmt via ignorePatterns.**
`.oxfmtrc.jsonc` gains an `ignorePatterns` entry for `duaility-ontology.html`
with the rationale in-file: it is an 8k+-line hand-authored spec document
(§-numbered prose + inline DDL) that `packages/vault` implements — its layout
is part of the document, not code style, and reformatting it is pure churn
against the source of design truth.

**Reformat the offending sources with oxfmt (no semantic changes).**
`bun run format` over the repo; this commit carries the files whose only
change is formatting: `apps/desktop/src/renderer/app-vault.ts`, the
bookings/budgets/studio/subscriptions/tasks/threads/vitals blueprint sources
under `packages/blueprints/apps/`, and
`packages/vault/src/commands/{attachments,business}.ts` plus the
attachments/bookings/subscriptions test files. Files that are being rewritten
on this branch anyway (the #258 writable-apps surface, the oxlint fixes in
business.test.ts / app-appview.ts) ride with their own commits, already
formatted — the branch as a whole is what turns the gate green.

## Out of scope
- The four oxlint errors also blocking `bun run ci` (business.test.ts
  `Record<string, any>` ×3, app-appview.ts no-self-assign) — fixed on this
  branch as their own change, anchored to their own issue.
- Any semantic change to the reformatted files.

## Verification

```bash
bun run format:check   # All matched files use the correct format. (735 files)
bun run check          # format:check + oxlint: 0 warnings, 0 errors
bun run ci             # 19/19 turbo tasks green (format, lint, typecheck)
bun run test           # 19/19 packages green
```

## Decisions

- **duaility-ontology.html is excluded, not reformatted.** oxfmt would rewrite
  8k+ lines of a hand-authored spec document whose layout is part of the
  document itself; excluding it in `.oxfmtrc.jsonc` keeps the gate green
  without churning the source of design truth. Same ownership logic as the
  existing `.governance/**` exclusions.
- **Feature-owned files are not in this commit** even where they were also
  format-dirty on main (the #258 app rewrites, the oxlint-fix files): they
  land already-formatted with their own commits, so the sweep stays a pure
  formatting change and `git blame` on those files points at their real
  change, not at this one.

## File coverage

Every path in this change set:

- `.oxfmtrc.jsonc` — the duaility-ontology.html ignorePatterns entry
- `receipts/issue-259-format-sweep.md` — this receipt
- Formatting only, no semantic change:
  - `apps/desktop/src/renderer/app-vault.ts`
  - `packages/blueprints/apps/bookings/app.js`
  - `packages/blueprints/apps/bookings/app.json`
  - `packages/blueprints/apps/budgets/app.css`
  - `packages/blueprints/apps/budgets/app.js`
  - `packages/blueprints/apps/budgets/app.json`
  - `packages/blueprints/apps/studio/app.js`
  - `packages/blueprints/apps/studio/app.json`
  - `packages/blueprints/apps/studio/index.html`
  - `packages/blueprints/apps/studio/queries/studio.js`
  - `packages/blueprints/apps/subscriptions/app.js`
  - `packages/blueprints/apps/subscriptions/app.json`
  - `packages/blueprints/apps/subscriptions/index.html`
  - `packages/blueprints/apps/tasks/app.js`
  - `packages/blueprints/apps/tasks/app.json`
  - `packages/blueprints/apps/tasks/queries/board.js`
  - `packages/blueprints/apps/threads/app.js`
  - `packages/blueprints/apps/threads/app.json`
  - `packages/blueprints/apps/threads/queries/thread.js`
  - `packages/blueprints/apps/vitals/app.css`
  - `packages/blueprints/apps/vitals/app.js`
  - `packages/blueprints/apps/vitals/app.json`
  - `packages/vault/src/commands/attachments.test.ts`
  - `packages/vault/src/commands/attachments.ts`
  - `packages/vault/src/commands/bookings.test.ts`
  - `packages/vault/src/commands/business.ts`
  - `packages/vault/src/commands/subscriptions.test.ts`

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-a6ee75db-db0-1783080466-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 160360 | 2275540 | 90946325 | 446125 | 2882025 | 143.3004 | 160360 | 2275540 | 90946325 | 446125 | chore(repo): oxfmt sweep — make the format gate green (#259)bun run format:check |
| claude-code-a6ee75db-db0-1783080649-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 2182 | 10768 | 2573058 | 8972 | 21922 | 3.1781 | 162542 | 2286308 | 93519383 | 455097 | chore(repo): oxfmt sweep — make the format gate green (#259)bun run format:check |
| claude-code-a6ee75db-db0-1783080673-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 2 | 690 | 371456 | 266 | 958 | 0.3934 | 162544 | 2286998 | 93890839 | 455363 | chore(repo): probe (#259)Issue: #259 |
| claude-code-a6ee75db-db0-1783080704-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 6 | 6117 | 1116438 | 1146 | 7269 | 1.2503 | 162550 | 2293115 | 95007277 | 456509 | chore(repo): probe (#259)Issue: #259 |
| claude-code-a6ee75db-db0-1783080784-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 476 | 9760 | 4130883 | 5168 | 15404 | 4.5160 | 163026 | 2302875 | 99138160 | 461677 | chore(repo): oxfmt sweep — make the format gate green (#259)bun run format:check |
| claude-code-a6ee75db-db0-1783080809-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 7372 | 1054 | 759484 | 438 | 8864 | 0.8683 | 170398 | 2303929 | 99897644 | 462115 | chore(repo): oxfmt sweep — make the format gate green (#259)Issue: #259 |
| claude-code-a6ee75db-db0-1783080836-1 | claude-code | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | claude-fable-5 | 2 | 4131 | 380269 | 176 | 4309 | 0.4407 | 170400 | 2308060 | 100277913 | 462291 | chore(repo): oxfmt sweep — make the format gate green (#259)Issue: #259 |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-a6ee75db-1719316584-1 | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | interrupt | structural |  | pending | 414 | 2026-07-03T11:36:03.829Z |
| steer-a6ee75db-1719316584-2 | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | correction | classifier | hold off on commit ceremony | pending | 417 | 2026-07-03T11:36:24.478Z |
| steer-a6ee75db-1719316584-3 | a6ee75db-db00-4e75-a483-389b3b887325 | #259 | correction | classifier | background tasks running | pending | 434 | 2026-07-03T11:39:00.572Z |

## Steering

| check | verdict | evidence |
| --- | --- | --- |
| steering events recorded | PASS | 3 steering rows appended: interrupt (ordinal 414), 2 corrections (ordinals 417, 434) |
| no non-steering recorded | PASS | ordinal 423 ("sure continue with UIs please") is task-continuation, not a steering redirect |

## Audit

| check | verdict | evidence |
| --- | --- | --- |
| what-changed faithful | PASS | Receipt describes ignorePatterns addition + formatting sweep on 29 files accurately; diff shows .oxfmtrc.jsonc entry for duaility-ontology.html + whitespace-only changes to vault/blueprint files |
| checklist realized in diff | PASS | [x] duaility-ontology.html excluded in .oxfmtrc.jsonc (visible in `git diff --cached .oxfmtrc.jsonc`); [x] offending files reformatted (sample: `packages/vault/src/commands/business.ts` diffs show only line-wrapping/array formatting, no semantic change) |
| checklist mirrors issue | PASS | Receipt's "## Checklist" matches GitHub issue #259: exclude duaility-ontology.html + reformat sources (no semantic changes); oxlint fixes defer to separate issue as stated |
