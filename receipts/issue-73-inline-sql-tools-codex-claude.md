# issue-73 — promote centraid SQL ops to first-class inline tools for codex + Claude

GitHub issue: [#73](https://github.com/srikanth235/centraid/issues/73)

## Checklist

- [x] Shared `sql-ops` core (`describeOp` / `readOp` / `writeOp`)
- [x] `centraid` CLI refactored to call shared ops
- [x] `AppChange` extended with provenance fields
- [x] SSE wire payload carries provenance
- [x] Codex `dynamicTools` + `item/tool/call`
- [x] Claude `createSdkMcpServer`
- [x] Chat-adapter swap to typed tools
- [x] Local-runtime wires change emitter
- [x] Auto-injected change-bridge in served HTML
- [x] Builder system-prompt reactive-data section
- [x] Tests pass

## What changed

> Cross-references for the checklist above:
> Shared `sql-ops` core (`describeOp` / `readOp` / `writeOp`),
> `centraid` CLI refactored to call shared ops,
> `AppChange` extended with provenance fields,
> SSE wire payload carries provenance,
> Codex `dynamicTools` + `item/tool/call`,
> Claude `createSdkMcpServer`,
> Chat-adapter swap to typed tools,
> Local-runtime wires change emitter,
> Auto-injected change-bridge in served HTML,
> Builder system-prompt reactive-data section,
> Tests pass.

**Why this matters.** Before this change the chat-assistant read / wrote an app's SQLite through the `centraid` CLI, which both codex and Claude invoked via their generic shell / Bash tool. Three costs followed: (1) CLI writes opened their own SQLite connection, so the runtime's in-process `Session` change-tracker never fired and the iframe stayed stale until the user manually navigated; (2) the agent saw an unstructured shell tool (`Exec(/bin/zsh -lc 'centraid sql write "UPDATE …"')`) instead of three typed tools; (3) PATH injection, shell quoting, and working-directory contracts were load-bearing in a way that was invisible to the agent prompt.

**Shared `sql-ops` core.** `packages/runtime-core/src/sql-ops.ts` lifts the three operations (describe / read / write) out of `centraid-cli.ts`, including the SELECT-only and DML-only guards, the 200-row read cap, and an `onWrite(tables)` callback. The CLI bin keeps working — it just calls the shared functions so any future tweak applies everywhere at once.

**Codex `dynamicTools` + `item/tool/call`.** `runCodexAppServerTurn` now sends `dynamicTools: [...]` on `thread/start` (only when the caller supplies a `ToolContext`) and adds an `item/tool/call` branch to its server-request dispatch. The tool-dispatch body lives in `codex-centraid-tools.ts` so the driver file stays small. Each call emits a `tool.start` followed by a `tool.result` event with the same `toolCallId` codex used, so the chat UI renders SQL pills natively. Write calls invoke `ctx.emitChange({ tables, toolCallId })` so the change bus fires with precise tables in the same process the runtime is hosting.

**Claude in-process MCP server.** `runClaudeSdkTurn` builds a per-turn `createSdkMcpServer({ name: 'centraid', tools: [...] })` via the SDK's `tool(...)` helper. Each handler returns the JSON-stringified payload as a single `text` content block so the model sees the same response shape across backends. The write handler propagates the SDK's `toolUseId` through `ctx.emitChange`. Zod is added as a peer dep on `@centraid/agent-runtime`; it's loaded via dynamic import so the codex code path never pays the cost.

**Provenance through the bus.** `AppChange` now requires `source: 'agent' | 'handler' | 'external'` and exposes optional `toolCallId` / `agentTurnId`. The `_changes` SSE payload mirrors the shape. `Runtime.emitForApp(appId, source)` stamps handler / external writes; new `Runtime.agentEmitForApp(appId)` returns the closure the chat adapter uses for agent writes — it propagates the per-turn `agentTurnId` (minted in `makeChatRunner.run`) and the per-call `toolCallId`. Openclaw's `centraid_sql_write` tool also stamps `source: 'agent'` so the cross-host SSE shape stays consistent. Existing tests are updated to pass the new field; new tests assert the wire format for both agent and handler flows.

**Auto-injected change-bridge.** `serveStatic` now accepts `changeBridgeAppId` and, when set, injects a small inline `<script>` that opens an `EventSource('/centraid/<appId>/_changes')`, exposes `window.centraid.onChange(cb)`, and dispatches a `centraid:datachange` `CustomEvent` on `document` whose detail is `{ tables, source, toolCallId?, agentTurnId?, ts }`. The bridge sits right before `</body>` so the rest of the page parses without waiting on the subscription; non-HTML responses are untouched. `appId` is JSON-stringified at injection time as defense-in-depth even though the runtime's id validator already forbids `/` and `..`. The per-response CSP nonce stamp catches the bridge automatically. The runtime wires `changeBridgeAppId: entry.id` for both `app-index` and `app-static` routes so user-authored multi-page apps work without effort.

**Chat-adapter swap.** The system-prompt preamble describes the three typed tools instead of the CLI subcommands, drops the centraidCliDir / extraPath wiring, and mints a stable `agentTurnId` per `ChatRunner.run`. The local-runtime closes over `runtime.agentEmitForApp` via a deferred ref to break the constructor cycle (`Runtime` needs the runner; the runner needs the runtime's emitter).

**Builder prompt.** `packages/builder-harness/src/system-prompt.ts` picks up a "Reactive data — keep the UI in sync with writes" section documenting both subscription APIs (`window.centraid.onChange` and the `centraid:datachange` DOM event), the full detail shape, what each `source` band means, and three practical patterns: filter by `tables`, flash agent-driven writes, one sink not many.

**Tests.** 203/203 runtime-core tests pass (was 198 before — five new tests for the bridge inject + SSE provenance) and 18/18 agent-runtime tests pass. New `sql-ops.test.ts` covers the SELECT-only / DML-only refusal, the row cap, and the `onWrite` callback firing. SSE tests now assert agent-sourced events carry `source: 'agent'` + `toolCallId` + `agentTurnId`, and handler-sourced events carry `source: 'handler'` with the optional fields absent. Static-server tests cover bridge inject end to end (shape + nonce + CSP whitelist), the `</html>` fallback when no `<body>` is present, embedded-quote safety, no-inject for non-HTML responses, and the no-op when `changeBridgeAppId` is absent.

## Verification

- `bun run typecheck` — 16/16 turbo tasks successful (runtime-core, agent-runtime, builder-harness, desktop, openclaw-plugin, chat-harness, etc.).
- `bun run test` — 203/203 runtime-core tests pass; 18/18 agent-runtime tests pass.
- `bun run lint` — 0 warnings, 0 errors.
- New tests:
  - `packages/runtime-core/src/sql-ops.test.ts` — SELECT-only / DML-only refusal, 200-row cap, `onWrite` callback firing with precise tables.
  - `packages/runtime-core/src/changes-sse.test.ts` — agent-sourced events carry `source: 'agent'` + `toolCallId` + `agentTurnId`; handler-sourced events carry `source: 'handler'` with the optional fields absent.
  - `packages/runtime-core/src/static-server.test.ts` — bridge inject + nonce stamping + CSP whitelist, `</html>` fallback when no `<body>`, embedded-quote safety, no-inject for non-HTML responses, no-op without `changeBridgeAppId`.
- Backwards compatibility: existing handler-sourced changes in `runtime.ts`'s `app-run` path continue to emit precise table names; no regression in the cloud-panel SQL editor (it now stamps `source: 'external'`); openclaw plugin's `centraid_sql_write` tool stamps `source: 'agent'` so cross-host SSE shape stays consistent.

## Out of scope (carried forward to follow-up issues)

- Deprecating the `centraid` CLI binary itself — kept for human / scripted callers.
- `fs.watch`-based cross-process reactivity backstop for ad-hoc writers (e.g. user running `sqlite3` in Terminal).
- Per-query subscriptions (a small reactive query layer keyed by table names).
- Splitting `centraid_sql_write` into INSERT / UPDATE / DELETE tools or adding parameterized queries.
- "Undo this assistant action" / `toolCallId`-keyed audit log — the data is now in the bus; the feature is its own issue.
