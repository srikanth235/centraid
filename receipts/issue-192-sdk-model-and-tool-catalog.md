# issue-192 — SDK model enumeration + gateway host-tool catalog

GitHub issue: [#192](https://github.com/srikanth235/centraid/issues/192)

Replace the billed `claude -p` model self-report with the Agent SDK's
zero-token `supportedModels()`, and — building on the same gateway-owned
catalog — make host tools (builtins + MCP) a first-class, persisted capability:
enumerated at **every gateway start**, read by the builder from cache (no
per-turn CLI spawn), and shown in Settings → Agents with their own Refresh
control, independent of the model Refresh.

## Checklist

- [x] Commit 1 — agent-runtime: enumerate claude models via SDK `supportedModels()`
- [x] Commit 2 — agent-runtime: host-tool probe (SDK loopback + MCP gate) + catalog v2 (tools beside models)
- [x] Commit 3 — gateway/skills: boot-probe tools, agents-status tools + `?refreshTools=1`, builder reads catalog
- [x] Commit 4 — desktop: per-agent tools view + separate Refresh tools control

## What changed

- **Commit 1 — agent-runtime: enumerate claude models via SDK `supportedModels()`.**
  Replaced the billed `claude -p` self-report in `model-enumerators.ts` with the
  Agent SDK's `query().supportedModels()` control method — opened with an empty
  streaming prompt so no model turn runs (zero tokens), raced against a 15s
  timeout, torn down in `finally`. New `mapClaudeModels` maps `ModelInfo[]` →
  `RunnerModel[]`: `value` → `id`, and the label prefers `description` (which
  carries the concrete version, e.g. "Opus 4.7 …") over `displayName` since the
  bare alias id hides the version; the `default` alias is flagged. Dropped the
  text-parsing helpers (`parseClaudeModelList`, id regex, prompt). `model-defaults.ts`
  now seeds claude with the SDK's capability **aliases** (`default`/`sonnet`/`haiku`)
  — the same vocabulary `supportedModels()` returns on Refresh, so seed and
  refreshed catalog agree — and these stable aliases need no `no-hardcoded-model-ids`
  waiver (codex keeps its concrete-id seed + waivers). Rewrote the claude tests in
  `model-enumerators.test.ts` to cover the mapping (description→name, dedupe,
  default flag).

- **Commit 2 — agent-runtime: host-tool probe (SDK loopback + MCP gate) + catalog v2 (tools beside models).**
  Reworked `host-tools.ts` so claude tool enumeration drives the Agent SDK against
  a trivial loopback server and snapshots the first Messages request's `tools[]`,
  holding the user message in streaming-input mode until `mcpServerStatus()`
  reports no MCP server is still `pending` (so the snapshot carries builtins + MCP
  in one shot); codex keeps the mock-LLM `codex exec` capture (synchronous MCP, no
  gate). Both zero-token, best-effort → `[]`. Extended the catalog store to **v2**:
  `CatalogEntry` carries `tools` + `toolsEnumeratedAt` beside `models`;
  `writeCatalogEntry` now **merges a partial patch** so models and tools refresh
  independently without clobbering each other. Added `resolveRunnerTools` (mirrors
  `resolveRunnerModels` but with **no seed** — tools are MCP-config-specific) and a
  pure `readRunnerTools` cache reader; exported both. Store tests in
  `model-catalog.test.ts` cover cold/warm/refresh/failure-preserve and
  model↔tool merge independence.

- **Commit 3 — gateway/skills: boot-probe tools, agents-status tools + `?refreshTools=1`, builder reads catalog.**
  `build-gateway.ts` warms the tool catalog for each detected runner on every
  `start()` — a background, best-effort probe from a stable `process.cwd()` (never
  a draft worktree, which makes the claude SDK report 0 tools). A shared
  `resolveCatalogTools` feeds both the boot probe and the route. `agents-routes.ts`
  now returns `codexTools`/`claudeTools` from the catalog and re-probes on a
  **separate** `?refreshTools=1` flag (distinct from models' `?refresh=1`, since
  the tool probe spawns a CLI). The builder stops probing on the hot path:
  `skills/authoring-prompt.ts` takes `tools` as data (the per-process in-memory
  cache and the `enumerateTools` injection seam are gone), and
  `unified-chat-runner.ts` reads cached tools from the catalog per turn via
  `readRunnerTools`. Route tests in `agents-routes.test.ts` (+3) cover the tools
  resolver, independent `refreshTools` threading, and best-effort degradation.

- **Commit 4 — desktop: per-agent tools view + separate Refresh tools control.**
  Settings → Agents gains a per-agent "N tools" disclosure that expands a panel
  grouped **Built-in → per-MCP-server**, each tool showing its name (mono), an
  `args` chip when it carries a JSON input schema, and its description; open state
  persists across re-renders, with a staggered reveal. A new **Refresh tools**
  button sits beside the renamed **Refresh models** button and hits `?refreshTools=1`
  with its own "Scanning tools…" state. `CentraidAgentsStatus` gains
  `codexTools`/`claudeTools` (new `CentraidHostTool` type); `getAgentsStatus`
  takes `refreshTools`. Styles under `.agent-entry` / `.agent-tools*` / `.tools-*`,
  consistent with the existing `agent-row` vocabulary.

## Out of scope

- codex model enumeration is unchanged — it has no alias vocabulary and no
  billed-turn problem (`model/list` JSON-RPC is already free), so it keeps its
  concrete-id seed behind per-line `no-hardcoded-model-ids` waivers.
- The model seed deliberately does **not** hardcode claude versions; the concrete
  version only appears after a Refresh against the live SDK (avoids the stale
  "Opus 4.8" the old hardcoded seed carried).

## Verification

- `tsc -p` (agent-runtime) — clean.
- `model-enumerators.test.ts` — claude mapping tests pass.
- Live `enumerateClaudeModels()` → `default`/`sonnet`/`haiku` with versioned
  descriptions as names; alias round-trip confirmed (`haiku`→4.5, `default`→Opus 4.7).
- `model-catalog.test.ts` — 12 pass (models + tools + merge independence).
- Live tool-catalog chain: cold read 0 → refresh probes the real claude CLI
  (44 tools / 16 MCP / 44 with schemas, ~5.5s) → persisted as catalog v2 with
  `toolsEnumeratedAt` → warm read returns 44 from disk.
- `agents-routes.test.ts` — 7 pass (models + tools resolver plumbing);
  `unified-chat-runner.test.ts` — 3 pass with the catalog-backed `resolveTools` seam.
- `tsc -p` clean for agent-runtime, skills, gateway; verified the dev desktop boots
  the in-process gateway against the fresh worktree dist.
- Merged `origin/main` (#191 chat→conversation/turn rename) into this branch:
  `unified-chat-runner` → `unified-conversation-runner` keeps the catalog-backed
  `resolveTools` seam (with the `runTurn` rename); `authoring-prompt` keeps the
  data-based tools header; `COSTS.md`/`STEERING.md` union both sides in epoch order.
  Post-merge `turbo run build` (gateway + desktop graph, 8 tasks) and the catalog /
  route / runner tests (22) pass.
