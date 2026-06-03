# issue-179 — Classify OpenClaw models into capability tiers

GitHub issue: [#179](https://github.com/srikanth235/centraid/issues/179)

Follow-up to [#178](https://github.com/srikanth235/centraid/issues/178). OpenClaw
enumerates concrete model keys with no tier semantics. This classifies them into
capability tiers with a one-shot LLM call, caches the result, groups the picker by
tier, and adds a UI refresh.

## Checklist

- [x] Classify OpenClaw's concrete models into capability tiers via an LLM prompt
- [x] Cache the classification on disk keyed by the model-list hash
- [x] Group the chat picker by tier
- [x] Add a UI refresh that forces reclassification

## What changed

**Classify OpenClaw's concrete models into capability tiers via an LLM prompt.**
`packages/openclaw-plugin/src/lib/openclaw-models.ts` gains `classifyModels`, which
runs a one-shot `openclaw infer model run --gateway --json` with a prompt asking for
a compact `[{id,tier}]` JSON array, and `parseClassification`, which reads the
infer-run envelope (`outputs[0].text`), strips code fences, and maps ids to the
`smart` / `balanced` / `fast` tiers. A new `ModelTier` type + `RunnerModel.tier`
field (in `packages/app-engine/src/runtime.ts`, mirrored in the renderer's
`centraid-api.d.ts`) carry the result.

**Cache the classification on disk keyed by the model-list hash.** `hashModelIds`
derives a stable hash of the model-id set; `resolveOpenClawModels` reads/writes a
`model-tiers.json` cache under the OpenClaw state dir. A normal runner-status read
serves the cache and, on a cold/stale cache, kicks a fire-and-forget classification
(guarded against overlap) so it never blocks; the plugin's `runnerStatus` calls this.

**Group the chat picker by tier.** `loadChatModels` in `apps/desktop/src/renderer/app.ts`
renders `<optgroup>` headers (Most capable / Balanced / Fastest) when models carry a
`tier`, falling back to a flat list otherwise. The runner-status seam grew an optional
`{ refresh }` (`RunnerStatusOptions` + a `refresh` flag parsed from the route query in
`router.ts`, threaded through `runtime.ts` and `build-gateway.ts`).

**Add a UI refresh that forces reclassification.** The picker's Refresh button now
calls `getRunnerStatus({ refresh: true })` (renderer `gateway-client-chat.ts` →
`/centraid/_chat/runner-status?refresh=1`), which makes the plugin reclassify
synchronously and rewrite the cache.

## Out of scope

- Live `/v1/models` fetching for codex/claude-code (still capability tiers / static).
- Per-user tier overrides or manual tier editing.
- Classifying the full `--all` OpenClaw catalog (only the configured models).

## Verification

- `bun run --cwd packages/app-engine build` — clean (emits `ModelTier`,
  `RunnerStatusOptions`, `RunnerModel.tier`).
- `apps/desktop` typecheck — clean. `gateway`, `agent-runtime`, and `openclaw-plugin`
  typecheck against the freshly built app-engine `dist` (paths override) — exit 0;
  the plugin's `runnerStatus` param is optional so it stays assignable across the
  worktree's stale `@centraid/gateway` dist too.
- New tests pass (openclaw-models 10/10): `parseClassification` (envelope mapping,
  fence stripping, invalid-tier drop, malformed input) and `hashModelIds` (order
  stable, set-sensitive).
- Live end-to-end: `resolveOpenClawModels({ refresh: true })` against the running
  gateway classified the configured models, wrote the cache, and a subsequent read
  served the cached tiers.
- oxlint + oxfmt clean on all changed files.
