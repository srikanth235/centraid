# issue-319 — Harden the OpenClaw embedded-agent runner (Approach A)

GitHub issue: [#319](https://github.com/srikanth235/centraid/issues/319)

We keep the **embedded agent runner** (`api.runtime.agent.runEmbeddedAgent`,
Approach A) as the turn engine and close the gaps around it. This lands the
three substantive workstreams; the fourth (optional complementary hooks) is
assessed and deferred with rationale below.

## Checklist

- [x] WS1 — turn accounting: usage events + real tool names on the OpenClaw chat path
- [x] WS2 — session/workspace state off shared-global paths
- [x] WS3 — vault tools on the embedded turn
- [x] WS4 — complementary gateway hooks (assessed, deferred)

## What changed

### WS1 — turn accounting: usage events + real tool names on the OpenClaw chat path

`packages/openclaw-plugin/src/lib/openclaw-conversation-runner.ts`:

- **Real tool names.** `tool.start` / `tool.result` are now driven off the
  always-on `onAgentEvent` stream (`stream: "tool"`, discriminated by
  `data.phase`), which carries the authoritative `toolCallId` + tool `name` +
  `isError`. The old code pattern-matched `tool_execution_start` /
  `tool_call_start` (OpenClaw's real stream name is just `"tool"`, so the match
  never fired) and synthesized `tool.result` from the `onToolResult` callback
  (which only fires under `verboseLevel: on|full`, so it emitted nothing by
  default and carried an empty `toolName`). Net: the OpenClaw chat trace went
  from **no tool events** to correctly-named, start/result-paired ones.
- **Usage.** After the run settles we emit one `usage` `TurnStreamEvent` from
  `result.meta.agentMeta` (provider, model, input/output/cache tokens), so the
  chat route folds real token + cost accounting into the unified ledger for
  OpenClaw turns exactly as it does for codex/claude.

### WS2 — session/workspace state off shared-global paths

`packages/openclaw-plugin/src/lib/openclaw-conversation-runner.ts`:

- **workspaceDir.** Was hardcoded to `~/.openclaw/centraid/_conversation-workspace`
  via `os.homedir()` — a single scratch dir **shared by every vault's turns**.
  Now derived from the runner-session dir (`path.dirname(sessionFile)` — the
  active vault's `runner-sessions/`), so it is per-vault disposable.
- `sessionFile` and the assistant `assistant-cwd` were **already** per-vault
  (both under `currentWorkspace().runnerSessionDir`); confirmed, nothing to
  change there. `workspaceDir` was the only cross-vault leak.

### WS3 — vault tools on the embedded turn

The **clientTools** path was the flagged "remaining verification" — and it is
**NOT** a synchronous in-process fulfillment path. `clientTools` on
`runEmbeddedAgent` route through `toClientToolDefinitions`, whose `execute`
returns a `{ status: "pending" }` stub and records the call for an out-of-band
**OpenResponses client** to fulfill across an HTTP boundary; the run yields
rather than feeding a result back to the model in the same turn. Wrong shape.

Instead we use `api.registerTool` (the real in-process path the pre-vault
`centraid_*` trio used) with a **factory keyed on `ctx.sessionKey`**:

- `packages/openclaw-plugin/src/lib/vault-tools.ts` (new) — registers
  `vault_sql` / `vault_invoke` / `vault_content` as OpenClaw agent tools,
  returned by the factory **only** for centraid conversation sessions
  (`centraid-conversation:<appId>:…`), so they never appear in the user's own
  OpenClaw agent's tool list. Each tool executes through the gateway's
  owner-side `makeVaultToolRunners` thunks, which resolve the **request's active
  vault** at call time (per-request vault scope, #289) and run through the same
  consent/receipt/parking pipeline as the CLI runners. Receipt ids stay
  gateway-side.
- `packages/openclaw-plugin/src/index.ts` — a deferred `vaultRegistryReady`
  promise (resolved from `gwPromise` right after `buildGateway`) breaks the
  chicken-and-egg between the injected runner/tools and the built gateway's
  registry; wires `registerVaultTools(api, vaultRegistryReady)`.
- `packages/openclaw-plugin/src/lib/openclaw-conversation-runner.ts` — appends
  the vault-register grounding (schema map + how to use the three tools) to the
  route's app-context preamble, because the app prompt deliberately names no
  vault schema; without it the agent would have the tools but not know the
  vault's shape.
- `packages/openclaw-plugin/package.json` (+ `bun.lock`) — adds the
  `@centraid/agent-runtime` and `typebox` (1.x, for the tool `parameters`
  schema) dependencies.
- Exports to reuse, not duplicate: `makeVaultToolRunners` + a new
  `buildVaultToolsGrounding` (the assistant register minus the shell's
  fenced-block answer format, which an app's own chat UI can't render) from
  `packages/gateway/src/index.ts` (grounding added in
  `packages/gateway/src/runs/assistant-prompt.ts`); the `VAULT_SQL_TOOL` /
  `VAULT_INVOKE_TOOL` / `VAULT_CONTENT_TOOL` specs from
  `packages/agent-runtime/src/index.ts`.

### WS4 — complementary gateway hooks (assessed, deferred)

Assessed and deferred — see Decisions + Out of scope. No code change.

### Tests

- `packages/openclaw-plugin/src/lib/openclaw-conversation-runner.test.ts` (new)
  — tool-stream → `tool.start`/`tool.result` name mapping, error flag, usage
  folding + omission, per-vault `workspaceDir`, grounding append.
- `packages/openclaw-plugin/src/lib/vault-tools.test.ts` (new) — session-scoped
  factory gating, in-process dispatch through the runners, receipt stripping,
  input validation.

## Decisions

- **`clientTools` is not an in-process tool loop** — it is the OpenResponses
  deferred-fulfillment protocol. In-process synchronous tools go through
  `api.registerTool`. (Resolves the issue's open verification.)
- **Session-scoped factory, not global registration + a `before_tool_call`
  guard** — the factory returns the tools only for centraid sessions, so
  `vault_*` never pollutes the user's own agent tool list AND can't reach a
  vault outside a request scope. Strictly better than the historical guard.
- **Grounding without the shell answer format** — app chat renders in the app's
  own UI, not the assistant shell, so the embedded turn must not be told to emit
  `block:table` / `block:chart` frames.
- **Both registers get the vault tools** — the OpenClaw runner handles every
  register (the injected runner short-circuits the ask/build facade); the CLI
  builder + ask registers both carry the vault register, so parity is to expose
  the tools on all centraid conversation turns.
- **WS4 deferred** — `registerAgentEventSubscription` would duplicate the SSE
  turn driver's journal recording; `registerControlUiDescriptor` is unverifiable
  cosmetic surface without a live console. Both optional; not worth the risk now.

## Out of scope

- **WS4 (optional complementary hooks) — deferred** (see Decisions).
- **Builder file-editing tools on the embedded turn** — the issue's parenthetical
  "(and the builder tools)". Authoring app code via the embedded agent needs the
  draft worktree wired as the run's workspace (today it's a scratch dir under
  limited bootstrap) — a larger piece than the data tools; the vault DATA tools
  are the concrete, verified-capable deliverable.
- **The vault-assistant `_assistant` route on the OpenClaw host** still uses the
  agent-runtime (codex/claude) runner rather than the injected embedded runner —
  a separate seam from #319's embedded-turn scope; flagged, untouched.
- **Raw tool-result bodies in the OpenClaw trace** — the sanitized `onAgentEvent`
  stream omits the result body, so `tool.result` carries name + ok, not the full
  output. Accepted trade for a correct, always-on source.

## Verification

Full turbo battery + gates all green from the worktree:

```sh
bun run build        # turbo: 11/11 packages
bun run typecheck
bun run lint:types   # tsgolint: ok across all packages
bun run lint         # oxlint: 0 warnings, 0 errors
bun run format:check
bun run test         # turbo: 21/21 tasks
```

New coverage lives in the two `packages/openclaw-plugin/src/lib/*.test.ts`
files (13 new tests); the affected package suites:

```sh
cd packages/openclaw-plugin && bun run test   # 23 passed
cd packages/agent-runtime && bun run test     # 68 passed
cd packages/gateway && bun run test           # 213 passed, 1 skipped
```

## Residual runtime note

The vault tools register through `api.registerTool` exactly as the historical
`centraid_*` trio did; whether OpenClaw's tool-policy resolution surfaces them
to the `isCanonicalWorkspace: false` limited-bootstrap run is the one thing that
needs a live OpenClaw host to confirm end to end (no such host in this
worktree). The wiring, scoping, and in-process execution are unit-covered.

## Audit

PASS - The receipt's "## What changed" faithfully describes the staged diff across all four workstreams (tool event mapping + usage folding for WS1, workspaceDir scoping for WS2, vault-tools registration + exports for WS3, and deferred assessment for WS4); all [x] checklist items are realized in the code; the checklist mirrors the issue's four-workstream structure exactly.

## Steering

PASS - No human-steering events in the session: a single initial goal directive, no interrupts or mid-task corrections.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-125b3273-480-1783492877-1 | claude-code | 125b3273-4806-4305-89ed-b86aebfc4b89 | #319 | claude-opus-4-8 | 22325 | 80037 | 5291053 | 36438 | 138800 | 4.1683 | 108576 | 870479 | 53218700 | 323879 |  |
| claude-code-125b3273-480-1783492914-1 | claude-code | 125b3273-4806-4305-89ed-b86aebfc4b89 | #319 | claude-opus-4-8 | 6 | 5595 | 927192 | 3831 | 9432 | 0.5944 | 108582 | 876074 | 54145892 | 327710 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
