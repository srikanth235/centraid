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

## Out of scope

These are the remaining items in #73, all to be landed in the inline-tool refactor that follows this PR:

- `runtime-core/src/sql-ops.ts` — pure `describeOp / readOp / writeOp` shared between codex, Claude, and the CLI.
- codex adapter: `dynamicTools` declaration in `thread/start`, `item/tool/call` server-request dispatch, typed `ChatStreamEvent`s.
- Claude adapter: `createSdkMcpServer` with the same three tools.
- `AppChange` enrichment: `source: 'agent' | 'handler' | 'external'`, `toolCallId?`, `agentTurnId?`; SSE wire payload mirrors it; the bridge inject dispatches the richer event detail.
- Chat preamble + builder preamble swap from CLI-doc to tool-doc.
- fs.watch backstop for ad-hoc external writers (e.g., user running `sqlite3` in Terminal). Not blocking; revisit only if a real use case surfaces.

All called out explicitly in [#73](https://github.com/srikanth235/centraid/issues/73)'s scope section.

## Verification

- **tests pass**: `bun run --filter='@centraid/runtime-core' test` → 190 tests, 0 failures (includes the two new `static-server` bridge-inject tests and the updated double-stamp assertion). `bun run --filter='@centraid/agent-runtime' test` → 18 tests, 0 failures. `bun run --filter='@centraid/builder-harness' test` → 1 test, 0 failures.
- `bun run --filter='@centraid/runtime-core' --filter='@centraid/agent-runtime' --filter='@centraid/builder-harness' --filter='@centraid/desktop' typecheck` — clean across all four packages.
- **End-to-end manual** (computer-use, codex backend): registered Todos app → opened in-app chat → "mark all todos as done" → codex executed `centraid sql write` against the right `data.sqlite` (the **chat-adapter cwd fix**), no `unknown variant` from the sandbox enum (the **codex sandbox kebab-case fix**), no "no coding agent configured" guard (the **default agent runner kind to codex** path). Verified the SQLite write landed by navigating back into the Todos view and seeing `buy milk` struck through under Done · 1. *(Iframe did not auto-refresh because the CLI subprocess path bypasses the change bus — exactly the gap the inline-tools follow-up closes.)*
- **AI providers panel render fix** sanity-checked: panel renders both rows without throwing; Codex row shows "connected via ~/.codex/auth.json"; Claude Code row shows "connected — held back because Codex is preferred". Re-sync no longer toasts TypeError.
- **tool-call expander scroll fix** sanity-checked by scrolling up the chat thread and expanding a tool-call row — page no longer yanks to the bottom; prior scrollTop preserved.
