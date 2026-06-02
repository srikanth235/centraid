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
- [x] `ctx.agent` is the only billed path; routed to the host `agentDispatcher`; journaled and not re-billed on replay
- [x] OpenClaw automations run via `runEmbeddedAgent` against the mock provider; `openclaw-fire.ts` bespoke dispatchers + `setOpenClawConfig` deleted
- [x] Same mock + journal + handler runtime drives codex, claude, and OpenClaw at parity
- [x] An interrupted fire resumes from the journal
- [x] Chat and automation share one embedded-agent turn helper — no duplicated runEmbeddedAgent wiring; ctx.agent answer coercion is shared cross-package

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

### Journaled crash-resume + one fire spine across hosts (Phase 3 + the spine lift)

The `run_nodes` ledger already records every `ctx.*` call with its
`output_json` — that IS the journal. `automation-handler-journal.ts` builds a
`RunJournal` from a prior run's settled, successful nodes keyed by ordinal; an
open node (the crash point) or a failed node is not replayable so it re-runs
live. `runAutomationHandler` gains `resumeFromRunId`: it loads the journal
before the handler starts and records the resume as a fresh run linked by
`retryOf`. The three dispatch points consult the journal by ordinal —
`dispatchToolBatch` (whole batch replays when every call is journaled),
`handleAgentMessage` (extracted from the runner), and `handleInvokeMessage`.
Because a replayed call returns the recorded result without dispatching,
**`ctx.agent` is the only billed path; routed to the host `agentDispatcher`;
journaled and not re-billed on replay**, and **an interrupted fire resumes from
the journal** running live only from the first un-journaled call. The
determinism contract (no `Date.now`/`Math.random`/ambient I/O outside `ctx.*`,
so ordinals align on re-run) is documented in the journal module.

The fire spine (`runAutomationFire`) now also **owns `ctx.invoke`**: it builds
an invoke dispatcher that re-enters `runAutomationFire` with the same injected
dispatch surface, so a child automation runs on the same runtime as its parent
and links into the run DAG — lifted out of the per-host fire (the issue's open
question) so every host gets it uniformly. The dispatch seam gains an optional
`model` (the manifest's `requires.model` tier) so a host's `ctx.agent` routes
to the declared capability tier. `resumeFromRunId` is threaded through
`runAutomationFire` and agent-runtime's `runAutomationLocal`.

### Host-agnostic shared session: OpenClaw onto the same runtime (Phase 2 + step 8)

To make codex, claude, **and** OpenClaw run the exact same runtime, the mock
server (`mock-llm-server.ts` + `mock-llm-writers.ts`) and the persistent-session
driver moved down into `@centraid/automation-engine` (the host-agnostic
package both hosts already depend on) as `startPersistentMockSession`. It owns
the mock, single dispatch id, batch staging/correlation, per-call timing, and
teardown — parameterized by one host-specific `driveAgent` callback (the only
thing that varies: a `codex exec`/`claude -p` subprocess vs. an embedded run).
agent-runtime's `startLiveDispatch` is now a thin CLI adapter over it.

`runOpenclawFire` delegates the whole spine (manifest load, ledger, journal/
resume, `onFailure`, `ctx.invoke`) to `runAutomationFire` and injects an
OpenClaw `OpenAutomationDispatch`. **OpenClaw automations run via
`runEmbeddedAgent` against the mock provider**: `toolDispatcher` rides
`startPersistentMockSession` with a `driveAgent` that runs ONE
`runEmbeddedAgent` session pointed at a localhost `centraid-mock` provider
(base_url → the mock, `anthropic-messages` wire); `agentDispatcher` is
`runEmbeddedAgent({ modelRun: true })` against the user's real provider at the
manifest's `model` tier. The bespoke `callGatewayTool` /
`prepareSimpleCompletionModelForAgent` direct dispatchers + the
`setOpenClawConfig` global are **deleted** — `api` is captured by closure and
`callGatewayTool` now runs only inside the embedded agent's own tool loop. So
the **same mock + journal + handler runtime drives codex, claude, and OpenClaw
at parity**, with OpenClaw getting journaled crash-resume + lifted `ctx.invoke`
for free. The build-gateway `fireAutomationFactory` seam injects
`runOpenclawFire` (now passed `api`), so cron + run-now + webhook ride it.

### Shared embedded-agent turn helper — post-#166 dedup

Routing OpenClaw's `ctx.tool`/`ctx.agent` rails through the same
`runEmbeddedAgent` primitive the per-app chat runner already uses exposed
duplication at the agent-turn **leaf** (one layer below the runtime cores,
which stay separate — they're near-inverses, not the same thing). Collapsed:

- `coerceAgentAnswer` (plain-text vs. fenced-JSON coercion of a `ctx.agent`
  answer) lived in BOTH `openclaw-fire.ts` and agent-runtime's
  `run-automation-live-dispatch.ts` — two packages. It moves to
  `@centraid/automation-engine` (`automation-agent-answer.ts`, exported from the
  index) and both hosts import the one copy.
- The OpenClaw `runEmbeddedAgent` invocation — the SDK-derived
  param/config/result types, the centraid defaults (`isCanonicalWorkspace:
  false` → bootstrapMode "limited", `promptMode: 'full'`), and `payloadText` —
  was re-derived in `openclaw-fire.ts` and re-inlined in `openclaw-chat-runner.ts`.
  A new `openclaw-plugin/src/lib/openclaw-agent-turn.ts` owns it as
  `runEmbeddedTurn(api, params)` + `payloadText` + the shared types; the chat
  runner and both fire dispatchers consume it, so **chat and automation share
  one embedded-agent turn helper — no duplicated runEmbeddedAgent wiring; ctx.agent
  answer coercion is shared cross-package**.

The cores are NOT merged: the automation runtime (manifest, deterministic
handler worker, run-nodes ledger, journal/crash-resume, the `ctx.invoke` DAG,
cron/webhook triggers) has no chat analog, and at the tool layer the two are
opposite — chat hits the real model interactively; automation `ctx.tool` is
mock-puppeted and token-free. `translateAgentEvent` stays chat-only (it maps to
`ChatStreamEvent`, so sharing it would dedup nothing).

## Out of scope

- **Live-host runtime confirmation of the OpenClaw mock-puppet path.** The code
  is type-checked against the installed OpenClaw SDK and the shared session is
  unit-tested with a fake `driveAgent`, but the embedded agent actually hitting
  the localhost mock on the `anthropic-messages` wire and executing mock-staged
  tools through OpenClaw's loop is the issue's Phase 2 spike — it needs a live
  OpenClaw host (not runnable from a bare worktree). The wire choice +
  tool-name-space are the assumptions that host run validates.
- The determinism-enforcement of replay (freezing `Date.now`/`Math.random` in
  the worker) — documented as a contract, not yet machine-enforced.

## Verification

- **One agent session per fire; no per-batch CLI spawn — `ctx.tool` consumes
  ~0 real model tokens**: the mock dictates every turn (no real model is
  contacted on the tool path, token-free by construction), and
  `run-automation-live-dispatch.test.ts` asserts `spawns === 1` across three
  dependent `ctx.tool` batches.
- `automation-engine`: typecheck clean; full suite **85/85**. It now owns the
  mock server + the host-agnostic `startPersistentMockSession`:
  `persistent-mock-session.test.ts` drives the session with a fake `driveAgent`
  that speaks the mock's wire over HTTP and proves many `ctx.tool` batches run
  through ONE session with dependent results, no session start when no tool is
  called, and tool errors surface as failed results;
  `mock-llm-server.test.ts` covers park-then-release + `endDispatch`;
  `automation-handler-journal.test.ts` proves a fully-journaled run replays
  with zero re-dispatch, a crash mid-`ctx.tool` replays the journaled
  `ctx.agent` (dispatcher throws if touched — **journaled and not re-billed on
  replay**) while the failed tool re-runs live; `automation-fire.test.ts` adds
  a `ctx.invoke`-through-the-spine test.
- `agent-runtime`: typecheck clean; suite 40/40 against worktree source (the
  `centraid-cli` binary tests need a built dist and run in CI). Its
  `startLiveDispatch` is now a thin CLI adapter over the shared session.
- `openclaw-plugin`: typecheck clean against the worktree's `@centraid/*`
  source + suite 6/6. **OpenClaw automations run via `runEmbeddedAgent` against
  the mock provider; `openclaw-fire.ts` bespoke dispatchers + `setOpenClawConfig`
  deleted** — the new `runEmbeddedAgent`-against-mock dispatch + `centraid-mock`
  provider config are type-checked against the installed OpenClaw SDK; the
  end-to-end host run is the documented spike (Out of scope).
- Cross-package note: the worktree resolves `@centraid/*` to the main repo's
  stale `dist`, so typechecks/tests use `tsconfig` `paths` overrides to the
  sibling `src`; CI builds topologically and runs the full suites fresh.
- Lint + format clean on all changed files; engine files kept under the
  500-line repo-hygiene cap (the agent handler was extracted into
  `automation-handler-ctx.ts`).
