# Issue #202 — agent-runtime: group flat src/ into functional folders

Issue: #202

## Checklist
- [x] Group flat agent-runtime src files into functional folders

## What changed

### Group flat agent-runtime src files into functional folders
`packages/agent-runtime/src/` was a flat directory of ~29 files. Grouped them
into functional folders mirroring the package's domains — a pure move +
intra-package import rewrite, no behavior change:

- `backends/` — the two coding-agent backends + codex helpers: claude-sdk,
  codex-app-server, codex-centraid-tools, codex-model-list, codex-provider-config
- `models/` — per-runner model catalog/tiers/defaults/enumerators:
  model-catalog, model-defaults, model-enumerators, model-tiers
- `automation/` — local per-fire automation orchestration: run-automation,
  run-automation-host-agent, run-automation-live-dispatch
- `cli/` — the `centraid` CLI bin: centraid-cli, centraid-cli-dir

`index.ts`, `types.ts`, and `runtime.ts` (the mode-agnostic `runTurn` engine
primitive) stay at root, as do the leaf helpers the engine composes —
conversation-adapter, preflight, host-tools, multimodal. The `worker/` subtree
is unchanged. Each `.test.ts` moved with its source; all intra-package
relative imports (`.js` sources + tests' `.ts` imports) were rewritten.

## Out of scope
- No code/behavior changes — only file locations and import paths.
- gateway and automation get the same treatment in sibling commits on this PR.

## Verification
- On-disk import-resolution sweep: all 51 intra-package relative imports
  resolve to real files (0 broken).
- Governance gates pass. Full tsc + test run is deferred to CI — this
  worktree can't resolve `@centraid/automation`/`@centraid/app-engine` source
  cross-package (the documented worktree limitation, present at baseline and
  unrelated to this move).
