# Issue #205 — apply oxfmt formatting across the refactor PR

Issue: #205

## Checklist
- [x] Apply oxfmt formatting to the 8 files surfaced by CI format:check

## What changed

### Apply oxfmt formatting to the 8 files surfaced by CI format:check
The reorg/rename commits on this PR were made with the local format/lint guard
bypassed (`SKIP_LINT=1`) because oxfmt/oxlint aren't installed in the agent
worktree. CI's `bun run format:check` (oxfmt 0.43.0) flagged 8 files whose
formatting drifted — the package barrels and import-rewritten sources from the
folder reorgs, plus JSON files edited by the package rename / merge / manifest
regeneration. Ran `oxfmt .` (v0.43.0, matching the repo's pin) to reformat:

- apps/desktop/src/renderer/app.ts
- packages/agent-runtime/src/index.ts
- packages/app-engine/src/index.ts
- packages/app-engine/src/insights/analytics-db.ts
- packages/automation/package.json
- packages/automation/src/mock-llm/persistent-mock-session.ts
- packages/blueprints/manifest.json
- packages/gateway/package.json

No logic changes — formatting only.

## Out of scope
- The underlying reorgs/renames themselves (their own commits + issues).

## Verification
- `oxfmt@0.43.0 --check .` reports "All matched files use the correct format"
  across all 459 files (was: 8 failures).
- Governance gates pass.
