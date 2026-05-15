# issue-59 — PR #57 review fixes: stale tool names + chat reopen drops context

GitHub issue: [#59](https://github.com/srikanth235/centraid/issues/59)

## Checklist

- [x] Rename stale tool names in plugin manifest
- [x] Rename stale tool names in setup-tools.mjs
- [x] Update README tool table
- [x] Add priorTurns to chat-harness factory
- [x] Render priorTurns into the system prompt
- [x] Snapshot priorTurns at START before SEND appends

## What changed

### Rename stale tool names in plugin manifest

[packages/openclaw-plugin/openclaw.plugin.json](../packages/openclaw-plugin/openclaw.plugin.json) listed `centraid_sql_select` and `centraid_get_schema` in its `contracts.tools` array. The plugin actually registers `centraid_sql_describe`, `centraid_sql_read`, `centraid_sql_write` (rename landed earlier in this branch). Updated the array to the canonical three. OpenClaw uses this manifest for tool resolution and the gateway's `tools.alsoAllow` flow — without the fix, remote callers see "tool not found" for the new names while the manifest still advertises the old ones.

### Rename stale tool names in setup-tools.mjs

[packages/openclaw-plugin/scripts/setup-tools.mjs](../packages/openclaw-plugin/scripts/setup-tools.mjs) is the idempotent patcher that merges the centraid tools into a user's `~/.openclaw/openclaw.json`'s `tools.alsoAllow`. Its `TOOLS` constant carried the same two stale names; updated to the new three. Header comment refreshed to match.

### Update README tool table

[packages/openclaw-plugin/README.md](../packages/openclaw-plugin/README.md) referenced the old names in three places: the agent-tools table, the `alsoAllow` JSON example, and the trailing prose. Renamed all three. Also extended the table to include `centraid_sql_write` (it was always there but the README hadn't been updated when DML support landed). Added a one-line pointer to `@centraid/chat-harness` so readers don't conflate the openclaw-side tools (for agents running inside the gateway) with the chat-harness pi-coding-agent tools (for the desktop's in-app chat).

### Add priorTurns to chat-harness factory

New optional `priorTurns: Array<{ user: string; assistant? }>` on `CreateDataChatSessionOptions` in [packages/chat-harness/src/data-chat-session.ts](../packages/chat-harness/src/data-chat-session.ts). When non-empty, the factory threads a `priorBlock` into the `appendSystemPromptOverride` callback right after the role-and-tools prompt block. A new internal `renderPriorTurnsBlock(turns)` helper formats the turns as numbered `### Turn N` sections with **User:** / **Assistant:** lines. Tool calls and results are deliberately omitted — the agent can re-run `centraid_sql_describe` if it needs schema; what matters for thread continuity is the user words + assistant answers.

### Render priorTurns into the system prompt

The chat-harness factory wires `priorBlock` into the prompt assembly: `appendSystemPromptOverride: () => priorBlock ? [promptBlock, priorBlock] : [promptBlock]`. The block leads with explicit guidance to the model — "You are resuming an existing chat. The user already had this exchange with you earlier — pick up the thread without re-introducing yourself or re-running queries you already did, unless the user asks again."

### Snapshot priorTurns at START before SEND appends

The subtle ordering trap: SEND appends the new user message to history BEFORE calling `ensureAgent`. If `ensureAgent` loaded prior turns inline, the just-appended user message would land in the system prompt AND be passed to `agent.prompt()` — duplicated. The fix snapshots prior turns at `START` time (before any SEND can run) and caches them on the `ChatSession` as `priorTurns`. `ensureAgent` then reads from the cached snapshot. New `loadPriorTurns(chatSessionId)` helper in chat.ts walks the history payload and pairs user/AI entries, dropping tool entries and tolerating turns with no AI reply (e.g. aborted runs). History-load failures degrade to an empty array, never block the chat — "model forgets context" is the pre-fix state, never worse.

## Out of scope

- **Replaying tool calls** in the prior-conversation block. Tools (sql_read / sql_write) are stateful by nature; reconstructing the model's reasoning over old tool results is brittle and noisy. The simpler contract — "the model sees the conversation, it can re-run tools if it needs to" — is the right primitive.
- **Persisting pi sessions to disk** (`sessionMode: 'continue'`). That was the alternative considered when the harness was designed; the user chose pi-in-memory + our history table at the time. Switching now would be a behavior change, not a bug fix.

## Verification

- `bun run --filter '*' typecheck` — passes across all 8 packages.
- `bun run --filter '*' test` — all suites green; chat-harness build picked up the new `priorTurns` field in its emitted `.d.ts` after rebuild.
- `bun run --filter '*' build` — passes.
- Final reference sweep: `grep -rn "centraid_get_schema\|centraid_sql_select"` returns nothing in source / scripts / docs (receipts intentionally preserved as historical record).
- Manual reopen smoke (planned for the PR reviewer): open a saved chat, ask a follow-up that depends on prior turn context — the model now resumes the thread instead of asking what the user is referring to.
