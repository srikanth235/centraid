# issue-73 — chat path correctness + reactive data foundation

GitHub issue: [#73](https://github.com/srikanth235/centraid/issues/73)

This commit lands the **preconditions** for #73 (which tracks promoting `centraid_sql_*` to first-class inline tools on codex + Claude). The inline-tool refactor itself is the *next* commit on this issue; everything here was discovered while trying to verify the chat path end-to-end and turned out to be load-bearing for that refactor.

## Checklist

- [x] chat-adapter cwd fix
- [x] codex sandbox kebab-case fix
- [x] default agent runner kind to codex
- [x] AI providers panel render fix
- [x] tool-call expander scroll fix
- [x] auto-inject change-bus bridge
- [x] templates subscribe to change bus
- [x] builder system prompt reactive-data section
- [x] tests pass

## What changed

### chat-adapter cwd fix

`packages/agent-runtime/src/chat-adapter.ts` was computing the spawn `cwd` as `path.join(opts.appsDir, input.appId)`. That equals `appDataDir(entry)` only for **uploaded** apps — path-registered apps have an externally-supplied `entry.path` that doesn't match, so the codex `workspaceWrite` sandbox covered the wrong directory and the agent couldn't open `data.sqlite`. Fixed by adding `dataDir: string` to `ChatRunInput`, populating it from `appDataDir(entry)` in `chat-routes.ts`, and using it as cwd. `MakeChatRunnerOptions.appsDir` is gone — no longer needed.

### codex sandbox kebab-case fix

`packages/agent-runtime/src/codex-app-server.ts` was sending `sandbox: 'workspaceWrite'`. Codex 0.128's `SandboxMode` serde is kebab-case and rejects the camelCase form with `unknown variant`. Pinned to `'workspace-write'`. Same docstring updated.

### default agent runner kind to codex

`apps/desktop/src/main/local-runtime.ts` and `apps/desktop/src/main/ipc.ts` had a `prefs.agent.runner.kind` guard that emitted *"No coding agent configured. Open Settings → AI providers and pick Codex or Claude Code."* But the AI providers panel never wrote that pref (no picker), so even a fresh install with `~/.codex/auth.json` present hit the guard. Default to `codex` when the pref is unset, matching the existing UI copy that already says *"Codex is preferred when both are present."*

### AI providers panel render fix

`apps/desktop/src/renderer/app.ts` read `status.providers['openai-codex']`, but main-process `readAuthStatus()` in `auth-import.ts` never returned a `providers` field — only `codexAvailable / claudeAvailable / anthropicApiKeyAvailable`. Every render threw `TypeError`, the chained `.catch` swallowed it into `{codexAvailable: false, claudeAvailable: false}`, so both rows always showed "not found" even with creds present. Clicking Re-sync surfaced the same error as a toast. Fixed by deriving the rows directly from the booleans (no `providers` indirection) and aligning the renderer-side `CentraidAuthStatus` type with reality. Dropped the unused `formatExpires` helper and the orphan `CentraidProviderStatus / CentraidAuthSource` types.

### tool-call expander scroll fix

`apps/desktop/src/renderer/app-chat.ts`'s `renderChat()` re-built the chat DOM from scratch on every state change and then set `scroll.scrollTop = scroll.scrollHeight`. Expanding a tool call up the thread (which calls `renderChat`) yanked the user back to the bottom. Now we snapshot whether the user was already within 8px of the bottom before re-rendering, and only pin to the bottom if so; otherwise restore their prior `scrollTop`.

### auto-inject change-bus bridge

`packages/runtime-core/src/static-server.ts` already runs every served HTML through `injectSettings` + `stampInlineScriptNonces`. Added a third pass — `injectChangeBridge` — that splices a small inline `<script>` right after the opening `<head>`:

- Opens `new EventSource('_changes')`.
- On each `event: change` SSE event, dispatches a `centraid:datachange` `CustomEvent` on `window` with `{detail: {tables, ts}}`.
- Augments (never overwrites) `window.centraid` with `onChange(cb)`. The mobile bridge's `centraid.haptic` / `centraid.notify` namespaces coexist.
- Auto-reconnects when `EventSource` lands in CLOSED.
- Gets nonce-stamped by the existing CSP machinery — runs under the strict `script-src 'self' 'nonce-…'` policy.

**Important caveat (handled in the inline-tools follow-up):** The bridge only fires for writes that reach the runtime's in-process `ChangeBus`. Today that's the user's own `actions/*.js` handlers (via `runtime.emitForApp`) and the gateway's `_apps/<id>/query` HTTP endpoint. The chat-assistant CLI subprocess opens its own SQLite connection and **doesn't** notify the bus — so chat writes still don't refresh the iframe automatically until the inline-tools refactor lands. This is exactly what #73's main scope addresses by moving the SQL ops in-process.

### templates subscribe to change bus

`packages/app-templates/{todos,journal,hydrate}/app.js` each add one line:

```js
window.centraid?.onChange?.(() => void refresh());
```

For `journal` the refresh path is split across `loadEntries` / `loadActive`, so the subscriber calls a new `reloadFromServer()` helper that flushes pending local saves before pulling, to avoid clobbering in-flight keystrokes.

### builder system prompt reactive-data section

`packages/builder-harness/src/system-prompt.ts` gains a new section documenting both the sugar (`window.centraid.onChange(refresh)`) and vanilla (`window.addEventListener('centraid:datachange', …)`) ways to subscribe, plus a note that the bridge auto-reconnects so apps don't need retry logic. Newly-generated apps inherit the wiring by default rather than re-discovering the gap.

### Misc

- `packages/runtime-core/src/chat-runner.ts`: `ChatRunInput` gains `dataDir`; updated the stale `sessionFile` docstring (it lives under `<dataDir>/_chat/`, not `<appsDir>/<appId>/_chat/`).
- `packages/runtime-core/src/static-server.test.ts`: updated the double-stamp test to reflect the bridge inject, added two new tests for the bridge (HTML with `<head>` → injected; HTML without `<head>` → no inject; non-HTML response → no inject).

## Follow-up — inline `centraid_sql_*` tools on codex + Claude

The inline-tool refactor itself landed on top of this foundation. Each item the "Out of scope" list above flagged is now done:

- Shared `sql-ops` core (`describeOp` / `readOp` / `writeOp`) lifted out of the `centraid` CLI into `packages/runtime-core/src/sql-ops.ts` with the SELECT-only / DML-only guards, `SELECT_ROW_CAP = 200`, and an `onWrite(tables)` hook. The CLI bin keeps working — it just calls the shared functions so any future tweak applies everywhere at once.
- `centraid` CLI refactored to call shared ops, so the bin stays usable for humans / scripts and doesn't drift from the agent surface.
- `AppChange` extended with provenance fields: required `source: 'agent' | 'handler' | 'external'` and optional `toolCallId` / `agentTurnId`. SSE wire payload carries provenance — every `_changes` event now ships them. `Runtime.emitForApp(appId, 'handler' | 'external')` stamps source for handler / cloud-panel writes; new `Runtime.agentEmitForApp(appId)` threads tool-call provenance through the bus for the chat path. The openclaw plugin's `centraid_sql_write` tool also stamps `source: 'agent'` so cross-host SSE shape stays consistent.
- Codex `dynamicTools` + `item/tool/call`: `runCodexAppServerTurn` now sends `dynamicTools: [...]` on `thread/start` (only when the caller supplies a `ToolContext`) and adds an `item/tool/call` branch to its server-request dispatch. The tool-dispatch body lives in `codex-centraid-tools.ts` so the driver file stays under the 500-line repo-hygiene cap. Each call emits a `tool.start` followed by a `tool.result` event with the same `toolCallId` codex used, so the chat UI renders SQL pills natively. Write calls invoke `ctx.emitChange({ tables, toolCallId })` so the change bus fires precisely in the same process the runtime is hosting.
- Claude `createSdkMcpServer`: `runClaudeSdkTurn` builds a per-turn `createSdkMcpServer({ name: 'centraid', tools: [...] })` via the SDK's `tool(...)` helper with Zod 4 input schemas. Each handler returns the JSON-stringified payload as a single `text` content block so the model sees the same response shape across backends. The write handler propagates the SDK's `toolUseId` through `ctx.emitChange`. Zod is added as a `dependencies` entry on `@centraid/agent-runtime` (peer dep of the Claude SDK); loaded via dynamic `import()` so the codex code path never pays the cost.
- Chat-adapter swap to typed tools: the system-prompt preamble describes the three typed tools instead of the CLI subcommands, mints a stable `agentTurnId` per `ChatRunner.run`, threads it via `emitChange`, and drops the centraidCliDir / extraPath wiring. `defaultCentraidCliDir` moves to its own tiny module for builder use.
- Local-runtime wires change emitter: `apps/desktop/src/main/local-runtime.ts` closes over `runtime.agentEmitForApp` via a deferred ref to break the construction cycle (`Runtime` needs the runner; the runner needs the runtime's emitter).
- Tests pass: 203/203 runtime-core tests, 18/18 agent-runtime tests, full repo typecheck clean. New `sql-ops.test.ts` covers refusal cases, the row cap, and the `onWrite` callback firing. SSE tests now assert agent-sourced events carry `source: 'agent'` + `toolCallId` + `agentTurnId`, and handler-sourced events carry `source: 'handler'` with the optional fields absent.

The auto-injected change-bridge (already shipped in the foundation commit) now carries the richer event detail by virtue of the SSE payload change — no template-side changes were needed.

The builder system-prompt reactive-data section has been expanded to document the new `detail.source` / `toolCallId` / `agentTurnId` fields with practical patterns (filter by `tables`, flash agent writes, one sink not many).

## Out of scope

Carried forward to follow-up issues:

- Deprecating the `centraid` CLI binary itself — kept for human / scripted callers.
- `fs.watch`-based cross-process reactivity backstop for ad-hoc external writers (e.g. user running `sqlite3` in Terminal).
- Per-query subscriptions (a small reactive query layer keyed by table names).
- Splitting `centraid_sql_write` into INSERT / UPDATE / DELETE tools or adding parameterized queries.
- "Undo this assistant action" / `toolCallId`-keyed audit log — the data is now in the bus; the feature is its own issue.

## Verification

- **tests pass**: `bun run --filter='@centraid/runtime-core' test` → 190 tests, 0 failures (includes the two new `static-server` bridge-inject tests and the updated double-stamp assertion). `bun run --filter='@centraid/agent-runtime' test` → 18 tests, 0 failures. `bun run --filter='@centraid/builder-harness' test` → 1 test, 0 failures.
- `bun run --filter='@centraid/runtime-core' --filter='@centraid/agent-runtime' --filter='@centraid/builder-harness' --filter='@centraid/desktop' typecheck` — clean across all four packages.
- **End-to-end manual** (computer-use, codex backend): registered Todos app → opened in-app chat → "mark all todos as done" → codex executed `centraid sql write` against the right `data.sqlite` (the **chat-adapter cwd fix**), no `unknown variant` from the sandbox enum (the **codex sandbox kebab-case fix**), no "no coding agent configured" guard (the **default agent runner kind to codex** path). Verified the SQLite write landed by navigating back into the Todos view and seeing `buy milk` struck through under Done · 1. *(Iframe did not auto-refresh because the CLI subprocess path bypasses the change bus — exactly the gap the inline-tools follow-up closes.)*
- **AI providers panel render fix** sanity-checked: panel renders both rows without throwing; Codex row shows "connected via ~/.codex/auth.json"; Claude Code row shows "connected — held back because Codex is preferred". Re-sync no longer toasts TypeError.
- **tool-call expander scroll fix** sanity-checked by scrolling up the chat thread and expanding a tool-call row — page no longer yanks to the bottom; prior scrollTop preserved.
