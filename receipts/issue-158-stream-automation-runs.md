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
- [~] **2 — Streaming Phase 1**: live node lifecycle (runner-agnostic
      foundation; durable timeline, late-join, parallel lanes). Backend
      (components 1+2+3) landed; desktop subscription (component 5) next.
- [ ] **3 — Streaming Phase 2**: per-runner `ctx.agent` token parity
      (claude SDK → codex app-server → openclaw ACP)
- [ ] **4 — Streaming Phase 3**: mock per-call tool timing

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

## Out of scope (so far)

- **Phase 1 component 5** (desktop SSE subscription replacing the 1.5s
  poll) — lands next on this branch. The backend streams today; the
  desktop still polls (unchanged, still works), so this is purely additive.
- **Streaming Phases 2–3** (`ctx.agent` token parity, mock per-call tool
  timing) — follow-up commits.
- Moving the chat custom-provider codex path off `materializeCodexHome`
  onto `-c` overrides — noted in the `codex-app-server.ts` comment, needs
  a live custom-provider chat turn to validate before flipping.

## Verification

- **Item 1:** `codex-provider-config.test.ts` 12 → 15 tests pass (3 new
  pinning `codexProviderOverrideArgs` output, env_key omission, no API key
  in args).
- **Phase 1 backend:** `agent-runs-store.test.ts` +2 (open/close lifecycle,
  in-flight NULL marker, token rollup); `run-event-bus.test.ts` +5 (fanout
  scoping, ephemeral no-op, unsubscribe, throwing/self-unsubscribing
  subscriber); `run-events-sse.test.ts` +3 (finished-run replay, in-flight
  late-join → live → close, 400 on missing runId); `automation-fire.test.ts`
  +1 (full `run.start`→node lifecycle→`run.end` sequence for tool + agent).
- Suites green: app-engine 310, automation 60, agent-runtime 62, gateway 82.
- Full-repo `turbo run build` green; `format:check` + `lint` clean.
