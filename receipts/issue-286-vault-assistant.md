# issue-286 — Vault assistant: shell-level Q&A over the whole vault

GitHub issue: [#286](https://github.com/srikanth235/centraid/issues/286)

The owner's assistant — a shell-level chat surface (not any app's chat)
that answers questions spanning the whole vault, including multi-hop
relationship questions, with **one read-only SQL statement as the primary
primitive**. Single-tenant by design: the consent keyhole protects the
owner from third parties, so the owner's own assistant rides the
owner-device credential with receipts (audit) instead of grants
(permission). Provider-agnostic: the register rides whichever runner
backend (codex / claude-code) the user configured, exactly like app chat.

## Checklist

Phase 1 + the phase-2 first slice land together, one commit per package:

- [x] Commit 1 — vault: owner-only `Gateway.sql` (read-only, receipted) + the assistant's live schema/ontology/commands map
- [x] Commit 2 — app-engine: vault-register tool seams (`vault_sql` + `vault_invoke`), the shared SSE turn driver, the reserved `_assistant` scope, `register` threading
- [x] Commit 3 — agent-runtime: both backends swap the `centraid_*` trio for the vault tools on vault-register turns
- [x] Commit 4 — gateway: assistant conversation register (`_turn`/`resolve` routes, runner, prompt), `invokeAsAssistant` (parked high-risk writes), and the ask-register switch for vault-backed apps
- [x] Commit 5 — desktop: Assistant page (threads + streaming chat + typed blocks + ref chips + queries pill); the copilot sends `register: 'ask'`

## What changed

Per-commit map (mirrors the checklist):

- Commit 1 — vault: owner-only `Gateway.sql` (read-only, receipted) + the assistant's live schema/ontology/commands map.
- Commit 2 — app-engine: vault-register tool seams (`vault_sql` + `vault_invoke`), the shared SSE turn driver, the reserved `_assistant` scope, `register` threading.
- Commit 3 — agent-runtime: both backends swap the `centraid_*` trio for the vault tools on vault-register turns.
- Commit 4 — gateway: assistant conversation register (`_turn`/`resolve` routes, runner, prompt), `invokeAsAssistant` (parked high-risk writes), and the ask-register switch for vault-backed apps.
- Commit 5 — desktop: Assistant page (threads + streaming chat + typed blocks + ref chips + queries pill); the copilot sends `register: 'ask'`.

Details:

- `packages/vault/src/gateway/sql.ts` — lexical gate (single statement,
  read-shaped first token) + per-call `PRAGMA query_only` connection on
  disk vaults; rows capped (200 default / 1000 max) with a `truncated`
  flag; `vault_content_text()` registered so FTS/content queries work.
  `Gateway.sql` is owner-device-only and receipts every run
  (`vault.sql`), allow and deny.
- `packages/vault/src/gateway/assistant-context.ts` — the model's map:
  ontology conventions, live link-relations vocabulary, FTS surfaces,
  live DDL. Built per turn so it never drifts.
- `packages/app-engine/src/http/turn-sse.ts` — the SSE/ledger half of the
  app `_turn` route, extracted verbatim (framing, accumulator, per-session
  lock, recordTurn/noteTurn) and shared with the assistant route;
  `turn-routes.ts` drops back under the file-size cap and keeps only the
  app-shaped half.
- `ToolContext.vaultSql` is the register discriminator — both backends
  swap the `centraid_*` trio for the ONE `vault_sql` tool
  (`packages/agent-runtime/src/vault-sql-tool.ts` shares name/description/
  schema/dispatch across codex dynamic tools and the claude MCP server).
- `packages/gateway/src/routes/assistant-routes.ts` —
  `POST /centraid/_vault/assistant/_turn` (SSE) +
  `POST /centraid/_vault/assistant/resolve` (refs → owner-resolved cards).
  Threads live under the reserved `_assistant` ledger scope (`_`-prefixed
  ids are structurally uninstallable as apps), so conversation CRUD reuses
  `/_centraid-conversations` unchanged, auto-titling included.
- `apps/desktop/src/renderer/app-assistant.ts` — two-pane surface:
  conversations left, streaming thread right; markdown-lite + typed
  fenced blocks (`block:table` / `block:chart` / `block:stat`, inline SVG,
  no libraries); `@[Label](ref:type/id)` chips resolved to cards; each
  turn's queries in a collapsible transparency pill.
- Commit 1 (vault) files in full: `packages/vault/src/gateway/sql.ts`,
  `packages/vault/src/gateway/sql.test.ts`,
  `packages/vault/src/gateway/assistant-context.ts`
  (conventions/vocab/FTS/DDL + the typed-commands section),
  `packages/vault/src/gateway/assistant-context.test.ts`,
  `packages/vault/src/gateway/gateway.ts` (the `Gateway.sql` op),
  `packages/vault/src/index.ts` (exports),
  `receipts/issue-286-vault-assistant.md` (this receipt).
- Commit 2 (app-engine) files in full:
  `packages/app-engine/src/conversation/turn.ts` (`VaultSqlRunner` +
  `VaultInvokeRunner` + `ToolContext.vaultSql`/`vaultInvoke`),
  `packages/app-engine/src/conversation/runner-core.ts` (per-turn seams),
  `packages/app-engine/src/conversation/history.ts` (reserved
  `ASSISTANT_APP_ID`), `packages/app-engine/src/conversation/runner.ts`
  (`ConversationTurnInput.register`),
  `packages/app-engine/src/http/turn-sse.ts` (new; register threading) +
  `packages/app-engine/src/http/turn-routes.ts` (extraction + register),
  `packages/app-engine/src/index.ts` (exports).
- Commit 3 (agent-runtime) files in full:
  `packages/agent-runtime/src/vault-sql-tool.ts` (new — `VAULT_SQL_TOOL`
  + `VAULT_INVOKE_TOOL` + dispatch),
  `packages/agent-runtime/src/backends/claude/host-tools.ts`,
  `packages/agent-runtime/src/backends/codex/host-tools.ts` +
  `packages/agent-runtime/src/backends/codex/host-tools.test.ts`
  (vault-register spec swap + dispatch cases),
  `packages/agent-runtime/src/backends/codex/backend.ts`.
- Commit 4 (gateway) files in full:
  `packages/gateway/src/serve/vault-plane.ts` (`sqlAsOwner` /
  `assistantContext` / `resolveAsOwner` / `invokeAsAssistant` — the
  idempotent `_assistant` agent enrollment + standing act grant) +
  `packages/gateway/src/serve/vault-plane.test.ts` (executes low-risk,
  parks high-risk, one agent row),
  `packages/gateway/src/serve/build-gateway.ts` (assistant runner +
  route mount + `askAppMeta` manifest probe + `askRunner` + the facade
  routing `register: 'ask'` turns on vault-backed apps onto the vault
  register), `packages/gateway/src/routes/assistant-routes.ts` +
  `packages/gateway/src/routes/assistant-routes.test.ts` (new),
  `packages/gateway/src/runs/assistant-conversation-runner.ts` (new;
  vaultInvoke + `buildPrompt` seam),
  `packages/gateway/src/runs/assistant-prompt.ts` (new; write guidance +
  `AssistantLens`).
- Commit 5 (desktop) files in full:
  `apps/desktop/src/renderer/app-assistant.ts` (new),
  `apps/desktop/src/renderer/app.ts`,
  `apps/desktop/src/renderer/app-shell-context.ts`,
  `apps/desktop/src/renderer/chrome.ts`,
  `apps/desktop/src/renderer/types.d.ts`,
  `apps/desktop/src/renderer/gateway-client-conversation.ts`
  (`streamAssistantTurn` / `resolveAssistantRefs` /
  `StreamTurnInput.register`), `apps/desktop/src/renderer/app-chat.ts`
  (the copilot sends `register: 'ask'`),
  `apps/desktop/src/renderer/styles.css`.

## Decisions

- **Consent bypass is deliberate, receipts are not.** `Gateway.sql` skips
  grant evaluation entirely (owner-device only) instead of compiling
  grants into SQL views — single-tenant: the keyhole protects the owner
  from third parties, and there is no third party on this surface. Every
  run still writes a receipt, allow and deny.
- **Registers swap, never mix.** `ToolContext.vaultSql` swaps the
  `centraid_*` trio out rather than adding a fourth tool beside it — an
  assistant turn has no app, so the trio could only error.
- **`WITH` required a new lexical gate.** The app-side `_sql` guard
  refuses CTEs (first token must be SELECT/EXPLAIN); recursive CTEs are
  the whole point here, so `sql.ts` has its own gate plus the
  `query_only` execution belt instead of reusing `isSelectOnly`.
- **Assistant turns always use the gateway CLI runner** — the OpenClaw
  in-process runner override is not consulted for this register in v0
  (no `vaultSql` seam there yet); noted as deferred on #286.
- **Ledger `runKind` for assistant turns records as `'chat'`** (runner
  leaves it unset), matching data-chat semantics.
- **Phase 2: writes ride an enrolled `_assistant` agent, NOT the
  owner-device credential** — deliberately, so the structural `medium`
  risk ceiling makes high-risk commands park for explicit approval.
  Its standing act grant is minted idempotently on first use (using the
  assistant IS the consent, single-tenant); scoped to `act` only.
- **Phase 2: the app lens biases, never constrains.** Ask-in-app rides
  the whole vault (owner asking their own data); the lens is prompt-level.
  The vault-backed check reads the live `main` manifest per turn.
- **Phase 2: `register` defaults to builder behavior.** Only the desktop
  copilot sends `register: 'ask'`; the builder pane and any old client
  send nothing and keep the unified runner — no behavior change outside
  the copilot. App-chat ledger turns still record as `kind='build'`
  (facade-level `runKind`), noted as a known cosmetic wrinkle.

## Out of scope

- `packages/blueprints/apps/people/app.css` and
  `packages/blueprints/src/app-manifests.test.ts` picked up formatter-only
  churn from the repo-wide `npm run format`; left uncommitted (not part of
  this feature).
- Deferred (listed on #286): a parked-approvals surface INSIDE the
  assistant/copilot UI (the tool tier itself lands here; approvals ride
  the existing vault tab / kit ask surfaces); pinning answers as
  `queryView`s / standing automations; journal.db queryability;
  conversation search; mobile surface; OpenClaw-hosted assistant turns;
  issue #286 phase-2 boxes 3–6 (no-silo scaffolding, `ext` band, draft
  semantics, deleting the trio).

## Verification

```sh
npx turbo run test --filter=@centraid/vault --filter=@centraid/app-engine \
  --filter=@centraid/agent-runtime --filter=@centraid/gateway --filter=@centraid/desktop \
&& npm run lint
```

- `packages/vault`: 236 tests green (incl. new `sql.test.ts` — lexical
  gate incl. `WITH RECURSIVE`/window/`replace()` cases, receipts on allow
  + deny, row cap, owner-only identity, disk-vault FTS MATCH +
  `vault_content_text`, query_only belt; `assistant-context.test.ts`).
- `packages/app-engine`: full suite green after the turn-sse extraction
  (`turn-routes.test.ts` 9/9, `history.test.ts` 38/38 with the reserved
  `_assistant` scope).
- `packages/agent-runtime`: suite green; codex host-tools tests 10/10
  (spec swap is additive — no app-register behavior change).
- `packages/gateway`: 145 tests green incl. new
  `assistant-routes.test.ts` (SSE stream + `_assistant` ledger fold +
  auto-title, 404 on unknown thread, resolve happy/malformed).
- `apps/desktop`: `tsc` clean, build green, renderer tests 81/81.
- Repo `oxlint`: 0 warnings, 0 errors. `npm run format` applied.
- Full battery: `turbo run test` across the five touched packages —
  15 tasks green.
- Phase 2 slice: `vault-plane.test.ts` 12/12 (invokeAsAssistant executes
  low-risk under the standing grant, parks `social.send_message`, one
  agent row across calls); codex `host-tools.test.ts` 14/14 (vault
  register spec swap incl. `vault_invoke`, dispatch, error surfacing);
  full battery re-run green after the slice.

## Audit

Re-verified after the phase-2 first slice joined the change set (vault_invoke + ask-register switch + register threading; receipt restructured to five per-package commits).

**Verdict 1 — "What changed" description vs. diff:** PASS. Bidirectional match: the five per-commit file lists enumerate exactly the current change set — 26 tracked code files + this receipt + 7 untracked (ignoring `packages/blueprints/*` per Out-of-scope) — including the phase-2 additions (`app-chat.ts`, `runner.ts`, `codex/host-tools.test.ts`, `vault-plane.test.ts`); spot-checked claims hold in the diff (`invokeAsAssistant` + idempotent `_assistant` enrollment in `vault-plane.ts`, typed-commands section in `assistant-context.ts`, `register?: 'ask' | 'build'` in `runner.ts`, ask-register facade in `build-gateway.ts`). One minor staleness, not a misrepresentation: Out-of-scope's deferred list still carries phase-1 wording ("`vault_invoke` write tier...") though the tool tier itself now lands in this slice (the in-UI parked-approvals surface remains deferred).

**Verdict 2 — Checklist items realized:** PASS. All five [x] items are realized in the diff: Commit 1 `Gateway.sql` + assistant context incl. the commands map (`registeredCommands` in `assistant-context.ts`); Commit 2 `VaultSqlRunner`/`VaultInvokeRunner` seams, `turn-sse.ts` extraction, reserved `_assistant` scope, `register` threading; Commit 3 both backends' `centraid_*`→vault-tools swap (`VAULT_SQL_TOOL` + `VAULT_INVOKE_TOOL` in `vault-sql-tool.ts`, host-tools on both backends); Commit 4 assistant routes/runner/prompt + `invokeAsAssistant` + the `askRunner`/`askAppMeta` register switch; Commit 5 the Assistant page and the copilot sending `register: 'ask'` (`app-chat.ts`).

**Verdict 3 — Checklist mirrors issue scope:** PASS. Phase 1 of the issue has no literal checkbox list; the receipt's commits 1/4/5 cover its five design points (SQL-first read, conversation register, ontology map, typed blocks, resolve). The issue's Phase 2 section DOES carry a six-box checklist with all boxes unchecked; the receipt claims exactly the first two boxes (`vault_invoke` tool + enrolled `_assistant` agent + commands in context; the ask-register switch) — the issue's first two — and claims nothing from boxes 3–6 (Lane 1 builder scaffolds, `ext` band, draft semantics, trio deletion), consistent with its stated "phase-2 first slice" framing.

## Steering

**Verdict:** PASS. Five human-steering events found in session `13c03fef-ea84-4f1a-b3bb-c51612a243f9`; each is recorded as a row in `### Steering` below. Judged per event:

1. **correction** (12:38:09Z) — "wait...think of it from vault owner perspective...he/she is the only user for this assistant" — redirected the design from a consent-scoped frame to owner-first single-tenant SQL mid-brainstorm. Steering.
2. **interrupt** (15:05:48Z) — explicit `[Request interrupted by user]` sentinel, arriving right after the 15:04 commit step. Structural steering.
3. **correction** (15:07:46Z) — "let's revisit the tools...do we really need those tools" — the post-interrupt redirect challenging the pre-vault `centraid_read/write/sql` tool design mid-task. Steering.
4. **correction** (15:17:02Z) — "you are mistaken, why would builder need centraid_ tools..it doesn't make sense" — corrected the agent's mistaken claim and redirected it to rethink the separate-sqlite assumption. Steering.
5. **interrupt** (15:23:26Z) — explicit `[Request interrupted by user]` sentinel, 9 s after "just update the existing issue with phase 2 and work on it" — halted the just-ordered phase-2 work (phase 2 ended up deferred). Structural steering. Final transcript event.

No non-steering messages were recorded: the initial task brief, the answers to the agent's design questions ("yeah, shell-level surface it is", "yes, it should be provider agnostic...go ahead"), "Continue from where you left off.", and the ordinary task instruction "just update the existing issue with phase 2" are not steering, and tool permission denials are not tracked.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-13c03fef-ea8-1783263850-1 | claude-code | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | claude-fable-5 | 72654 | 1925345 | 81657789 | 387284 | 2385283 | 125.8153 | 72654 | 1925345 | 81657789 | 387284 | feat(vault): owner-only whole-model SQL read + the assistant's schema/ontology m |
| claude-code-13c03fef-ea8-1783263891-1 | claude-code | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | claude-fable-5 | 5863 | 11494 | 1935690 | 2014 | 19371 | 2.2387 | 78517 | 1936839 | 83593479 | 389298 | feat(vault): owner-only whole-model SQL read + the assistant's schema/ontology m |
| claude-code-c0bf538c-2f5-1783266085-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 149141 | 5030988 | 132342802 | 577111 | 5757240 | 225.5771 | 149141 | 5030988 | 132342802 | 577111 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)G |
| claude-code-c0bf538c-2f5-1783266124-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 3773 | 4584 | 996027 | 351 | 8708 | 1.1086 | 152914 | 5035572 | 133338829 | 577462 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)I |
| claude-code-c0bf538c-2f5-1783266203-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 532 | 8162 | 4028688 | 9510 | 18204 | 4.6115 | 153446 | 5043734 | 137367517 | 586972 | feat(vault): owner-only whole-model SQL read + the assistant's vault map (#286)G |
| claude-code-c0bf538c-2f5-1783266240-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 11373 | 1683 | 1520943 | 2739 | 15795 | 1.7927 | 164819 | 5045417 | 138888460 | 589711 | feat(app-engine): vault-register seams, shared SSE turn driver, reserved _assist |
| claude-code-c0bf538c-2f5-1783266261-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 164819 | 5045417 | 138888460 | 589711 | feat(agent-runtime): vault_sql + vault_invoke tools on both backends (#286)One s |
| claude-code-c0bf538c-2f5-1783266300-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 2 | 4819 | 507542 | 973 | 5794 | 0.6164 | 164821 | 5050236 | 139396002 | 590684 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266318-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 164821 | 5050236 | 139396002 | 590684 | feat(desktop): Assistant page — threads, streaming chat, typed blocks, ref chips |
| claude-code-c0bf538c-2f5-1783266362-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 395 | 5406 | 2051126 | 1159 | 6960 | 2.1806 | 165216 | 5055642 | 141447128 | 591843 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266441-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 14 | 6680 | 3610070 | 2698 | 9392 | 3.8286 | 165230 | 5062322 | 145057198 | 594541 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |
| claude-code-c0bf538c-2f5-1783266462-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 165230 | 5062322 | 145057198 | 594541 | feat(desktop): Assistant page — threads, streaming chat, typed blocks, ref chips |
| claude-code-c0bf538c-2f5-1783266510-1 | claude-code | c0bf538c-2f5f-4ef0-a96d-831300b3fbf8 | #286 | claude-fable-5 | 8011 | 17128 | 2590758 | 4272 | 29411 | 3.0986 | 173241 | 5079450 | 147647956 | 598813 | feat(gateway): assistant register — routes, runner, prompt, parked writes, ask s |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-13c03fefea84-1783255089-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | think of it from vault owner perspective; single-tenant, owner-first SQL | pending | 30 | 2026-07-05T12:38:09.466Z |
| steer-13c03fefea84-1783263948-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | interrupt | structural |  | pending | 706 | 2026-07-05T15:05:48.112Z |
| steer-13c03fefea84-1783264066-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | revisit centraid_read/write/sql tools — do we really need those in vault era | pending | 709 | 2026-07-05T15:07:46.630Z |
| steer-13c03fefea84-1783264622-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | correction | classifier | you are mistaken, builder doesn't need centraid_ tools; rethink separate sqlite | pending | 715 | 2026-07-05T15:17:02.609Z |
| steer-13c03fefea84-1783265006-1 | 13c03fef-ea84-4f1a-b3bb-c51612a243f9 | #286 | interrupt | structural |  | pending | 725 | 2026-07-05T15:23:26.348Z |
