# Receipt — Issue #541: Re-found automations

<!-- governance: allow-receipt-per-issue implementation is being delivered in explicit waves; the complete issue crosswalk and final independent audit replace this WIP waiver before the PR is opened -->

Issue: https://github.com/srikanth235/centraid/issues/541

## Checklist

- [x] When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used
- [x] Per-automation runner/model choices persist and override subsystem defaults for fire and compile
- [x] The automation wire and durable ledger expose native turns/items with ACP call ids, raw envelopes, stop reasons, and usage
- [x] The thread renders cold and live shared-Message traces without polling
- [x] Interactive automation replies use the same per-automation runner/model override and structurally deny runtime permission requests
- [x] Standing replies rewrite instructions and enter the existing compile seam
- [x] Cron, vault data/condition, webhook, and provider events share one durable bounded cursor engine
- [x] Gmail new-message and GitHub pull-request/issue sources use exact bound accounts without exposing credentials
- [ ] Anchored references and compiler-derived field/row-grain scopes are in progress

## What changed

When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used:

- `packages/client/src/react/screen-contracts.ts` exposes every exact provider-and-kind connection, including principal and health.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` preserves every exact match instead of collapsing an ambiguous set.
- `packages/client/src/react/shell/routes/automationEditorConnections.test.ts` covers exact, absent, and multiple-match catalog behavior.
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx` renders an inline account chooser and binds the selected durable connection id.
- `packages/client/src/react/screens/AutomationEditorScreen.tsx` preserves an explicit account choice across catalog refreshes.
- `packages/client/src/react/screens/AutomationEditorScreen.module.css` styles the compact inline account controls with existing design tokens.
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx` proves account selection is saved and cannot be clobbered by a later refresh.
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx` isolates the multi-account interaction regression test below the repository file-size ceiling.
- `receipts/issue-498-mobile-springboard-v0.md` gains a narrow receipt-index waiver for the duplicate #498 follow-up receipt already present on `origin/main`, which otherwise blocks every new issue receipt.

Per-automation runner/model choices persist and override subsystem defaults for fire and compile:

- `packages/automation/src/manifest/manifest.ts` and `packages/automation/src/manifest/manifest.test.ts` add the open, non-empty `requires.runner` manifest key.
- `packages/automation/src/scaffold/scaffold.ts` and `packages/automation/src/scaffold/scaffold-files.test.ts` persist initial runner/model pins.
- `packages/client/src/centraid-api.d.ts`, `packages/client/src/gateway-client-automation-editing.ts`, and `packages/client/src/react/screen-contracts.ts` carry runner/model pins and dynamic catalog/default data over the client boundary.
- `packages/client/src/react/screens/AutomationEditorAgentPicker.tsx`, `packages/client/src/react/screens/AutomationEditorScreen.tsx`, and `packages/client/src/react/screens/AutomationEditorScreen.module.css` add the compact Agent control next to Connectors.
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx` proves a gateway-listed harness and model are saved without a duplicated client-side runner list.
- `packages/client/src/react/shell/routes/automationEditorAgentData.ts`, `packages/client/src/react/shell/routes/automationEditorCreateData.ts`, `packages/client/src/react/shell/routes/automationEditorData.ts`, and `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` derive effective defaults, load explicit pins, and persist create/edit selections.
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts` covers runner-scoped effective model defaults.
- `packages/gateway/src/routes/lifecycle-automation-routes.ts` and `packages/gateway/src/routes/lifecycle-automation-routes.test.ts` round-trip create/update pins and make `null` clear them.
- `packages/gateway/src/lifecycle/automation-agent-selection.ts` and `packages/gateway/src/lifecycle/automation-agent-selection.test.ts` validate a manifest runner against the runtime registry, fall back to automations prefs, and resolve model precedence against the selected runner.
- `packages/app-engine/src/conversation/runner.ts`, `packages/app-engine/src/conversation/runner-core.ts`, and `packages/app-engine/src/conversation/runner-core.test.ts` add a validated one-turn runner override without weakening subsystem defaults.
- `packages/agent-runtime/src/conversation-adapter.ts`, `packages/gateway/src/runs/assistant-conversation-runner.ts`, and `packages/gateway/src/runs/unified-conversation-runner.ts` thread the requested runner into preference loading; a different runner never inherits the configured default runner’s binary or arguments.
- `packages/gateway/src/serve/runner-prefs.ts` and `packages/gateway/src/serve/runner-prefs.test.ts` isolate the host preference rule and regress the exact custom-runner-A versus pinned-runner-B launch-settings bug found by the independent audit.
- `packages/gateway/src/lifecycle/headless-automation-compile.ts` and `packages/gateway/src/lifecycle/headless-automation-compile.test.ts` apply runner/model pins to headless compilation.
- `packages/gateway/src/serve/build-gateway.ts` applies the same selection to compile, manual/scheduled fire, and webhook fire.
- `docs/runners.md` records the per-automation precedence and forward-compatible fallback contract.

The wire, ledger, and forensic view now speak native turns/items with ACP fidelity:

- `packages/app-engine/src/conversation/automation-turn-stream-event.ts`, the conversation schema/store, and gateway DDL add native `turn.*`/`item.*` events plus durable `callId`/`rawJson`.
- `packages/agent-runtime/src/backends/acp/*` preserves raw tool/final envelopes, stop reasons, and usage while mapping parallel tool calls by ACP call id.
- `packages/automation/src/handler/*` records tool identity, verbatim envelopes, and token/cost actuals into the shared conversation ledger.
- `packages/gateway/src/routes/automations-routes.ts` and `packages/client/src/gateway-client.ts` cut over the `_automations` surface to `turn`/`item`; legacy `run`/`node` routes are absent.
- `RunViewRoute`/`RunViewScreen` remain the forensic register over the native records and shared conversation renderer.

The automation thread is a real cold/live conversation:

- `packages/client/src/react/shell/routes/automationTurnMessages.ts` folds durable items and reduces standard `TurnStreamEvent` activity into `AsstMsgDTO`.
- `AutomationThreadScreen` consumes `AssistantMessage` unchanged, warms the newest trace, lazily expands older traces, joins running fires over SSE, and contains no timer poll.
- `AutomationViewRoute` performs the required authoritative expanded read after `turn.end`; the hidden builder redirect and one-off text prefix are gone.

Interactive steering and standing revision use the automation's existing identity:

- `GatewayCapabilities.automationTurns` gates the composer for older gateways.
- `interactive-automation-turn.ts` builds a bounded ledger preamble, serializes per-ref execution, resumes only as an optimization, runs in a scoped scratch directory, and fans identical standard events to the response and automation bus.
- ACP permission requests on interactive automation turns receive a structural deny instead of a runtime consent dialog.
- `rewrite-automation-instructions.ts` performs a tool-less cheap-tier rewrite, records the visible revision turn, persists through the existing manifest path, and invokes the existing compile seam.
- `POST /centraid/_automations/turn?ref=` streams the standard grammar; `POST /centraid/_automations/revise?ref=` returns the reserved `compileTurnId`.

Every trigger source now advances through one durable bounded cursor engine:

- `packages/app-engine/src/conversation/trigger-store.ts` and the gateway journal schema add per-trigger cursor state plus deduplicated, retained `trigger_ingress` rows.
- `packages/automation/src/fire/cursor-engine.ts` replaces the parallel cron/data/condition/webhook paths with one ordered source contract, a uniform catch-up cap, persist-before-fire semantics, explicit gap/skipped metadata, per-trigger serialization, restart bootstrap, and immediate ingress nudges.
- `packages/automation/src/fire/condition.ts` exposes condition/data reads as cursor sources, while manifest validation and runtime registration share one denylist for outbox, trigger bookkeeping, and conversation-ledger entities.
- Authenticated webhook POSTs append bounded durable ingress and return 202; the source reader—not the HTTP handler—owns firing. The real HTTP integration proves ingress, cursor advance, native turn completion, and bearer-free shared-secret authentication.
- The shared fire callback now represents the full run promise, so scheduler shutdown and per-trigger single-flight semantics bracket the actual automation rather than a detached task.
- Trigger gap notes are persisted on native turns, and the legacy scheduler ledger is retained only for liveness because source positions now have one authoritative store.

First-party provider events use the same cursor and ingress machinery:

- `packages/automation/src/manifest/manifest.ts` defines validated `event` triggers for Gmail new-message and GitHub pull-request/issue sources, including cadence and GitHub repository filters.
- `packages/gateway/src/serve/automation-event-sources.ts` implements bounded Gmail History and GitHub repository-event adapters with Gmail re-baselining, GitHub conditional requests/poll intervals, safe normalized payloads, and no credential material.
- `packages/gateway/src/serve/connection-broker.ts` performs read-only provider polling through the exact durable connection binding, host pinning, refresh, rate limiting, and a 1 MiB response cap; Gmail connect time captures its history baseline.
- Provider events enter `trigger_ingress` with stable delivery ids before firing, so restart, deduplication, catch-up gaps, and native turn provenance match webhook/data/cron behavior.
- The automation editor only offers event triggers when an exact Gmail/GitHub pull connection is bound, displays the selected account, and persists the provider event, repository filter, and cadence.
- Lifecycle routes validate and round-trip the same event shape rather than maintaining a route-local trigger dialect.

## Out of scope

- None for issue #541. Wave 10 is still in progress and will be recorded here before the PR is opened.

## Decisions

- The account chooser stays inside the existing Connectors popover so account identity is visible at the point of binding without adding another editor dialog.
- Preserve both immutable #498 narratives and waive only the later follow-up from the one-receipt index; this repairs a pre-existing governance contradiction without deleting history.

## Verification

```sh
bun run --cwd packages/client test -- AutomationEditorScreen.test.tsx AutomationEditorAccountChoice.test.tsx automationEditorConnections.test.ts
bun run --cwd packages/client typecheck
bun run build
bun run --cwd packages/automation test -- src/manifest/manifest.test.ts src/scaffold/scaffold-files.test.ts
bun run --cwd packages/app-engine test -- src/conversation/runner-core.test.ts
bun run --cwd packages/client test -- AutomationEditorAccountChoice.test.tsx AutomationEditorScreen.test.tsx automationEditorPrefill.test.ts automationEditorConnections.test.ts
bun run --cwd packages/gateway test -- src/lifecycle/automation-agent-selection.test.ts src/lifecycle/headless-automation-compile.test.ts src/serve/runner-prefs.test.ts src/routes/lifecycle-automation-routes.test.ts
bun run --cwd packages/automation typecheck
bun run --cwd packages/app-engine typecheck
bun run --cwd packages/gateway typecheck
bun run --filter @centraid/client test -- src/react/shell/routes/runViewData.test.ts src/react/screens/AutomationThreadScreen.test.tsx
bun run --filter @centraid/client typecheck
bun run --filter @centraid/agent-runtime test -- src/backends/acp/backend.test.ts
bun run --filter @centraid/gateway test -- src/routes/automations-routes.test.ts src/routes/lifecycle-automation-routes.test.ts src/lifecycle/interactive-automation-turn.test.ts src/lifecycle/rewrite-automation-instructions.test.ts
bun run --filter @centraid/gateway typecheck
bun run --filter @centraid/protocol typecheck
bun run --filter @centraid/app-engine test -- src/conversation/trigger-store.test.ts src/stores/gateway-db.test.ts
bun run --filter @centraid/automation test -- src/fire/cursor-engine.test.ts src/fire/in-process-scheduler.test.ts src/manifest/manifest.test.ts src/scaffold/webhook.test.ts
bun run --filter @centraid/client test -- src/react/screens/AutomationEditorTriggers.test.tsx
bun run --filter @centraid/gateway test -- src/serve/automation-event-sources.test.ts src/serve/connection-broker.test.ts src/routes/lifecycle-automation-routes.test.ts
bun run --filter @centraid/gateway test -- src/lifecycle/webhook-route-over-http.test.ts
```

## Audit

**Interim Waves 1–2 audit**

PASS — the final fresh-context Waves 1–2 auditor verified exact account binding and refresh preservation; open runner validation; dynamic editor choices; persistence and null clearing; manifest precedence across compile and all fire paths; unknown-runner fallback; and both generic plus gateway-host regressions preventing runner A’s binary/arguments from leaking into pinned runner B. The full-scope audit will be re-run after Waves 3–10.

## Accounting

### Steering

(no rows — no interrupt/correction events recorded for this change set)

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f9495-7c0-1784905227-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 334821 | 0 | 10015744 | 23188 | 358009 | 3.6888 | 334821 | 0 | 10015744 | 23188 | feat(automations): choose exact connector account (#541) |
| codex-019f9495-7c0-1784905470-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 28664 | 0 | 1103360 | 7060 | 35724 | 0.4534 | 363485 | 0 | 11119104 | 30248 | feat(automations): choose exact connector account (#541) -m governance: allow-do |
| codex-019f9495-7c0-1784911283-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 312159 | 0 | 16580096 | 37209 | 349368 | 5.4836 | 675644 | 0 | 27699200 | 67457 | feat(automations): pin runner and model per automation (#541) |
| codex-019f9495-7c0-1784911338-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 3047 | 0 | 440832 | 163 | 3210 | 0.1203 | 678691 | 0 | 28140032 | 67620 | feat(automations): pin runner and model per automation (#541) -m governance: all |
| codex-019f9495-7c0-1784943285-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 1022245 | 0 | 29047552 | 97489 | 1119734 | 11.2798 | 1700936 | 0 | 57187584 | 165109 | feat(automations): stream native turn conversations (#541) -m governance: allow- |
| codex-019f9495-7c0-1784943378-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 4157 | 0 | 787200 | 592 | 4749 | 0.2161 | 1705093 | 0 | 57974784 | 165701 | feat(automations): stream native turn conversations (#541) -m governance: allow- |
| codex-019f9495-7c0-1784947056-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 569461 | 0 | 35412992 | 88205 | 657666 | 11.6000 | 2274554 | 0 | 93387776 | 253906 | feat(automations): unify trigger cursors and provider events (#541) -m governanc |
| codex-019f9495-7c0-1784947218-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 17426 | 0 | 1662208 | 2957 | 20383 | 0.5035 | 2291980 | 0 | 95049984 | 256863 | feat(automations): unify trigger cursors and provider events (#541) -m governanc |

## Steering

PASS — the final fresh-context Waves 1–2 auditor found no interrupt or correction events.
