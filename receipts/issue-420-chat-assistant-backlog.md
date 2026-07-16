<!-- governance: allow-receipt-per-issue incremental multi-wave receipt for the #420 umbrella; shape + Audit completed on the final commit of this branch -->
# issue-420 — chat assistant enhancement backlog: shared core + waves 1–4

GitHub issue: [#420](https://github.com/srikanth235/centraid/issues/420)

## Checklist

Issue #420's suggested phasing, each wave discharged by the named subsection in
**What changed** and the evidence in **Verification**.

- [x] **Wave 0 — shared conversation core**
- [ ] **Wave 1 — transcript table stakes**
- [ ] **Wave 2 — rendering**
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

## Out of scope

- Backend/runner changes — `makeAssistantConversationRunner`, tools, prompt
  assembly are already shared and untouched by Wave 0.
- Shell parked/consent UI adoption of `consent-cards.js` (shell has no parked
  UI today; the shared logic is in place, kit is the sole consumer for now).
- Wave 5 topics (context-window management, cross-conversation memory, full
  edit/branching UX, mobile/PWA assistant layout, subagent items) — spun out
  as separate design issues per the umbrella's phasing.
- Voice input, math rendering (noted in the issue as future, not v0).

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
