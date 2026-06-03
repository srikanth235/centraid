# issue-178 — Enumerate chat models per runtime

GitHub issue: [#178](https://github.com/srikanth235/centraid/issues/178)

Follow-up to [#176](https://github.com/srikanth235/centraid/issues/176). The chat
model picker reads `RunnerStatus`, but no runtime actually enumerated its models.
This wires per-runtime enumeration so the picker lists real choices for OpenClaw,
codex, and claude-code.

## Checklist

- [x] Add a `RunnerStatus.models` field for runtime-enumerated models
- [x] Enumerate OpenClaw models via the `openclaw models list` CLI
- [x] Offer provider-agnostic capability tiers for claude-code (codex stays on gateway default)
- [x] Read runner-status from the active gateway in the chat picker

## What changed

**Add a `RunnerStatus.models` field for runtime-enumerated models.** Added a
`RunnerModel` interface (`{ id, name?, default? }`) and a top-level
`models?: RunnerModel[]` on `RunnerStatus` in `packages/app-engine/src/runtime.ts`,
exported from the package index. Mirrored as `CentraidRunnerModel` /
`CentraidRunnerStatus.models` in the renderer's `centraid-api.d.ts`. This field is
distinct from `provider.models` (the custom OpenAI-compatible endpoint's `/models`
catalog), which stays for the codex-with-custom-endpoint case.

**Enumerate OpenClaw models via the `openclaw models list` CLI.** New
`packages/openclaw-plugin/src/lib/openclaw-models.ts` shells out to
`openclaw models list --json` and maps each entry's `key`→`id`, `name`, and
`tags:["default"]`→`default`. It is best-effort (6s timeout, `[]` on any failure)
so runner-status never breaks. The plugin's `runnerStatus` override in
`packages/openclaw-plugin/src/index.ts` now attaches the enumerated `models`.

**Offer provider-agnostic capability tiers for claude-code (codex stays on gateway
default).** Pinning concrete model ids is disallowed by the `no-hardcoded-model-ids`
directive, so `packages/agent-runtime/src/model-tiers.ts` defines capability tiers
(`smart` / `balanced` / `fast`) rather than a static id catalog. `runPreflight`
attaches them to `status.models` for claude-code; codex has no tier vocabulary so
it stays on "Gateway default" (its custom endpoint still surfaces live `/models`).
`resolveClaudeModel` in `claude-sdk.ts` maps a tier to the Claude CLI's built-in
aliases (smart→opus, balanced→sonnet, fast→haiku) at turn time, passing full ids
through unchanged.

**Read runner-status from the active gateway in the chat picker.** Added an HTTP
`getRunnerStatus()` to the renderer's `gateway-client.ts` that hits the active
gateway's `GET /centraid/_chat/runner-status` (instead of the local-IPC preflight),
so a remote OpenClaw gateway's models are reachable. `loadChatModels()` in
`app.ts` now uses it, preferring `status.models`, falling back to
`status.provider.models`, and flags the default model in the option label.

## Out of scope

- Live model fetching for codex/claude-code (proven viable via the Anthropic
  `/v1/models` endpoint, but deliberately deferred — capability tiers for now).
- A codex tier vocabulary / reasoning-effort mapping.
- Claude / codex credential reading on the gateway host.

## Verification

- `bun run --cwd packages/app-engine build` — clean (emits the new `RunnerModel` /
  `RunnerStatus.models` declarations).
- `apps/desktop` typecheck — clean.
- `agent-runtime` typecheck against the freshly built app-engine `dist`
  (paths-override tsconfig) — exit 0. Plain in-worktree runs show only the known
  stale-`dist` `RunnerModel` artifact, which resolves in dependency order in CI.
- The `no-hardcoded-model-ids` governance directive passes (no concrete provider
  ids in centraid source; tier tokens + CLI aliases only).
- New tests pass: `openclaw-models.test.ts` (parse mapping, 5/5) and
  `model-tiers.test.ts` (tiers + `resolveClaudeModel` alias mapping, 3/3).
- Live integration: `listOpenClawModels()` against the installed `openclaw` returned
  the configured models with the default flagged.
- oxlint + oxfmt clean on all changed files.
