# issue-71 — Switch chat-harness to OpenClaw gateway inference via plugin-initiated runEmbeddedAgent

GitHub issue: [#71](https://github.com/srikanth235/centraid/issues/71)

## Checklist

- [x] M1 — runtime-core chat surface
- [x] M2 — OpenClaw ChatRunner
- [x] M3 + M4 — local-chat-runner package
- [x] M5 — chat-harness rewrite
- [x] M6 — data mode
- [x] M7 — cleanup
- [x] Open item — empirically pin codex schema + simplify to CLI
- [x] typecheck
- [x] test
- [x] check

## What changed

**Why this rewrite.** Today `@centraid/chat-harness` spawned `@earendil-works/pi-coding-agent` locally in the Electron main process and exposed three custom tools (`centraid_sql_describe/read/write`) that round-tripped back through the runtime's HTTP surface. That's a divergent inference path — pi locally for in-app chat, OpenClaw centrally for everything else. Two problems stack: the desktop's bundled pi loop bypasses OpenClaw's tool policy, model resolution, and per-agent skills when the desktop is pointed at a remote OpenClaw; and it ships an inference engine users can't swap for their own configured coding agent. Issue #71 unifies the remote path through OpenClaw's `runEmbeddedAgent` and lets the embedded local runtime spawn a BYO CLI (Codex or Claude Code) instead of bundling pi forever.

**Design principle — host owns initiation, not the loop.** Both hosts (OpenClaw plugin, desktop local-runtime) implement a `ChatRunner` capability that runtime-core's chat routes delegate to. OpenClaw's runner calls `api.runtime.agent.runEmbeddedAgent` in-process; the local runtime's runner spawns the user's CLI as a subprocess with a stdio MCP server attached. Either way, runtime-core never runs an agent loop in centraid code.

### M1 — runtime-core chat surface

`chat-runner.ts` defines `ChatRunner.run(input) → Promise<ChatRunResult|void>`. `ChatRunInput` carries `appId`, `windowId`, `sessionFile`, `mode`, `message`, `extraSystemPrompt`, optional `model`/`thinking`/`idempotencyKey`, an `abortSignal`, and an `onEvent` callback. `ChatRunResult` lets the adapter report back its assigned session id (`adapterSessionId`) and `adapterKind` so the next turn can resume. `ChatStreamEvent` is the normalized union both adapters emit (`assistant.start`, `assistant.delta`, `reasoning.delta`, `tool.start`, `tool.result`, `phase`, `final`, `error`, `aborted`).

`chat-store.ts` owns the per-app `_chat/index.json` file. `ChatStore.upsertWindow(windowId, desiredMode, adapter?)` is idempotent — once a window's mode is pinned, subsequent calls return the existing meta. `noteTurn` bumps counters; `deleteWindow` removes from the index AND unlinks the JSONL transcript. `isValidWindowId` accepts `[A-Za-z0-9_\-:]+` only, banning path separators and the reserved `index.json` filename so a malicious id can't escape `_chat/`. Transcript reads tolerate JSONL noise (skip blank/non-JSON lines) so runner-owned formats with comment lines still parse.

`chat-routes.ts` parses sub-routes under `/centraid/<id>/_chat`: `POST /_chat`, `GET /_chat/windows`, `GET /_chat/windows/<wid>/history`, `DELETE /_chat/windows/<wid>`. On POST, the handler writes SSE headers up front, sets up a 30s heartbeat, builds `extraSystemPrompt` via `buildExtraPrompt` (which reads `data.sqlite` schema with a no-throw fallback for fresh apps), then calls `runner.run` inside a per-`(appId, windowId)` async lock so a second POST queues behind the first. The handler also owns transcript persistence: it tees every `ChatStreamEvent` through `recordEvent` (which accumulates `assistant.delta` text and pushes `user`/`tool`/`assistant` entries) and appends the JSONL tail in the `finally` block. The `adapterSessionId` returned by the runner gets persisted via `store.noteTurn`. Errors thrown by the runner become SSE `error` frames AND release the per-window lock; client disconnect aborts the run via `AbortController`.

`buildExtraPrompt({ appId, appName, appDescription, mode, schema })` lives in runtime-core so both adapters splice identical context. Full mode emits a brief "Centraid app context" block plus a live-schema dump; data mode emits the full data-chat instructions (mirrors the pre-rewrite `system-prompt.ts` content) plus the live schema. The schema block formats one line per table (`- **name** (col TYPE NOT NULL PK, ...)`).

`router.ts` adds two new `Route` kinds: `{ kind: 'app-chat', appId, segments }` for `/centraid/<id>/_chat[...]` and `{ kind: 'app-runner-status' }` for the gateway-wide `/centraid/_chat/runner-status`. The latter is gated on a new `RunnerStatus` interface and `RuntimeOptions.runnerStatus` callback; without one configured, the route returns `{ kind: 'none', ok: false, reason: 'no runner configured' }` (200 OK so the chat panel's Setup screen renders cleanly).

`RuntimeOptions` gains `chatRunner?`, `appMeta?`, and `runnerStatus?` fields. Without `chatRunner` the route handler 503s with `no_chat_runner` — the M1 stub behavior the issue calls out. `Runtime.chatRouteContext()` is a private helper that bundles registry + runner + appMeta for the route module so chat-routes.ts doesn't need to know about `Runtime` directly (avoids a circular module shape).

### M2 — OpenClaw ChatRunner

`packages/openclaw-plugin/src/lib/openclaw-chat-runner.ts` exports `makeOpenClawChatRunner(api: OpenClawPluginApi): ChatRunner`. The runner wraps `api.runtime.agent.runEmbeddedAgent` with:

- `sessionKey: centraid-chat:<appId>:w<windowId>` so the existing `before_tool_call` hook in `lib/tools.ts` (which derives the app from the session key prefix) still enforces app-scope on `centraid_sql_*` calls.
- `isCanonicalWorkspace: false` + a plugin-owned `workspaceDir` (`~/.openclaw/centraid/_chat-workspace[-full]/`) so `bootstrapMode` resolves to `"limited"` and OpenClaw skips AGENTS.md / SOUL.md / USER.md loading. We never claim to be the user's main agent — `agentId` is omitted, so OpenClaw falls back to its default (`"main"`) for model resolution and policy.
- `prompt: input.message` + `extraSystemPrompt: input.extraSystemPrompt` so the route-built app context is injected per turn.
- `disableMessageTool: input.mode === 'data'` + `promptMode: input.mode === 'data' ? 'minimal' : 'full'` + per-mode `toolsAllow` (data mode pins `centraid_sql_describe/read/write`).
- Callback bridge: `onAssistantMessageStart` → `assistant.start`; `onBlockReply` → `assistant.delta` or `reasoning.delta` (when `isReasoning`); `onReasoningStream` → `reasoning.delta`; `onToolResult` → `tool.result` (the SDK doesn't expose a `toolCallId` here, so we synthesize one); `onAgentEvent` is best-effort translated by `translateAgentEvent` — recognized streams (`tool_execution_start`, `execution_phase`) become typed events, the rest pass through as generic `phase` events the harness can ignore.

`openclaw-plugin/src/index.ts` constructs the runner and passes it into `new Runtime({ chatRunner, runnerStatus: async () => ({ kind: 'openclaw', ok: true }) })`. Existing tool registrations and the `before_tool_call` hook are unchanged.

### M3 + M4 — local-chat-runner package

`local-chat-runner.ts` exports `makeLocalChatRunner({ appsDir, prefsLoader, mcpServerScript?, nodeBin? })`. The runner is stateless and reads prefs on every turn so a settings flip doesn't need a restart. On each `run()` it looks up the previous turn's `adapterSessionId` from `ChatStore`, then dispatches to either `runCodexTurn` or `runClaudeTurn`. If the user switched runner kind mid-window, the stale resume id is dropped (codex/claude session ids aren't portable).

`centraid-mcp-server.ts` is a **standalone stdio MCP server** (built into `dist/`, declared as a `bin` so it can be located by path). Argv pins `--apps-dir <path> --app-id <id>` at spawn time — the model cannot redirect to another app because the MCP tool schemas don't expose an `appId` parameter and the server computes the data file path from argv only. Three tools: `centraid_sql_describe`, `centraid_sql_read` (SELECT-only guard), `centraid_sql_write` (DML-only guard). All three reuse `runQuery` / `readAppSchema` from runtime-core — same code paths the OpenClaw plugin's tool registration uses, just invoked from a subprocess instead of in-process.

`codex-adapter.ts` builds the codex command:

```
codex exec --json [--session <prev>] --mcp-server centraid=<node> <mcp-server.js> --apps-dir <dir> --app-id <id> --mode <full|data>
        [--model <id>]
        [--ask-for-approval never --sandbox read-only --allowed-tools mcp__centraid__centraid_sql_*  (data mode only)]
        --system-prompt <extraSystemPrompt>
        <message>
```

`spawn-cli.ts` is the shared subprocess helper: it line-buffers stdout (stripping `data:` SSE prefixes when present), surfaces JSON lines to `onJsonLine`, optionally reports stderr lines, kills the child on `abortSignal`, and resolves with `{ exitCode, signal, stderrTail }`.

`translateCodexLine` is best-effort: it recognizes several near-equivalent event names (`item.assistant_delta` / `assistant.delta` / `text.delta`; same for tool/reasoning/final/error events), captures any `threadId` / `session_id` field for resume, and passes unrecognized shapes through as `phase` events so a codex schema drift produces noise, not a broken adapter.

`claude-adapter.ts` writes a per-turn tmpfile MCP config (cleaned up in `finally`) and runs:

```
claude -p <message> --output-format stream-json --mcp-config <tmpfile>
       [--resume <prev>] [--model <id>] [--append-system-prompt <extra>]
       [--permission-mode plan --allowedTools mcp__centraid__centraid_sql_*  (data mode only)]
```

`translateClaudeLine` walks the stream-json shape: `{ type: 'system', subtype: 'init', session_id }` captures the resume id; `{ type: 'assistant', message: { content: [...] } }` unpacks `text` / `thinking` / `tool_use` items; `{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content, is_error }] } }` becomes `tool.result`; `{ type: 'result', result }` becomes `final`. Unknown shapes pass through as `phase` events for diagnostic surfacing.

`preflight.ts` runs `<bin> --version` once per `(kind, binPath)` cache key, caches the result in-memory, and returns a `RunnerStatus`. ENOENT becomes `{ ok: false, reason: 'codex not found on PATH', hint: '...' }`. The desktop's `runnerStatus` callback wraps this and is invoked on `GET /centraid/_chat/runner-status` so the chat panel can render a Setup screen.

### M5 — chat-harness rewrite

`packages/chat-harness/package.json` drops the `@earendil-works/pi-coding-agent` dependency, the `@centraid/builder-harness` dependency, and the `typebox` dependency. `index.ts` now re-exports `openChatStream`, `fetchChatHistory`, `listChatWindows`, `clearChatWindow`, `getRunnerStatus`, plus the runtime-core types `ChatMode`, `ChatStreamEvent`, `ChatWindowMeta`, `RunnerStatus` for consumer ergonomics.

`chat-client.ts` is the streaming half: it POSTs `{ windowId, message, mode?, model?, thinking?, idempotencyKey? }`, then parses the SSE response into an `AsyncIterable<ChatStreamEvent>`. The parser tracks `event:` / `data:` line pairs separated by a blank line, ignores `:` heartbeat lines, and terminates cleanly on the server's `end` frame. Aborting is two-way: the caller's optional `signal` is forwarded to an internal `AbortController` that owns the `fetch`.

`chat-history.ts` is the non-streaming half: thin GETs / DELETE against `/centraid/<id>/_chat/windows[/<wid>[/history]]` and `/centraid/_chat/runner-status`.

Deleted files: `system-prompt.ts` (moved to runtime-core's `buildExtraPrompt`), `sql-tools.ts` (the tools now live server-side — OpenClaw registers them; the local MCP server exposes them), `data-chat-session.ts` (the pi-coding-agent wrapper).

### desktop wiring

`apps/desktop/src/main/chat.ts` is gutted from a pi-coding-agent embed to a thin SSE proxy. Each chat session carries a `windowId` (derived from the chat-history row id when available, so a reload resumes the same gateway-side window) and a `mode` (defaults to `full`; renderer can opt into `data` via the `START` IPC). `runTurn` opens an `openChatStream` and translates each `ChatStreamEvent` into the renderer's existing `centraid:chat:event` shape so the renderer didn't need to change. `currentAbort` is the SSE-disconnect handle; `ABORT` IPC calls it.

`apps/desktop/src/main/local-runtime.ts` now constructs the `Runtime` with a `chatRunner` built via `makeLocalChatRunner({ appsDir, prefsLoader })`. `prefsLoader` reads `chat.runner.{kind,binPath,extraArgs}` from the `UserStore` per turn — the desktop's existing user-prefs store doubles as the runner config surface. `runnerStatus` wraps `runPreflight`. A new exported `noteRunnerPrefsChanged()` invalidates the preflight cache so settings-save flips show up immediately.

`apps/desktop/package.json` adds the new workspace dep `@centraid/local-chat-runner`.

### M6 — data mode

`mode: 'full' | 'data'` flows: renderer IPC `chat:start` → `ChatSession.mode` → `openChatStream({ mode })` → POST body → route handler `body.mode` → `ChatStore.upsertWindow(desiredMode)` (first turn pins it; subsequent turns inherit) → `ChatRunInput.mode` → runner. Each adapter applies its own lockdown flags as described in M2/M3/M4. Full mode is the default and what the renderer sends today; data mode is opt-in.

### M7 — cleanup

`packages/openclaw-plugin/README.md` gains a `_chat` row in the per-app URL surface table, a "Chat surface (host-agnostic)" paragraph, and a pointer to per-window transcript storage under `<appsDir>/<id>/_chat/`. `packages/openclaw-plugin/scripts/setup-tools.mjs` adds a doc-comment block explaining that the `tools.alsoAllow` patch is now load-bearing for data-mode chat (the `toolsAllow` allowlist is intersected with the resolved agent's effective policy), and the output message mentions the same.

`receipts/issue-59-pr-57-review-fixes.md` had a link to the now-deleted `packages/chat-harness/src/data-chat-session.ts`; the link is replaced with a plain reference plus a note that the file was removed in #71's rewrite, so `no-broken-internal-doc-links` stays green.

`packages/builder-harness/` is deliberately unchanged — the app-authoring agent legitimately needs local fs/bash, so pi-coding-agent stays for the builder. A BYO-CLI migration for the builder is a separate issue.

### Open item — empirically pin codex schema + simplify to CLI

A follow-up pass on the local codex adapter, prompted by empirical runs of `codex-cli 0.128.0` and a re-read of codex's sandbox model. The original adapter shipped flags that don't exist in the CLI (`--allowed-tools`, `--system-prompt`, `--session`, `--ask-for-approval`) and assumed MCP-over-stdio was the only path to tool exposure. Two things changed:

1. **Schema verified end-to-end.** Captured the actual `codex exec --json` event stream: `thread.started.thread_id`, `turn.started`, `item.started`, `item.completed[agent_message]` / `[command_execution]`, `turn.completed`, `turn.failed`. The `translateCodexLine` function was pinned to that schema; unknown shapes fall through as `phase` events so a small upgrade doesn't break parsing. A unit test at `packages/local-chat-runner/src/codex-adapter.test.ts` carried the captured fixtures verbatim. (*Deleted in a later commit when the package swapped to `codex app-server` — see the v0 swap section below.*)

2. **MCP entirely dropped in favour of a small `centraid` CLI.** Empirical probe showed codex's `--sandbox read-only` and `--sandbox workspace-write` both block outbound network (including loopback), which kills any "CLI talks to local HTTP" design. Codex DOES allow workspace-write filesystem access, so the simplest possible mechanism is a Node bin that opens `./data.sqlite` directly. The adapter spawns codex with `-C <appsDir>/<appId>` (cwd = the per-app data dir) and prepends the centraid-CLI bin dir to PATH. AppId is the cwd; the model never names it, so it can't escape the scope.

The `centraid` CLI ([packages/local-chat-runner/src/centraid-cli.ts](../packages/local-chat-runner/src/centraid-cli.ts)) exposes three subcommands: `centraid sql describe` (JSON schema dump), `centraid sql read "SELECT ..."` (rows JSON), `centraid sql write "INSERT/UPDATE/DELETE/REPLACE ..."` (rowsAffected JSON). DDL and PRAGMA are refused with exit code 64; bad-usage with exit code 2. `CENTRAID_DATA_FILE` env override is supported for tests; production codex/claude adapters rely on cwd alone.

The Claude Code adapter (`packages/local-chat-runner/src/claude-adapter.ts`) was simplified to the same shape (cwd + CLI on PATH, prompt preamble teaching the agent about the CLI) — Claude Code's permission-based sandbox accepted this without special flags. (*Deleted in a later commit when the package swapped to the Claude Agent SDK — see the v0 swap section below.*)

Mode handling for codex was dropped: codex's sandbox model has no clean read-only-with-writable-app-data regime, so the `mode: 'data'` toggle now only affects the runtime's prompt (`buildExtraPrompt` still picks the more-restrictive data-mode wording). OpenClaw's data-mode lockdown via `toolsAllow` + `disableMessageTool` is unchanged.

Files deleted: `mcp-server-core.ts`, `centraid-mcp-server.ts`, `mcp-http-pool.ts` (the latter was speculative — never landed in the prior commit). Files added: `centraid-cli.ts`, `centraid-cli.test.ts`, `codex-adapter.test.ts`. The `@modelcontextprotocol/sdk` dependency is removed.

`RunnerStatus` in runtime-core gains `minVersion?: string` and `versionAtLeast?: boolean`; `preflight.ts` parses semver from the CLI's `--version` output and compares against pinned minima (`codex` 0.128.0 / `claude-code` 2.1.126). When the user's CLI parses but is older, the preflight surfaces a warning hint while still reporting `ok: true` — older versions may work but we only know for sure on verified ones.

## Verification

Automated checks all green at the worktree HEAD before commit:

- `bun run typecheck` — 16/16 turbo tasks succeed (runtime-core, openclaw-plugin, chat-harness, local-chat-runner, builder-harness, desktop, mobile, app-templates, design-tokens, tsconfig).
- `bun run test` — 12/12 turbo tasks succeed:
  - `packages/runtime-core/src/chat-store.test.ts` (7 tests): window-id validation, idempotent upsert, mid-window adapter swap, turnCount, list ordering, delete + transcript unlink, JSONL parser tolerance.
  - `packages/runtime-core/src/chat-routes.test.ts` (8 tests): 503 without runner, empty window list, end-to-end POST + SSE + window persistence, invalid windowId, DELETE, runner-status `none`, transcript replay via `/history`, error → SSE error frame.
  - `packages/chat-harness/src/chat-client.test.ts` (4 tests): SSE multi-event parse, bearer-token forwarding, non-2xx → `ChatHarnessError`, body fields (mode/model) forwarded.
  - `packages/local-chat-runner/src/preflight.test.ts` (7 tests): binary-not-found reporting, cache reuse, cache busting on binPath change, semver parsing, semver ordering, versionAtLeast surfacing.
  - `packages/local-chat-runner/src/codex-adapter.test.ts` (4 tests): basic schema fixture, tool-call lifecycle fixture, turn.failed → error, unknown event → phase.
  - `packages/local-chat-runner/src/centraid-cli.test.ts` (8 tests): describe/read/write JSON contracts, refusal exit codes, unknown subcommand handling, `CENTRAID_DATA_FILE` override.
  - Existing tests (179+) continue to pass.
- `bun run check` — oxfmt + oxlint clean (0 warnings, 0 errors) across 244 files / 154 lint targets.
- `bun run build` — 8/8 turbo build tasks succeed; the new `centraid-mcp-server.js` lands in `packages/local-chat-runner/dist/` and is wired as a `bin` entry so subprocess spawn paths can locate it.

Manual end-to-end verification deferred to a follow-up: spinning up a real OpenClaw gateway against the new `_chat` route, and running codex / claude-code against a real app's SQLite. The event-translation paths and per-mode flag matrix are best-effort and tagged as open verification items in the issue.

## Out of scope (per the issue)

- Mobile / embedded chat clients (will reuse the same endpoint when added).
- A new openclaw agent identity for centraid (explicitly avoided via `isCanonicalWorkspace: false`).
- Per-call tool list extension (not exposed by `runEmbeddedAgent`).
- Bundling an inference loop or SDK in the local runtime — CLI-only by design.
- Provider auth inside centraid — the user's CLI owns it.
- Auto-installing the CLIs — preflight detects + reports; install is manual.
- A builder-harness BYO-CLI migration.
- Cross-adapter session migration.

## Open verification items deferred to follow-up

Two classes of items from the issue's "Open verification items" remain:

1. **CLI stream-event schemas.** The codex and claude-code adapters are written defensively (multiple recognized event names; unknown shapes fall through as `phase`), but the exact event-type strings each CLI emits today need empirical confirmation. The adapters survive small drifts; a large schema change would require updating the `translate*Line` helpers. Pin minimum CLI versions in preflight once we've verified.
2. **MCP server lifecycle across resumes.** The current implementation spawns a fresh MCP server per turn (the codex `--mcp-server` flag and the claude `--mcp-config` tmpfile are both per-invocation). Per-session lifetime (the issue's stated preference) would reduce per-turn latency; the migration is a `local-chat-runner` internal — no public-API impact.

Both are tracked as open items here rather than blocking the M1–M7 land.

## Follow-up — desktop electron bump + runtime-mode badge

Manual end-to-end verification surfaced two desktop-only gaps that the M1–M7 land could not have caught without running the embedded local runtime:

1. **`node:sqlite` not available in electron@33.** The desktop pinned `electron@^33`, which ships Node 20.18 — too old for `node:sqlite` (added in Node 22.5). `import('./local-runtime.js')` therefore failed with `ERR_UNKNOWN_BUILTIN_MODULE` and the embedded HTTP server never bound. Bumped [apps/desktop/package.json](../apps/desktop/package.json) to `electron@^37` (Node 22.18). The only remaining diagnostic is the expected `ExperimentalWarning: SQLite` line on boot.

2. **No indication of which gateway is active.** A failed chat send produced "Could not reach the gateway" with no hint about whether the user was in `local` or `remote` mode. Added a small `Local`/`Remote` meta badge next to the sidebar's Settings row, cached in [apps/desktop/src/renderer/app.ts](../apps/desktop/src/renderer/app.ts) (`currentRuntimeMode`) and refreshed on settings save. Threaded through [chrome.ts](../apps/desktop/src/renderer/chrome.ts) (`SidebarOpts.runtimeMode`) and reused by both home and builder sidebars; builder reads it via `window.Centraid.getRuntimeMode()`.

Verified live: scaffolded a Todos app from the template grid in local mode, sent "Add a todo: buy milk" through the chat panel. Codex spawned with `cwd=<appsDir>/todos-2`, invoked `centraid sql write "INSERT INTO todos…"`, the CLI opened `./data.sqlite` (correctly scoped), the row landed (`1|buy milk|0|<ts>`), and the published Todos UI reflected it after iframe reload.

One product gap surfaced but not addressed here (pending a separate decision): the desktop has no UI to set `chat.runner.kind`. The PR's `prefsLoader` reads the value from `user_prefs` but nothing writes it. The verification above set the pref by direct SQL. Options for the next pass: (a) add a Settings → AI providers picker, or (b) auto-default from the imported credentials (Codex preferred → `kind = 'codex'`).

### Fix-up — serialize runtime-mode prefetch with the initial renderHome

The first version of the badge wiring called `renderHome()` synchronously at boot AND then `applyRoute(home)` again inside the `refreshRuntimeMode().then()` callback. Both invocations ran `renderHomeAsync()` concurrently — `clear()` and the async `await hydrateDrafts()` / `loadAvailableTemplates()` chain interleaved across the two renders, so `root` ended up with the whole shell appended twice (a stacked duplicate sidebar + main, visually indistinguishable from "two windows").

Fix: serialize — `await refreshRuntimeMode()` first, then `renderHome()` once. The settings IPC is a local file read; first-paint isn't measurably slower.

## Follow-up — extract mode-agnostic CLI primitives + `preview snapshot` subcommand

Prep work for the next change: swapping the builder harness from `@earendil-works/pi-coding-agent` (in-process) to the same local CLI runner that chat already uses (codex `exec --json` / claude `-p --output-format stream-json`). This slice is scoped narrowly to "make `local-chat-runner` usable from a non-chat consumer without breaking chat."

### What changed

- `packages/local-chat-runner/src/codex-adapter.ts` and `claude-adapter.ts` (both later deleted): refactored `runCodexTurn` / `runClaudeTurn` to take a neutral `{ cwd, message, extraSystemPrompt, model?, prevSessionId?, abortSignal, onEvent }` input plus a `{ hostBinDir?, binPath?, extraArgs? }` config. The hardcoded `CENTRAID_PROMPT_PREAMBLE` (which talks about `./data.sqlite` and the `centraid sql ...` commands — chat-specific) moved out of the adapters; the caller now owns any preamble.
- [packages/local-chat-runner/src/local-chat-runner.ts](../packages/local-chat-runner/src/local-chat-runner.ts): `makeLocalChatRunner` becomes a thin wrapper that constructs `cwd = <appsDir>/<appId>`, splices the chat preamble into `extraSystemPrompt`, reads/writes the per-window `ChatStore` for resume, and delegates to the primitive. Public surface unchanged — chat path is byte-for-byte equivalent.
- [packages/local-chat-runner/src/types.ts](../packages/local-chat-runner/src/types.ts): dropped `RunOneTurnArgs` / `AdapterCtx` (only used by the old chat-shaped adapter signatures); kept `RunnerKind` + `RunnerPrefs`.
- [packages/local-chat-runner/src/index.ts](../packages/local-chat-runner/src/index.ts): now exports the primitives (`runCodexTurn`, `runClaudeTurn`) and their input/config/result types alongside the existing `makeLocalChatRunner`, so a future builder-harness session can import them directly without a circular dep.
- [packages/local-chat-runner/src/centraid-cli.ts](../packages/local-chat-runner/src/centraid-cli.ts): added `centraid preview snapshot` subcommand returning `{ path, exists, sizeBytes?, mtimeMs?, ageMs? }` for `./.preview/snapshot.png`. The builder will keep this file fresh from the Electron main process; the agent reads the metadata to know whether a preview is ready, and uses its native `Read` tool for the image bytes.
- [packages/local-chat-runner/src/centraid-cli.test.ts](../packages/local-chat-runner/src/centraid-cli.test.ts): added four tests for the new subcommand (missing file → `exists:false`, present file → size/mtime/age, no-subcommand usage error, extra-args rejection).

### What did not change

- Runtime-core types (`ChatRunner`, `ChatRunInput`, `ChatStreamEvent`, …) — `ChatRunner` is correctly chat-specific (it's the contract for the per-app `_chat` route handler), so no rename.
- Package name (`@centraid/local-chat-runner`) — chat is still the primary consumer; builder will import primitives from the same package.
- The chat flow end-to-end — `makeLocalChatRunner` still constructs the same `ChatRunner`, emits the same events, persists the same `adapterSessionId` back to `ChatStore` via the route handler. `codex-adapter.test.ts`'s 4 schema-fixture tests pass unchanged because `translateCodexLine` is untouched.

### Why this lands now, not as a separate PR

The user's stated next step is "swap pi out of the builder for the same CLI runner the chat already uses." That swap (next slice) needs primitives it can import. Landing the extraction here makes the next diff strictly about the builder side — none of the changes in this slice are user-visible.

### Why a CLI subcommand for the snapshot instead of just a file convention

Considered telling the agent the snapshot path in its system prompt and letting it use the native `Read` tool exclusively. The subcommand wins on one point: it's a cheap freshness check the agent can do without loading the image into context (size + age in JSON is a few bytes; reading a PNG drags the whole binary in). Codex's bash tool can shell out to `centraid preview snapshot` to decide whether to bother reading the file. Negligible cost to add; useful even if the builder slice ends up not using it.

### Verification

- `bun run build` — all turbo build tasks succeed.
- `bun run typecheck` — 16/16 tasks succeed across the workspace (`@centraid/local-chat-runner`, `@centraid/desktop`, `@centraid/openclaw-plugin`, …).
- `bun run test` — 22/22 tests pass in `@centraid/local-chat-runner` (4 codex translator + 7 preflight + 7 centraid-cli (existing) + 4 centraid-cli (new preview subcommand)). All 12 turbo test tasks succeed; no other package's tests touched these files.
- `bun run lint` — `oxlint` clean (0 warnings, 0 errors across 156 files).

### Open items for the builder-swap slice

- New `BuilderSession` in `@centraid/builder-harness` calling `runCodexTurn` / `runClaudeTurn` with builder-specific cwd (`<projectsDir>/<projectId>`), preamble (the centraid format guide + UI grounding + preview-snapshot pointer that pi's `appendSystemPromptOverride` hook currently injects), and resume id (per-project, not per-window).
- Desktop main-process loop that writes `<projectDir>/.preview/snapshot.png` whenever the builder preview `<webview>` paints (debounced).
- Delete `@earendil-works/pi-coding-agent` from `packages/builder-harness/package.json` plus the now-unused `agent-session.ts` / `preview-screenshot-tool.ts`.
- Drop the pi target from [auth-import.ts](../apps/desktop/src/main/auth-import.ts) (credentials now belong solely to the user's `codex` / `claude` installs).

## v0 swap — codex app-server + Claude Agent SDK

The previous "extract primitives" pass kept the `codex exec --json` and `claude -p --output-format stream-json` adapters as the underlying CLI runners. A re-alignment with the original plan (and a fresh read of the codex repo + Claude Agent SDK docs) pivoted to a unified runtime that targets the *embedding* primitives both vendors actually recommend:

- **Codex:** spawn `codex app-server` (long-lived process, JSON-RPC 2.0 over stdio, token deltas, structured tool-call lifecycle, `thread/resume` for cross-restart continuity). `codex exec` was designed for one-shot CI use; app-server is the contract VS Code's Codex extension uses.
- **Claude:** import `@anthropic-ai/claude-agent-sdk` (in-process TypeScript, async-iterator events, `systemPrompt: { type: 'preset', preset: 'claude_code', append }` for prompt injection, `includePartialMessages: true` for streaming deltas, `resume` for session continuity). The `claude -p` CLI was useful as a stand-in but doesn't expose stable embedding semantics.

### What changed

- New [packages/local-chat-runner/src/codex-app-server.ts](../packages/local-chat-runner/src/codex-app-server.ts) — JSON-RPC client for `codex app-server`. Handshake is `initialize` (with `experimentalApi: true` capability) → `initialized` notification → `thread/start` (or `thread/resume`) → `turn/start`. cwd / `developerInstructions` / `sandbox` / `approvalPolicy: 'never'` are passed inside `thread/start` params (app-server does **not** honor `-c key=value` — that flag is parsed by the root `codex` CLI and only forwarded to opt-in subcommands). Auto-accepts any `*/requestApproval` server requests so the turn doesn't stall under `approvalPolicy: 'never'`. `turn/interrupt { threadId }` on abort.
- New [packages/local-chat-runner/src/claude-sdk.ts](../packages/local-chat-runner/src/claude-sdk.ts) — wraps `mod.query({ prompt, options })`. Lazy-imports the SDK so codex-only paths don't pay the dependency cost (the SDK pulls a bundled `claude` binary into `node_modules`). Translates `SDKMessage` events — `partial_assistant_message` content-block deltas → `assistant.delta` / `reasoning.delta`; assistant `tool_use` blocks → `tool.start`; user `tool_result` blocks → `tool.result`; `result` → `final`.
- New [packages/local-chat-runner/src/runtime.ts](../packages/local-chat-runner/src/runtime.ts) — exports `runAgentTurn(input, config)`, the unified primitive both chat and builder consume. Dispatches by `prefs.kind` ∈ `'codex' | 'claude-code'`. Returns `{ adapterKind, sessionId? }` for resume.
- [packages/local-chat-runner/src/local-chat-runner.ts](../packages/local-chat-runner/src/local-chat-runner.ts) — `makeLocalChatRunner` is now a thin chat wrapper over `runAgentTurn`: derives `cwd = <appsDir>/<appId>`, splices the centraid-CLI preamble into `extraSystemPrompt`, reads/writes the per-window `ChatStore` for resume, prepends the centraid bin dir to `PATH` so codex's shell tool can invoke `centraid` by bare name.
- [packages/local-chat-runner/src/index.ts](../packages/local-chat-runner/src/index.ts) — exports the new primitives + the backend-specific input/result types for direct consumers (builder-harness).
- [packages/local-chat-runner/package.json](../packages/local-chat-runner/package.json) — adds `@anthropic-ai/claude-agent-sdk@^0.3.143`.

### Deleted

- `packages/local-chat-runner/src/codex-adapter.ts` — replaced by `codex-app-server.ts`.
- `packages/local-chat-runner/src/claude-adapter.ts` — replaced by `claude-sdk.ts`.
- `packages/local-chat-runner/src/spawn-cli.ts` — generic CLI subprocess helper, no longer needed (`codex-app-server.ts` owns its own process; `claude-sdk.ts` is in-process).
- `packages/local-chat-runner/src/codex-adapter.test.ts` — fixtures pinned to the old `codex exec --json` schema. New backend-specific tests are deferred until we've captured wire output from real app-server / SDK runs.

### What did not change

- `ChatRunner` interface in `@centraid/runtime-core` — the chat-routes contract is unchanged.
- `ChatStreamEvent` shape — both new backends emit the same normalized union the renderer consumes.
- The `centraid` CLI bin (`sql describe / read / write`, `preview snapshot`) — agents still shell out to it for host capabilities.
- Public surface of `@centraid/local-chat-runner` for chat consumers (`makeLocalChatRunner`, `defaultCentraidCliDir`, preflight helpers).

### Verification (this commit)

- `bun run build`: all turbo build tasks succeed.
- `bun run typecheck`: 16/16 succeed.
- `bun run test`: 18/18 pass (4 codex translator fixtures dropped with `codex-adapter.test.ts`; 7 preflight + 11 centraid-CLI tests pass unchanged).
- `bun run lint`: 0/0 errors.
- `bunx oxfmt --check`: clean.

### Open items for the builder-harness swap (next commit)

- Replace `packages/builder-harness/src/agent-session.ts` (pi-based) with a duck-typed session backed by `runAgentTurn`. Translate `ChatStreamEvent` → the pi-shaped `CentraidAgentEvent` union the renderer's `handleAgentEvent` consumes, so the renderer doesn't change.
- Per-project resume: persist the returned `sessionId` under `<projectDir>/.centraid-builder-state.json`. The CLI handles transcript continuity internally; the renderer hydrates an empty chat on reload (lossy by design, can revisit).
- Desktop snapshot-capture loop: write `<projectDir>/.preview/snapshot.png` (debounced) so the builder agent can read it via its native `Read` tool / `centraid preview snapshot` for visual feedback. Replaces pi's `previewScreenshot` custom tool.
- Drop `@earendil-works/pi-coding-agent` from `packages/builder-harness/package.json` and delete `preview-screenshot-tool.ts`. Update `ui-grounding.ts` to remove the `withScreenshotTool` opt-in and reference the snapshot file directly.
- Drop the pi target from [auth-import.ts](../apps/desktop/src/main/auth-import.ts).
