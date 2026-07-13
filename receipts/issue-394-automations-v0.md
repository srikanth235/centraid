# issue-394 — automations v0 standalone compile and ledger

GitHub issue: [#394](https://github.com/srikanth235/centraid/issues/394)

## Checklist

- [x] Ledger: one conversation per automation
- [x] Headless compile path
- [x] Editor completion
- [x] @-based data tagging in Instructions
- [x] Polish while the run spine is open

## What changed

### Ledger: one conversation per automation

- `packages/app-engine/src/conversation/store.ts`,
  `packages/app-engine/src/conversation/store-sql.ts`, and
  `packages/app-engine/src/conversation/schema.ts` add the stable
  `ensureAutomationConversation` seam, make retention operate on turns inside
  that conversation, and reduce deletion to the one cascading conversation.
  `packages/app-engine/src/stores/gateway-db.ts` documents the resulting
  ownership model. `packages/app-engine/src/conversation/run-summary-sink.ts`
  and `packages/app-engine/README.md` update the public ledger terminology.
- `packages/automation/src/handler/runner.ts`,
  `packages/automation/src/handler/audit.ts`, and
  `packages/automation/src/handler/ctx.ts` append every fire to the stable
  conversation and admit `compile` as a distinct trigger kind.
- Coverage was updated in
  `packages/app-engine/src/conversation/store.test.ts`,
  `packages/app-engine/src/insights/analytics-store.test.ts`, and
  `packages/app-engine/src/insights/insights-store.test.ts`.

### Headless compile path

- `packages/gateway/src/lifecycle/headless-automation-compile.ts` adds the
  framed work order and records the shared runner's headless compile as a
  normal automation turn. The shared gateway runner already enforces Claude
  `bypassPermissions` and Codex `approvalPolicy=never`; the compile seam has
  no weaker per-turn mode. Its unit contract lives in
  `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`.
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`,
  `packages/gateway/src/routes/lifecycle-routes.ts`, and
  `packages/gateway/src/lifecycle/lifecycle-shared.ts` expose the asynchronous
  compile kick-off. `packages/gateway/src/serve/build-gateway.ts` publishes the
  validated draft, enables only the first successful compile, derives tagged
  vault scopes, preserves the prior enabled state on recompile, reconciles the
  scheduler, and reports success/failure health. A compile failure also fires
  the manifest's `onFailure` target with compile error context when configured;
  the thread supplies the direct retry affordance.
  HTTP coverage is in
  `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`.
- `packages/automation/src/scaffold/scaffold.ts` changes generated provenance
  from the builder-specific name to `centraid-compiler`.
- `packages/client/src/gateway-client-automation-compile.ts` and
  `packages/client/src/gateway-client.ts` add the renderer compile client;
  `packages/client/src/gateway-client-editing.ts` carries vault blocks through
  automation updates.
  `packages/client/src/react/shell/App.tsx` gates the retained
  `automation-builder` route by redirecting it to the editor, and
  `packages/client/src/react/shell/ShellApp.tsx` removes its builder full-bleed
  treatment. The builder contracts remain available internally but no shipped
  automation screen exposes them.
- `packages/client/src/react/screens/AutomationThreadScreen.tsx` and
  `packages/client/src/react/screens/AutomationThreadScreen.test.tsx` hide the
  composer and show compile progress, success, failure, and retry. The old live
  builder scenario in
  `apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs` is now a
  create → headless compile → shared-ledger fire scenario with an explicit
  no-builder-UI assertion.

### Editor completion

- `packages/client/src/react/screens/AutomationEditorScreen.tsx`,
  `packages/client/src/react/screens/AutomationEditorScreen.module.css`, and
  `packages/client/src/react/screens/AutomationEditorScreen.test.tsx` replace
  the scalar trigger picker with additive/removable trigger cards, preserve all
  loaded triggers, enforce one webhook, validate/edit condition `where`, and
  compile after create or changed instructions.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` consumes
  `templateId`, maps all trigger rows, derives condition/data vault scopes, and
  starts the headless compile. `packages/client/src/react/screen-contracts.ts`
  carries the multi-trigger, mention-search, and compile bridge shapes.
- `packages/vault/src/host.ts`,
  `packages/gateway/src/serve/vault-plane.ts`,
  `packages/client/src/gateway-client-vault.ts`, and
  `packages/client/src/centraid-api.d.ts` expose the enrolled agent's stable
  host key. `packages/client/src/gateway-client-outbox.ts`,
  `packages/client/src/react/shell/routes/automationThreadData.ts`,
  `packages/client/src/react/shell/routes/automationThreadData.test.ts`, and
  `packages/client/src/react/shell/routes/approvalsData.test.ts` replace the
  display-name consent match with exact agent-id matching.
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx` owns retry
  compile while keeping its hidden composer callback contract;
  `packages/client/src/react/shell/routes/AutomationsRoute.tsx` supplies the
  stable agent identity to the fleet consent projection.

### @-based data tagging in Instructions

- The editor provides gateway-backed mention search and inserts stable
  `@[schema.table/id]` tokens, with chip rendering in both editor and thread.
  `packages/client/src/gateway-client-vault.ts` supplies the picker query.
- Headless work orders expand each token into the concrete consent-checked
  `ctx.vault.resolve({refs:[{type,id}]})` call the generated handler must use;
  compile publication contributes read scopes for tagged tables. Anchor-grade
  selectors are deliberately unnecessary because the manifest token is the
  stable reference.

### Polish while the run spine is open

- `packages/gateway/src/routes/automations-routes.ts` merges unfinished turns
  into both ref-scoped and global activity feeds; coverage is in
  `packages/gateway/src/routes/automations-routes.test.ts` and
  `packages/gateway/src/runs/run-events-sse.test.ts`.
- `packages/client/src/react/shell/routes/automationsData.ts` projects compile
  lifecycle status into fleet rows and
  `packages/client/src/react/screens/AutomationsOverviewScreen.tsx` keeps fleet
  counts tied to the underlying enabled/draft health while those transient
  labels render, while
  `packages/client/src/react/shell/routes/automationThreadData.ts` loads the
  one conversation directly. Thread polling no longer has a 60-second cap.
- `ARCHITECTURE.md` records the long-lived automation conversation, the
  compile/fire turn spine, and the explicit cron catch-up policy: skip missed
  fires after sleep/restart, retain the bounded missed-window ledger, and never
  burst-fire. `packages/automation/src/fire/scheduler-ledger.test.ts` is the
  already-existing executable policy contract and passed in the full runtime
  suite.

## Out of scope

- Trigger unification into vault-ingress cursors remains deferred; no runtime
  trigger kind or security-sensitive webhook machinery was added.
- Conversational revision in the automation thread remains hidden with the
  composer.
- `core_link_anchor` / W3C selector tagging and optional `core.link` backlinks
  remain deferred.
- Builder implementation code is retained for a future product decision; only
  its v0 UI route and affordances are gated.

## Verification

The automation runtime suite passed 228 tests. The focused ledger, compile,
gateway route, editor/thread, consent, and run-feed suite passed 95 tests. The
extended lifecycle, scheduler, validation, overview, template, and data suite
passed 61 tests. Type checking passed all 26 workspace tasks, changed-file
oxlint passed with zero errors, the rewritten live flow passed `node --check`,
and `git diff --check` passed.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/automation test
bunx vitest run \
  packages/app-engine/src/conversation/store.test.ts \
  packages/app-engine/src/insights/analytics-store.test.ts \
  packages/app-engine/src/insights/insights-store.test.ts \
  packages/gateway/src/lifecycle/headless-automation-compile.test.ts \
  packages/gateway/src/routes/automations-routes.test.ts \
  packages/gateway/src/routes/lifecycle-automation-routes.test.ts \
  packages/gateway/src/runs/run-events-sse.test.ts \
  packages/client/src/react/screens/AutomationEditorScreen.test.tsx \
  packages/client/src/react/screens/AutomationThreadScreen.test.tsx \
  packages/client/src/react/shell/routes/automationThreadData.test.ts \
  packages/client/src/react/shell/routes/approvalsData.test.ts
bunx vitest run \
  packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts \
  packages/gateway/src/serve/scheduler-health.test.ts \
  packages/gateway/src/serve/serve-scheduler-reconcile.test.ts \
  packages/gateway/src/validate-automation-handler.test.ts \
  packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx \
  packages/client/src/react/shell/routes/automationsData.test.ts \
  packages/client/src/react/screens/AutomationTemplatesScreen.test.tsx \
  packages/client/src/react/shell/automationTemplatePreview.test.ts
node --check apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs
{ git diff --name-only --diff-filter=ACMR; \
  printf '%s\n' packages/client/src/gateway-client-automation-compile.ts \
    packages/gateway/src/lifecycle/headless-automation-compile.ts \
    packages/gateway/src/lifecycle/headless-automation-compile.test.ts; \
} | sort -u | xargs bunx oxlint
git diff --check
```

`bun run lint` remains red on the unchanged baseline (207 existing oxlint
errors, predominantly generated `apps/web/src/generated/centraid_web_iroh.js`
and legacy e2e-live files). The changed-file-only oxlint invocation above is
clean. The live Electron flow was syntax-checked but not executed in this
workspace because it requires the external desktop/LLM rig.

`bash .governance/run.sh` passes 18 directives and is blocked by three
pre-existing repository-wide violations outside this change: the historical
`claude-code-cc2cac63-a14-1783910592-1` token-accounting row, the issue #354
receipt crosswalk, and the 556-line
`packages/app-engine/src/http/turn-routes.test.ts`. This receipt's audit,
steering, issue match, file coverage, toolchain, docs, and layer directives
all pass.

## Decisions

- The retained `automation-builder` route redirects to the editor instead of
  introducing a public feature flag. This is fail-closed for v0 while keeping
  builder code and contracts intact.
- Compile kick-off returns a run id immediately; status is observed through
  the same run ledger used by the thread and fleet. This avoids holding an HTTP
  request open for an agent turn.
- Successful first compile enables the automation; recompiles preserve the
  current enabled state.
- Stable tokens derive consent scopes at table granularity. Runtime access
  remains subject to the existing vault grant checks.
- No database migration is included, matching the issue's v0 recreate policy.

## Audit

PASS — fresh-context audit against the current unstaged diff, untracked files,
and GitHub issue #394 confirms that `## What changed` faithfully describes the
implementation, all five checked checklist items are realized, and the
checklist mirrors the issue's five top-level scope sections. Every changed
non-exempt file is named by full path in the receipt, including
`packages/client/src/react/screens/AutomationsOverviewScreen.tsx`.

The compile lifecycle labels and focused coverage, enabled-state
snapshot/restore, consent-checked `ctx.vault.resolve` work order, configured
`onFailure` dispatch plus thread retry, and durable cron catch-up policy are
represented in the diff. Verification commands are replayable, the
changed-file oxlint command is present, and the live Electron flow is
accurately limited to syntax-check evidence rather than claimed as executed.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Steering

PASS — the supplied transcript fact pattern contains one initial user request
and no later user correction, redirect, or interruption. The empty Steering
accounting table is therefore correct; the initial scope-setting request is not
a mid-task steering event.
