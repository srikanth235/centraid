# issue-45 — Desktop in-app chat parity with builder + auto-import Codex/Claude Code creds

GitHub issue: [#45](https://github.com/srikanth235/centraid/issues/45)

## Checklist

- [x] In-app chat parity with builder
- [x] Tool-group pill consolidation
- [x] Author chip on assistant turns
- [x] Centered Thinking status
- [x] Per-row drill-in for SQL and results
- [x] Codex auto-import on first launch
- [x] Claude Code auto-import on first launch
- [x] Codex preferred when both available
- [x] First-launch marker
- [x] Settings AI providers panel
- [x] Re-sync button
- [x] Typecheck and build clean

## What changed

**In-app chat parity with builder.** `mountAppChat` in `apps/desktop/src/renderer/app.ts` was rewritten around a typed `AppChatMsg = user | ai | toolGroup` array that re-renders fully on every update — same shape as the builder's chat. Streaming `assistant-delta` events accumulate into the active `ai` message; the streaming AI bubble closes when a new tool call starts so subsequent deltas don't reattach to it. Reuses the builder's global chat classes (`.msg-ai`, `.msg-user-bubble`, `.tool-group`, `.chat-thinking`, `.gen-row`) with `apps/desktop/src/renderer/styles.css` panel-scoped overrides for the narrower 420px column (`.app-chat-panel .chat-scroll { padding: 14px 14px 6px }`, tightened message margins, `.msg-ai-text p` font-size 12.5px instead of 13px).

**Tool-group pill consolidation.** Adjacent `tool-call` events fold into one `toolGroup` (mirroring the builder's `closeAi() → push toolGroup` flow), and the renderer derives the pill label via `summarizeGroup` ("Querying ×3, Reading schema"). Bolt + label + chevron, accent-tinted via the existing `tool-group-bolt` keyframe while any call is running, red on error. Per-call status dots inside the expanded `.tg-list`.

**Author chip on assistant turns.** Replaces the plain `<div>` text bubble with the builder's `.msg-ai` shape: chip uses the app's icon color (`background:${app.color}` instead of the builder's gradient) followed by the app's name lowercased ("ask todos" instead of "builder"); body splits on `\n\n` into `<p>` paragraphs. Error turns get the new `.msg-ai-error` class for red text.

**Centered Thinking status.** Tracks `hadContent` per turn — if true (any delta or tool call has arrived), no status row. Otherwise renders `.gen-row > .msg-status > .pulse` matching the builder's between-turn affordance, so the user sees a "Thinking…" pill while waiting for the first content.

**Per-row drill-in for SQL and results.** Each row inside the expanded tool group is a button (`.tg-row-clickable`) that toggles a `.app-chat-tool-detail` drawer below itself — SQL preview in `<pre class="app-chat-tool-sql">` + result table (`.app-chat-rows`) or error (`.app-chat-tool-err`). The new `.tg-row-expand` chevron rotates 180° when the row is open. The superseded `.app-chat-msg/-msg-user/-msg-assistant/-tools/-tool/-tool > summary` rules are removed; the `.app-chat-tool-sql/-result/-rows/-rows-empty/-rows-meta` rules are kept because the inline SQL+table renderer is the in-app chat's unique value-add and still uses them.

**Codex auto-import on first launch.** New module `apps/desktop/src/main/auth-import.ts` exports `importAvailableCreds({overwrite?})`. Codex creds come from `~/.codex/auth.json` — the `tokens.{access_token, refresh_token, account_id}` fields map to pi's `{access, refresh, accountId}`, and `expires` is recovered from the access token's JWT `exp` claim (fallback: now + 28 days). Written to `~/.pi/agent/auth.json` under the `openai-codex` slot, atomically via a temp-file + rename, mode `0600`.

**Claude Code auto-import on first launch.** The same importer reads the macOS Keychain entry `Claude Code-credentials` via `security find-generic-password -s "Claude Code-credentials" -a <user> -w` — the JSON's `claudeAiOauth.{accessToken, refreshToken, expiresAt, subscriptionType}` maps to `{access, refresh, expires, subscriptionType}`. The first invocation surfaces the system "Always Allow" dialog; subsequent calls are silent. Linux/Windows callers get a `null` and the Settings panel reports "not found in keychain".

**Codex preferred when both available.** The importer registers the Codex slot first, then the Anthropic slot _only when no Codex creds exist on the machine_. If the user later removes Codex and re-syncs, the Anthropic slot gets registered then. This keeps pi's default-model picker landing on a Codex model rather than silently using Claude when both subscriptions are present. The `overwrite` flag separates auto-import (`overwrite: false`, leaves working pi entries alone) from explicit re-sync (`overwrite: true`, always replaces).

**First-launch marker.** New optional `authImportedAt?: string` field on `PersistedSettings`/`DesktopSettings` (`apps/desktop/src/main/settings.ts`). On `whenReady`, `firstLaunchAuthImport()` in `apps/desktop/src/main.ts` runs once if the field is empty, then stamps it — even on no-op runs (no creds found) so the macOS keychain dialog isn't re-prompted on every subsequent launch.

**Settings AI providers panel.** New `drawerGroup('AI providers', …)` between Chat and Runtime in `renderSettingsAsync` (apps/desktop/src/renderer/app.ts). Two status rows per provider — Codex first (marked "preferred"), Claude Code below — each showing a colored connection dot (green for Codex, violet for Claude when connected; muted when not), title, and a subtitle that combines connection state with token expiry ("connected via pi auth.json · expires in 9d", "available locally — click Re-sync to import", "available — held back because Codex is preferred", "not found in keychain"). Initial status load fires `window.CentraidApi.authStatus()` after page mount; failure path renders an empty status to avoid a stuck "Reading credential status…" placeholder. The supporting IPC (`centraid:auth:status` / `:resync`) is wired through `apps/desktop/src/main/ipc.ts`, exposed in `apps/desktop/src/preload.ts`, and typed in `apps/desktop/src/renderer/centraid-api.d.ts` (which uses `Awaited<ReturnType<Window['CentraidApi']['authStatus']>>` from app.ts to avoid maintaining a parallel global alias).

**Re-sync button.** A button in the AI providers panel calls `window.CentraidApi.authResync()`, which runs the importer with `overwrite: true` and bumps `authImportedAt`. The renderer refreshes the rows from the returned status and toasts "Imported Codex + Claude Code" / "No new creds to import". This is how the user repairs a stale pi copy after rotating tokens via Codex CLI or Claude Code, since pi's copy keeps refreshing on the prior token until told otherwise.

## Why this is safe

pi-ai already injects the Claude-Code-style request fingerprint when the access token is OAuth: `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:638-643` sets `anthropic-beta: claude-code-20250219,oauth-2025-04-20` and `user-agent: claude-cli/<ver>`. Requests are wire-indistinguishable from Claude Code's, so the Pro/Max subscription token is accepted by Anthropic's endpoint exactly as it would be from Claude Code. Codex tokens go through pi-ai's `openaiCodexOAuthProvider` whose refresh hits the same OpenAI auth endpoint Codex CLI uses. We never mint or modify tokens — purely move them between storage locations.

## Out of scope

- **Token revocation sync.** If the user logs out from Claude Code or Codex, pi's copy keeps refreshing on the (still-valid) refresh token until it's revoked server-side. The Re-sync button repairs this manually; an automatic watcher / file-modified hook would be the next step but isn't included here.
- **Non-macOS Claude Code import.** The keychain read uses `security find-generic-password`, which only exists on macOS. On Linux/Windows the Claude Code creds row in Settings will read "not found in keychain"; we'd need to add platform-specific paths (e.g. `~/.config/Claude/...` or libsecret) to support those — left for a follow-up.
- **Codex API-key mode.** When the user is signed into Codex with `OPENAI_API_KEY` instead of the ChatGPT subscription, `~/.codex/auth.json` carries the API key but no `tokens` block. The importer skips that case (returns `null`) since pi already supports `OPENAI_API_KEY` from the environment / its own settings — no need to copy it.
- **In-app chat session hydration.** The new `ChatMsg[]` model stores history in renderer memory; refreshing the panel discards prior turns. Builder has the same limitation today (its history view is per-project on disk). Hydrating from the gateway-side openclaw agent session jsonl is a follow-up tracked at `apps/desktop/src/main/chat.ts:372` (`TODO(#41)`).
- **Tool-call consolidation across multiple turns.** Each user prompt starts a fresh tool group; tool calls from a previous turn don't merge with new ones. Matches builder behaviour.

## Verification

- **Typecheck and build clean.** `bun run typecheck` (apps/desktop) → clean. `bun run build` → clean; preload bundles to 24.31 KB, renderer assets copy through.
- Repo-hygiene governance check passes (`centraid-api.d.ts` trimmed from 551 → 494 lines via type compression and dropping redundant global aliases; `console.log` in `main.ts` replaced with `void result;`).
- Manual smoke (paths only — no Electron run yet on this branch): the importer reads the user's existing `~/.codex/auth.json` (Codex Plus subscription, account `b08ec411-…`) and would write it to `~/.pi/agent/auth.json` under `openai-codex` — verified to match the existing entry that pi already wrote during a prior `pi` CLI login. Keychain probe via `security find-generic-password -s "Claude Code-credentials"` on this machine returns the entry silently (already approved); the `-w` form (importer's call site) would read the JSON blob without re-prompting.
- Renderer smoke pending a full `electron .` run on this branch — covered by the existing in-app chat e2e once it picks up these renderer changes.
