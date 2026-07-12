# issue-387 — automations revamp wave 1: instructions-first editor, thread-per-automation surface, consent in the config loop

GitHub issue: [#387](https://github.com/srikanth235/centraid/issues/387)

Re-founds the automations UI on the owner-approved redesign (2026-07-12):
the automation is a conversation (fires are runs in its thread), the owner's
Instructions are the source of intent (the builder compiles them into
`handler.js`), and consent is configured at edit time + reviewed in-thread —
never a runtime dialog. Both codex and claude-code stay supported runtimes.
Wave 1 = the UI plus the gateway seams it needs; the ledger-level
conversation-per-automation schema change and trigger unification (triggers
as vault cursors, webhook/API as ingress rows) are later waves.

## Checklist

- [x] Automation update endpoint
- [x] In-flight runs in the ref-scoped feed
- [x] Headless claude turns
- [x] Instructions-first automation editor
- [x] Automation thread screen
- [x] Fleet overview
- [x] Templates and entry-point rewiring
- [x] Automations dead-code sweep
- [x] Automation e2e flows rewritten
- [x] Cross-surface flows re-verified

## What changed

### Gateway

#### Automation update endpoint

- `packages/gateway/src/routes/lifecycle-automation-routes.ts`:
  `handleAutomationUpdate` — `POST /centraid/_automations/update?ref=` body
  `{name?, prompt?, triggers?, sessionId?, publish?}` → `{row, staged,
  webhook?}`. Loads the manifest, applies only present fields, validates via
  the same `validateManifest` as create, stages via `stageAndMaybePublish`.
  Triggers are a full replacement; re-declaring an existing webhook reuses
  its `secretHash` verbatim (rotation stays `rotate-webhook`'s job); adding
  a webhook where none existed mints id+secret once. Renames propagate with
  no special casing — `publishAndReconcile` already re-runs
  `enrollAutomationAgent(appId, name)` (build-gateway.ts) and
  `ensureAgentEnrolled` self-heals `core_party.display_name`.
  Registered in `lifecycle-routes.ts`. 10 new tests in
  `lifecycle-automation-routes.test.ts`.
#### In-flight runs in the ref-scoped feed

- `packages/gateway/src/routes/automations-routes.ts`: `runs?ref=` merges
  IN-FLIGHT turns (via `ConversationStore.listAutomationTurns`, `endedAt`
  undefined) ahead of the `run_summary`-derived rows — the view is
  finished-only (`WHERE t.ended_at IS NOT NULL`), and the new thread screen
  stays put on "Run now" instead of jumping into the SSE run viewer, so a
  slow fire was invisible. Ref-scoped only; the global feed is unchanged.
  Test added in `automations-routes.test.ts`.

### Agent runtime

#### Headless claude turns

- `packages/agent-runtime/src/runtime.ts`: claude chat/builder turns pass
  `permissionMode: 'bypassPermissions'`. Gateway turns are headless — no
  approval UI is wired to SDK permission prompts, so the SDK default
  deadlocked the first builder file write (the agent ended its turn with
  "I need permission to write handler.js"). Codex parity: `runCodexTurn`
  pins `approvalPolicy:'never'` + `sandbox:'workspace-write'`, and the
  pre-SDK spawn was `claude -p --permission-mode bypassPermissions`.
  Centraid's own consent layer (vault grants, outbox) is the gate that
  matters. Latent until now because codex was the default runner.

### Renderer (apps/desktop/src/renderer)

- Routing: `automation-editor` route kind (`app-shell-context.ts`,
  `router.ts`, `App.tsx`); `automation-builder` gained `seedMessage?`
  (consumed in `BuilderRoute.tsx` as `initialPrompt`).
#### Instructions-first automation editor

- `react/screens/AutomationEditorScreen.tsx` (+ css/test, new):
  instructions-first form — Name, Instructions (the hero, maps to manifest
  `prompt`), single-trigger picker (Schedule w/ cron next-runs preview,
  Webhook, Condition, Data; multi-trigger rows warn and defer to the
  builder), tabs: Connectors (manifest requires/connector/vault scopes),
  Behavior (enabled switch, standing grants with revoke, park-vs-grant
  explainer), Notifications (`onFailure`, model). Create → `createAutomation`
  then hands off to the builder seeded with a FRAMED compile work order
  ("Compile this automation now: …") — raw instructions pasted as chat read
  as conversation and the agent sometimes discussed instead of writing.
  Edit → `updateAutomation`; changed instructions surface "Recompile plan".
  Route wrapper `AutomationEditorRoute.tsx` + `automationEditorData.ts`.
#### Automation thread screen

- `react/screens/AutomationThreadScreen.tsx` (+ css/test, new; replaces
  AutomationViewScreen at `automation-view`): header (identity hue/glyph,
  status pill, `role="switch"` enable, Run now/Edit/Delete, mono trigger
  chips, webhook copy/rotate), amber consent strip (parked + outbox cards,
  "Always allow" grant mint, standing-grants `<details>` with revoke),
  date-grouped run spine oldest→newest (status dots, running pulse, click →
  run-view), composer → builder chat with `seedMessage`. Bounded 2s polling
  while the latest run is live, plus an `awaitingRun` window after Run now
  (the 202 races the ledger row). Consent actor matching is a documented
  soft match on the enrolled agent's display name (`automationThreadData.ts`).
#### Fleet overview

- `react/screens/AutomationsOverviewScreen.tsx` rebuilt as the fleet:
  hairline rows (identity glyph, `data-au-status` pill, mono trigger chip,
  last-run dot + relative time, next-fire, amber attention badge fed by the
  same consent matcher), RECENT ACTIVITY register, empty state.
#### Templates and entry-point rewiring

- Templates: calmer cards with per-trigger-kind hue accents; adopt resolves
  the fresh clone's `ref` (the `_clone` response only carries the bare id)
  and lands on the thread — `TemplatesRoute.tsx` + `DiscoverRoute.tsx`;
  "Start from scratch" and Home's context-menu Edit open the editor.
#### Automations dead-code sweep

- Dead code: `scaffoldAutomationDraft`, `buildAutomationViewData` +
  `AutomationViewData`/`AuViewRunDTO`/`AuViewWebhookSecretDTO`/
  `AutomationViewBridgeProps` removed; hero derivation lives on as
  `deriveAutomationHero` (tests retargeted).

### e2e-live

#### Automation e2e flows rewritten

- flows-automations-01..06 rewritten to the new selector contract (ARIA
  first: named buttons, `role="switch"`, `data-au-status`/`data-run-status`/
  `data-trigger-kind`); flow-05 renames through the real editor Save path;
  flow-03 adds an in-thread consent-strip assertion; flow-06 goes through
  the editor create → framed-seed compile → publish → run-now (goal-marker
  verified) and pins `agent.runner.kind=claude-code` for the vault (this
  machine's npm-global codex launcher is broken — vendor binary missing).
  smoke.mjs template counts updated post-#383 (24 = 8 apps + 16
  automations). A narrowly-scoped `isKnownBenignConsoleError` excludes the
  pre-existing Chromium `clipboard-read/write` permissions-policy noise
  (reproduces with no Locker mounted) in the suites that assert console
  cleanliness, including flows-approvals-02.

## Verification

#### Cross-surface flows re-verified

- Real rig (Playwright `_electron`, real gateway + dev vault):
  flows-automations-01..06 PASS; flows-approvals-01/02, flows-insights-01,
  flows-verify-approvals-identity, flows-shell-01-nav-chrome, flows-ask-02
  PASS; smoke PASS. Visual probe screenshots reviewed for every new screen.

Re-run it:

```sh
bun install && bun run build
bunx vitest run packages/gateway/src/routes/lifecycle-automation-routes.test.ts \
  packages/gateway/src/routes/automations-routes.test.ts
(cd apps/desktop && bunx vitest run)
node apps/desktop/tests/e2e-live/smoke.mjs
for f in 01-lifecycle 02-triggers 03-corners 04-trigger-fires 05-grants-rename 06-builder-to-run; do
  node "apps/desktop/tests/e2e-live/flows-automations-$f.mjs"
done
```
- Unit: desktop 885+ tests green; gateway suite (141+ incl. 11 new) green;
  agent-runtime 79 green. Typecheck green; oxlint/oxfmt clean on touched
  files (pre-existing failures elsewhere untouched).

## Decisions

- **Thread is a UI aggregation for now.** Conversation-per-automation at the
  ledger level (fires as runs of ONE conversation, reply-in-thread as an
  interactive turn) is the approved end-state but a later wave; the thread
  screen renders per-fire conversations as one timeline and its composer
  hands off to the builder chat.
- **Editor is single-trigger v1** (full trigger-array replacement on save;
  multi-trigger rows warn and defer to the builder chat).
- **The compile seed is a framed work order**, not raw instructions-as-chat —
  the instructions are already the manifest `prompt`; the seed asks the
  builder to write the plan, which de-flakes the compile turn.
- **Adopt lands on the thread everywhere** (Templates + Discover); the clone
  helper resolves the fresh row's `ref` by re-listing (`_clone` returns only
  the bare id) and falls back to the fleet if unresolved.
- **In-flight run visibility is ref-scoped** — the global feed keeps the
  finished-only `run_summary` semantics.
- **claude-code turns get codex's trust posture** (`bypassPermissions` ≙
  `approvalPolicy:'never'` + workspace-write): the SDK permission layer is
  not Centraid's consent surface; vault grants/outbox are.

## Out of scope

- Ledger-level conversation-per-automation schema change; reply-in-thread as
  a real interactive turn on the automation's own conversation.
- Trigger unification ("every trigger is a vault cursor"; webhook/API as
  vault-ingress rows; cron catch-up semantics).
- claude-code automation-fire hang on the first `ctx.tool` batch (latent
  mock-host path — codex fails fast, claude hangs silently; spun off, plus a
  fire-spine watchdog so a hung host records a failed run).
- Exact consent actor matching via a renderer `listAgents()` client (server
  route exists); wave 1 soft-matches on the enrolled agent's display name.
- Editor multi-trigger authoring; structured `where` editing for condition
  triggers (existing clause preserved on save).

## Files

New:

- `apps/desktop/src/renderer/react/screens/AutomationEditorScreen.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationEditorScreen.module.css`
- `apps/desktop/src/renderer/react/screens/AutomationEditorScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationThreadScreen.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationThreadScreen.module.css`
- `apps/desktop/src/renderer/react/screens/AutomationThreadScreen.test.tsx`
- `apps/desktop/src/renderer/react/shell/routes/AutomationEditorRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/automationEditorData.ts`
- `apps/desktop/src/renderer/react/shell/routes/automationThreadData.ts`
- `apps/desktop/src/renderer/react/shell/routes/automationThreadData.test.ts`
- `apps/desktop/tests/e2e-live/probe-revamp.mjs`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `receipts/issue-387-automations-ui-revamp.md` (this receipt)

Modified:

- `apps/desktop/src/renderer/app-shell-context.ts`
- `apps/desktop/src/renderer/gateway-client-editing.ts`
- `apps/desktop/src/renderer/react/screen-contracts.ts`
- `apps/desktop/src/renderer/react/screens/AutomationTemplatesScreen.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationTemplatesScreen.module.css`
- `apps/desktop/src/renderer/react/screens/AutomationsOverviewScreen.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationsOverviewScreen.module.css`
- `apps/desktop/src/renderer/react/screens/AutomationsOverviewScreen.test.tsx`
- `apps/desktop/src/renderer/react/screens/DiscoverScreen.tsx`
- `apps/desktop/src/renderer/react/shell/App.tsx`
- `apps/desktop/src/renderer/react/shell/router.ts`
- `apps/desktop/src/renderer/react/shell/router.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/AutomationViewRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/AutomationsRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/BuilderRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/DiscoverRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/HomeRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/TemplatesRoute.tsx`
- `apps/desktop/src/renderer/react/shell/routes/automationsData.ts`
- `apps/desktop/src/renderer/react/shell/routes/automationsData.test.ts`
- `apps/desktop/src/renderer/react/shell/routes/templatesData.ts`
- `apps/desktop/tests/e2e-live/flows-approvals-02-corner-cases.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-01-lifecycle.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-02-triggers.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-03-corners.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-04-trigger-fires.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-05-grants-rename.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs`
- `apps/desktop/tests/e2e-live/smoke.mjs`
- `packages/agent-runtime/src/backends/claude/backend.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/routes/lifecycle-routes.ts`

Deleted:

- `apps/desktop/src/renderer/react/screens/AutomationViewScreen.tsx`
- `apps/desktop/src/renderer/react/screens/AutomationViewScreen.module.css`
- `apps/desktop/src/renderer/react/screens/AutomationViewScreen.test.tsx`
## Audit

PASS — file coverage is exact: script-comparing `git status --short` (50 tracked/untracked entries, receipt itself excluded) against the receipt's Files section (13 New + 35 Modified + 3 Deleted = 51, minus the receipt entry itself = 50) yields zero omissions and zero phantoms, and every entry's git status code matches its receipt bucket (`??`→New, `M`→Modified, `D`→Deleted, 0 mismatches). Eight load-bearing claims verified directly against source: (1) `handleAutomationUpdate` at `packages/gateway/src/routes/lifecycle-automation-routes.ts:203` preserves an existing webhook's `secretHash` on re-declare via `automation.webhookTriggerOf(existing.triggers)` returned verbatim, minting fresh only when `existingWebhook` is falsy; (2) `automations-routes.ts:436-438` merges in-flight turns via `runsStore.listAutomationTurns(ref, {limit:10}).filter(t => t.endedAt === undefined ...)` ahead of `run_summary`-derived finished rows, gated `if (ref)` so the global feed is untouched; (3) `packages/agent-runtime/src/runtime.ts:65` sets `permissionMode: 'bypassPermissions'`, mirrored in `backends/claude/backend.ts:77-84`; (4) `AutomationEditorScreen.tsx:474` seeds the builder with the "Compile this automation now: update automation.json and write the real handler.js…" work order; (5) both `AutomationViewRoute.tsx:150` and `AutomationEditorRoute.tsx:168-176` navigate to `automation-builder` with the bare `row.id` (a ref's `/` would 500 as a URL path segment); (6) `templatesData.ts:37` `cloneAutomationTemplate` resolves `ref` by re-listing since `_clone` only returns the bare id; (7) `AutomationThreadScreen.tsx:621-622` keeps `type="checkbox"` + `role="switch"` on the enable toggle; (8) grep for `AutomationViewScreen` outside its own three deleted files turns up only comment references, zero live imports. Unit tests run fresh by the auditor: gateway `lifecycle-automation-routes.test.ts` + `automations-routes.test.ts` → 2 files, 20 tests, all passed; desktop editor/thread/overview screens + thread/automations data tests → 5 files, 50 tests, all passed. No discrepancies found against any checked claim.

## Steering

PASS: the session JSONL (`cc2cac63-a147-49ae-b91c-573579adedd9.jsonl`, 1300 lines) contains 316 user-type entries; 288 are machine-generated tool_result blocks and 28 are text/image-bearing. Of those 28: 2 are genuine human-authored prose — the design-brainstorm turns (16:10:31 "let's first brainstorm on automations…" and 16:34:39 the consent-grants question + decisions), both predating the `/goal` command and therefore design conversation, not implementation steering; 1 is the `/goal` command itself (16:40:07, "revamp the screens… dump all old irrelevant ones… act as orchestrator and delegate to sonnet sub-agents… thoroughly test… fix and re-verify") — the single human steering event that assigned the task; the remaining 25 are machine-generated (goal-set echo, Stop-hook notice, skill-load dump, and 22 background-subagent task-notifications spanning 16:43–19:12). No human prose appears anywhere after the `/goal` command — the entire wave-1 build (gateway routes, agent-runtime permission fix, four renderer screens, dead-code sweep, e2e rewrite) proceeded under the Stop-hook-enforced goal with zero operator course corrections.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-cc2cac63-a14-1783883926-1 | claude-code | cc2cac63-a147-49ae-b91c-573579adedd9 | #387 | claude-fable-5 | 163670 | 1590610 | 148714333 | 488985 | 2243265 | 194.6829 | 163670 | 1590610 | 148714333 | 488985 | feat(gateway): automation update endpoint + in-flight runs in the ref feed (#387 |
| claude-code-cc2cac63-a14-1783883953-1 | claude-code | cc2cac63-a147-49ae-b91c-573579adedd9 | #387 | claude-fable-5 | 2 | 4629 | 461991 | 205 | 4836 | 0.5301 | 163672 | 1595239 | 149176324 | 489190 | x (#387)Issue: #387 |
| claude-code-cc2cac63-a14-1783883980-1 | claude-code | cc2cac63-a147-49ae-b91c-573579adedd9 | #387 | claude-fable-5 | 2 | 399 | 466620 | 126 | 527 | 0.4779 | 163674 | 1595638 | 149642944 | 489316 | x (#387)Issue: #387 |
| claude-code-cc2cac63-a14-1783884078-1 | claude-code | cc2cac63-a147-49ae-b91c-573579adedd9 | #387 | claude-fable-5 | 8200 | 16726 | 3286325 | 9846 | 34772 | 4.0697 | 171874 | 1612364 | 152929269 | 499162 | feat(gateway): automation update endpoint + in-flight runs in the ref feed (#387 |
| claude-code-cc2cac63-a14-1783884111-1 | claude-code | cc2cac63-a147-49ae-b91c-573579adedd9 | #387 | claude-fable-5 | 4 | 1410 | 955746 | 920 | 2334 | 1.0194 | 171878 | 1613774 | 153885015 | 500082 | fix(agent-runtime): run headless claude turns with bypassPermissions (#387)Gatew |
