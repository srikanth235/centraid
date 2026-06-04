# Issue #203 — automation: group flat src/ into functional folders

Issue: #203

## Checklist
- [x] Group flat automation src files into functional folders

## What changed

### Group flat automation src files into functional folders
`packages/automation/src/` was a flat directory of ~32 files (flattened from
the old `conversation-engine/src/automation` in #194 but never grouped).
Grouped them into functional folders — a pure move + intra-package import
rewrite, no behavior change:

- `manifest/` — automation manifest parsing/validation + refs: manifest,
  manifest-errors, manifest-output, ref
- `handler/` — handler execution & analysis: handler-runner, handler-ctx,
  handler-lint, handler-audit, agent-answer
- `fire/` — the fire spine + scheduling: fire, host, cron-match,
  in-process-scheduler
- `scaffold/` — automation app scaffolding + webhooks: scaffold, webhook, app
- `mock-llm/` — the persistent mock-LLM test harness: mock-llm-server,
  mock-llm-writers, persistent-mock-session

`index.ts` (the package barrel) stays at root; the `worker/` subtree is
unchanged. Each `.test.ts` moved with its source; all intra-package relative
imports (`.js` sources + tests' `.ts` imports) were rewritten.

## Out of scope
- No code/behavior changes — only file locations and import paths.
- gateway gets the same treatment in a sibling commit on this PR.

## Verification
- On-disk import-resolution sweep: all 67 intra-package relative imports
  resolve to real files (0 broken).
- Governance gates pass (no broken doc links). Full tsc + test run is
  deferred to CI — this worktree can't resolve the package's `@centraid/*`
  source cross-package (the documented worktree limitation, unrelated to this
  move).
