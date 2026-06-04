# Issue #206 — agent-runtime: symmetric backend folder layout

Issue: #206

## Checklist
- [x] Restructured backends/ into codex/ and claude/ subfolders with vendor-prefix-free filenames
- [x] Extracted claude's buildCentraidMcpServer into claude/host-tools.ts
- [x] Extracted claude's model enumeration into claude/model-list.ts and reduced model-enumerators.ts to the switchboard
- [x] Co-located the split model-list tests beside their subjects

## What changed

The two coding-agent backends in `@centraid/agent-runtime` implement one
contract surface — a `run*Turn` entry consumed by `runtime.ts`, both exposing
the identical `centraid_*` host tools — but their file decomposition diverged.
Codex was split by concern into four `codex-*` files; claude was a single
`claude-sdk.ts` monolith with its tool wiring inline and its model enumeration
stranded in `models/model-enumerators.ts`. You couldn't predict claude's layout
from codex's.

- **Restructured backends/ into codex/ and claude/ subfolders with
  vendor-prefix-free filenames** so the two mirror each other:
  `codex-app-server.ts` → `codex/backend.ts`, `codex-centraid-tools.ts` →
  `codex/host-tools.ts`, `codex-model-list.ts` → `codex/model-list.ts`,
  `codex-provider-config.ts(.test)` → `codex/provider-config.ts(.test)`, and
  `claude-sdk.ts` → `claude/backend.ts` (all via `git mv`, history preserved).
- **Extracted claude's buildCentraidMcpServer into claude/host-tools.ts**, which
  mirrors `codex/host-tools.ts` and aligns the host-tool wiring with the
  existing top-level `host-tools.ts` vocabulary (instead of the old
  `centraid-tools` naming axis). `claude/backend.ts` now imports it.
- **Extracted claude's model enumeration into claude/model-list.ts and reduced
  model-enumerators.ts to the switchboard**: `enumerateClaudeModels`,
  `mapClaudeModels`, and `ClaudeModelInfo` moved out of
  `models/model-enumerators.ts` (which is now just the per-runner dispatcher
  importing each backend's `model-list.ts`), mirroring codex.
- **Co-located the split model-list tests beside their subjects**: the combined
  `models/model-enumerators.test.ts` split into `backends/codex/model-list.test.ts`
  and `backends/claude/model-list.test.ts`, matching the `provider-config.test.ts`
  convention.
- Updated all importers (`runtime.ts`, `index.ts`, root `host-tools.ts`, the two
  `automation/run-automation-*.ts` files, `models/model-tiers.test.ts`) and three
  stale doc-comment references to the old filenames.

Pure refactor — no behavior change. The `centraid_*` tool names (the literal
names the model sees) and all exported symbols are unchanged.

## Out of scope
- Exported symbol names still carry the old naming axis (`runClaudeSdkTurn`,
  `ClaudeSdkInput`, `runCodexAppServerTurn`, `CodexAppServerInput`). Renaming
  those touches the `index.ts` public surface and is left as a separate
  follow-up.
- The broader cross-module naming inconsistencies surfaced in review (the
  `design-tokens` no-`src/` layout, folder-prefix redundancy in other folders)
  are not part of this change.

## Verification
- `npx tsc -p tsconfig.json --noEmit` on `@centraid/agent-runtime`: clean.
- `backends/**` + `models/**` tests: 27/27 pass (includes the split
  `model-list.test.ts` files and `provider-config.test.ts`).
- The 12 full-suite failures are confined to `cli/centraid-cli.test.ts`, which
  spawns `dist/centraid-cli.js`; that artifact is absent because the worktree
  has no build. Pre-existing/environmental — unrelated to this refactor.
- Repo-wide grep confirms zero remaining import references to the old paths
  (`codex-app-server`, `claude-sdk`, `codex-centraid-tools`, `codex-model-list`,
  `codex-provider-config`).
