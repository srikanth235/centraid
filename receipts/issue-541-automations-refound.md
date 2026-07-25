# Receipt — Issue #541: Re-found automations

Issue: https://github.com/srikanth235/centraid/issues/541

## Checklist

- [x] When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used
- [x] Per-automation harness and model choices persist and override subsystem defaults across compile, manual/scheduled/provider/webhook fire, interactive steering, revision, and nested `onFailure`
- [x] The automation wire is a clean native turn/item cutover, and the Details view reads the same durable records
- [x] Native items preserve ACP `callId`, raw envelopes, and terminal stop reasons; reopened turns distinguish refusal, truncation, cancellation, and ordinary completion
- [x] Token/cost usage is honest across supported harnesses and feeds the existing Automation Insights projection
- [x] Automation threads render real cold/live shared-Message traces over SSE with no two-second polling loop
- [x] Interactive replies replay to second viewers, cold and resumed context are ledger-equivalent, and permission requests are structurally denied without a dialog
- [x] Turning an automation on after a standing-instruction change preserves visible user → revised-instructions → compile ordering
- [x] Cron, vault data/condition, and authenticated webhook sources share one durable bounded cursor; cron records `k−1` skipped wakes, both validation/runtime denylists agree, and existing trigger UX remains intact
- [x] Gmail/GitHub polling persists provider tokens, ingresses stable event ids, records accurate bounded overflow, re-baselines expired Gmail history as an explicit gap, and uses the exact bound connection
- [x] Anchored references resolve through live `core_link_anchor` rows and compile to enforced field/row/span-grain scopes
- [x] No automation execution path opens a runtime consent dialog

## What changed

### Acceptance crosswalk

The issue’s completed acceptance text is preserved verbatim here so the receipt’s evidence groups below remain mechanically tied to every checked row:

- When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used
- Per-automation harness and model choices persist and override subsystem defaults across compile, manual/scheduled/provider/webhook fire, interactive steering, revision, and nested `onFailure`
- The automation wire is a clean native turn/item cutover, and the Details view reads the same durable records
- Native items preserve ACP `callId`, raw envelopes, and terminal stop reasons; reopened turns distinguish refusal, truncation, cancellation, and ordinary completion
- Token/cost usage is honest across supported harnesses and feeds the existing Automation Insights projection
- Automation threads render real cold/live shared-Message traces over SSE with no two-second polling loop
- Interactive replies replay to second viewers, cold and resumed context are ledger-equivalent, and permission requests are structurally denied without a dialog
- Turning an automation on after a standing-instruction change preserves visible user → revised-instructions → compile ordering
- Cron, vault data/condition, and authenticated webhook sources share one durable bounded cursor; cron records `k−1` skipped wakes, both validation/runtime denylists agree, and existing trigger UX remains intact
- Gmail/GitHub polling persists provider tokens, ingresses stable event ids, records accurate bounded overflow, re-baselines expired Gmail history as an explicit gap, and uses the exact bound connection
- Anchored references resolve through live `core_link_anchor` rows and compile to enforced field/row/span-grain scopes
- No automation execution path opens a runtime consent dialog

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
- `packages/gateway/src/serve/build-gateway.ts` applies the same registry-backed selection to compile, primary fire, provider/webhook/manual fire, interactive turns, rewrites, and each nested `onFailure` target; an explicit automation model remains ahead of cheap rewrite/catalog defaults during revision.
- “Gateway default” leaves the model unset for the backend; no warmed catalog entry is injected as a hidden automation pin.
- `docs/runners.md` records the per-automation precedence, forward-compatible fallback contract, and live-confirmation accounting boundary.

The wire, ledger, and forensic view now speak native turns/items with ACP fidelity:

- `packages/app-engine/src/conversation/automation-turn-stream-event.ts`, the conversation schema/store, and gateway DDL add native `turn.*`/`item.*` events plus durable `callId`/`rawJson`.
- `packages/agent-runtime/src/backends/acp/*` preserves raw tool/final envelopes, stop reasons, and usage while mapping parallel tool calls by ACP call id. Cumulative ACP session counters are deltaed against a snapshot persisted beside the resume handle, including after process restart.
- `packages/automation/src/handler/*` records tool identity, verbatim envelopes, and token/cost actuals into the shared conversation ledger. Only a live ACP-confirmed model may be stamped; unconfirmed token usage receives an explicit estimated unknown-model charge instead of a false configured identity or zero.
- `packages/gateway/src/routes/automations-routes.ts` and `packages/client/src/gateway-client.ts` cut over the `_automations` surface to `/turn-now`, `/turns`, `/turn`, and `/turn/items`; legacy `run`/`node` routes are explicitly rejected.
- `RunViewRoute`/`RunViewScreen` remain the forensic Details register over the native records and shared conversation renderer.
- Cold projection reads terminal `stopReason` from durable output/raw envelopes and renders a distinct error bubble for refusal, token/request truncation, cancellation, and unknown terminal reasons; live projection uses the same mapping.
- Headless compile and instruction-rewrite turns persist raw terminal envelopes, stop reasons, and honest usage on success and model failure alike, so their reopened failure traces retain refusal/truncation/cancellation evidence rather than only a summary string.
- `apps/mobile/src/lib/automations.ts` consumes the clean `{turnId}` response from `/turn-now`, with a focused contract test.

The automation thread is a real cold/live conversation:

- `packages/client/src/react/shell/routes/automationTurnMessages.ts` folds durable items and reduces standard `TurnStreamEvent` activity into `AsstMsgDTO`, preserving production ordering when a tool completes after its parent agent item closes.
- Late and second viewers seed the reducer from the durable item prefix; replayed `item.start`/`item.end` pairs are idempotent and hydrate completed answers/tools even when their ephemeral deltas predated the subscription.
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
- `packages/automation/src/fire/cursor-engine.ts` replaces the parallel cron/data/condition/webhook paths with one ordered source contract, a uniform catch-up cap, explicit gap/skipped metadata, per-trigger serialization, restart bootstrap, and immediate ingress nudges. Its durable write-ahead `pending` batch contains the exact selected elements, target position, acknowledgements, and gap metadata; restart replays that authoritative batch before reading later source data, and advances the cursor only after every element is terminal.
- Cron catch-up selects the latest due minute and records the other `k−1` due wakes as an explicit bounded gap instead of silently replaying or losing them.
- `packages/automation/src/fire/condition.ts` exposes condition/data reads as cursor sources, while manifest validation and runtime registration share one denylist for outbox, trigger bookkeeping, and conversation-ledger entities.
- Authenticated webhook POSTs append bounded durable ingress and return 202; the source reader—not the HTTP handler—owns firing. The real HTTP integration proves ingress, cursor advance, native turn completion, and bearer-free shared-secret authentication.
- The shared fire callback now represents the full run promise, so scheduler shutdown and per-trigger single-flight semantics bracket the actual automation rather than a detached task.
- Trigger gap notes are persisted on native turns, and the legacy scheduler ledger is retained only for liveness because source positions now have one authoritative store.

First-party provider events use the same cursor and ingress machinery:

- `packages/automation/src/manifest/manifest.ts` defines validated `event` triggers for Gmail new-message and GitHub pull-request/issue sources, including cadence and GitHub repository filters.
- `packages/gateway/src/serve/automation-event-sources.ts` exhausts Gmail History and safe GitHub repository-event pagination before advancing provider cursors; the complete provider window reaches durable ingress, so the fire cap records exact overflow instead of a one-row placeholder. If a provider window exceeds the 100-page safety budget, the cursor advances explicitly with an unknown-tail gap instead of retrying the same pages forever.
- `packages/gateway/src/serve/connection-broker.ts` performs read-only provider polling through the exact durable connection binding, host pinning, refresh, rate limiting, and a 1 MiB response cap; it preserves GitHub’s safe `Link` pagination header, and Gmail connect time captures its history baseline.
- Provider events enter `trigger_ingress` with stable delivery ids before firing, so restart, deduplication, catch-up gaps, and native turn provenance match webhook/data/cron behavior.
- The automation editor only offers event triggers when an exact Gmail/GitHub pull connection is bound, displays the selected account, and persists the provider event, repository filter, and cadence.
- Lifecycle routes validate and round-trip the same event shape rather than maintaining a route-local trigger dialect.

Anchored references are row/field/span-grade instead of whole-table hints:

- The automation editor searches live `core_link_anchor` rows before legacy entity/type matches and writes opaque `@[core.link_anchor/<anchor_id>]` tokens; chips label their row/field/span extent.
- `automation-anchor-scopes.ts` resolves the opaque id through a live `core_link`, re-matches the W3C-style text selector against the source row, identifies the exact source field (including decoded canonical content), and fails closed when the link, row, or span is stale.
- Same-table anchors compile to one bounded row union only when every selected row has the same referenced field set. Non-rectangular row/field combinations fail closed because the current conjunctive scope algebra cannot represent them without widening access; ordinary unanchored entity tokens retain their deliberately broader behavior.
- `headless-automation-compile.ts` gives the model only trusted anchor facts and gateway-derived scopes; a resolution failure is recorded as a failed compile turn before the runner starts.
- Automation manifest validation, install-grant top-up, widening requests, active-grant summaries, revocation tombstones, owner approval routes, and client consent views now preserve `rowFilter` and `fieldMask`.
- The vault execution credential now carries a host-owned manifest scope clamp that is intersected with durable owner grants. Tests prove an anchored run sees only its exact row/fields even when the enrolled agent retains an older broad grant, and a manifest declaring no vault scopes cannot ride historical consent.
- `ARCHITECTURE.md` records the anchored token grammar, fail-closed compiler boundary, and same-table scope aggregation contract.

Full-gate concurrency exposed three test-only timing assumptions. The scheduler expectations now match durable cursor bootstrap/catch-up, the handler busy-refusal test asserts causal ordering instead of a wall-clock race, and the 50k-photo algorithm budget uses process CPU time so OS descheduling by parallel package suites is not charged to the algorithm.

The final governance pass also enforced the 500-line source ceiling. The shared turn attachment/locking helpers now live in `packages/app-engine/src/http/turn-sse-support.ts`; conversation prune/delete cases live in `packages/app-engine/src/conversation/store-prune.test.ts`; cursor contracts and pending-batch parsing live in `packages/automation/src/fire/cursor-engine-support.ts`; and the live automation reducer/projection lives in `packages/client/src/react/shell/routes/automationLiveMessages.ts`. These are responsibility-preserving splits of already-tested behavior, with all resulting modules below the cap.

Mechanical changed-file index (the substantive grouping above is the review guide; this exact index closes the receipt’s file-coverage loop):

- `apps/desktop/tests/e2e/automations.spec.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/mobile/src/lib/automations.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/agent-runtime/src/backends/acp/backend.model-usage.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/backends/acp/permissions.ts`
- `packages/agent-runtime/src/backends/acp/stream-events.test.ts`
- `packages/agent-runtime/src/backends/acp/stream-events.ts`
- `packages/agent-runtime/src/backends/acp/test-fixtures.ts`
- `packages/agent-runtime/src/backends/acp/types.ts`
- `packages/agent-runtime/src/backends/acp/usage.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/app-engine/src/conversation/history.ts`
- `packages/app-engine/src/conversation/run-stream-event.ts`
- `packages/app-engine/src/conversation/schema.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/store-prune.test.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/conversation/store.ts`
- `packages/app-engine/src/conversation/trigger-store.test.ts`
- `packages/app-engine/src/conversation/turn.ts`
- `packages/app-engine/src/http/turn-routes.ts`
- `packages/app-engine/src/http/turn-sse-support.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/model-pricing.test.ts`
- `packages/app-engine/src/model-pricing.ts`
- `packages/app-engine/src/pricing/catalog.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/automation/src/fire/cron-cursor.ts`
- `packages/automation/src/fire/cursor-engine-support.ts`
- `packages/automation/src/fire/cursor-engine.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/fire/in-process-scheduler.ts`
- `packages/automation/src/fire/memory-cursor-store.ts`
- `packages/automation/src/handler/audit.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/manifest-vault.test.ts`
- `packages/automation/src/scaffold/app.ts`
- `packages/automation/src/scaffold/webhook.test.ts`
- `packages/automation/src/scaffold/webhook.ts`
- `packages/blueprints/kit/turn-stream.d.ts`
- `packages/client/src/app-format.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/gateway-client-automation-compile.ts`
- `packages/client/src/gateway-client-logs.ts`
- `packages/client/src/gateway-client-outbox.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/react/screens/AutomationEditorAnchorMention.test.tsx`
- `packages/client/src/react/screens/AutomationEditorTriggers.test.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.test.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/RunViewScreen.module.css`
- `packages/client/src/react/screens/RunViewScreen.test.tsx`
- `packages/client/src/react/screens/RunViewScreen.tsx`
- `packages/client/src/react/screens/VaultScreen.tsx`
- `packages/client/src/react/shell/App.inline-branch.test.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/routes/AppSettingsController.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/RunViewRoute.tsx`
- `packages/client/src/react/shell/routes/RunsPane.tsx`
- `packages/client/src/react/shell/routes/appSettingsData.ts`
- `packages/client/src/react/shell/routes/approvalsData.ts`
- `packages/client/src/react/shell/routes/automationLiveMessages.ts`
- `packages/client/src/react/shell/routes/automationThreadData.test.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.test.ts`
- `packages/client/src/react/shell/routes/automationsData.test.ts`
- `packages/client/src/react/shell/routes/automationsData.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.test.ts`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationConfigView.test.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationConfigView.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPaneShared.test.ts`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPaneShared.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.tsx`
- `packages/client/src/react/shell/routes/homeData.test.ts`
- `packages/client/src/react/shell/routes/runViewData.test.ts`
- `packages/client/src/react/shell/routes/runViewData.ts`
- `packages/gateway/src/lifecycle/automation-anchor-scopes.test.ts`
- `packages/gateway/src/lifecycle/automation-anchor-scopes.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.test.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/routes/assistant-routes.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-routes.ts`
- `packages/gateway/src/routes/sse-cap.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/runs/run-event-bus.test.ts`
- `packages/gateway/src/runs/run-event-bus.ts`
- `packages/gateway/src/runs/run-events-sse.test.ts`
- `packages/gateway/src/serve/automation-event-sources.test.ts`
- `packages/gateway/src/serve/connection-broker.test.ts`
- `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/serve/vault-picker.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/worktree-store/worktree-store.ts`
- `packages/protocol/src/capabilities.ts`
- `packages/vault/src/gateway/consent.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/install-memory.ts`
- `packages/vault/src/schema/consent.ts`
- `packages/vault/src/schema/migrate.ts`
- `ARCHITECTURE.md`
- `apps/mobile/src/apps/photos/timeline-50k.test.ts`
- `apps/mobile/src/lib/automations.test.ts`
- `docs/runners.md`
- `packages/agent-runtime/src/conversation-adapter.ts`
- `packages/app-engine/src/conversation/automation-turn-stream-event.ts`
- `packages/app-engine/src/conversation/runner-core.test.ts`
- `packages/app-engine/src/conversation/runner-core.ts`
- `packages/app-engine/src/conversation/runner.ts`
- `packages/app-engine/src/conversation/trigger-store.ts`
- `packages/app-engine/src/handlers/handler-runner.contract.test.ts`
- `packages/automation/src/fire/condition.ts`
- `packages/automation/src/fire/cursor-engine.ts`
- `packages/automation/src/fire/in-process-scheduler.test.ts`
- `packages/automation/src/manifest/manifest.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold-files.test.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx`
- `packages/client/src/react/screens/AutomationEditorAgentPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/automationEditorAgentData.ts`
- `packages/client/src/react/shell/routes/automationEditorConnections.test.ts`
- `packages/client/src/react/shell/routes/automationEditorCreateData.ts`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.test.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/runs/assistant-conversation-runner.ts`
- `packages/gateway/src/runs/unified-conversation-runner.ts`
- `packages/gateway/src/serve/automation-event-sources.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/connection-broker.ts`
- `packages/gateway/src/serve/runner-prefs.test.ts`
- `packages/gateway/src/serve/runner-prefs.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/vault/src/gateway/identity.ts`
- `packages/vault/src/gateway/types.ts`
- `receipts/issue-498-mobile-springboard-v0.md`
- `receipts/issue-541-automations-refound.md`

## Out of scope

- None.

## Decisions

- The account chooser stays inside the existing Connectors popover so account identity is visible at the point of binding without adding another editor dialog.
- Preserve both immutable #498 narratives and waive only the later follow-up from the one-receipt index; this repairs a pre-existing governance contradiction without deleting history.
- Anchor tokens carry only an opaque `core.link_anchor` id. Source type, row key, field mask, and exact span are always recovered from the addressed vault so authored instruction text cannot widen its own consent.
- Multiple anchors on one table use a bounded `in` row filter only for a rectangular scope with one shared field set. A non-rectangular combination is rejected because separate row and field unions would grant their Cartesian product.
- ACP session usage is cumulative, so the persisted resume handle and usage snapshot form one accounting state. A requested model is never substituted for live ACP confirmation.

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
bun run --filter @centraid/automation test -- src/manifest/manifest.test.ts src/manifest/manifest-vault.test.ts
bun run --filter @centraid/vault test -- src/host.test.ts src/schema/migrate.test.ts src/gateway/duties.test.ts
bun run --filter @centraid/gateway test -- src/lifecycle/automation-anchor-scopes.test.ts src/lifecycle/headless-automation-compile.test.ts
bun run --filter @centraid/gateway test -- src/serve/vault-plane.test.ts
bun run --filter @centraid/client test -- src/react/screens/AutomationEditorScreen.test.tsx src/react/screens/AutomationEditorAnchorMention.test.tsx src/react/shell/routes/approvalsData.test.ts
bun run --filter @centraid/automation typecheck
bun run --filter @centraid/vault typecheck
bun run --filter @centraid/gateway typecheck
bun run --filter @centraid/client typecheck
bun run --filter @centraid/app-engine test -- src/conversation/store.test.ts src/conversation/runner-core.test.ts src/model-pricing.test.ts
bun run --filter @centraid/agent-runtime test -- src/backends/acp/backend.model-usage.test.ts src/backends/acp/backend.test.ts
bun run --filter @centraid/automation test -- src/fire/cursor-engine.test.ts src/fire/fire.test.ts
bun run --filter @centraid/client test -- src/react/shell/routes/automationTurnMessages.test.ts
bun run --filter @centraid/gateway test -- src/routes/automations-routes.test.ts src/lifecycle/interactive-automation-turn.test.ts src/lifecycle/headless-automation-compile.test.ts src/lifecycle/rewrite-automation-instructions.test.ts src/lifecycle/automation-anchor-scopes.test.ts
bun run --cwd apps/desktop test:e2e -- automations.spec.ts
bun run --cwd packages/gateway test -- src/serve/automation-event-sources.test.ts
bun run --cwd packages/gateway test -- src/serve/vault-plane.test.ts -t "execution scope clamps|no declared vault scopes"
bun run --cwd packages/client test -- src/react/shell/routes/automationTurnMessages.test.ts
bun run --cwd apps/mobile test -- src/lib/automations.test.ts
bun run --cwd packages/vault typecheck
bun run --cwd packages/automation typecheck
bun run --cwd packages/agent-runtime typecheck
bun run --cwd packages/gateway typecheck
bun run --cwd packages/client typecheck
bun run --cwd apps/mobile typecheck
bun run --cwd packages/gateway test -- src/routes/replica-shape.test.ts -t "uses the exact first grant/scope selected by canonical online consent"
bun run --cwd packages/vault test
bun run --cwd packages/gateway test -- src/lifecycle/automation-anchor-scopes.test.ts src/routes/replica-shape.test.ts
bun run --cwd packages/app-engine test -- src/conversation/store.test.ts src/conversation/store-prune.test.ts
bun run --cwd packages/automation test -- src/fire/cursor-engine.test.ts
bun run --cwd packages/client test -- src/react/shell/routes/automationTurnMessages.test.ts src/react/shell/routes/runViewData.test.ts
bun run check:pr:full
```

## Audit

**PASS — fresh-context final full-scope audit**

PASS — all 12 issue criteria remain implemented and mirrored verbatim in the receipt checklist/crosswalk (12/12, no mismatch). The 172-file index matches the diff with no missing or extra paths, and `## What changed` faithfully documents the four responsibility-preserving splits. Their files are 81–439 lines, original public import paths remain re-exported, and consumers are rewired without cycles or semantic changes. Focused suites passed 40/40, app-engine, automation, client, and gateway typechecks passed, `git diff --cached --check` passed, and `bun run check:pr:full` is green.

## Steering

**PASS** — The session contains the initial issue-scoping request and a later “continue” instruction, but no correction, redirect, or interruption of the implementation. The empty steering accounting section is therefore accurate.

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
| codex-019f9495-7c0-1784949655-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 402429 | 0 | 25121280 | 54112 | 456541 | 8.0981 | 2694409 | 0 | 120171264 | 310975 | feat(automations): resolve anchored references narrowly (#541) -m governance: al |
| codex-019f9495-7c0-1784949877-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 22803 | 0 | 2663168 | 4556 | 27359 | 0.7911 | 2717212 | 0 | 122834432 | 315531 | feat(automations): resolve anchored references narrowly (#541) -m governance: al |
| codex-019f9495-7c0-1784962125-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 2478691 | 0 | 114247168 | 249879 | 2728570 | 38.5067 | 5195903 | 0 | 237081600 | 565410 | fix(automations): close final replay and governance gaps (#541) -m governance: a |
