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
- [ ] Commit 2 — agent-runtime: host-tool probe (SDK loopback + MCP gate) + catalog v2 (tools beside models)
- [ ] Commit 3 — gateway/skills: boot-probe tools, agents-status tools + `?refreshTools=1`, builder reads catalog
- [ ] Commit 4 — desktop: per-agent tools view + separate Refresh tools control

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
