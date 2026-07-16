<!-- governance: allow-receipt-per-issue incremental multi-wave receipt for the #420 umbrella; shape + Audit completed on the final commit of this branch -->
# issue-420 — chat assistant enhancement backlog: shared core + waves 1–4

GitHub issue: [#420](https://github.com/srikanth235/centraid/issues/420)

## Checklist

Issue #420's suggested phasing, each wave discharged by the named subsection in
**What changed** and the evidence in **Verification**.

- [x] **Wave 0 — shared conversation core**
- [x] **Wave 1 — transcript table stakes**
- [x] **Wave 2 — rendering**
- [ ] **Wave 3 — management & search**
- [ ] **Wave 4 — resilience**
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

## Out of scope

- Backend/runner changes — `makeAssistantConversationRunner`, tools, prompt
  assembly are already shared and untouched by Wave 0.
- Shell parked/consent UI adoption of `consent-cards.js` (shell has no parked
  UI today; the shared logic is in place, kit is the sole consumer for now).
- Wave 5 topics (context-window management, cross-conversation memory, full
  edit/branching UX, mobile/PWA assistant layout, subagent items) — spun out
  as separate design issues per the umbrella's phasing.
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

Pre-existing, unrelated: `packages/blueprints/src/docs-media.test.ts` times out
(`Promise.try` missing in vendored `pdf.min.mjs`) — fails identically on the
base commit without this branch's changes.

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
- Interim commits on this branch carry the receipt-shape waiver at line 1; the
  final commit removes it and adds the required `## Audit`/`## Steering`
  attestations, keeping per-wave commits reviewable without re-attesting each.

## Steering

**PASS** — No human-steering events in this session. Evidence: 33 user-type transcript entries analyzed. Entry composition: 1 /goal command (directive), 2 system hook/command messages, 28 agent tool results, 2 task-completion notifications (all system-emitted). Zero user redirects, corrections, or interrupts identified.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8a681dbc-73c-1784183799-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 99 | 272890 | 3489315 | 67279 | 340268 | 10.2654 | 99 | 272890 | 3489315 | 67279 | feat(chat): shared framework-free conversation core for kit and shell (#420)Extr |
| claude-code-8a681dbc-73c-1784184001-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 8 | 15457 | 394682 | 5121 | 20586 | 0.8440 | 107 | 288347 | 3883997 | 72400 | feat(chat): shared framework-free conversation core for kit and shell (#420)Extr |
| claude-code-8a681dbc-73c-1784184048-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 2 | 416 | 103881 | 161 | 579 | 0.1172 | 109 | 288763 | 3987878 | 72561 | feat(chat): shared conversation core (#420)Issue: #420 |
| claude-code-8a681dbc-73c-1784187431-1 | claude-code | 8a681dbc-73cf-4589-8a6f-6e5b9bf2f6ed | #420 | claude-fable-5 | 42 | 38135 | 2334532 | 37845 | 76022 | 4.7039 | 151 | 326898 | 6322410 | 110406 | probe (#420)Issue: #420 |
