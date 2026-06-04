# issue-196 — Drive local claude automations via in-process Agent SDK

GitHub issue: [#196](https://github.com/srikanth235/centraid/issues/196)

The local automation runner's `defaultSpawnCli` was the last `claude -p`
subprocess holdout. Every other claude path already runs the in-process
`@anthropic-ai/claude-agent-sdk` `query()` — chat, `ctx.agent`
(`runClaudeSdkTurn`), model enumeration, and host-tool enumeration
(`captureClaudeTools`). This moves the `ctx.tool` dispatch path to the same
in-process SDK and fixes the comment drift that still called the claude runner
a `claude -p` subprocess.

## Checklist

- [x] Replace `claude -p` spawn with in-process Agent SDK `query()`
- [x] Point at the mock via `options.env` without mutating `process.env`
- [x] Fix `claude -p` comment drift

## What changed

### `packages/agent-runtime/src/run-automation-cli-spawn.ts`

- **Replace `claude -p` spawn with in-process Agent SDK `query()`.**
  `defaultSpawnCli` now branches into two helpers. The claude branch calls a
  new `runClaudeAgentSdk` that drives one turn through the in-process
  `@anthropic-ai/claude-agent-sdk` instead of spawning a subprocess; the codex
  branch is extracted unchanged into `spawnCodexExec` (still a real
  `codex exec` subprocess — there is no in-process equivalent).
- **Map CLI flags to SDK options.** `--allowed-tools` → `allowedTools`,
  `--permission-mode bypassPermissions` → `permissionMode` +
  `allowDangerouslySkipPermissions: true`, `binPath` →
  `pathToClaudeCodeExecutable`. The `--verbose` / `--output-format stream-json`
  flags are dropped (they were CLI-stdout concerns the SDK does not have).
- **Point at the mock via `options.env` without mutating `process.env`.** The
  per-fire mock URL + bearer are set as `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_API_KEY` on a copied env passed through `options.env`, which the
  SDK uses as the child env wholesale — the host `process.env` is never
  touched (matching `captureClaudeTools` / `runClaudeSdkTurn`).
- The generator is drained to completion: the mock dictates every turn and
  ends it with `end_turn`, so a clean turn returns `{ ok: true, exitCode: 0 }`
  and an abort/error returns `{ ok: false }` so the awaiting `ctx.tool` batch
  sees a failure rather than a silent success. The `SpawnCli` /
  `SpawnCliResult` contract is unchanged; `SpawnCliResult.exitCode`'s doc now
  notes the SDK path synthesizes `0`/`null`.

### Fix `claude -p` comment drift

The claude runner is no longer a subprocess, so comments that described it as
`claude -p` were corrected to "in-process Claude Agent SDK turn":

- `packages/agent-runtime/src/run-automation-live-dispatch.ts` — module header,
  the `startLiveDispatch` doc, and the `driveAgent` adapter comment.
- `packages/agent-runtime/src/run-automation-local.ts` — module header.
- `packages/conversation-engine/src/automation/mock-llm-server.ts` — module
  header, the wire-protocol table's `(claude -p)` → `(Claude Agent SDK)`
  annotation, the concurrency-model paragraph, and `endDispatch`'s doc.
- `packages/conversation-engine/src/automation/mock-llm-writers.ts` — the
  streaming-default and Anthropic-Messages writer comments.
- `packages/conversation-engine/src/automation/persistent-mock-session.ts` —
  the `driveAgent` variants comment.
- `packages/conversation-engine/src/automation/worker/automation-runner.ts` —
  the "why batching" comment, also reframed off the pre-#166 per-batch-spawn
  model onto per-turn mock round-trips.
- `packages/conversation-engine/src/index.ts` — two re-export comments.

## Out of scope

- The codex `codex exec` subprocess path is unchanged — there is no in-process
  codex SDK, so it still spawns.
- The OpenClaw embedded (`runEmbeddedAgent`) dispatch path is untouched.
- No rename of the `SpawnCli` / `defaultSpawnCli` / `SpawnCliInput` /
  `SpawnCliResult` surface — the codex path still genuinely spawns and a rename
  would churn `run-automation-local`, `live-dispatch`, the barrel, and the
  gateway for no functional gain.

## Verification

- `tsc --noEmit` clean on both `@centraid/agent-runtime` and
  `@centraid/conversation-engine`.
- Automation tests pass (25/25) across `persistent-mock-session`,
  `mock-llm-server`, and `automation-fire` in conversation-engine — the
  dispatch contract `defaultSpawnCli` plugs into is exercised there via
  injected drivers.
- The SDK option names (`allowedTools`, `permissionMode`,
  `allowDangerouslySkipPermissions`, `pathToClaudeCodeExecutable`) were checked
  against the installed `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` before
  wiring. No test imports `defaultSpawnCli` directly (tests inject their own
  `spawnCli`), so the public behavior contract is preserved.
