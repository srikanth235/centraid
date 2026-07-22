# Issue #500 — Harden ACP client

GitHub issue: [#500](https://github.com/srikanth235/centraid/issues/500)

## Checklist

- [x] Honor `session/prompt` stopReason
- [x] System/policy prompt on every turn
- [x] Permission auto-allow audit notices
- [x] Auth failure taxonomy
- [x] session/resume preferred; warm pool; session/close
- [x] Settings capability chips (Refresh probe)
- [x] Stdio vault MCP bridge when no HTTP MCP
- [x] Plan/diff stream enrichment + additionalDirectories
- [x] docs/runners.md surface table

## What changed

- **Honor `session/prompt` stopReason:** `stop-reason.ts` maps refusal / max_tokens / cancelled; refusal no longer emits a success `final`.
- **System/policy prompt on every turn:** `extraSystemPrompt` is prepended on every `session/prompt` (including load/resume), not only fresh sessions.
- **Permission auto-allow audit notices:** auto-allow still applies; emits `permission_auto_allowed` with tool title + option kind.
- **Auth failure taxonomy:** `agent-errors.ts` turns AUTH_REQUIRED and auth-ish Internal errors into install-hint messages.
- **session/resume preferred; warm pool; session/close:** Prefer `session/resume` → `session/load` → `session/new`; emit `session_continuity`; optional warm process pool (~2 min) with rebindable JSON-RPC handlers; `session/close` when advertised.
- **Settings capability chips (Refresh probe):** Agents status may include ACP capabilities after Refresh; chips for vault / resume / models / sign-in.
- **Stdio vault MCP bridge when no HTTP MCP:** Agents without HTTP MCP get a stdio MCP entry that proxies to the per-turn loopback HTTP vault (`vault-mcp-stdio-proxy.mjs`).
- **Plan/diff stream enrichment + additionalDirectories:** Normalized plan entries and tool diffs on `TurnStreamEvent`; `additionalDirectories` on `TurnInput` / session lifecycle.
- **docs/runners.md surface table:** documents the implemented surface vs intentional non-goals.

Changed paths covered by this receipt:

```text
docs/runners.md
packages/agent-runtime/package.json
packages/agent-runtime/src/backends/acp/agent-errors.test.ts
packages/agent-runtime/src/backends/acp/agent-errors.ts
packages/agent-runtime/src/backends/acp/backend.test.ts
packages/agent-runtime/src/backends/acp/backend.ts
packages/agent-runtime/src/backends/acp/backend.vault-tools.test.ts
packages/agent-runtime/src/backends/acp/capabilities-cache.ts
packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs
packages/agent-runtime/src/backends/acp/json-rpc.ts
packages/agent-runtime/src/backends/acp/permissions.ts
packages/agent-runtime/src/backends/acp/probe-capabilities.ts
packages/agent-runtime/src/backends/acp/session-config.ts
packages/agent-runtime/src/backends/acp/session-warm.ts
packages/agent-runtime/src/backends/acp/stop-reason.test.ts
packages/agent-runtime/src/backends/acp/stop-reason.ts
packages/agent-runtime/src/backends/acp/stream-events.test.ts
packages/agent-runtime/src/backends/acp/stream-events.ts
packages/agent-runtime/src/backends/acp/turn-vault-tools.ts
packages/agent-runtime/src/backends/acp/types.ts
packages/agent-runtime/src/backends/acp/vault-mcp-stdio-proxy.mjs
packages/agent-runtime/src/index.ts
packages/agent-runtime/src/registry.ts
packages/app-engine/src/conversation/runner.ts
packages/app-engine/src/conversation/turn.ts
packages/client/src/centraid-api.d.ts
packages/client/src/react/screen-contracts.ts
packages/client/src/react/screens/SettingsProvidersAgents.tsx
packages/client/src/react/screens/SettingsProvidersScreen.module.css
packages/client/src/react/screens/SettingsProvidersScreen.tsx
packages/client/src/react/shell/routes/settingsProvidersData.ts
packages/gateway/src/routes/agents-routes.ts
packages/gateway/src/serve/build-gateway.ts
receipts/issue-500-acp-client-hardening.md
```

## Decisions

None — implementation followed the product-shaped ACP hardening plan settled before coding (headless turn driver, not full IDE client).

## Out of scope

- Agent slash-command UI, interactive permission UI, client fs/terminal
- Protocol authenticate/logout, session/list/delete
- Arbitrary user MCP servers, ACP v2

## Verification

```sh
bun run --filter @centraid/agent-runtime test
bun run --filter @centraid/app-engine test
bun run --filter @centraid/gateway test src/routes/agents-routes.test.ts
bun run --filter @centraid/client test src/react/shell/routes/settingsProvidersData.test.ts
bun run --filter @centraid/agent-runtime typecheck
bun run --filter @centraid/app-engine typecheck
bun run --filter @centraid/gateway typecheck
bun run --filter @centraid/client typecheck
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Steering

**PASS.**

No mid-task human-steering interrupts or corrections occurred during the implementation work for #500.

1. **Every human-steering event is recorded as a row:** No mid-task steering events were identified, so no real ledger rows are required. The `### Steering` table above has headers only (explicit **none**; no fabricated steer-keys).
2. **No non-steering message is recorded as steering:** Session human messages were correctly classified as non-steering:
   - ACP missing-pieces / blind-spots analysis — ordinary task framing
   - “Did we implement all ACP features / model switch” — Q&A
   - “Why not implement useful features” — Q&A
   - “What missing pieces for current app” — recommendation request
   - “please go ahead and implement all the items you just listed!” — **task start**, not a mid-task correction
   - “create a separate PR from latest remote branch!” — **new task after implementation**, not mid-implementation steering of the code work

## Audit

**PASS.**

Evidence for the three rubric checks (receipt ↔ issue #500 ↔ working-tree implementation under `packages/agent-runtime`, `packages/app-engine`, `packages/gateway`, `packages/client`, `docs/runners.md`):

1. **`## What changed` faithfully describes the diff (no misrepresentation, no omission): PASS**
   - **Turn correctness:** `stop-reason.ts` maps `refusal` → error/`emitFinal: false`, `max_tokens`/`max_turn_requests` → warn + final, `cancelled` → notice; `backend.ts` uses `outcomeForStopReason` and does not emit success `final` on refusal. System/policy text is prepended via `input.extraSystemPrompt` on every `session/prompt`. Permissions emit `permission_auto_allowed` (`permissions.ts`). `agent-errors.ts` classifies `AUTH_REQUIRED` (-32000) and auth-ish Internal (-32603) into install-hint messages.
   - **Session continuity:** `backend.ts` prefers `session/resume` → `session/load` → `session/new`; emits `session_continuity`; `session-warm.ts` idle pool `IDLE_MS = 120_000` (~2 min) with `conn.setHandlers` rebind on warm reuse; `session/close` when `canClose`.
   - **Vault reach:** `turn-vault-tools.ts` + `vault-mcp-stdio-proxy.mjs` stdio bridge when `httpMcp` is false.
   - **Builder signals:** `stream-events.ts` normalizes plan entries and tool diffs onto `TurnStreamEvent` / `phase: plan|diff`; `additionalDirectories` on types/`TurnInput` and session lifecycle.
   - **Settings:** gateway `AgentAcpCapabilities` + client `capabilityChips` (vault / resume / models / sign-in) after Refresh probe.
   - **Docs:** `docs/runners.md` “ACP client surface” table matches implemented surface and intentional non-goals.
   - No material omission relative to checklist claims; narrative aligns with those files.

2. **Each `- [x]` item is realized in the tree: PASS**
   | Checklist item | Evidence |
   | --- | --- |
   | Honor `session/prompt` stopReason | `stop-reason.ts`, `backend.ts` prompt result handling, tests in `backend.test.ts` / `stop-reason.test.ts` |
   | System/policy prompt on every turn | `backend.ts` prepends `extraSystemPrompt`; test “system policy is prepended on every turn including resumed sessions” |
   | Permission auto-allow audit notices | `permissions.ts` `permission_auto_allowed` |
   | Auth failure taxonomy | `agent-errors.ts` AUTH_REQUIRED + auth-ish Internal |
   | session/resume preferred; warm pool; session/close | `backend.ts` resume→load→new; `session-warm.ts`; close on dispose/non-park |
   | Settings capability chips (Refresh probe) | `agents-routes.ts` capabilities; `settingsProvidersData.ts` chips; Settings “Refresh models & capabilities” |
   | Stdio vault MCP bridge when no HTTP MCP | `turn-vault-tools.ts` / `vault-mcp-stdio-proxy.mjs` |
   | Plan/diff stream enrichment + additionalDirectories | `stream-events.ts`; types + session params |
   | docs/runners.md surface table | `docs/runners.md` lines documenting surface + non-goals |

3. **`## Checklist` mirrors the issue's checklist: PASS**
   Issue #500 in-scope bullets map 1:1 onto the receipt’s nine checked items (stopReason, system/policy every turn, permission audit notices, auth taxonomy, resume/warm/close, Settings chips via Refresh, stdio vault bridge, plan/diff + additionalDirectories, docs/runners.md). Receipt **Out of scope** matches the issue (no full IDE ACP client, no ACP v2, no arbitrary user MCP servers; receipt also lists slash-command UI / interactive permissions / fs-terminal / authenticate-logout / session list-delete consistently with the issue and `docs/runners.md` non-goals).
