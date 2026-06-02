# issue-166 — Unified automation runtime: persistent mock session, journaled resume, one fire spine

GitHub issue: [#166](https://github.com/srikanth235/centraid/issues/166)

An automation is a deterministic `handler.js` whose only outside calls are
`ctx.tool` (token-free, puppeted by a mock provider) and `ctx.agent` (the only
billed inference). This issue makes the runtime **one thing across hosts**: a
single long-lived agent session per fire drives every `ctx.tool` batch, the
fire spine is owned once in app-engine, and a journal makes a crashed fire
resumable without re-billing `ctx.agent`.

## Checklist

- [x] One agent session per fire; no per-batch CLI spawn — `ctx.tool` consumes ~0 real model tokens
- [ ] `ctx.agent` is the only billed path; routed to the host `agentDispatcher`; journaled and not re-billed on replay
- [ ] OpenClaw automations run via `runEmbeddedAgent` against the mock provider; `openclaw-fire.ts` bespoke dispatchers + `setOpenClawConfig` deleted
- [ ] Same mock + journal + handler runtime drives codex, claude, and OpenClaw at parity
- [ ] An interrupted fire resumes from the journal

## What changed

### Persistent mock-LLM session — one CLI session per fire (Phase 1)

The mock-LLM server (`mock-llm-server.ts`) becomes a long-lived multi-turn
session instead of a per-batch one-shot. When a CLI request arrives and no turn
is staged yet — because the deterministic handler hasn't reached its next
`ctx.tool` call — the mock now **parks the request** (awaits) rather than
returning 503, releasing it the instant the driver `stageTurn`s the next turn.
A FIFO waiter queue per dispatch id backs this; `stageTurn` releases a parked
request directly, a new `endDispatch(dispatchId)` releases parked requests with
a benign `end_turn` for clean teardown, and `close()` releases every straggler
so an open connection never blocks shutdown. A dropped client connection
settles its parked request too.

`run-automation-live-dispatch.ts`'s `startLiveDispatch` is rewritten around this:
instead of spawning a fresh CLI per `ctx.tool` batch, it spawns **one** CLI
session (lazily, on the first batch — an automation that never calls a tool
never spawns one) pointed at the mock with a single dispatch id. Each batch is
staged into that session; the CLI executes the tools natively through its
MCP/auth machinery and returns `tool_result` blocks, which the dispatcher maps
back by tool-use id. The session stays alive across every batch and exits only
when `close()` stages the final `end_turn`. Per-call timing (issue #158) is
preserved via a flat tool-use-id → window map. If the session dies mid-run
(crash/abort) a parked batch is woken with a failure instead of hanging.

## Out of scope

- The **mock-puppeted OpenClaw tool path** (`runEmbeddedAgent` against a
  `centraid-mock` provider) and deleting `setOpenClawConfig`: per the issue's
  own Phase 2 step 8 this needs the live OpenClaw host (not runnable from a
  bare worktree) and the pi-ai wire-compatibility spike, so the working
  in-process dispatchers are kept and the spine is unified instead.
- The determinism-enforcement of replay (freezing `Date.now`/`Math.random` in
  the worker) — documented as a contract, not yet machine-enforced.

## Verification

- **One agent session per fire; no per-batch CLI spawn — `ctx.tool` consumes
  ~0 real model tokens**: the mock dictates every turn (no real model is
  contacted on the tool path, token-free by construction), and
  `run-automation-live-dispatch.test.ts` asserts `spawns === 1` across three
  dependent `ctx.tool` batches.
- `agent-runtime`: typecheck clean; full suite 59/59 (incl. new
  `run-automation-live-dispatch.test.ts` — a fake persistent CLI that speaks
  the mock's wire over HTTP proves many `ctx.tool` batches run through ONE
  session with dependent results, no spawn when no tool is called, and tool
  errors surface as failed results; `mock-llm-server.test.ts` covers
  park-then-release + `endDispatch`).
- Lint + format clean on all changed files.
