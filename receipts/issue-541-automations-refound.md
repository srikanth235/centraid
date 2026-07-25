# Receipt — Issue #541: Re-found automations

Issue: https://github.com/srikanth235/centraid/issues/541

## Checklist

- [x] A connector kind with 2+ configured accounts shows an inline account chooser (label + principal + health) in the editor picker; choosing one binds that `connectionId`; single-account kinds keep one-click toggle; a user-chosen binding survives catalog refresh.
- [x] An automation can pin its own **harness and model** via the Agent chip ("Use default (<pin>)" + `AGENT_RUNNER_KINDS` + model catalog); both persist as `requires.runner`/`requires.model` and override the subsystem prefs at fire, compile, and interactive-turn time; clearing either restores the default.
- [x] The `_automations` wire speaks `turn`/`item` (no `run`/`node` field names remain); the legacy run/node projection is gone; `RunViewScreen` still works via Details against the native names.
- [x] A `tool` item persists its ACP `callId` and parallel tool calls in one turn map to distinct items; each item's `rawJson` sidecar carries the untouched ACP envelope incl. the verbatim stop reason (a failed fire's card distinguishes `refusal` from `max_tokens`).
- [x] Per-turn token + cost come from the harness's ACP `usage` (`costSource:'agent'`) when reported, estimated fallback otherwise; a fire on **any** harness shows a non-zero, honest cost on its turn card and in the Insights rollup (closes #479's accounting gap).
- [x] The automation thread renders each turn's real trace — user/trigger bubble, coalesced tool rows, agent text — using the shared `Message` renderer; older turns collapse to summary until expanded; a running fire streams live with **no** 2s polling.
- [x] With the `automationTurns` capability, a reply (toggle OFF) executes a streamed `interactive` turn under the automation's already-granted scopes, visible on replay/second viewers, and **produces identical results on a cold vs. resumed session** (ledger preamble is sufficient); a stray `session/request_permission` from any harness is denied structurally with no UI dialog.
- [x] With toggle ON, the reply rewrites the instructions headlessly, recompiles via the existing compile seam, and the thread shows user bubble → "Revised instructions" → compile card.
- [x] All four triggers (cron/webhook/condition/data) fire through the **one** cursor engine loop with uniform dedup/idempotency; cron still skips (not backfills) missed windows, recording `skipped = k−1` per gap (ported `scheduler-ledger` contract stays green); a webhook POST is durable once ingressed (survives a mid-fire gateway restart) behind unchanged secret-hash auth; the engine's deny-list rejects cursors over `outbox.*`, `trigger_ingress`, bookkeeping tables, and the conversation ledger at both manifest validation and cursor registration; the four user-facing kinds and their editor UX are unchanged.
- [x] A bound Gmail account triggers an automation on new mail via a `historyId` poll cursor, and a bound GitHub repo on new PR/issue events via conditional-request polling; polled events land in `trigger_ingress` with provider-event-id idempotency (a re-listed event never double-fires); catch-up after sleep is bounded (per-wake cap, overflow recorded as `skipped`); an expired Gmail cursor re-baselines to now with a recorded gap, never a mailbox backfill; polls use only the automation's bound connection and its already-granted scopes.
- [x] *(Wave 10, if kept)* An anchored `@`-reference in instructions resolves to a `core_link_anchor` and the compiler derives a field/row-grain vault scope for it (narrower than the whole-table scope an unanchored token yields).
- [x] No runtime consent dialogs anywhere in the new flows.

## What changed

### Acceptance crosswalk

The issue’s completed acceptance text is preserved verbatim here so the receipt’s evidence groups below remain mechanically tied to every checked row:

- A connector kind with 2+ configured accounts shows an inline account chooser (label + principal + health) in the editor picker; choosing one binds that `connectionId`; single-account kinds keep one-click toggle; a user-chosen binding survives catalog refresh.
- An automation can pin its own **harness and model** via the Agent chip ("Use default (<pin>)" + `AGENT_RUNNER_KINDS` + model catalog); both persist as `requires.runner`/`requires.model` and override the subsystem prefs at fire, compile, and interactive-turn time; clearing either restores the default.
- The `_automations` wire speaks `turn`/`item` (no `run`/`node` field names remain); the legacy run/node projection is gone; `RunViewScreen` still works via Details against the native names.
- A `tool` item persists its ACP `callId` and parallel tool calls in one turn map to distinct items; each item's `rawJson` sidecar carries the untouched ACP envelope incl. the verbatim stop reason (a failed fire's card distinguishes `refusal` from `max_tokens`).
- Per-turn token + cost come from the harness's ACP `usage` (`costSource:'agent'`) when reported, estimated fallback otherwise; a fire on **any** harness shows a non-zero, honest cost on its turn card and in the Insights rollup (closes #479's accounting gap).
- The automation thread renders each turn's real trace — user/trigger bubble, coalesced tool rows, agent text — using the shared `Message` renderer; older turns collapse to summary until expanded; a running fire streams live with **no** 2s polling.
- With the `automationTurns` capability, a reply (toggle OFF) executes a streamed `interactive` turn under the automation's already-granted scopes, visible on replay/second viewers, and **produces identical results on a cold vs. resumed session** (ledger preamble is sufficient); a stray `session/request_permission` from any harness is denied structurally with no UI dialog.
- With toggle ON, the reply rewrites the instructions headlessly, recompiles via the existing compile seam, and the thread shows user bubble → "Revised instructions" → compile card.
- All four triggers (cron/webhook/condition/data) fire through the **one** cursor engine loop with uniform dedup/idempotency; cron still skips (not backfills) missed windows, recording `skipped = k−1` per gap (ported `scheduler-ledger` contract stays green); a webhook POST is durable once ingressed (survives a mid-fire gateway restart) behind unchanged secret-hash auth; the engine's deny-list rejects cursors over `outbox.*`, `trigger_ingress`, bookkeeping tables, and the conversation ledger at both manifest validation and cursor registration; the four user-facing kinds and their editor UX are unchanged.
- A bound Gmail account triggers an automation on new mail via a `historyId` poll cursor, and a bound GitHub repo on new PR/issue events via conditional-request polling; polled events land in `trigger_ingress` with provider-event-id idempotency (a re-listed event never double-fires); catch-up after sleep is bounded (per-wake cap, overflow recorded as `skipped`); an expired Gmail cursor re-baselines to now with a recorded gap, never a mailbox backfill; polls use only the automation's bound connection and its already-granted scopes.
- *(Wave 10, if kept)* An anchored `@`-reference in instructions resolves to a `core_link_anchor` and the compiler derives a field/row-grain vault scope for it (narrower than the whole-table scope an unanchored token yields).
- No runtime consent dialogs anywhere in the new flows.

When multiple Gmail/GitHub/etc. accounts exist, I can choose the exact one and only that account’s scopes are used:

- `packages/client/src/react/screen-contracts.ts` exposes every exact provider-and-kind connection, including principal and health.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` preserves every exact match instead of collapsing an ambiguous set.
- `packages/client/src/react/shell/routes/automationEditorConnections.test.ts` covers exact, absent, and multiple-match catalog behavior.
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx` renders an inline account chooser and binds the selected durable connection id.
- `packages/client/src/react/screens/AutomationEditorScreen.tsx` preserves an explicit account choice across catalog refreshes.
- `packages/client/src/react/screens/AutomationEditorScreen.module.css` styles the compact inline account controls with existing design tokens.
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx` proves account selection is saved and cannot be clobbered by a later refresh.
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx` isolates the multi-account interaction regression test below the repository file-size ceiling.

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

Full-gate concurrency exposed test-only timing assumptions. The scheduler expectations now match durable cursor bootstrap/catch-up, the handler busy-refusal test asserts causal ordering instead of a wall-clock race, the 50k-photo algorithm budget uses process CPU time so OS descheduling by parallel package suites is not charged to the algorithm, and desktop E2E polls for the lifecycle POST instead of assuming the asynchronous request is recorded in the same event-loop turn as the click.

The first GitHub `verify` run also exposed an instrumentation gap: the shipped browser and Electron journeys exercised the builder cloud, editor/thread route orchestration, and thin HTTP clients, but those surfaces had no direct Vitest contracts and therefore did not count toward the repository coverage ratchet. Focused behavioral contracts now drive overview/log/automation lifecycle controls, every automation/vault/outbox/log HTTP method, exact editor create/edit bindings, native cold/live thread streaming, steering, and provider failure/backoff/malformed-input branches. Provider failure contracts live in a companion test module so both suites remain below the repository source ceiling. The coverage floors remain unchanged.

The final governance pass also enforced the 500-line source ceiling. The shared turn attachment/locking helpers now live in `packages/app-engine/src/http/turn-sse-support.ts`; conversation prune/delete cases live in `packages/app-engine/src/conversation/store-prune.test.ts`; cursor contracts and pending-batch parsing live in `packages/automation/src/fire/cursor-engine-support.ts`; and the live automation reducer/projection lives in `packages/client/src/react/shell/routes/automationLiveMessages.ts`. These are responsibility-preserving splits of already-tested behavior, with all resulting modules below the cap.

The review-pass corrections pushed four test modules back over that ceiling, so the same
discipline applied again: ledger item/attachment cases moved to
`packages/app-engine/src/conversation/store-items.test.ts`, the owner-plane HTTP contracts to
`packages/client/src/gateway-client-vault.contract.test.ts`, the live-turn rejoin and cold-trace
retry cases to `packages/client/src/react/screens/AutomationThreadScreenTurnWatch.test.tsx`, and
the GitHub conditional-poll cases to
`packages/gateway/src/serve/automation-event-sources-github.test.ts`, each with a sibling
`*test-fixtures*` module so no fixture body is duplicated. Every split is a pure move — the
per-file test counts sum to the originals (23, 4, 22, and 10 respectively) with no assertion
deleted, weakened, or skipped.

### Review-pass corrections

An independent multi-agent review of this branch found defects the green gate did not catch.
They are fixed here rather than deferred, because each one falsified a claim this receipt
already makes.

**Durable delivery now means what it says.** The cursor contract gained one invariant: a cursor
may only advance to the position of an element that was actually delivered and acknowledged.
Rows past the per-read catch-up cap are *surplus* — still durable, delivered on the next tick —
not a gap. `packages/gateway/src/serve/trigger-ingress-cursor.ts` extracts the ingress read so
that invariant is unit-testable, and `packages/automation/src/fire/condition.ts` now requests
exactly the limit it can deliver instead of over-fetching 200 changes and committing a watermark
past 150 of them. `skipped`/`gapReason` is reserved for genuinely unrecoverable loss: a missed
cron window, an expired Gmail history, and now an ingress row that passed its retention TTL
before it was ever read — `pruneIngress` measures that loss per source and
`ingressRetentionGap` charges it only to the reader whose delivered position it actually
overtook. `packages/automation/src/fire/cursor-engine.ts` collapses every cron trigger of one
automation into a single registration, so two overlapping crons fire once per matching minute
instead of twice; keeps a doorbell rung during a failing batch instead of swallowing it;
retains cursors across a disable and treats an empty desired set as a no-op rather than a
vault-wide wipe; deletes by `(automation_id, trigger_index)` so a shrunken trigger list cannot
resurrect a stale position; and stops writing a cursor row on every quiet cron minute.
`cron-cursor.ts` scans backwards under a 31-day bound, dedupes a DST fall-back repeat, and no
longer fires on register. `condition.ts` gives each delivery occurrence a distinct position, so
the documented reminder behaviour — a row that leaves the trigger window and re-enters fires
again — is reachable instead of being suppressed by its own idempotency key.

**Accounting is honest under cancellation and unknown models.** `acp/backend.ts` emits `usage`
outside the abort gate and pre-seeds the resume baseline, so a cancelled turn books the tokens
it burned rather than advancing the cumulative ACP snapshot past them, and a prompt that never
returns cannot wipe the baseline into a double-booked next turn. `model-pricing.ts` and
`pricing/catalog.ts` drop the catalog-maximum fallback: an unpriceable model books NULL cost and
NULL provenance, restoring the module's own contract that unknown is not a number. `raw_json` is
capped at the same 64 KiB budget the ledger already applies to args and output — at the store
boundary in `conversation/store.ts` for every writer, and locally in
`lifecycle/automation-turn-context.ts` before a gateway SSE frame carries it — keeping #438's
bounded ledger and #544's disk budget intact. A denied ACP permission now selects the harness's
own `reject_once` option instead of answering `cancelled`, so a structural deny no longer reads
as whole-turn cancellation.

**Consent memory stops eroding.** `packages/vault/src/install-memory.ts` reverses the tombstone
sweep: a standing "no" is withdrawn only when an approved scope *covers* it, so approving one
anchored `core.core_task` read no longer deletes a schema-wide `core` refusal and re-prompts the
owner for something they declined. `packages/vault/src/gateway/consent.ts` intersects every
clamp scope covering a table instead of picking one by sort order, so a second same-table scope
can only narrow the first and the result is order-independent; the one shape intersection cannot
express — two scopes pinning the same column to different values, which is a union — throws a
named error instead of silently dropping a restriction. `packages/vault/src/scope-extent.ts` is
now the single canonical `scopeCovers`, so consent memory and install-grant reconciliation
cannot drift.

**The new anchor reads are receipted.** `lifecycle/automation-anchor-scopes.ts` and
`serve/vault-picker.ts` no longer reach into `db.vault` with interpolated SQL; every anchor,
link, source row, and content read goes through `gateway.read` with the owner credential and a
purpose, so `GET /centraid/_vault/anchors` leaves an audit trail instead of returning locker
titles silently. The scope-clamp algebra is untouched.

**Lifecycle plumbing.** `packages/gateway/src/journal-stores.ts` memoizes one `ConversationStore`
per `journal.db` path and can actually release it, closing a per-fire connection leak that
accumulated an unclosed handle and 64 MiB of mapped address space every few seconds on a
webhook-driven automation — `ConversationStore.close()` had been a documented no-op.
`lifecycle/automation-revision.ts` runs a revise under the same conversation lock an interactive
turn takes, and rolls the published prompt back with a visible `Instructions rolled back` turn
when the compile fails, so the thread can no longer show new instructions while the old
`handler.js` keeps firing. `stop()` drains detached automation work and conversation locks before
closing vault databases. The interactive-turn stream admits through the SSE subscriber cap and
refuses with a complete `503`, and the client treats any non-settled outcome as grounds for a
bounded rejoin with a Reconnect affordance — replacing a stream that, once dropped, left a
running turn spinning forever. A provider-supplied `x-poll-interval` is clamped to 15 minutes so
one response cannot park a trigger for years.

**Client honesty.** The cold projection and the live seed share one
`automationTurnInboundText`, so the headless compiler's internal work order is no longer
rendered as a message the owner supposedly typed. A connector binding whose account has vanished
from the catalog is surfaced as `Bound account unavailable` with the event trigger withdrawn,
rather than displaying a different surviving account while saving the dead id. A failed cold
trace read is distinguishable from an empty one and offers a retry instead of showing a spinner
and a Done footer at once. Messages key off ledger item ids, `RunViewScreen.module.css` uses a
real shell token, the retired `RunNodeDTO` payload is gone, the screenshot harness serves the
`turn` routes, and the automations contract test now fails closed on an unrouted path and
asserts method plus query parameters.

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
- `packages/client/src/gateway-client-automations.contract.test.ts`
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
- `packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`
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
- `packages/client/src/react/shell/routes/builder/BuilderCloud.test.tsx`
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
- `packages/gateway/src/serve/automation-event-sources-errors.test.ts`
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
- `packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx`
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
- `receipts/issue-541-automations-refound.md`
- `apps/desktop/scripts/screenshot-automations.mjs`
- `packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`
- `packages/agent-runtime/src/backends/acp/permissions.test.ts`
- `packages/agent-runtime/src/backends/acp/usage.test.ts`
- `packages/automation/src/fire/condition.test.ts`
- `packages/automation/src/fire/cron-cursor.test.ts`
- `packages/automation/src/fire/cursor-engine-support.test.ts`
- `packages/automation/src/fire/cursor-invariants.test.ts`
- `packages/client/src/react/shell/App.tsx`
- `packages/gateway/src/journal-stores.ts`
- `packages/gateway/src/journal-stores.test.ts`
- `packages/gateway/src/lifecycle/automation-revision.ts`
- `packages/gateway/src/lifecycle/automation-revision.test.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.test.ts`
- `packages/gateway/src/serve/trigger-ingress-cursor.ts`
- `packages/gateway/src/serve/trigger-ingress-cursor.test.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/install-memory.test.ts`
- `packages/vault/src/scope-extent.ts`
- `packages/vault/src/scope-extent.test.ts`
- `packages/vault/src/gateway/execution-clamp.test.ts`
- `packages/app-engine/src/conversation/store-items.test.ts`
- `packages/app-engine/src/conversation/store-test-fixtures.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-vault.contract.test.ts`
- `packages/client/src/react/screens/AutomationThreadScreen.test-fixtures.tsx`
- `packages/client/src/react/screens/AutomationThreadScreenTurnWatch.test.tsx`
- `packages/gateway/src/serve/automation-event-sources-github.test.ts`
- `packages/gateway/src/serve/automation-event-sources.test-fixtures.ts`

## Out of scope

- **Never dropping an undelivered ingress row.** The retention TTL still deletes
  `trigger_ingress` rows an automation stalled past 72 h never read; this change makes that loss
  measured and attributed (`ingress_retention`) instead of silent. Making it impossible needs a
  per-source undelivered floor plus a hard backlog ceiling — a durability design with its own
  tradeoffs against #544's disk budget, not a review-fix.
- **Runner launch modes.** `packages/agent-runtime/src/registry.ts` launches codex with
  `agent-full-access` and claude-code with `bypassPermissions`, so the automation turn's
  `permissionPolicy: 'deny'` is never exercised in production and confinement rests on `cwd`.
  The untrusted-data fencing below reduces the injection surface; closing it is a product
  decision about how automation turns are sandboxed.
- **A capability gate for the `run.*` → `turn.*` wire rename.** v0 carries no
  backward-compatibility obligation, so an older client meeting a newer gateway is out of scope.
- `AutomationTriggerStore` still opens its own handle on `journal.db` alongside the memoized
  conversation store, so each vault holds two. It does not leak; sharing one provider is a
  follow-up.

## Decisions

- The account chooser stays inside the existing Connectors popover so account identity is visible at the point of binding without adding another editor dialog.
- Anchor tokens carry only an opaque `core.link_anchor` id. Source type, row key, field mask, and exact span are always recovered from the addressed vault so authored instruction text cannot widen its own consent.
- Multiple anchors on one table use a bounded `in` row filter only for a rectangular scope with one shared field set. A non-rectangular combination is rejected because separate row and field unions would grant their Cartesian product.
- ACP session usage is cumulative, so the persisted resume handle and usage snapshot form one accounting state. A requested model is never substituted for live ACP confirmation.
- **No ledger-band column repair for pre-#541 `journal.db` files.** The conversation ledger gains
  `conversations.adapter_usage_json`, `items.call_id`, and `items.raw_json` plus a partial unique
  index over `call_id`, and `ensureConversationLedger` runs the DDL without `ALTER TABLE` repairs
  for them, so a journal created before this change fails to open. This is a deliberate v0 call
  by the project owner: pre-release carries no backward-compatibility or migration obligation and
  dev vaults are recreated. The vault audit band keeps its own COMPAT-tagged repair because that
  ladder is versioned independently.
- **An unpriceable model books NULL, not a ceiling.** The previous fallback charged the
  catalog-wide maximum per-token rate under `costSource: 'estimated'`, indistinguishable from a
  real estimate; a local model's run could report orders of magnitude over actual. Unknown is now
  absent rather than a maximal number, per the pricing module's own stated contract.
- **A dangling connector binding is surfaced, never silently rebound.** When the bound
  `connectionId` is gone from the catalog the editor says so and withdraws the connector-event
  trigger, but keeps the stored id: choosing a different account is the owner's decision, not a
  repair the editor may make on their behalf.
- **Prior-run output reaches the model as fenced untrusted data.** Interactive-turn context is
  flattened, defused, clipped per turn and in total, and wrapped in labelled untrusted-data
  fences. This bounds a prompt-injection path from webhook/Gmail/GitHub payloads into an agent
  whose permission prompts are bypassed; it does not close it (see Out of scope).

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
bun run --cwd packages/client test -- gateway-client-automations.contract.test.ts AutomationEditorRoute.test.tsx AutomationViewRoute.test.tsx BuilderCloud.test.tsx
bun run --cwd packages/gateway test -- automation-event-sources.test.ts automation-event-sources-errors.test.ts
bun run coverage
bun run test:diff-coverage
```

Review-pass corrections:

```sh
bun run --cwd packages/vault test -- src/install-memory.test.ts src/scope-extent.test.ts src/gateway/execution-clamp.test.ts
bun run --cwd packages/agent-runtime test -- src/backends/acp/usage.test.ts src/backends/acp/permissions.test.ts src/backends/acp/backend.model-usage.test.ts src/backends/acp/backend.test.ts
bun run --cwd packages/app-engine test -- src/model-pricing.test.ts src/conversation/store.test.ts src/conversation/trigger-store.test.ts
bun run --cwd packages/automation test -- src/fire/cron-cursor.test.ts src/fire/cursor-engine-support.test.ts src/fire/cursor-invariants.test.ts src/fire/condition.test.ts src/fire/cursor-engine.test.ts
bun run --cwd packages/gateway test -- src/journal-stores.test.ts src/serve/trigger-ingress-cursor.test.ts src/lifecycle/automation-revision.test.ts src/lifecycle/automation-turn-context.test.ts src/lifecycle/automation-anchor-scopes.test.ts
bun run --cwd packages/client test -- src/react/shell/routes/automationTurnMessages.test.ts src/react/screens/AutomationThreadScreen.test.tsx src/react/screens/AutomationEditorAccountChoice.test.tsx gateway-client-automations.contract.test.ts
bun run check:pr:full
```

## Audit

**PASS — fresh-context final full-scope audit**

PASS — all 12 authoritative GitHub acceptance rows match both the receipt checklist and acceptance crosswalk exactly; only checkbox state differs. The 176-file index matches the rebased diff with no missing or extra paths, no #498 receipt path remains, and `## What changed` faithfully documents the four responsibility-preserving splits plus the provider failure test companion. Their files are 81–491 lines, original public import paths remain re-exported, and consumers are rewired without cycles or semantic changes. The original focused suites passed 40/40 and the direct coverage contracts passed 21/21. Full coverage passed at 71.19% lines (104,810/147,211), 78.00% branches, and 74.51% gateway branches; changed-line coverage passed at 80.2% (4,361/5,441) without lowering a floor. App-engine, automation, client, and gateway typechecks passed, `git diff --check` and governance passed, and the final `bun run check:pr:full` completed 29/29 tasks with 1,052 gateway tests passing and six intentional skips.

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
| codex-019f9495-7c0-1784962166-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 3316 | 0 | 170240 | 273 | 3589 | 0.0549 | 5199219 | 0 | 237251840 | 565683 | fix(automations): close final replay and governance gaps (#541) -m governance: a |
| codex-019f9495-7c0-1784963138-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 333774 | 0 | 6656000 | 11549 | 345323 | 2.6717 | 5532993 | 0 | 243907840 | 577232 | docs(receipt): reconcile issue scope with main (#541) |
| codex-019f9495-7c0-1784964031-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 101994 | 0 | 6809600 | 6819 | 108813 | 2.0597 | 5637891 | 0 | 251251200 | 584364 | test(desktop): await automation lifecycle request (#541) |
| codex-019f9495-7c0-1784966365-1 | codex | 019f9495-7c00-7b70-a588-ca83afb8dcab | #541 | gpt-5.6-sol | 532618 | 0 | 13535744 | 44029 | 576647 | 5.3759 | 6170509 | 0 | 264786944 | 628393 | test(automations): cover route and provider contracts (#541) |
| claude-code-cb3cdd71-e6f-1784981974-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 289 | 962650 | 24179812 | 317857 | 1280796 | 26.0543 | 289 | 962650 | 24179812 | 317857 | fix(vault): stop a narrow approval from erasing a broad revocation (#541) |
| claude-code-cb3cdd71-e6f-1784983111-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 41 | 36770 | 5152438 | 12402 | 49213 | 3.1163 | 330 | 999420 | 29332250 | 330259 | fix(vault): stop a narrow approval from erasing a broad revocation (#541) |
| claude-code-cb3cdd71-e6f-1784983185-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 2 | 7320 | 506626 | 724 | 8046 | 0.3172 | 332 | 1006740 | 29838876 | 330983 | fix(automations): book cancelled turns and never price an unknown model (#541) |
| claude-code-cb3cdd71-e6f-1784983279-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 2 | 563 | 256973 | 167 | 732 | 0.1362 | 334 | 1007303 | 30095849 | 331150 | fix(automations): hold trigger cursors to elements they delivered (#541) |
| claude-code-cb3cdd71-e6f-1784983384-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 2 | 367 | 257536 | 165 | 534 | 0.1352 | 336 | 1007670 | 30353385 | 331315 | fix(gateway): close automation lifecycle leaks and receipt anchor reads (#541) |
| claude-code-cb3cdd71-e6f-1784983475-1 | claude-code | cb3cdd71-e6f1-4303-b704-a3339241de49 | #541 | claude-opus-5 | 2 | 504 | 257903 | 190 | 696 | 0.1369 | 338 | 1008174 | 30611288 | 331505 | fix(client): recover a dropped turn stream and stop faking owner messages (#541) |
