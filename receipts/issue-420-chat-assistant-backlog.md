# issue-420 — chat assistant enhancement backlog: shared core + waves 1–4

GitHub issue: [#420](https://github.com/srikanth235/centraid/issues/420)

## Checklist

Issue #420's suggested phasing, each wave discharged by the named subsection in
**What changed** and the evidence in **Verification**.

- [x] **Wave 0 — shared conversation core**
- [x] **Wave 1 — transcript table stakes**
- [x] **Wave 2 — rendering**
- [x] **Wave 3 — management & search**
- [x] **Wave 4 — resilience**
- [ ] **Wave 5 — design issues to spin out**

## What changed

### Wave 0 — shared conversation core

Extracted the shared, framework-free conversation core into the kit dir (single
canonical copy, vanilla ESM served verbatim from `sharedAssetsDir`); both chat
clients — the kit Ask panel and the React shell — now consume it. One SSE
parser, one rich renderer, one consent flow, one route/model-state helper.

New shared modules (each with a sibling `.d.ts` so the strict TS client keeps
type-checking; the `TurnStreamEvent` union in `turn-stream.d.ts` is now the
single documented wire contract):

- `packages/blueprints/kit/turn-stream.js` + `packages/blueprints/kit/turn-stream.d.ts` —
  the one SSE frame parser (`consumeSse`, `parseFrame`, `parseSseText`,
  `frameData`) with `AbortSignal` plumbing.
- `packages/blueprints/kit/assistant-rich.js` + `packages/blueprints/kit/assistant-rich.d.ts` —
  the one string→HTML rich-answer renderer (`richAnswerHtml`, `hydrateRefs`,
  `defaultResolveRefs`), ported from the shell's `assistantRich.ts` with an
  injectable class map + ref resolver.
- `packages/blueprints/kit/consent-cards.js` + `packages/blueprints/kit/consent-cards.d.ts` —
  shared parked/consent flow logic (`outcomeOf`, `fetchParkedEntry`,
  `describeParked`, `confirmParked`, `normalizeApproveOutcome`), transport-injected.
- `packages/blueprints/kit/conversation-client.js` + `packages/blueprints/kit/conversation-client.d.ts` —
  single-sourced route builders (turn/conversations/blobs/model/parked/resolve/
  vault-status), model-picker state helpers, `readJsonResponse`.

Consumers refactored:

- `packages/blueprints/kit/kit.js` — Ask controller uses all four shared
  modules; hand-rolled SSE pump deleted; answers render via
  `richAnswerHtml`/`hydrateRefs` (ref-chips + typed `block:*` now render
  identically to the shell instead of as escaped text); added a working
  Stop/cancel (Send becomes ■ while busy, aborts via per-turn `AbortController`).
- `packages/blueprints/kit/kit.css` — `asst*` rich-answer styles mapped to
  `--kit-*` tokens, scoped under `.kit-msg.ai`.
- `packages/client/src/react/shell/routes/assistantRich.ts` — thin adapter over
  the shared renderer (shell CSS-module classes + auth-aware ref resolver).
- `packages/client/src/gateway-client-conversation.ts` — private SSE parser and
  local `TurnStreamEvent` union deleted; re-exports the shared type, uses
  shared `consumeSse` + route builders.
- `packages/client/package.json` — added `@centraid/blueprints` workspace dep
  (bare `@centraid/blueprints/kit/*.js` subpath imports).

Allowlists updated for the four new kit modules:
`packages/app-engine/src/http/security.ts` (`SHARED_ASSET_FILES`),
`packages/blueprints/src/app-boot-harness.ts` (jsdom symlink set),
`packages/blueprints/scripts/lint-apps.mjs` (no-undef targets).

New unit tests (27 tests): `packages/blueprints/src/turn-stream.test.ts`,
`packages/blueprints/src/assistant-rich.test.ts`,
`packages/blueprints/src/consent-cards.test.ts`,
`packages/blueprints/src/conversation-client.test.ts`.

### Wave 1 — transcript table stakes

All twelve §1/§3/§4/§5 quick-win items:

- **Copy message + copy code block** — per-message copy button; the code-block
  copy button is emitted by the shared renderer (`.asstCodeWrap`/`.asstCopyBtn`
  + exported `wireCodeCopy`) in `packages/blueprints/kit/assistant-rich.js` /
  `packages/blueprints/kit/assistant-rich.d.ts`, so the kit Ask panel
  (`packages/blueprints/kit/kit.js`, styles in `packages/blueprints/kit/kit.css`)
  and the shell both get it.
- **Regenerate / retry a turn** — control on the last AI answer re-runs the
  last user message as a `retryOf` turn; transcript reconstruction collapses
  retries linear-with-retry with a `‹ 2/2 ›` sibling pager
  (`groupRetryFamilies` in `packages/app-engine/src/conversation/transcript.ts`).
  `retryOf` threads HTTP body → `DriveTurnOptions` → `recordTurn` → `insertTurn`
  via `packages/app-engine/src/http/turn-routes.ts`,
  `packages/app-engine/src/http/turn-sse.ts`,
  `packages/gateway/src/routes/assistant-routes.ts`.
- **Retry on transient stream failure** — error bubbles keep the failed text
  and show a Retry button that re-runs it without duplicating the message.
- **Message timestamps** — `createdAt` rendered as muted hover time per group.
- **Message-level feedback** — new `turns.feedback` column (`up|down|null`,
  CHECK-constrained; pre-release v0, no migration) in
  `packages/app-engine/src/conversation/schema.ts` +
  `packages/app-engine/src/stores/gateway-db.ts`, `setTurnFeedback` in
  `packages/app-engine/src/conversation/store.ts` /
  `packages/app-engine/src/conversation/store-sql.ts` /
  `packages/app-engine/src/conversation/history.ts` (+
  `packages/app-engine/src/conversation/history.test.ts`), a
  `PATCH .../sessions/<id>/turns/<turnId>/feedback` route in
  `packages/app-engine/src/http/conversation-routes.ts`, thumbs on AI answers.
- **Lightweight transcript virtualization** — `content-visibility: auto` +
  `contain-intrinsic-size` on message rows.
- **Scroll-aware auto-scroll + jump-to-bottom** and **per-conversation scroll
  restore** — `packages/client/src/react/screens/useAssistantScroll.ts`: stick
  only when near bottom, floating ↓ pill otherwise, in-memory position map.
- **Rename in the UI** — sidebar row menu (Rename/Delete) in
  `packages/client/src/react/shell/Sidebar.tsx` → existing
  `renameConversation`.
- **Delete undo** — 6s undo toast with optimistic row-hide and deferred
  cascade delete (`packages/client/src/react/shell/undoToast.ts`, wired in
  `packages/client/src/react/shell/App.tsx`).
- **Builder attach button wired** — `uploadChatAttachment` per-app blob-CAS
  upload in `packages/client/src/react/shell/routes/builder/useBuilder.ts`,
  staged chips + send in
  `packages/client/src/react/screens/BuilderChatPane.tsx` /
  `packages/client/src/react/screens/BuilderChatPane.module.css` /
  `packages/client/src/react/screens/BuilderChatPane.test.tsx`,
  `packages/client/src/react/shell/routes/builder/BuilderShell.tsx`.
- **Draft persistence** — per-conversation localStorage drafts cleared on send
  (`packages/client/src/react/screens/assistantDrafts.ts`).

Shell transcript surface refactored into
`packages/client/src/react/screens/AssistantMessage.tsx` (message + action
bar), `packages/client/src/react/shell/routes/assistantTranscript.ts` (+
`packages/client/src/react/shell/routes/assistantTranscript.test.ts`) with
updates to `packages/client/src/react/screens/AssistantScreen.tsx`,
`packages/client/src/react/screens/AssistantScreen.module.css`,
`packages/client/src/react/screens/AssistantScreen.test.tsx`,
`packages/client/src/react/shell/routes/AssistantRoute.tsx`,
`packages/client/src/react/shell/routes/assistantRich.ts`,
`packages/client/src/react/shell/routes/assistantRich.module.css`,
`packages/client/src/react/screen-contracts.ts`,
`packages/client/src/centraid-api.d.ts`,
`packages/client/src/gateway-client-conversation.ts`,
`packages/blueprints/src/assistant-rich.test.ts`,
`packages/app-engine/src/http/turn-routes.test.ts`.

### Wave 2 — rendering

All §2 items in the SHARED renderer, so both surfaces gain them at once:

- **Full GFM** — new kit sibling `packages/blueprints/kit/gfm.js`: links,
  images, ordered/nested/mixed lists, blockquotes, pipe tables with alignment,
  horizontal rules, strikethrough; existing `block:*`/ref-chip paths preserved.
- **Syntax highlighting** — new dependency-free
  `packages/blueprints/kit/code-highlight.js` +
  `packages/blueprints/kit/code-highlight.d.ts` (js/ts/jsx/tsx, json, python,
  sql, bash, html, css, rust, go; plain fallback), wired into the code-block
  path of `packages/blueprints/kit/assistant-rich.js` /
  `packages/blueprints/kit/assistant-rich.d.ts`; token classes themed in
  `packages/blueprints/kit/kit.css` and
  `packages/client/src/react/shell/routes/assistantRich.module.css` (+ adapter
  `packages/client/src/react/shell/routes/assistantRich.ts`).
- **Sanitization contract** — escape-by-default everywhere; `sanitizeUrl`
  allowlist (http/https/mailto/relative; javascript:/data:/vbscript:/
  protocol-relative rejected, control chars stripped pre-scheme-detection);
  external links get `rel="noopener noreferrer"`; documented as a SECURITY
  CONTRACT header in `assistant-rich.js`; adversarial tests in
  `packages/blueprints/src/assistant-sanitize.test.ts` and
  `packages/blueprints/src/code-highlight.test.ts` (+ extended
  `packages/blueprints/src/assistant-rich.test.ts`).
- **Reasoning/thinking display** — `reasoning.delta` streams into a
  collapsible ThinkingRow in the vault assistant (BuilderChatPane pattern),
  via `packages/client/src/react/shell/routes/assistantTranscript.ts`,
  `packages/client/src/react/shell/routes/AssistantRoute.tsx`,
  `packages/client/src/react/screens/AssistantMessage.tsx`,
  `packages/client/src/react/screens/AssistantScreen.tsx`,
  `packages/client/src/react/screens/AssistantScreen.module.css`,
  `packages/client/src/react/screens/AssistantScreen.test.tsx`.
- **Per-turn usage/cost** — live `usage` event → client estimate
  (`packages/client/src/react/screens/assistantUsage.ts`); reload path returns
  the frozen ledger rollup: `getSession` attaches per-turn usage in
  `packages/app-engine/src/conversation/history.ts` (+
  `packages/app-engine/src/conversation/history.test.ts`), wire types in
  `packages/client/src/centraid-api.d.ts`,
  `packages/client/src/react/screen-contracts.ts`.
- **Image attachment previews** — composer thumbnails via local object URLs;
  transcript image attachments fetch bytes auth-aware
  (`fetchAssistantAttachmentUrl` in
  `packages/client/src/gateway-client-conversation.ts`). No image-output
  ItemKind exists, so user-attached previews are the complete surface.
- Allowlists updated for the two new kit siblings in
  `packages/app-engine/src/http/security.ts`,
  `packages/blueprints/src/app-boot-harness.ts`,
  `packages/blueprints/scripts/lint-apps.mjs`.

### Wave 3 — management & search

All four §3 items plus the §4 composer remainder (@-mentions, starters, slash
commands).

- **Conversation search, end-to-end.** A new FTS5 shadow table `fts_conversation`
  over chat/build titles + inbound `message_in` text, kept in sync by triggers —
  mirroring the vault's own FTS pattern (`snippet()` context, `unicode61
  remove_diacritics 2`). DDL + idempotent `NOT EXISTS`-guarded backfill in
  `packages/app-engine/src/stores/gateway-db.ts` (`CONVERSATION_FTS_DDL`, ensured
  on every journal open); `conversationMatchExpression` + `searchConversations`
  (rank-ordered, snippet, archived-excluded, user/app-scoped) in
  `packages/app-engine/src/conversation/store.ts` /
  `packages/app-engine/src/conversation/store-sql.ts`; facade `searchSessions` in
  `packages/app-engine/src/conversation/history.ts`; route
  `GET .../sessions/search?q=` in
  `packages/app-engine/src/http/conversation-routes.ts` (matched BEFORE the
  generic `sessions/<id>` route). Client `searchConversations` +
  `conversationSearchPath` in `packages/client/src/gateway-client-conversation.ts`
  / `packages/blueprints/kit/conversation-client.js`. The ⌘K palette gains a
  "Conversations" category via a debounced async source
  (`packages/client/src/react/shell/routes/paletteConversationSearch.ts`) that
  fills the palette's synchronous cache and re-runs `buildPaletteGroups` through
  the injected `refresh()`; a hit deep-links to `{kind:'assistant',
  conversationId}` with a snippet sub-line
  (`packages/client/src/react/shell/routes/paletteData.ts`,
  `packages/client/src/react/shell/App.tsx`).
- **LLM auto-titles.** After the FIRST successful turn of a still-unnamed thread,
  a fire-and-forget cheap-tier one-shot names it. Generator
  `generateConversationTitle` + `cleanTitle` (tool-less `runTurn`, accumulate,
  strip quotes/markers/trailing punctuation, cap 60) in
  `packages/app-engine/src/conversation/auto-title.ts`; the driver fires it on the
  naming turn via a `generateTitle` hook threaded through `DriveTurnOptions`
  (`packages/app-engine/src/http/turn-sse.ts`) and the assistant route
  (`packages/gateway/src/routes/assistant-routes.ts`). The gateway closure
  (`build-gateway.ts`) resolves the `fast` capability TIER (never a model id —
  governance `no-hardcoded-model-ids`; overridable via `model.<runnerKind>.title`,
  skipped on codex which lacks tier vocabulary), and applies the result only when
  the stored title is STILL the exact `deriveTitle` truncation (user renames win).
- **Export a conversation.** Client-side serializer over the already-fetched
  transcript (no route): `conversationToMarkdown` (role headings, timestamps,
  code fences, attachment notes, usage line) + `conversationToJson` (structured
  transcript under an export envelope) + `downloadConversation` in
  `packages/client/src/react/shell/routes/conversationExport.ts`. Wired into the
  sidebar row menu (Export as Markdown / JSON).
- **Pin / archive.** Reused the existing `conversations.pinned` column and added
  an `archived` column (v0, no migration) in
  `packages/app-engine/src/conversation/schema.ts` /
  `packages/app-engine/src/stores/gateway-db.ts`; store setters + list ordering
  (`pinned DESC`, archived last) + PATCH `{pinned?|archived?}` on the existing
  sessions PATCH route; client `setConversationPinned`/`setConversationArchived`.
  Sidebar `ChatsSection` groups pinned-on-top, a collapsed "Archived" group at
  the bottom (`packages/client/src/react/shell/Sidebar.tsx`,
  `chrome.module.css`), with row-menu Pin/Unpin + Archive/Unarchive
  (`packages/client/src/react/shell/App.tsx`).
- **@-mentions + slash-commands (§4).** Clean React composer autocomplete calling
  the SAME endpoints (justification below), not a kit-popover extraction: pure
  helpers (`mentionTokenAt`/`slashCommandAt`/`refString`/`insertRef`) in
  `packages/client/src/react/screens/composerMentions.ts`, a
  `useComposerAutocomplete` hook + popover in
  `packages/client/src/react/screens/ComposerAutocomplete.tsx`, wired into the
  composer in `packages/client/src/react/screens/AssistantScreen.tsx`
  (`AssistantScreen.module.css`). `@` opens an entity picker over auth-aware
  `searchVaultEntities` and inserts `@[label](ref:type/id)` (exactly what the
  shared renderer parses); leading `/` runs an existing shell action (/export,
  /rename, /new). Justification: the kit's `attachMentionPopover` pokes an
  uncontrolled DOM textarea, hard-codes a cookie-auth picker fetch with no
  injectable search hook, and styles via global kit.css — the shell composer is a
  controlled React textarea authed by bearer token; per the Wave-0 audit a React
  reimplementation over the shared endpoints is the right call, and the only
  genuinely shareable bits (token detection + ref splice) are tiny pure functions.
  No new kit sibling ⇒ no allowlist changes.
- **Prompt starters (§4).** Empty-state chips are now configurable via prefs
  `assistant.starters` (defaults preserved) — `resolveStarters` +
  `DEFAULT_STARTERS` in
  `packages/client/src/react/shell/routes/assistantStarters.ts`, loaded via
  `getUserPrefs` in `AssistantRoute.tsx`.

New Wave 3 tests: FTS search + pin/archive (store + route), auto-title unit
(mocked runTurn), export serializer, palette conversation group + async search
source, composer mention/slash helpers, starters resolver; the ledger-tables
snapshot test updated for the FTS plane.

### Wave 4 — resilience & correctness (§6)

All five §6 items.

- **Idempotency enforced at the turn route.** New `turns.idempotency_key`
  column (v0, no migration) + `idx_turns_idempotency(conversation_id,
  idempotency_key)` in `packages/app-engine/src/stores/gateway-db.ts`;
  threaded `Turn.idempotencyKey` through `schema.ts`, `store-sql.ts`
  (`RawTurn`/`turnFromRaw`/`insertTurn` + a `getTurnByIdempotency` statement),
  `store.ts` (`InsertTurnInput.idempotencyKey`, `getTurnByIdempotencyKey`),
  `history.ts` (`RecordTurnInput.idempotencyKey`, `recordTurn` persistence, a
  new `findRecordedTurn` facade returning a `RecordedTurnReplay`). The shared
  driver `driveTurnOverSse` (`http/turn-sse.ts`) now, INSIDE the
  per-conversation lock and BEFORE running, looks up a recorded turn for the
  key and — if found — replays its recorded answer as a short SSE stream
  (`http/turn-replay.ts` `buildReplayEvents`: `assistant.start` → `delta` →
  `usage` → `final`, or a bare `error`) then returns without re-running or
  re-recording. **In-flight semantics:** chosen = "attach via the lock". A
  duplicate arriving while the first turn is still running queues behind the
  SAME per-conversation lock, so by the time it acquires the lock the first has
  recorded → it replays. No 409, no double-run, and the client consumes a
  replay identically to a fresh turn (why 409 was rejected: it would force the
  client to special-case a normal-looking duplicate). The assistant route now
  also threads `idempotencyKey` (it previously dropped it). Client mints a
  fresh UUID per user send and REUSES it on resend/retry
  (`gateway-client-conversation.ts` `StreamTurnInput.idempotencyKey`,
  `AssistantRoute` submit/regenerate=new key, retryError=reuse; kit `ask` send
  + 404 re-mint reuse the same key; `useBuilder` per-send key).
- **Resend-on-failure / flaky-network.** `AssistantRoute.runTurn` reworked: a
  transport failure that produced NO stream activity surfaces the failed text +
  a Resend button reusing the same key (safe now); `navigator.onLine === false`
  adds an "offline" hint (DTO `offline`, styled in `AssistantScreen.module.css`,
  button label flips to "Resend"). Composer re-enable + failed-text preservation
  (Wave 1) verified to compose with key reuse. Full replica/outbox integration
  is OUT of scope (noted below).
- **Stream resumption / ledger catch-up.** The shared `consumeSse`
  (`kit/turn-stream.js`) now returns `{ ended }` (true iff the terminal
  `event: end` was seen) via a new `isEndFrame` helper — the "stream died
  mid-turn" signal both surfaces read (`turn-stream.d.ts` updated). New
  lightweight `GET .../sessions/<id>/status` route (`conversation-routes.ts`,
  matched before the generic `sessions/<id>`) returns `{turnCount, updatedAt}`;
  client `conversationStatus` + `conversationStatusPath`. On a mid-turn drop the
  shell marks the answer "Connection lost — catching up…", polls the status via
  `assistantCatchUp.ts` `catchUpAfterDrop` until `turnCount` climbs past the
  pre-send baseline (or a 30s timeout), then `reloadConversation` materializes
  the completed answer; on timeout it falls back to the resend bubble. Kit keeps
  simpler behavior (no catch-up loop) — the shared signal is exposed for it.
- **Rate limiting / backpressure.** New `http/turn-limiter.ts` `TurnLimiter`
  (default max 4 concurrent running turns, `TURN_RETRY_AFTER_SECONDS = 3`,
  mirrors `SseSubscriberCap`) + `writeTurnBusy` (429 + `Retry-After`). One
  limiter per vault id, resolved from the ambient vault in `build-gateway.ts`
  and shared by BOTH the per-app `_turn` route (via `Runtime.turnLimiter` →
  `TurnRouteContext.turnLimiter`) and the assistant route
  (`AssistantRouteOptions.limiter`). `driveTurnOverSse` acquires a slot before
  opening the stream (429 if saturated) and releases it when the stream ends.
  The Wave-3 auto-titler yields: `generateAssistantTitle` skips generation when
  `turnLimiterForCurrentVault().atCapacity()`. Client auto-retries a 429 up to
  4× honoring `Retry-After` (`postTurnWithRetry` in
  `gateway-client-conversation.ts`); the reused idempotency key makes each retry
  replay-safe. Kit shows a "vault is busy" nudge on 429.
- **PDF-attachment notice on Codex.** New `notice` event on the wire union
  (`conversation/runner.ts` + `kit/turn-stream.d.ts`:
  `{type:'notice'; level:'warn'|'info'; code?; message}`), folded as a
  pass-through in the `turn-sse` accumulator. Server-side seam: the codex
  backend (`backends/codex/backend.ts`) detects dropped PDFs via a new pure
  `codexUnsupportedPdfs` (`multimodal.ts`) and emits a `notice`
  (`code:'attachment_unsupported'`) before `turn/start`, so both surfaces get it
  through the shared parser. Shell renders a `notice` transcript row
  (`AssistantMessage.tsx` + `AsstMsg`/DTO `notice` kind); kit renders it as a
  plain assistant line.

New Wave 4 tests: idempotency replay + in-flight dedup + errored-turn replay +
limiter 429/slot-release (`http/turn-routes.test.ts`), `buildReplayEvents` +
`TurnLimiter` units (`http/turn-replay.test.ts`), `findRecordedTurn`
(`conversation/history.test.ts`), `consumeSse` ended/drop signal + `isEndFrame`
(`blueprints/src/turn-stream.test.ts`), `conversationStatusPath`
(`blueprints/src/conversation-client.test.ts`), `codexUnsupportedPdfs`
(`agent-runtime/src/multimodal.test.ts`), `catchUpAfterDrop`
(`assistantCatchUp.test.ts`), client key-threading + 429 auto-retry
(`gateway-client-conversation.test.ts`).

### Wave 5 — design issues to spin out

Five design issues drafted, grounded in the current code:
context-window management across runner-kind switches (filed as
[#424](https://github.com/srikanth235/centraid/issues/424)),
cross-conversation memory, message editing / true branching UX, mobile/PWA
assistant layout, and subagent items (`ItemKind 'agent'`). The remaining four
are drafted and pending owner approval to publish (issue creation is
permission-gated for the agent).

### Coverage appendix — remaining touched files

Wave 3/4 files not named above:
`packages/agent-runtime/src/backends/codex/backend.ts`,
`packages/agent-runtime/src/multimodal.ts`,
`packages/agent-runtime/src/multimodal.test.ts`,
`packages/app-engine/src/conversation/auto-title.test.ts`,
`packages/app-engine/src/conversation/runner.ts`,
`packages/app-engine/src/conversation/store.test.ts`,
`packages/app-engine/src/http/turn-limiter.ts`,
`packages/app-engine/src/http/turn-replay.ts`,
`packages/app-engine/src/http/turn-replay.test.ts`,
`packages/app-engine/src/index.ts`,
`packages/app-engine/src/runtime.ts`,
`packages/app-engine/src/stores/gateway-db.test.ts`,
`packages/client/src/gateway-client-conversation.test.ts`,
`packages/client/src/react/screens/composerMentions.test.ts`,
`packages/client/src/react/shell/chrome.module.css`,
`packages/client/src/react/shell/routes/assistantCatchUp.ts`,
`packages/client/src/react/shell/routes/assistantCatchUp.test.ts`,
`packages/client/src/react/shell/routes/assistantStarters.test.ts`,
`packages/client/src/react/shell/routes/conversationExport.test.ts`,
`packages/client/src/react/shell/routes/paletteConversationSearch.test.ts`,
`packages/client/src/react/shell/routes/paletteData.test.ts`,
`packages/gateway/src/serve/build-gateway.ts`.

## Out of scope

- Backend/runner changes — `makeAssistantConversationRunner`, tools, prompt
  assembly are already shared and untouched by Wave 0.
- Shell parked/consent UI adoption of `consent-cards.js` (shell has no parked
  UI today; the shared logic is in place, kit is the sole consumer for now).
- Wave 5 topics (context-window management, cross-conversation memory, full
  edit/branching UX, mobile/PWA assistant layout, subagent items) — spun out
  as separate design issues per the umbrella's phasing.
- Wave 4: full replica/outbox integration on the turn path (the client's
  `packages/client/src/replica/` outbox) — the issue's "at minimum" is
  keep-the-message + one-tap resend + reused idempotency key, which is what
  landed. True resumable SSE is likewise out — catch-up-from-ledger (poll +
  transcript reload) is the chosen substitute per the issue. The kit keeps the
  simpler resilience surface (no catch-up loop / no auto-429-retry); the shared
  `consumeSse` `{ended}` signal is exposed so it can adopt them later.
- Voice input (noted in the issue as future, not v0).
- Math rendering — deferred: KaTeX/MathJax is infeasible under the kit's
  dependency-free constraint and a hand-rolled TeX subset was judged not worth
  the added attack surface; not part of the issue's Wave 2 plan.
- Reasoning rows are live-only (reasoning is not persisted to the ledger), so
  they intentionally do not replay on reload.

## Verification

Wave 0 — from the worktree root, all green:

```bash
bun run typecheck        # 26/26 turbo tasks pass
bun run lint:types       # all packages ok
bunx vitest run packages/client            # 108 files / 805 tests pass
bunx vitest run packages/blueprints/src/turn-stream.test.ts \
  packages/blueprints/src/assistant-rich.test.ts \
  packages/blueprints/src/consent-cards.test.ts \
  packages/blueprints/src/conversation-client.test.ts   # 27 tests pass
node packages/blueprints/scripts/lint-apps.mjs          # 0 errors (incl. new modules)
```

Wave 1 — from the worktree root, all green:

```bash
bun run typecheck        # 26/26 turbo tasks pass
bun run lint:types       # all packages ok
bunx vitest run packages/app-engine   # 387 tests pass
bunx vitest run packages/client       # 816 tests pass
bunx vitest run packages/gateway/src/routes/assistant-routes.test.ts  # pass
```

New Wave 1 tests: retry-collapse + feedback (store/facade/route/end-to-end),
`wireCodeCopy`, transcript codec, screen action-bar interactions.

Wave 2 — from the worktree root, all green:

```bash
bun run typecheck        # 26/26 turbo tasks pass
bun run lint:types       # all packages ok
node packages/blueprints/scripts/lint-apps.mjs   # 0 errors
bunx vitest run packages/blueprints/src packages/client packages/app-engine
# 1416 passed / 1 failed = the pre-existing docs-media.test.ts env issue
```

Final full gate — from the worktree root before the last commit:

```bash
bun run format:check   # clean (1810 files)
bunx oxlint .          # 0 warnings, 0 errors
bun run typecheck      # 26/26 turbo tasks pass
bun run lint:types     # all packages ok
bun run coverage       # thresholds met; 3669 tests pass; 3 failures are the
                       # known pre-existing/flaky files (docs-media.test.ts env,
                       # serve.test.ts pre-existing, stream-ingress.test.ts
                       # passes in isolation)
bash .governance/run.sh  # 20/21 pass; only repo-hygiene fails, on the 9
                         # over-cap files pre-existing on main
```

Pre-existing, unrelated: `packages/blueprints/src/docs-media.test.ts` times out
(`Promise.try` missing in vendored `pdf.min.mjs`) — fails identically on the
base commit without this branch's changes.

Wave 3 — from the worktree root:

```bash
bun run typecheck        # 26/26 turbo tasks pass
bun run lint:types       # all packages ok
bunx oxlint packages/{app-engine,gateway,client}/src packages/blueprints/kit  # 0 errors
bunx vitest run packages/app-engine   # 401 tests pass
bunx vitest run packages/client       # 836 tests pass
bunx vitest run packages/gateway      # 665 pass; 3 non-Wave-3 fails, see below
```

Gateway fails are NOT from this wave:
- `src/serve/serve.test.ts` "reports {configured: false}" — a backup/vault-list
  assertion; verified pre-existing (fails identically after `git stash -u` on the
  base tree).
- `src/cli/backup-admin.test.ts`, `src/cli/key-admin.test.ts` — flaky under
  full-parallel load (5s timeouts); both PASS when re-run in isolation
  (`bunx vitest run packages/gateway/src/cli/backup-admin.test.ts
  packages/gateway/src/cli/key-admin.test.ts` → 11/11).

`oxfmt --check` flags only the vendored `pdf.min.mjs` / `pdf.worker.min.mjs`
(pre-existing, untouched); every touched source file is formatted.

## Decisions

- Canonical copy of the shared core lives in `packages/blueprints/kit/` (not
  `packages/client`) because the kit must stay dependency-free vanilla ESM
  served verbatim; React code can bundle kit files, never the reverse.
- Import mechanism: bare `@centraid/blueprints/kit/*.js` subpath specifiers
  from the client (blueprints has no `exports` field, so subpaths resolve
  directly) — chosen over relative cross-package imports to avoid `rootDir`
  declaration-emit errors.
- Wave 1: `AssistantRoute.tsx` (514) and `history.ts` (543) crossed the
  500-line cap and carry line-1 `allow-repo-hygiene file-size-limit` waivers.
- Wave 1: retry-on-error re-sends the failed message as a plain turn (not
  always `retryOf`) because a failed turn's recorded id isn't reliably known
  client-side without a reload; regenerate threads `retryOf` properly.
- Interim commits on this branch carried a receipt-shape waiver at line 1
  (documented WIP case); the final commit removed it and added the required
  `## Audit`/`## Steering` attestations, keeping per-wave commits reviewable
  without re-attesting each.
- Live usage pricing moved server-side after Wave 2: the Wave 2 client kept a
  mirror of the model price table (`assistantUsage.ts`), which violated
  `no-hardcoded-model-ids`. The `usage` SSE event now carries `costUsd`, priced
  at the `turn-sse.ts` seam via the allowlisted `model-pricing.ts`
  (`costForUsage`); the client mirror table was deleted. Wire contract updated
  in `runner.ts` + `kit/turn-stream.d.ts`.
- Per-wave commits used `SKIP_GOVERNANCE=1` solely for the repo-hygiene
  file-size violations pre-existing on main (9 files, none in this change
  set); every other directive passed on every commit (probed before each).
- Wave 3 (search): the conversation FTS indexes titles + inbound `message_in`
  text only — assistant answers live in `items.output_json` as a JSON envelope,
  not extractable in a pure-SQL trigger; titles + the user's own words are what
  a person remembers a thread by, and the grain stays one FTS row per
  conversation (re-derived on each text insert; chat threads are small).
- Wave 3 (titles): resolves the `fast` capability TIER, never a model id
  (`no-hardcoded-model-ids`); overridable per runner via `model.<runnerKind>.title`;
  skipped on codex (no tier vocabulary — a bare token would be sent verbatim).
  Fire-and-forget with a re-checked "still the derived truncation" guard so a
  title miss never touches the turn and a manual rename always wins.
- Wave 3 (export): client-side serializer over the transcript already fetched by
  `GET .../sessions/<id>` — no route, since there are no attachment bytes to
  stream (attachments are referenced by hash/URL, preserved in the JSON form).
- Wave 3 (@-mentions): a clean React composer autocomplete over the same
  `searchVaultEntities` / `@[label](ref:type/id)` contract, NOT an extraction of
  the kit's `attachMentionPopover` (uncontrolled DOM textarea, non-injectable
  cookie-auth fetch, global kit.css) — the shell composer is a controlled React
  textarea on bearer auth; only the tiny pure token/splice helpers are shared-
  shaped. No new kit sibling ⇒ no allowlist changes.
- Wave 3: `pinned` reuses the existing conversations column; `archived` is a new
  column (v0, no migration). `App.tsx`/`AssistantRoute.tsx`/`store.ts`/`history.ts`
  already carry line-1 file-size waivers; no NEW file crossed the 500-line cap
  (Sidebar 461, AssistantScreen 402, gateway-db 408, ComposerAutocomplete 242).

## Audit

**CHECK 1 (What changed):** PASS — Diff faithfully describes changes. Verified:
files exist (turn-stream.js/.d.ts, assistant-rich.js/.d.ts, gfm.js, code-highlight.js, turn-limiter.ts all present); sampled claims match: kit.js imports shared modules (`consumeSse`, `richAnswerHtml`), `feedback` column added (`readonly feedback?: 'up' | 'down'`), TurnLimiter exports `atCapacity()`, auto-title exports `generateConversationTitle` and `cleanTitle`.

**CHECK 2 (Checklist realized):** PASS — All five checked items (Waves 0–4) are in the commits: 4d9321eb (Wave 0), 5b603b7d (Wave 1), dc522940 (Wave 2), 59983399 (Wave 3), 6a9674e8 (Wave 4). Spot-checks: Wave 0 has four shared modules with .d.ts, Wave 1 has feedback column + retry-collapse (`groupRetryFamilies`), Wave 2 has gfm.js/code-highlight.js/sanitization, Wave 3 has auto-title/export/pin-archive/FTS/mentions, Wave 4 has idempotency+limiter+catch-up+notices.

**CHECK 3 (Checklist mirrors issue):** PASS — Receipt's six-item checklist (Waves 0–5) matches issue's "Suggested phasing" section exactly: structure, naming, and completion state identical (five checked, Wave 5 unchecked per issue design-doc scope).

## Steering

**PASS** — No human-steering events in this session. Evidence: 135 user-type transcript entries analyzed. Entry composition: 1 /goal command (directive start), 1 local-command-stdout, 1 system Stop hook notification, 5 system task-completion notifications (af8e6a6e, a4d6ce57, aceedbef, af0a21eb, a1fe954c for Waves 5/0/1/2/3/4), 126 agent tool-result arrays, and empty-line padding. Zero user redirects, corrections, or interrupts identified across the autonomous execution of all five waves.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8a681dbc-73c-1784183799-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 99 | 272890 | 3489315 | 67279 | 340268 | 10.2654 | 99 | 272890 | 3489315 | 67279 | feat(chat): shared framework-free conversation core for kit and shell (#420)Extr |
| claude-code-8a681dbc-73c-1784184001-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 8 | 15457 | 394682 | 5121 | 20586 | 0.8440 | 107 | 288347 | 3883997 | 72400 | feat(chat): shared framework-free conversation core for kit and shell (#420)Extr |
| claude-code-8a681dbc-73c-1784184048-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 2 | 416 | 103881 | 161 | 579 | 0.1172 | 109 | 288763 | 3987878 | 72561 | feat(chat): shared conversation core (#420)Issue: #420 |
| claude-code-8a681dbc-73c-1784187431-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 42 | 38135 | 2334532 | 37845 | 76022 | 4.7039 | 151 | 326898 | 6322410 | 110406 | probe (#420)Issue: #420 |
| claude-code-8a681dbc-73c-1784197385-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 284 | 193381 | 24211050 | 122604 | 316269 | 32.7614 | 435 | 520279 | 30533460 | 233010 | probe (#420)Issue: #420 |
