# Receipt — issue #424: context-window management across runner-kind switches

Issue: #424
Branch: `claude/issue-424-runner-switch-context` (stacked on `claude/issue-420-implementation-bf4dbc`, PR #428)

## Checklist

Mirrors the issue's "Suggested v0 posture" (options A2 + A1 shipped; B deferred by design; C/D non-v0):

- [x] **A2 — pin the runner kind at first turn** (pin wins; prefs steer new conversations only)
- [x] **A1 — visible fresh-context reset** (persistent `context.reset` system-note in both clients)
- [x] **Document the v0 memory model** (adapter-resume-only; the ledger is a UI codec)
- [ ] **B — ledger-derived replay on lost handle** (designed-but-deferred upgrade path; the `context.reset` notice is the seam where it would slot in).
- [ ] **C — summarize-on-switch / D — engine-owned canonical history** (explicitly non-v0 per the issue).

## What changed

### A2 — pin the runner kind at first turn (pin wins; prefs steer new conversations only)

Once a conversation has run a turn with kind K, every later turn runs with K regardless of the user's current `agent.runner.*` prefs — a mid-thread prefs flip loses no context; prefs changes take effect on the next new conversation.

- `packages/app-engine/src/conversation/runner-core.ts` — the decisive change. Replaces the silent `prevAdapterKind === prefs.kind ? resume : undefined` drop with: `effectivePrefs = pinnedKind ? { ...prefs, kind: pinnedKind } : prefs` (only `kind` is overridden; `binPath`/`extraArgs` stay as loaded), resume id = `prevAdapterSessionId` whenever pinned, and a `notice { level: 'warn', code: 'context.reset' }` emitted when the conversation is pinned but has no handle to resume. Carries the expanded v0-memory-model block comment the issue asked for ("today it lives only as a one-line comment").
- `packages/app-engine/src/conversation/runner-core.test.ts` — new: pinned kind wins over flipped prefs and resume is passed; first turn uses prefs and pins; resume-with-handle emits no notice; lost handle emits `context.reset` and starts fresh.

### A1 — visible fresh-context reset (persistent `context.reset` system-note in both clients)

The one remaining reset (lost/expired resume handle) emits a `context.reset` transcript system-note instead of silently starting blank — rendered live and after reload, replayed on idempotent turn replay, included in Markdown export. Previously `notice` was live-only — `turn-sse.ts`'s accumulator explicitly ignored it. Now:

- `packages/app-engine/src/conversation/schema.ts` — new `TurnNotice` type (`{level, code?, message}`) + `Turn.notices?` field.
- `packages/app-engine/src/stores/gateway-db.ts` — `notices TEXT` column on the `turns` DDL (pre-release v0: direct DDL edit, no migration).
- `packages/app-engine/src/conversation/store-sql.ts` — `RawTurn.notices`, tolerant `parseNotices` (malformed blobs degrade to none), `turnFromRaw` mapping, `notices = $notices` in `finishTurn`.
- `packages/app-engine/src/conversation/store.ts` — `FinishTurnInput.noticesJson` + wrapper plumbing.
- `packages/app-engine/src/conversation/history.ts` — `RecordTurnInput.notices` / `RecordedTurnReplay.notices`; serialized on `recordTurn`; `getSession` emits notice rows positioned after the user message, before the answer (mirrors live stream order); `findRecordedTurn` surfaces them for replay.
- `packages/app-engine/src/http/turn-sse.ts` — folds `notice` into the turn accumulator and passes it to `recordTurn`.
- `packages/app-engine/src/http/turn-replay.ts` — `buildReplayEvents` replays persisted notices ahead of the final/error event, so an idempotent duplicate request sees the same system-note the original stream did.
- `packages/app-engine/src/conversation/history.test.ts`, `packages/app-engine/src/http/turn-replay.test.ts` — round-trip (`recordTurn` → `getSession`), `findRecordedTurn`, and replay-ordering coverage (ok + errored turns).

### Clients (both surfaces render the note, live and after reload)

- `packages/client/src/centraid-api.d.ts` — `notice` variant added to `CentraidConversationHistoryMessage` (both embedded copies of the contract).
- `packages/client/src/react/shell/routes/assistantTranscript.ts` — `hydrateMessages` reconstructs persisted notices; the live `notice` row rendering in `AssistantMessage.tsx` (from #420 wave 4) is reused unchanged.
- `packages/client/src/react/shell/routes/assistantTranscript.test.ts` — codec reconstructs + renders a persisted notice.
- `packages/client/src/react/shell/routes/conversationExport.ts` — notice branch in the Markdown export.
- `packages/blueprints/kit/kit.js` — `api.notice()` helper; the Ask panel's live handler and `renderTranscript` both render the system-note row (previously the live path rendered it as a plain ai bubble and reload dropped it). No new kit files — no allowlist changes needed.
- `packages/blueprints/kit/kit.css` — `.kit-ask-notice` muted-warn style.

### Document the v0 memory model (adapter-resume-only; the ledger is a UI codec)

- `packages/app-engine/src/conversation/runner-core.ts` — expanded block comment at the resume seam (replacing the one-liner the issue called out).
- `docs/plans/conversation-memory-model.md` — new design note: adapter-resume-only is the deliberate v0 memory model; the ledger is a UI codec, never a prompt builder; kind pins at first turn; option B (ledger-derived replay) is the deferred upgrade path; C/D are non-v0.
- `receipts/issue-424-runner-switch-context.md` — this receipt.

## Out of scope

- **Option B (ledger-derived replay)** — deferred by design; documented as the upgrade path in `docs/plans/conversation-memory-model.md`. The `context.reset` notice site in `runner-core.ts` is the seam where it slots in.
- **Options C (summarize-on-switch) and D (engine-owned canonical history)** — explicitly non-v0 per the issue.
- **Per-conversation runner override UI** — with pin-wins semantics a user who wants the new runner starts a new conversation; an explicit "switch this conversation's runner" affordance (which would be a deliberate, visible context reset) is left for a future issue if requested.
- **Detecting adapter-side resume failures** (backend accepts the handle but its internal thread is gone — e.g. Claude session GC where the SDK errors or silently starts fresh) — the engine can only observe the handle it holds; adapter-internal expiry that doesn't clear the handle remains opaque. Documented as a known limitation in the design note.

## Verification

Full local gate on the worktree, all green:

```
bun run typecheck        → 28/28 tasks successful
bunx oxlint .            → 0 warnings, 0 errors (1350 files)
bun run format:check     → all files correctly formatted (1877 files)
```

Test suites (vitest):

```
packages/app-engine      → 421 passed (421)   [includes new runner-core.test.ts]
packages/client          → 888 passed (888)
packages/blueprints      → 222 passed (222)   [kit.js exercised via app-boot harness]
gateway runs/assistant-routes → 21 passed (21)
```

New/extended coverage: (a) pinned kind wins over flipped prefs + resume passed; (b) first turn uses prefs and pins; (c) resume-with-handle emits no notice; (d) lost handle → `context.reset` notice + fresh start; (e) notice persistence round-trip (`recordTurn` → `getSession`) and `findRecordedTurn`; (f) `buildReplayEvents` notice ordering for ok and errored turns; (g) React transcript codec reconstructs and renders the persisted notice.

## Decisions

1. **Pin-wins (not warn-and-switch).** The issue's A2 offered "refuse/warn on switch"; we implemented the strongest form: the conversation keeps its original backend, so the common case (prefs flip mid-thread) loses no context at all rather than losing it with a warning. Prefs changes take effect on the next new conversation. This is the least-surprise reading of "pin".
2. **No runner-switch notice path exists once pinning wins.** Because the pin always overrides to `prevAdapterKind` and resumes, a mid-thread prefs flip never resets context — so the only reset left is handle loss/expiry, and the notice message is switch-agnostic ("Starting a fresh context — earlier messages in this conversation aren't carried over to the model."). The issue's "mention the runner switch when that's the cause" became moot inside the engine.
3. **Notice storage shape:** JSON `notices` column on `turns` (array of `{level, code?, message}`), written at `finishTurn` — the same pattern as #420's `feedback` column. Parsing is tolerant: malformed or legacy blobs degrade to no notices rather than failing the transcript.
4. **Transcript position:** persisted notices render between the user message and the assistant answer, mirroring live stream order; replay emits them after `assistant.start`, before deltas or the error. Errored idempotent replays also carry their notices, for parity with `getSession`.
5. **Stacked branch:** #424's code builds directly on #420's shared `notice` event contract and turn-replay machinery (PR #428, unmerged at branch time), so the branch stacks on `claude/issue-420-implementation-bf4dbc`; the PR should be retargeted/merged after #428 lands (GitHub retargets automatically on base-branch merge).

## Audit

**CHECK 1 (What changed):** PASS — All five sampled claims verified in `git diff`. `effectivePrefs` pin override at runner-core.ts:179 (`const effectivePrefs: RunnerPrefs = pinnedKind ? { ...prefs, kind: pinnedKind } : prefs`); `notices TEXT` column in gateway-db.ts:152 with JSON array comment; `context.reset` notice emission at runner-core.ts:194–202 when `pinnedKind && !resumeId`; notice replay in turn-replay.ts:26–31 via `const notices: TurnStreamEvent[] = (recorded.notices ?? []).map(...)`; `.kit-ask-notice` CSS muted-warn style at kit.css:2177–2183. All 16 modified files and 3 new files (runner-core.test.ts, conversation-memory-model.md, receipt) are correctly accounted for. Additional claims verified: `TurnNotice` type in schema.ts, `parseNotices` tolerance in store-sql.ts, notice serialization in store.ts/history.ts, `notice` variant in centraid-api.d.ts, `hydrateMessages` reconstruction in assistantTranscript.ts, notice branch in conversationExport.ts Markdown export, `api.notice()` helper in kit.js, live and replay handler in kit.js `renderTranscript`. All claimed changes faithfully match the diff; nothing claimed is absent.

**CHECK 2 (Checklist realized):** PASS — Three checked items implemented in full. A2 (pin-wins) confirmed: runner-core.ts:179 effectivePrefs override + test at runner-core.test.ts:48–65 (pinned kind wins over flipped prefs, resume passed). A1 (visible reset) confirmed: context.reset notice emitted at runner-core.ts:194–202 + persisted on turns.notices (gateway-db.ts:152) + replayed by buildReplayEvents (turn-replay.ts) + rendered by both React transcript (assistantTranscript.ts) and kit Ask panel (kit.js) and Markdown export (conversationExport.ts) + tested in runner-core.test.ts:92–105, history.test.ts, turn-replay.test.ts, assistantTranscript.test.ts. Documentation realized: expanded block comment in runner-core.ts:150–177 (v0 memory model, pin mechanics, handle-loss reset) + new docs/plans/conversation-memory-model.md design note. Two unchecked items correctly absent: no ledger-derived replay (B) and no summarize-on-switch or engine-owned history (C/D) — both documented as deferred/non-v0 in design note.

**CHECK 3 (Checklist mirrors issue):** PASS — GitHub issue #424 "Suggested v0 posture" section specifies "Ship **A2 + A1**… Keep **B (ledger replay)** as the designed-but-deferred upgrade path… treat **D** as a non-v0 architecture bet." Receipt mirrors exactly: `[x] A2`, `[x] A1`, `[x] Document…`, `[ ] B — ledger-derived replay… (designed-but-deferred upgrade path)`, `[ ] C — summarize-on-switch / D — engine-owned canonical history (explicitly non-v0)`. Checked/unchecked alignment confirmed.

## Steering

**PASS** — One task directive (2026-07-16T10:43:07.915Z) initiated the #424 work with explicit orchestration and delegation instructions. Eighteen subsequent user-type entries in the transcript are all tool-result array notifications from subagent execution, not genuine human input. No user-typed steering events (corrections, redirects, interrupts, rejections, or scope changes) occurred during the #424 implementation work (10:43–11:05 UTC 2026-07-16).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8a681dbc-73c-1784200321-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #424 | claude-fable-5 | 254 | 204214 | 18546334 | 140915 | 345383 | 28.1473 | 689 | 724493 | 49079794 | 373925 | feat(chat): pin runner kind per conversation, visible context-reset notice (#424 |
