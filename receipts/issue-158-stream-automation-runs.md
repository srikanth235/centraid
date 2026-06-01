# issue-158 — stream automation runs end-to-end

GitHub issue: [#158](https://github.com/srikanth235/centraid/issues/158)

Automations run on the same agent engines as chat, but their runs are
**not streamed** — `run-now` returns `202 {runId}` and detaches, the run
viewer loads the node timeline once, and the standing-order panel polls
the ledger every 1.5s. Chat, by contrast, streams token-level
`ChatStreamEvent`s over SSE.

This issue streams automation runs end-to-end with **full chat parity**
(the same `ChatStreamEvent` union, nested per run-node) using a
**ledger-tail hybrid** (durable nodes + ephemeral token deltas). It also
captures a **priority prerequisite**: codex `ctx.tool` couldn't reach the
user's MCP servers, undercutting the "ride on top of the user's
claude/codex/openclaw" model.

v0 pre-release: no backward compatibility, no migrations.

## Checklist (suggested sequence)

- [x] **1 — codex `ctx.tool` `-c` MCP fix** (priority prerequisite; small,
      unblocks the MCP value prop)
- [x] **2 — Streaming Phase 1**: live node lifecycle (runner-agnostic
      foundation; durable timeline, late-join, parallel lanes). Backend
      (components 1+2+3) + desktop SSE subscription (component 5) landed.
- [~] **3 — Streaming Phase 2**: per-runner `ctx.agent` token parity.
      claude (SDK) landed — backend + token persistence + desktop live
      render. codex (app-server) and openclaw (ACP) remain (need live-CLI
      validation + provider-config threading for codex).
- [x] **4 — Streaming Phase 3**: mock per-call tool timing — a tool node's
      duration is its real execution window, not the batch span.

## What changed

### 1 — codex `ctx.tool` `-c` MCP fix

Deterministic `ctx.tool` dispatch routed codex through a redirected
`CODEX_HOME` (`materializeCodexHome`), which writes a bare `config.toml`
declaring only the mock provider — and thereby **drops** the user's
`[mcp_servers.*]`. So during the deterministic tool turn, the agent could
not reach the user's MCP servers, defeating the "ride on top" model.

- New `codexProviderOverrideArgs(provider)` in `codex-provider-config.ts`
  renders `-c key=value` provider overrides (model_provider + the
  `[model_providers.<id>]` table) as TOML basic strings. These layer on
  top of the user's real `~/.codex/config.toml` instead of replacing it,
  so the user's MCP servers survive. Honored by `codex exec` since
  codex-cli 0.128.0 (our pinned `MIN_VERSIONS` minimum) — POC-proven.
- `run-automation-cli-spawn.ts` (the `ctx.tool` codex path) now spawns
  `codex exec` with those overrides and **no `CODEX_HOME` redirect**. The
  bearer token still flows via env under `env_key`, never on disk.
- Corrected the stale `codex-app-server.ts` comment claiming app-server
  doesn't honor `-c` (it does in 0.128.0). The chat custom-provider path
  still uses `materializeCodexHome`; moving it to `-c` (to preserve MCP in
  chat too) is noted as a follow-up needing a live-turn validation.

`materializeCodexHome` is retained — still used by the chat app-server
custom-provider path and `host-tools.ts`.

### 2 — Streaming Phase 1: live node lifecycle (backend)

The runner-agnostic foundation. All events originate parent-side (no new
worker IPC); the transport is a plain in-process emitter feeding SSE.

- **`@centraid/app-engine`**
  - New `RunStreamEvent` union (`run-stream-event.ts`): `run.start` /
    `node.start` / `node.end` / `run.end` (durable, replayable) plus
    `node.delta` (ephemeral chat-parity tokens, emitted from Phase 2 on).
  - `AgentRunsStore` gains `openNode()` (insert a "running" row —
    `ended_at`/`duration_ms` NULL, `ok` provisional) + `closeNode()`
    (settle outcome + the token/model rollup). Per-call, `batchId`
    preserved for parallel lanes. `insertNode` kept for one-shot writes.
- **`@centraid/automation`** — an `onRunEvent` sink threads alongside
  `onLog` from `runAutomationHandler` → `runAutomationFire`. The audit
  helpers split into `openRunNode`/`closeRunNode` (durable write **+**
  `node.*` emit, both guarded). `run.start`/`run.end` bracket the run.
  Tool batches open every node before dispatch (parallel-lane view); the
  `onFailure` cascade is **not** streamed onto the parent channel (separate
  run, separate id).
- **`@centraid/agent-runtime`** — `runAutomationLocal` forwards `onRunEvent`.
- **`@centraid/gateway`** — new `RunEventBus` (runId-keyed in-process
  emitter). `fireAutomation` mints the runId up front (so cron fires have a
  stable channel) and publishes via `onRunEvent`. New SSE endpoint
  `GET /centraid/_automations/run/events?runId=`: subscribe-first, replay
  the durable ledger snapshot, then drain buffered + live events until
  `run.end`. A finished run replays terminal-and-closes (late join); a
  background fire with no viewer still persists nodes.

No token deltas yet — `ctx.agent` shows start→end (Phase 2 adds tokens).

#### Component 5 — desktop SSE subscription

The run viewer no longer polls every 1.5s. New `streamAutomationRun()`
client (SSE consumer, same fetch+ReadableStream pattern as `streamChat`).
`renderRunView` keeps a local node model keyed by ordinal and re-renders on
each `node.start`/`node.end`; on `run.end` it refetches the authoritative
run record + persisted nodes. `waitForAutomationRun` (standing-order panel,
no viewer) now resolves off the stream's `run.end`. Both fall back to a
bounded ledger poll if the stream can't be established (older gateway).
`loadNodesInto` (historical runs panel) stays a one-shot read — finished
runs don't stream.

### 3 — Streaming Phase 2: `ctx.agent` token parity (claude)

Per the issue's "one runner at a time" plan, claude first. `ctx.agent` for
the claude runner now routes through the **Claude SDK chat adapter**
(`runClaudeSdkTurn`) — the same adapter chat uses — instead of a
collect-on-exit `claude -p` spawn.

- **agent-runtime** — the live-dispatch agent dispatcher's claude branch
  calls `runClaudeSdkTurn` with `permissionMode: 'bypassPermissions'`
  (preserving the old non-interactive behavior), forwards each
  `ChatStreamEvent` to `call.onEvent`, accumulates the final text, and
  coerces it exactly as before (return contract unchanged). codex/openclaw
  stay on the collect-on-exit path. Added an optional `permissionMode`
  passthrough to `ClaudeSdkInput` (additive; chat leaves it unset).
- **automation** — `AutomationAgentCall` gains an `onEvent` sink; the
  handler runner forwards it, wraps each event as a `node.delta` on the
  agent node, and captures the adapter's `usage` event to persist the
  token/model rollup via `closeRunNode` → `closeNode` (so `runs.total_*`
  is accurate for `ctx.agent`).
- **desktop** — the run viewer accumulates `node.delta` assistant text per
  node ordinal and renders it live in the in-flight agent card; the final
  output replaces it on `node.end`.

Test: a stubbed streaming dispatcher proves `node.delta` forwarding (agent
ordinal) + usage persisted onto the node and rolled up on the run.

### 4 — Streaming Phase 3: mock per-call tool timing

In Phase 1 a tool batch opened every node at dispatch start and closed
them all at dispatch end — so a tool's recorded duration also covered the
CLI spawn/teardown that brackets the batch. Phase 3 narrows it to the real
per-tool window.

- **mock-llm-server** — new `onToolStart(dispatchId, toolUses)` callback,
  fired the instant the mock returns a turn carrying `tool_use` blocks (the
  CLI is handed the calls). Pairs with the existing per-call `onToolResults`
  (the finish side).
- **agent-runtime** — the live-dispatch tool dispatcher records per-tool
  start (onToolStart) + finish (onToolResults) keyed by dispatch + tool-use
  id, and attaches `startedAt`/`endedAt` to each `AutomationToolResult`.
- **automation** — `dispatchToolBatch` uses the dispatcher's reported
  per-call window for the node's duration when present, falling back to the
  batch span otherwise.

Tests: mock fires `onToolStart` per tool_use (and not for text-only turns);
a fire with a dispatcher-reported 250ms window records that as the node
duration, not the batch span.

## Out of scope

- **Phase 2 for codex + openclaw** — route their `ctx.agent` through the
  app-server / ACP adapters (claude is done). Deferred: needs live-CLI
  validation, and codex needs provider-config threading into the automation
  fire path. The streaming transport + node.delta plumbing is already
  runner-agnostic, so each is a localized adapter swap.
- Moving the chat custom-provider codex path off `materializeCodexHome`
  onto `-c` overrides — noted in the `codex-app-server.ts` comment; needs a
  live custom-provider chat turn to validate before flipping.

## Verification

- **Item 1:** `codex-provider-config.test.ts` +3 (`codexProviderOverrideArgs`
  output, env_key omission, no API key in args).
- **Phase 1:** `agent-runs-store.test.ts` +2 (open/close lifecycle, in-flight
  NULL marker, token rollup); `run-event-bus.test.ts` +5; `run-events-sse.test.ts`
  +3 (replay, late-join → live → close, 400 guard); `automation-fire.test.ts`
  +1 (full `run.start`→node→`run.end` sequence). Desktop run viewer + the
  standing-order wait reimplemented on the SSE stream (typecheck + bundle
  green; Electron runtime not exercised here).
- **Phase 2 (claude):** `automation-fire.test.ts` +1 (`node.delta` forwarding
  on the agent ordinal + usage persisted onto the node and rolled up).
- **Phase 3:** `mock-llm-server.test.ts` +2 (`onToolStart` per tool_use; not
  fired for text-only turns); `automation-fire.test.ts` +1 (per-call window
  → node duration, not the batch span).
- Suites green: app-engine 310, automation 62, agent-runtime 64, gateway 82.
- Full-repo `turbo run build` / `typecheck` / `test` green; `format:check` +
  `lint` clean.
