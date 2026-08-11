# Issue #743 — one agent door: vocabulary rationalization + automation dispatch convergence

## Checklist

- [x] Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`), `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`, `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated
- [x] Harness axis rename (`RunnerKind` → `HarnessKind`, `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` → `requires.harness`, …)
- [x] Delegate rail rename (`ctx.agent` → `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix)
- [x] Glossary / docs A1 write-back (forbidden synonyms, delegate step, schema-naming rule)
- [x] `ctx.delegate` dispatched through the accounted chat spine (metering, budgeted hydration, kind-scoped resume)
- [x] HarnessSessions extraction keyed `(conversationRef, harnessKind)`; per-binding settlement + multi-harness regression test
- [x] Per-call `harness`/`model`/`configPins` on `ctx.delegate`; consent fail-closed (#567 D13); compiler grounding + blueprint handlers regenerated
- [x] `@agentclientprotocol/sdk` adoption; `backends/acp/json-rpc.ts` deleted
- [ ] Close #740 as absorbed by this issue (per-call harness/model is item 5 of the Decision)

## What changed

- **Vault schema sweep (first slice).** The enrolled caller credential row moved out of the `agent`
  plane: `agent_agent` → `consent_agent`, defined beside `consent_app` / `consent_device` so the
  caller triple reads `consent.app` / `consent.device` / `consent.agent`. PK stays `agent_id`. The
  `agent` plane keeps the delegation ontology (`agent_command`, `agent_capability`, `agent_judgment`,
  `agent_correction`). Its credential column `host_key` → `enrollment_key` ("host" is
  glossary-loaded), threaded end-to-end through vault-plane enroll/revoke, gateway, replica, and
  client (`hostKey` → `enrollmentKey`). The journal audit-attribution column
  `agent_command_invocation.agent_id` → `caller_id` (the column holds any of the three caller
  kinds); provenance's genuine `agent_id`/`agent_kind` untouched. `media_media_asset` →
  `media_asset` (logical `media.asset`) across vault, gateway, blueprints, mobile, and the
  recognition-automation handler sources. v0: straight renames, no aliases, no migrations.
- Done in full: Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`),
  `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`,
  `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated.

- **Harness axis rename (second slice).** One axis, one word: the installed agentic CLI is a
  **harness** everywhere. Done in full: Harness axis rename (`RunnerKind` → `HarnessKind`,
  `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` →
  `requires.harness`, …). Concretely — `RunnerKind`/`RUNNER_KINDS`/`isRunnerKind` →
  `HarnessKind`/`HARNESS_KINDS`/`isHarnessKind`; `RunnerPrefs`/`RunnerModel`/`RunnerVersion` →
  `HarnessPrefs`/`HarnessModel`/`HarnessVersion`; `RunnerBackend`/`RUNNER_BACKENDS`/
  `getRunnerBackend` → `HarnessSpec`/`HARNESSES`/`getHarness` (plus
  `SUPPORTED_HARNESS_KINDS`/`SUPPORTED_HARNESSES`, `HARNESS_TIERS`); `AgentFailureClass` →
  `HarnessFailureClass`; `runnerHealth`/`RunnerHealthController` →
  `harnessHealth`/`HarnessHealthController` with `runner-health.ts` → `harness-health.ts`;
  `resolveSubsystemRunnerLadder` → `harnessLadder`. The adapter-named fields that never meant the
  npm adapter became harness-named: `adapterKind`/`latestAdapter`/`observedAdapter`/
  `prevAdapterKind`/`activeAdapterKind`, including the persisted `conversations.adapter_kind` →
  `harness_kind` and `conversation_harness_sessions.runner_kind` → `harness_kind` columns and the
  `runner_health` table → `harness_health`. Wire and config surfaces followed (v0, no compat):
  route `/centraid/_turn/runner-status` → `/centraid/_turn/harness-status` (RPC kind
  `app-runner-status` → `app-harness-status`), prefs keys `runner.*`/`agent.runner.kind` →
  `harness.*`/`agent.harness.kind`, daemon config `"runner"` block → `"harness"`, automation
  create/update body field `runner` → `harness`, manifest `requires.runner` → `requires.harness`,
  the `centraid-agent-failure:` marker's `runner` field → `harness`, and
  `CENTRAID_LIVE_FAILOVER_RUNNER` → `CENTRAID_LIVE_FAILOVER_HARNESS`. Gateway `cli/runner-prefs.ts`
  and `serve/runner-prefs.ts` (+test) became `harness-prefs.ts`. UI copy still says "Agents" (the
  market word); only identifiers moved.

- **Delegate rail rename (third slice).** Done in full: Delegate rail rename (`ctx.agent` →
  `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix). The handler's
  judgment rail is now `ctx.delegate`, leaving "agent" reserved for L2 principals. The worker
  surface exposes `ctx.delegate(...)` over renamed worker RPC messages `{type:"delegate"}` /
  `"delegate-reply"`; parent-side types became `DelegateDispatcher` / `DelegateCall` /
  `DelegateAttachment` / `DelegateContentRef` / `handleDelegateMessage`; `agent-answer.ts` →
  `delegate-answer.ts` with `coerceAgentAnswer` → `coerceDelegateAnswer` (re-exported from the
  package barrel). The fire spine and agent-runtime live dispatch followed, including
  `AGENT_FAILURE_PREFIX` → `DELEGATE_FAILURE_PREFIX` (wire value `centraid-agent-failure:` →
  `centraid-delegate-failure:`), `AutomationAgentFailure` → `AutomationDelegateFailure`,
  `parseAutomationAgentFailure` → `parseAutomationDelegateFailure`, and
  `HandlerOutcome.agentCalls` / `RunRecord.agentCalls` → `delegateCalls`. The ledger `ItemKind`
  union dropped `"agent"` for `"delegate"`, and every writer and reader moved with it — the
  `openRunNode` and interactive-automation-turn writers, the client run/turn/compile message
  readers, `hydration.ts`, and the SQL rollups in `store-sql.ts` / `reprice.ts` / `gateway-db.ts`
  including the `items` `CHECK` constraint and the `run_summary` view. Five blueprint automation
  handlers and the `photo-ocr` recognition-automation source now call `ctx.delegate(...)`, and the
  `no-ctx-tool` lint message plus the gateway authoring skills say `ctx.delegate`.
- **Regression fix.** The harness slice renamed the `conversations.adapter_kind` column to
  `harness_kind` but missed a raw SQL string in `tests/quality/user-facing-qualities.test.ts`,
  leaving F1 failing with `no such column: c.adapter_kind`. The query, its row type, and its loop
  variable are corrected here; the quality suite is back to 14/14.

- **Docs / glossary A1 write-back (fourth slice).** Done in full: Glossary / docs A1 write-back
  (forbidden synonyms, delegate step, schema-naming rule). `docs/glossary.md` now lists the ledger
  item kinds as `{message_in, step, tool, delegate}`, renames the manifest concept "agent variant"
  to **"delegate step"** (pairing with the existing "deterministic step"), and gains three
  forbidden-synonym rows — runner/adapter/backend/provider-as-CLI → **harness**; agent-for-the-
  model-turn-rail → **delegate** (agent reserved for principals); and the schema-naming rule that
  **a table never repeats its schema's name**, citing `agent_agent` → `consent_agent` and
  `media_media_asset` → `media_asset`. A tolerated dual-vocabulary row records that user-facing
  copy keeps "Agents" (the market word) while every identifier says `harness`, following the
  existing chat/conversation precedent. `docs/runners.md` was rewritten to harness vocabulary, and
  ARCHITECTURE.md, README.md, CONSTITUTION.md, TESTING.md, `docs/decisions.md`,
  `docs/blueprint-seats.md`, `docs/recognition-automations.md`, `docs/photos-derived-ledger.md`,
  and `docs/config-ownership.md` were swept for the renamed identifiers. CHANGELOG.md gains an
  Unreleased → Changed entry recording the breaking v0 renames.

- **One door, part (a): `ctx.delegate` through the accounted spine (fifth slice).** Done in full:
  `ctx.delegate` dispatched through the accounted chat spine (metering, budgeted hydration,
  kind-scoped resume). `run-automation-live-dispatch.ts` dropped its `getHarness(kind).runTurn`
  import and now takes the host's turn driver as a required `runTurn: RunTurnFn`, threaded through
  `RunAutomationOptions` and supplied by the gateway as `accountRunTurn(options.runTurn ?? runTurn)`
  — the same expression chat, builder, headless compile, and interactive steering already receive.
  An unattended fire is therefore measured in `ResourceAccounting.recordAgentRun` like every other
  turn, and its `delegate` ledger item is priced through the same `resolveItemCost` path; the one
  unmetered path in the system is closed. What legitimately differs between the four callers became
  data: `TURN_POSTURES` in `packages/app-engine/src/conversation/posture.ts` states each caller's
  consent mode, failover locus, hydration budget, permission policy, and artifact expectation in one
  place. The fire dispatch reads the `fire` row for its 8k / `minTurns: 2` budget, and `turn-sse.ts`,
  the headless compile, and the interactive steering turn now read their budget from that table
  instead of repeating `8_000`. Automation hydration compiles through one `compileBudgeted` helper
  that applies the posture budget and, exactly as chat does, treats a fold funding zero turns as no
  fold. Two adjacent drifts died with it — a binding that
  minted no session id now folds the whole ledger rather than the watermark's empty tail, and a
  recovery plan is compiled only against a resume handle that actually exists. The unkeyed
  `latestHarness` slot became a `Map` keyed by harness kind, so a fire reaching two harnesses can no
  longer resume one harness's opaque session id against the other. The consent check (#567 D13),
  `DELEGATE_FAILURE_PREFIX` marshalling, breaker behavior, and the `local`-tier seal are untouched.

- **One door, part (b): HarnessSessions (sixth slice).** Done in full: HarnessSessions extraction
  keyed `(conversationRef, harnessKind)`; per-binding settlement + multi-harness regression test.
  Four call sites each owned a private copy of the binding/resume/watermark planning — the chat SSE
  driver's `planFor` memo in `turn-sse.ts`, the fire's `resumable` map in
  `run-automation-live-dispatch.ts`, and hand-rolled `getHarnessBinding` +
  `hydrationMessagesFromLedger` + `compileHydrationPlan` blocks in `headless-automation-compile.ts`
  and `interactive-automation-turn.ts`. They collapse into one owner,
  `packages/app-engine/src/conversation/harness-sessions.ts`, keyed exactly as
  `conversation_harness_sessions` UNIQUE `(conversation_id, harness_kind, acp_session_id)` always
  said it should be. It owns the binding row, the resume decision (`TurnResumePlan` moved verbatim,
  preserving "resume only against the backend that minted the opaque session id"), the budgeted
  fold and its recovery counterpart, the hydration-token bill, retirement of an abandoned handle,
  and warm-process association. Both stores hand one out over a narrow `HarnessSessionsLedger`
  port, so no caller re-derives which session a harness resumes. `ConversationTurnInput
  .resumeForKind` became `harnessSessions`; `runner-core.ts` asks per rung and reports each rung
  back. Settlement is now per binding: `noteTurn` / `noteFailedTurn` take
  `readonly TouchedHarnessBinding[]` instead of one adapter, upserting every delivered binding,
  superseding predecessors, and advancing every watermark. The fire path retires stale bindings on
  recovery hydration exactly as chat does. Net 523 insertions / 797 deletions across the 19
  extraction-site files (net −274) plus the 286-line owner — roughly 555 lines of duplicated
  planning deleted.

- **One door, part (c): per-call harness/model/configPins (seventh slice, absorbs #740).** Done in
  full: Per-call `harness`/`model`/`configPins` on `ctx.delegate`; consent fail-closed (#567 D13);
  compiler grounding + blueprint handlers regenerated. `DelegateCall` gained optional `harness?`,
  `model?`, and `configPins?`, threaded through the worker RPC bridge (`worker/runner.ts`'s
  `ctx.delegate`, `handler/ctx.ts`'s `handleDelegateMessage`, the `WorkerToParentMessage` shape)
  into `run-automation-live-dispatch.ts`. `configPins` was already first-class on `TurnInput` and
  merely unreachable from handlers; it is reachable now. Naming is not constructing: a per-call
  `harness` is validated against the registry's `HarnessKind` union, and when it differs from the
  fire's own harness it is treated as code-authored and validated through
  `recordDerived("ladder", …)` exactly like an unauthored manifest `requires.harness` pin — never
  auto-granted. Because no retry exists inside `delegateDispatcher`, an explicitly named harness
  that fails surfaces its own typed failure and never silently falls over to a different provider;
  the whole-fire ladder cascade is orthogonal and untouched. Multi-turn continuity needs no session
  handle: repeating the same `harness` resumes the same binding through slice (b)'s keying.
  `HEADLESS_COMPILE_WORK_ORDER` and `packages/gateway/skills/automation-authoring/SKILL.md` now
  teach the per-call surface, so "use opencode deepseek-ocr for the OCR step" compiles to a
  `ctx.delegate({ harness, model, … })` on that call alone. Slice (b)'s acceptance test is
  literalized: it now makes two real `ctx.delegate({ harness })` calls naming `claude-code` and
  `codex`, so the issue's criterion reads verbatim, with assertions still on real DB rows.

- **One door, part (d): the ACP SDK owns the wire (eighth slice).** Done in full:
  `@agentclientprotocol/sdk` adoption; `backends/acp/json-rpc.ts` deleted. The hand-rolled wire
  layer — 218 lines of pending-request map, id allocation, frame dispatch, `AcpRpcError`, a
  hand-tracked `AUTH_REQUIRED_CODE`, and the `setHandlers` rebinding hook — is gone, replaced by
  `connection.ts` driving one spawned harness process through `@agentclientprotocol/sdk` pinned
  exactly at 1.3.0, alongside the two adapter packages already shipped from that org. The SDK's
  STABLE entrypoint (`client()` → `ClientApp.connect(stream)` → `ClientConnection`, plus
  `ClientContext.request/notify`, `RequestError`, `CLIENT_METHODS`, `PROTOCOL_VERSION`) now owns
  request/response correlation, JSON-RPC ids, error codes, the method-not-found answer for
  capabilities we never advertised, and teardown that rejects in-flight work; `experimental/v2` is
  imported nowhere. `AUTH_REQUIRED` is now derived rather than asserted — `agent-errors.ts`
  computes the code from `RequestError.authRequired().code` — so an unsigned-in harness still
  answers with its own `installHint`. Everything the SDK does not do is kept and green: launch
  specs, warm pooling, the capability probe and cache, stream normalization, the loopback vault MCP
  server, and usage normalization. Malformed frames no longer vanish: a line that opens like a
  frame and fails to parse fails the connection with a typed `AcpFrameError`, surfacing as a
  `TurnStreamEvent` error instead of hanging until the idle watchdog. Per the issue's design note a
  connection is owned by one session actor for its life — the handler set is fixed at connect time
  and only a turn-local sink is attached and released — so `setHandlers` was removed, not ported.

### Files touched (vault-schema slice)

Mechanical rename propagation; every path below changed only for the schema renames described above (or their formatting).

- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import-run.ts`
- `apps/mobile/src/apps/photos/memories-model.ts`
- `apps/mobile/src/apps/photos/people-model.test.ts`
- `apps/mobile/src/apps/photos/people-model.ts`
- `apps/mobile/src/apps/photos/photo-edit-save.ts`
- `apps/mobile/src/apps/photos/photos-collections.ts`
- `apps/mobile/src/apps/photos/photos-selection-writes.ts`
- `apps/mobile/src/apps/photos/photos-trash.ts`
- `apps/mobile/src/apps/photos/search-hits.test.ts`
- `apps/mobile/src/apps/photos/search-hits.ts`
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/photos/use-copy-to-vault.ts`
- `apps/mobile/src/apps/photos/viewer-menu.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/placement-transport.test.ts`
- `apps/mobile/src/screens/home/blueprint-search.ts`
- `apps/mobile/src/screens/home/tile-model.test.ts`
- `apps/mobile/src/screens/home/useSearchRecents.ts`
- `apps/mobile/src/screens/home/useSpringboardTiles.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/scope-kit.ts`
- `packages/blueprints/apps/notes/app.json`
- `packages/blueprints/apps/photos/actions/request-enrichment.ts`
- `packages/blueprints/apps/photos/actions/tag-asset.ts`
- `packages/blueprints/apps/photos/actions/update-asset.ts`
- `packages/blueprints/apps/photos/app-root.tsx`
- `packages/blueprints/apps/photos/components/Editor.tsx`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/SelectionBar.tsx`
- `packages/blueprints/apps/photos/enrichment-gate.ts`
- `packages/blueprints/apps/photos/format.ts`
- `packages/blueprints/apps/photos/queries/_shared.ts`
- `packages/blueprints/apps/photos/queries/duplicates.ts`
- `packages/blueprints/apps/photos/queries/face-queue.ts`
- `packages/blueprints/apps/photos/queries/library.ts`
- `packages/blueprints/apps/photos/queries/people.ts`
- `packages/blueprints/apps/photos/queries/search.ts`
- `packages/blueprints/apps/photos/scope-declaration.ts`
- `packages/blueprints/apps/photos/trash-actions.ts`
- `packages/blueprints/automations/embed-image/automations/embed-image/automation.json`
- `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`
- `packages/blueprints/automations/faces/automations/faces/handler.js`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/automation.json`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/transcript/automations/transcript/automation.json`
- `packages/blueprints/automations/transcript/automations/transcript/handler.js`
- `packages/blueprints/src/photos-library-store.test.ts`
- `packages/blueprints/src/photos-shelves-v4.test.ts`
- `packages/blueprints/src/photos-vocabulary.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/query-handlers.test.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/react/blueprints/centraid-inline-scopes.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/screens/privacyStores.test.ts`
- `packages/client/src/react/shell/routes/automationThreadData.test.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.test.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.ts`
- `packages/client/src/react/shell/routes/homeTileContent.test.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/replica/shell-session-scopes.test.ts`
- `packages/design/kit/elements-base.js`
- `packages/gateway/src/brief/daily-brief.test.ts`
- `packages/gateway/src/brief/daily-brief.ts`
- `packages/gateway/src/enrich/semantic-search.test.ts`
- `packages/gateway/src/enrich/semantic-search.ts`
- `packages/gateway/src/routes/commons-recovery-routes.test.ts`
- `packages/gateway/src/routes/commons-routes-intents.test.ts`
- `packages/gateway/src/routes/commons-routes.test.ts`
- `packages/gateway/src/routes/commons-routes.ts`
- `packages/gateway/src/routes/enrich-search-routes.test.ts`
- `packages/gateway/src/routes/import-routes.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/gateway/src/serve/commons-observability.test.ts`
- `packages/gateway/src/serve/demo-seed.test.ts`
- `packages/gateway/src/serve/peer-commons-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-hardening.test.ts`
- `packages/gateway/src/serve/peer-commons-sweep.test.ts`
- `packages/gateway/src/serve/peer-give.test-fixtures.ts`
- `packages/gateway/src/serve/peer-remote-give.test.ts`
- `packages/gateway/src/serve/peer-transport-remote.test.ts`
- `packages/gateway/src/serve/vault-plane-assistant.test.ts`
- `packages/gateway/src/serve/vault-plane-links.test.ts`
- `packages/gateway/src/serve/vault-plane-scopes.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/test-kit/src/year3-vault.ts`
- `packages/vault/README.md`
- `packages/vault/src/blob/flow.test.ts`
- `packages/vault/src/blob/local-orphan-sweep.test.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/blob/staging.ts`
- `packages/vault/src/bootstrap.ts`
- `packages/vault/src/commands/attachments.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/knowledge.test.ts`
- `packages/vault/src/commands/media-places.test.ts`
- `packages/vault/src/commands/media-purge.test.ts`
- `packages/vault/src/commands/media.test.ts`
- `packages/vault/src/commands/media.ts`
- `packages/vault/src/commands/parties.ts`
- `packages/vault/src/commands/tags.test.ts`
- `packages/vault/src/commands/tags.ts`
- `packages/vault/src/enrich/clusters.test.ts`
- `packages/vault/src/enrich/clusters.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/vault/src/enrich/face-clusters.ts`
- `packages/vault/src/enrich/memories.test.ts`
- `packages/vault/src/enrich/memories.ts`
- `packages/vault/src/gateway/cards.test.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.contract.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/identity.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/ingest/enrich-publishers.ts`
- `packages/vault/src/ingest/publishers.ts`
- `packages/vault/src/ingest/stage-file.ts`
- `packages/vault/src/ingest/takeout-photos.test.ts`
- `packages/vault/src/journal-archive.test.ts`
- `packages/vault/src/replica/change-log.test.ts`
- `packages/vault/src/replica/invocation-commits.test.ts`
- `packages/vault/src/replica/invocation-commits.ts`
- `packages/vault/src/replica/unavailable-columns.ts`
- `packages/vault/src/schema/agent.ts`
- `packages/vault/src/schema/atlas.ts`
- `packages/vault/src/schema/consent.ts`
- `packages/vault/src/schema/domains-home-business.ts`
- `packages/vault/src/schema/domains-social-knowledge-media.ts`
- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/journal.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/share/closure-location-policy.test.ts`
- `packages/vault/src/share/closure-split.test.ts`
- `packages/vault/src/share/closure.ts`
- `packages/vault/src/share/commons-chain.test.ts`
- `packages/vault/src/share/commons-convergence-properties.test.ts`
- `packages/vault/src/share/commons-derived-removal.test.ts`
- `packages/vault/src/share/commons-hardening.test.ts`
- `packages/vault/src/share/commons-lifecycle.test.ts`
- `packages/vault/src/share/commons-recovery.test.ts`
- `packages/vault/src/share/commons-retain-closure.test.ts`
- `packages/vault/src/share/commons-size.test.ts`
- `packages/vault/src/share/commons.test.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/share/household.test.ts`
- `packages/vault/src/share/placement-fixture.ts`
- `packages/vault/src/share/placement-lifecycle.test.ts`
- `packages/vault/src/share/placement.test.ts`
- `packages/vault/src/share/project-closure.ts`
- `packages/vault/src/share/projection-ingest.ts`
- `packages/vault/src/share/read-closure.ts`
- `packages/vault/src/share/removal.ts`
- `receipts/issue-743-one-agent-door.md`
- `tests/scale/large-vault.scale.test.ts`
- `tests/scale/phash-clustering.scale.test.ts`
- `tests/scale/photos-memories.scale.test.ts`
- `tests/scale/photos-timeline.scale.test.ts`
- `tools/recognition-automations/automation-handlers/embed-image.js`
- `tools/recognition-automations/automation-handlers/faces.js`
- `tools/recognition-automations/automation-handlers/photo-ocr.js`
- `tools/recognition-automations/automation-handlers/transcript.js`

### Files touched (harness-axis slice)

Mechanical rename propagation on the harness axis; every path below changed only for the renames described above (or their formatting).

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/desktop/tests/e2e/settings-gateways.spec.ts`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/assistant/useAssistant.test.ts`
- `apps/mobile/src/apps/assistant/useAssistant.ts`
- `apps/mobile/src/apps/insights/Insights.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/lib/assistant.test.ts`
- `apps/mobile/src/lib/assistant.ts`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/scripts/live-adapter-smoke.ts`
- `packages/agent-runtime/scripts/probe-all-adapters.ts`
- `packages/agent-runtime/src/automation/live-automation-failover.test.ts`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.test.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/agent-runtime/src/backends/acp/agent-errors.ts`
- `packages/agent-runtime/src/backends/acp/backend.model-usage.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/backends/acp/backend.vault-tools.test.ts`
- `packages/agent-runtime/src/backends/acp/blueprint-agent-parity.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/capabilities-cache.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.test.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.ts`
- `packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`
- `packages/agent-runtime/src/backends/acp/launch.ts`
- `packages/agent-runtime/src/backends/acp/probe-capabilities.ts`
- `packages/agent-runtime/src/backends/acp/session-config.ts`
- `packages/agent-runtime/src/backends/acp/session-warm.test.ts`
- `packages/agent-runtime/src/backends/acp/turn-vault-tools.ts`
- `packages/agent-runtime/src/backends/acp/types.ts`
- `packages/agent-runtime/src/backends/acp/usage.test.ts`
- `packages/agent-runtime/src/backends/acp/usage.ts`
- `packages/agent-runtime/src/conversation-adapter.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/matrix-contracts.test.ts`
- `packages/agent-runtime/src/matrix-durability.test.ts`
- `packages/agent-runtime/src/models/catalog-warmer.test.ts`
- `packages/agent-runtime/src/models/catalog-warmer.ts`
- `packages/agent-runtime/src/models/catalog.test.ts`
- `packages/agent-runtime/src/models/catalog.ts`
- `packages/agent-runtime/src/models/enumerators.test.ts`
- `packages/agent-runtime/src/models/enumerators.ts`
- `packages/agent-runtime/src/models/tiers.test.ts`
- `packages/agent-runtime/src/models/tiers.ts`
- `packages/agent-runtime/src/preflight.test.ts`
- `packages/agent-runtime/src/preflight.ts`
- `packages/agent-runtime/src/registry.test.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/agent-runtime/src/runtime.invalid-kind.test.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/types.ts`
- `packages/app-engine/README.md`
- `packages/app-engine/src/conversation/archive/segment.ts`
- `packages/app-engine/src/conversation/auto-title.test.ts`
- `packages/app-engine/src/conversation/auto-title.ts`
- `packages/app-engine/src/conversation/capture-classifier.test.ts`
- `packages/app-engine/src/conversation/capture-classifier.ts`
- `packages/app-engine/src/conversation/harness-health.test.ts`
- `packages/app-engine/src/conversation/harness-health.ts`
- `packages/app-engine/src/conversation/history.test.ts`
- `packages/app-engine/src/conversation/history.ts`
- `packages/app-engine/src/conversation/hydration.test.ts`
- `packages/app-engine/src/conversation/hydration.ts`
- `packages/app-engine/src/conversation/provider-egress-consent.test.ts`
- `packages/app-engine/src/conversation/provider-egress-consent.ts`
- `packages/app-engine/src/conversation/runner-core-types.ts`
- `packages/app-engine/src/conversation/runner-core.failover.test.ts`
- `packages/app-engine/src/conversation/runner-core.test.ts`
- `packages/app-engine/src/conversation/runner-core.ts`
- `packages/app-engine/src/conversation/runner.ts`
- `packages/app-engine/src/conversation/schema.ts`
- `packages/app-engine/src/conversation/store-sql.test.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/conversation/store.ts`
- `packages/app-engine/src/conversation/turn.test.ts`
- `packages/app-engine/src/conversation/turn.ts`
- `packages/app-engine/src/http/router.ts`
- `packages/app-engine/src/http/turn-routes.test.ts`
- `packages/app-engine/src/http/turn-routes.ts`
- `packages/app-engine/src/http/turn-sse.test.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/insights/README.md`
- `packages/app-engine/src/insights/index.ts`
- `packages/app-engine/src/insights/insights-sql.ts`
- `packages/app-engine/src/insights/insights-store.test.ts`
- `packages/app-engine/src/insights/insights-store.ts`
- `packages/app-engine/src/insights/insights-types.ts`
- `packages/app-engine/src/runtime.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/app-engine/src/stores/prefs-store.test.ts`
- `packages/app-engine/src/stores/prefs-store.ts`
- `packages/automation/src/fire/enrich-gate.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/audit.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/manifest/manifest.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold-files.test.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/blueprints/src/__snapshots__/scaffold-defaults.test.ts.snap`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/scaffold-defaults.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-automations.contract.test.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx`
- `packages/client/src/react/screens/AutomationEditorAgentPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/BuilderChatPane.test.tsx`
- `packages/client/src/react/screens/BuilderChatPane.tsx`
- `packages/client/src/react/screens/InsightsScreen.test.tsx`
- `packages/client/src/react/screens/InsightsScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/agentGlyphs.tsx`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.test.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.test.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/assistantTranscript.ts`
- `packages/client/src/react/shell/routes/automationEditorAgentData.ts`
- `packages/client/src/react/shell/routes/automationEditorCreateData.ts`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.test.ts`
- `packages/client/src/react/shell/routes/builder/BuilderShell.tsx`
- `packages/client/src/react/shell/routes/builder/useBuilder.test.ts`
- `packages/client/src/react/shell/routes/builder/useBuilder.ts`
- `packages/client/src/react/shell/routes/runViewData.test.ts`
- `packages/client/src/react/shell/routes/settingsProvidersData.test.ts`
- `packages/client/src/react/shell/routes/settingsProvidersData.ts`
- `packages/design/kit/conversation-client.js`
- `packages/design/kit/kit.ts`
- `packages/design/kit/turn-stream.d.ts`
- `packages/gateway/README.md`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/cli/cli.test.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/config.ts`
- `packages/gateway/src/cli/harness-prefs.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.test.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.test.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.test.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/agents-routes.test.ts`
- `packages/gateway/src/routes/agents-routes.ts`
- `packages/gateway/src/routes/assistant-routes.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/routes/route-helpers.ts`
- `packages/gateway/src/runs/assistant-conversation-runner.ts`
- `packages/gateway/src/runs/assistant-prompt.ts`
- `packages/gateway/src/runs/unified-conversation-runner.test.ts`
- `packages/gateway/src/runs/unified-conversation-runner.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/harness-prefs.test.ts`
- `packages/gateway/src/serve/harness-prefs.ts`
- `packages/gateway/src/serve/resource-accounting.ts`
- `packages/gateway/src/serve/runner-prefs.test.ts`
- `packages/gateway/src/serve/runner-prefs.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/vault/src/host.ts`
- `tests/perf/agent-turn.perf.test.ts`
- `tests/quality/user-facing-qualities.test.ts`
- `tests/scale/agent-sessions.scale.test.ts`

### Files touched (delegate-rail slice)

The delegate-rail rename plus the `harness_kind` SQL regression fix; every path below changed only for those.

- `apps/desktop/scripts/screenshot-automations.mjs`
- `packages/agent-runtime/src/automation/live-automation-failover.test.ts`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.test.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/app-engine/src/conversation/hydration.ts`
- `packages/app-engine/src/conversation/reprice.ts`
- `packages/app-engine/src/conversation/schema.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/app-engine/src/stores/prefs-store.ts`
- `packages/automation/README.md`
- `packages/automation/src/fire/connector.test.ts`
- `packages/automation/src/fire/enrich-gate.test.ts`
- `packages/automation/src/fire/enrich-gate.ts`
- `packages/automation/src/fire/enrich-refusal-outcome.test.ts`
- `packages/automation/src/fire/fire-vault.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/delegate-answer.ts`
- `packages/automation/src/handler/lint.test.ts`
- `packages/automation/src/handler/lint.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/handler.js`
- `packages/blueprints/automations/doc-filer/automations/doc-filer/handler.js`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`
- `packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/handler.js`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/release-notes-drafter/automations/release-notes-drafter/handler.js`
- `packages/blueprints/src/__snapshots__/scaffold-defaults.test.ts.snap`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/scaffold-defaults.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/react/shell/routes/automationCompileData.ts`
- `packages/client/src/react/shell/routes/automationLiveMessages.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.test.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.ts`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.tsx`
- `packages/client/src/react/shell/routes/connectorPlatform.ts`
- `packages/client/src/react/shell/routes/runViewData.test.ts`
- `packages/client/src/react/shell/routes/runViewData.ts`
- `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/runs/run-events-sse.test.ts`
- `packages/vault/src/enrich/policy.ts`
- `receipts/issue-743-one-agent-door.md`
- `tests/perf/automation-fire.perf.test.ts`
- `tests/quality/user-facing-qualities.test.ts`
- `tools/recognition-automations/automation-handlers/photo-ocr.js`

### Files touched (docs write-back slice)

Markdown only; no code changed in this slice.

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CONSTITUTION.md`
- `README.md`
- `TESTING.md`
- `docs/blueprint-seats.md`
- `docs/config-ownership.md`
- `docs/decisions.md`
- `docs/glossary.md`
- `docs/photos-derived-ledger.md`
- `docs/recognition-automations.md`
- `docs/runners.md`
- `receipts/issue-743-one-agent-door.md`

### Files touched (convergence (a) slice)

- `packages/agent-runtime/src/automation/live-automation-failover.test.ts`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.test.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/app-engine/src/conversation/posture.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/gateway/src/lifecycle/automation-delegate-metering.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `receipts/issue-743-one-agent-door.md`

### Files touched (convergence (b) slice)

- `docs/runners.md`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation-multi-harness.test.ts`
- `packages/agent-runtime/src/automation/run-automation-per-call-harness.test.ts`
- `packages/app-engine/src/conversation/harness-sessions.ts`
- `packages/app-engine/src/conversation/history.test.ts`
- `packages/app-engine/src/conversation/history.ts`
- `packages/app-engine/src/conversation/runner-core.failover.test.ts`
- `packages/app-engine/src/conversation/runner-core.ts`
- `packages/app-engine/src/conversation/runner.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/conversation/store.ts`
- `packages/app-engine/src/http/turn-sse.test.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `receipts/issue-743-one-agent-door.md`
- `tests/quality/fixtures/kill-mid-write-child.ts`
- `tests/quality/user-facing-qualities.test.ts`

### Files touched (convergence (c) slice)

- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation-multi-harness.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `receipts/issue-743-one-agent-door.md`

### Files touched (convergence (d) slice)

- `bun.lock`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/src/backends/acp/agent-errors.test.ts`
- `packages/agent-runtime/src/backends/acp/agent-errors.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/backends/acp/connection.test.ts`
- `packages/agent-runtime/src/backends/acp/connection.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.ts`
- `packages/agent-runtime/src/backends/acp/json-rpc.ts`
- `packages/agent-runtime/src/backends/acp/probe-capabilities.ts`
- `packages/agent-runtime/src/backends/acp/session-warm.test.ts`
- `packages/agent-runtime/src/backends/acp/session-warm.ts`
- `receipts/issue-743-one-agent-door.md`

## Out of scope

- Renaming the `@centraid/agent-runtime` npm package (README disclaimer instead — see issue).
- `providerEgressConsent` → `EgressConsent` (egress language legitimately says "provider").
- Rewriting historical journal rows with item `kind:"agent"` (mixed historical values accepted).
- `experimental/v2` of the ACP SDK; a `ctx.acp` rail; worktree-store/publish mechanics; new consent UI.

## Decisions

- `hostKey` → `enrollmentKey` was threaded through the TypeScript mirrors end-to-end
  (gateway-client, automation thread routes, mobile) rather than only the SQL column — it is the
  same field on the wire, and v0 has no compat layer to absorb a split name.
- The logical registry entry for the media table is `media.asset` (not `media.media_asset`): the
  schema-naming rule ("a table never repeats its schema's name") applies to the dotted entity name
  too, so `tables.ts` maps `media` → `asset`.
- Two live fixtures encoded the old names as *data*, not identifiers, and were updated as
  functional changes: `packages/blueprints/apps/notes/app.json` grant scope
  (`media/media_asset` → `media/asset`) and a `consent_policy.applies_table` fixture in
  `duties.test.ts`.
- Provenance's `agent_id` / `agent_kind` and the invocation table's genuine agent reference keep
  their names — only the journal audit-attribution column (which holds any of the three caller
  kinds) became `caller_id`.
- Legacy ledger rows with item `kind:"agent"` are accepted as mixed historical data (the issue's
  settled default) and read-mapped to `"delegate"` at the single SQL-row → `Item` boundary in
  `store-sql.ts`. No migration was written; journals are audit history and v0 installs are few.
- The `items` `CHECK (kind IN (…))` constraint now lists `'delegate'`, but the table is created
  `IF NOT EXISTS`, so a vault whose `items` table predates this change keeps its old CHECK and
  would reject `kind:"delegate"` writes until the table is recreated. The `run_summary` view
  self-heals (it is dropped and recreated when its stored SQL text differs). This is the same
  class of v0 breakage for existing installs that the vault-schema and harness-axis slices already
  accepted — called out here so it is not mistaken for an oversight.
- `AutomationAgentSelection` / `resolveAutomationAgentSelection` keep their names: their fields
  (`harness`, `selectionSource`, `model`, `configPins`) name the *harness choice* for an
  automation, not the delegate rail.
- `CostSource` (`"agent" | "estimated"`), `AppChange.source`, and `Attachment.source: "agent"` were
  left alone — they describe "reported by the model/ACP harness", a different axis than the rail,
  and the issue's rename list does not name them. The manifest's `agentVariant` / "agent variant"
  → "delegate step" wording belongs to the glossary write-back slice.
- `docs/runners.md` keeps its filename rather than becoming `harnesses.md`: its one inbound link
  lives in `packages/agent-runtime/src/registry.ts`, a `.ts` file outside the docs slice's edit
  fence. The issue's acceptance criteria already list `docs/runners.md` scope as a tolerated case.
  The file's prose is fully harness-vocabulary, with a note at the top pointing at the glossary's
  tolerated-dual entry.
- Governance-frozen historical sections were deliberately NOT rewritten: CONSTITUTION.md's
  Evolution Log and QUALITY.md's Resolved list are declared `frozen-section` in
  `.governance/conf/.../doc-integrity.conf` and describe past PRs in the vocabulary current at the
  time. The live `handler-uses-ctx-primitives` directive text WAS updated.
- `docs/runners.md`'s "billed rail" line documented a stale positional signature
  (`ctx.agent(prompt, { json, model })`); it was corrected to the real options-object form
  `ctx.delegate({ prompt, json, model })` rather than mechanically substituting the new name into
  a wrong signature.
- Glossary L2/L4 entries keep the word "agent": they describe autonomous *principals*, which is
  precisely the surviving meaning under the new forbidden-synonym row.
- **Behavior change, called out explicitly:** fire turns now send `permissionPolicy: "deny"`.
  Previously the fire sent none and the ACP default applied. The issue's posture table specifies
  `deny` for `ctx.delegate`, compile and steering already send it, and nobody is present to answer
  a permission request (#484). This is the one change in slice (a) that is not pure drift-deletion.
- No `TurnPlane` class was built. The issue sequences (a) as "point `ctx.delegate` at the accounted
  chat spine ... before any new abstraction", so the abstraction added is one data table plus one
  injected seam; the rest of the production diff is substitution or deletion.
- `TURN_POSTURES` has five fields, three of which are read today (`consent`, `hydration`,
  `permissions`). `failover` and `artifacts` are recorded but structural — in-turn rungs live in
  `runner-core.ts`, new-run rungs in `run-automation.ts`, and "artifacts" is conferred by being
  handed a writable worktree cwd rather than by a flag. The file header says so, so the table does
  not overstate itself; both become read fields when the one door owns cwd and ladder walking.
- `runTurn` is a REQUIRED option, not optional with a registry fallback: a default would silently
  restore the unmetered path.
- Per-binding settlement is deliberately NOT done here. `finalizeTurn` still settles the last
  binding touched through the single-binding `noteTurn` / `noteFailedTurn` API. Slice (a) fixes the
  *resume* half of the `latestAdapter` bug class; the *settlement* half needs the store shape change
  that belongs to HarnessSessions, and the two-harness settlement regression test lands with it.
- The metering guarantee is asserted at two levels: behaviorally (harness calls == accounted-seam
  calls) and structurally (the dispatch module's source contains no `../registry.js` import and no
  `getHarness(` call), because the behavioral half alone cannot stop a future edit reopening the fork.
- **The issue's hydration diagnosis was partly inaccurate, and the receipt says so rather than
  inheriting it.** #743 describes the fork's hydration as "eager, **no budget**, always
  `forceHydration: true`". In fact `compileHydrationPlan` has defaulted to `tokenBudget ?? 8_000`
  and `minTurns ?? 2` since #567, and the fork called it without an override — so the 8k budget
  already applied and the automation path was never truly unbudgeted. What this slice actually
  changes is: the budget is now *sourced from* `TURN_POSTURES` instead of re-derived by default
  (so chat and fire cannot drift apart again), a fold that funds zero turns is treated as no fold,
  and a recovery plan is compiled only against a resume handle that exists. `forceHydration`
  itself remains — it means "fold even though the harness could resume", which is correct for a
  cold fire, and it is now always budgeted. The acceptance criterion "no unbudgeted
  `forceHydration` path" holds, but it was closer to true before this slice than the issue implies.
- **Test-quality note, disclosed rather than papered over.** The "same token budget as chat" test
  asserts the fold fits 8k and drops oldest-first; because the 8k default pre-existed, that test
  would likely also pass against the pre-slice code, so it documents the invariant rather than
  discriminating this change. Its comment was corrected to say exactly that instead of claiming the
  fork "used to hand the harness the entire ledger, unbounded", which was false. A discriminating
  test for the zero-turn-fold rule would require a hydration-budget override on the production
  dispatch options purely for testing; that was judged a worse trade than an honest comment.
- **The acceptance criterion for this slice is satisfied in substance but NOT yet literally.** It
  reads "a fire whose handler calls `ctx.delegate` twice with two different harnesses". `ctx.delegate`
  cannot name a harness until slice (c), so the regression test drives the fire twice while the
  injected accounted `runTurn` reports `claude-code` for the first call and `codex` for the second —
  legitimate, because `TurnResult.harnessKind` documents itself as echoing the kind that produced
  `sessionId`. The invariant under test is identical and the assertions are on real rows: call 2 is
  handed codex's own session id, not the claude-code one minted a moment earlier, and both bindings
  settle. When (c) lands, the test's two landing branches become two literal
  `ctx.delegate({ harness })` calls and the criterion reads literally.
- The test was **demonstrated red before green**: keying the memo on the planned kind instead of the
  minting kind reproduces the `latestAdapter` bug and fails with
  `expected 'session-claude-new' to be 'session-codex-old'`.
- **This is an extraction, not a new layer — with one honest exception.** The planning code is a
  genuine four-copies-to-one move and the diff is net-negative even counting the new module. The
  added piece is the `HarnessSessionsLedger` port, needed because two stores (journal-direct
  `ConversationStore` and app-scoped `ConversationHistoryStore`, with different hydration reads and
  blob-path resolution) must drive the same owner. Three functions plus an optional fourth, defined
  next to its only consumer.
- **`TouchedHarnessBinding` gained an `ok` flag — an addition, not a move.** Once a turn settles
  several bindings, delivered and errored must be distinguishable per binding: a chat failover turn
  can end `ok` overall while rung 0 errored, and advancing rung 0's watermark would erase the user's
  message from every later fold.
- The `conversation_harness_sessions` SQL stayed in the store: `HarnessSessions` owns the
  *decisions*, the store owns the writes. Moving the SQL in would have made the owner a second store.
- `hydration_count` now increments per hydrating binding rather than once per turn — a two-harness
  turn that re-folded twice genuinely paid twice.
- Deleted `ConversationTurnInput.prevBindingId`, a pre-existing dead field (written by `turn-sse`,
  read by nobody) belonging to the concern this slice owns.
- **The 5 blueprint automation handlers were NOT re-bundled, and that is a deliberate reading of
  the scope.** They already call `ctx.delegate(...)` — the delegate-rail slice updated all five.
  Their sources (`tools/recognition-automations/automation-handlers/*.js`) are standalone JS with no
  imports from `packages/automation` or `agent-runtime`, so nothing in slice (c) changes their
  compiled output, and running the bundler in this sandbox is known to rewrite all five wholesale
  with non-reproducible minification. Adding a per-call `harness`/`model` to `photo-ocr.js` purely
  to demonstrate the feature would be an unrequested behavior change to a shipped automation, which
  the issue's own Out list ("recognition / delegate-step behavior changes beyond renames") excludes.
- **A per-call harness is always consented as `ladder`, never `direct`.** A harness named inside
  handler code was not chosen live in Settings, so it cannot inherit the fire's `direct` consent.
  This is a judgment call that follows from D13's "naming is not constructing" rather than being
  spelled out verbatim in the issue.
- **The compile → publish → fire round-trip criterion is only partially covered, stated plainly.**
  The publish → fire half is genuinely exercised end-to-end through a real `worker_threads`
  boundary. The compile half is grounded and asserted at the prompt level
  (`HEADLESS_COMPILE_WORK_ORDER` content is tested) but NOT executed through a live LLM, because
  that needs a real coding-agent harness this environment cannot drive. Recorded here rather than
  claimed as done.
- **A test file was split to respect the repo-hygiene line cap.** Slice (c)'s new cases pushed
  `run-automation-dispatch.test.ts` to 707 lines against a 625 limit. Rather than waive the
  directive, the per-call harness/model/configPins block moved to
  `run-automation-per-call-harness.test.ts` (with the consent-store helper it needs), leaving both
  files under the cap.
- **`session/update` notifications deliberately BYPASS the SDK's client-app dispatch — the most
  significant deviation in this PR, recorded in full.** `ClientApp`'s constructor unconditionally
  installs a static handler that runs `zSessionNotification.parse` ahead of every user handler,
  including one registered with a pass-through parser; a notification the generated union rejects
  is discarded with a `console.error` and no handler runs. That closed union would silently drop
  any vendor `sessionUpdate` variant, a `usage_update` lacking the required `used`/`size` (our
  `--cost`-only shape), and any plan entry lacking `priority`/`status` — and would strip the vendor
  fields `stream-events.ts` deliberately reads (`filePath` on diffs, `output`/`text` on terminal
  blocks, token counts on `usage_update`, plan `text`/`title`). Routing updates through it would
  have re-introduced exactly the silent-drop this slice exists to remove AND degraded the
  normalization the issue says to keep, so updates reach the sink unparsed. Requests
  (`session/request_permission`) DO go through the SDK — there is no schema router for requests.
  Net: the SDK owns the wire and the request path; the update path is transport-only by choice.
- **The transport is a hand-built `Stream` rather than the SDK's `ndJsonStream`**, for two
  behavioural reasons: writes must go through `safeStdinWrite` to survive a closed pipe, and
  `ndJsonStream` `console.error`s and *drops* unparseable lines — the precise silent-drop being
  removed. What stays hand-written is ~35 lines of stdio↔`Stream` adapter (the SDK has no
  stdio-child adapter on the stable path); the protocol layer is fully deleted.
- **stdout EOF fails the stream with `new Error("acp agent exited")`** rather than the SDK's
  generic "ACP connection closed", which would have erased the cause `classifyAgentFailureDetail`
  keyword-classifies and regressed the nonzero-exit test from `exit` to `unknown`.
- **A malformed frame now kills the connection** where it was previously skipped. Non-`{` stdout
  chatter (banners, progress) is still ignored exactly as before; the strictness applies only to
  lines that open like a frame. That failure classifies as `unknown` — `HarnessFailureClass` was
  not extended with a `protocol` member, since that union is owned by `app-engine` and feeds the
  breakers.
- `session/cancel` on abort is now async (`ClientContext.notify` awaits a stream write) where it
  was a synchronous send; the frame is enqueued rather than written before `SIGTERM`. Updates are
  now delivered synchronously from the stdout handler while responses go through the SDK's async
  reader, so an update can only arrive earlier relative to a response than before, never later.
- **Scope caveat on the SDK checkbox, from the independent audit:** the JSON-RPC transport
  (framing, ids, `RequestError` codes) is genuinely SDK-owned, but `session/update` payload
  interpretation — the highest-volume inbound frame, carrying the whole turn stream — is
  deliberately kept outside the SDK's typed dispatch by necessity. A maintainer should NOT read
  the acceptance checkbox as "every frame is now SDK-typed". The audit verified the underlying
  claim against `node_modules/@agentclientprotocol/sdk/dist/acp.js` rather than taking it on
  trust: `ClientApp`'s constructor registers a static handler first in the chain that calls the
  THROWING `zSessionNotification.parse`, and an exception aborts the whole per-message handler
  loop in `Connection.processIncomingMessage`, so no later handler ever runs.

## Verification

- `packages/vault`: 1255 passed / 2 skipped; 1 pre-existing failure (`wal-shipper.test.ts` G4,
  untouched by this diff). `packages/blueprints`: 3300/3300. `packages/gateway` replica-shape suite
  green after fixture update.
- `git grep -n 'agent_agent\|media_media_asset\|host_key' -- packages apps` → zero hits.
- Reviewer replay:

```sh
git grep -n 'agent_agent\|media_media_asset\|host_key' -- packages apps  # expect zero hits
bun run --cwd packages/vault test
bun run --cwd packages/blueprints test
```

- **Delegate slice.** `bun run typecheck` green (35/35). `packages/automation` 419/419,
  `packages/app-engine` 625/625, `packages/client` 2027/2027, `packages/blueprints` 3300/3300 green.
  `tests/quality/user-facing-qualities.test.ts` 14/14 after the `harness_kind` SQL fix. Remaining
  failures are pre-existing and reproduce unchanged on `origin/main`: agent-runtime
  `launch.test.ts` (2 `IS_SANDBOX` env assertions), vault `wal-shipper.test.ts` G4, gateway
  `gateway-db-lock.integration.test.ts` (sandbox sqlite3).
- Reviewer replay for the delegate slice:

```sh
git grep -n 'ctx\.agent\b\|AgentDispatcher\|coerceAgentAnswer\|centraid-agent-failure' -- packages apps tools tests  # expect zero hits
bun run typecheck
bun run --cwd packages/automation test
bunx vitest run --config vitest.quality.config.ts user-facing-qualities
```

- **Docs slice.** `bun run test:qualities` → 4 files / 23 tests passed. `bash .governance/run.sh`
  → `internal-doc-links` and `doc-integrity` pass (no frozen section touched, no doc link broken).
  The attestation audit caught `format-check` failing on three of this slice's own files
  (`CHANGELOG.md`, `docs/config-ownership.md`, `docs/glossary.md` — emphasis style and a stale
  table column width); they were formatted with the pinned oxfmt and restaged, and the directive
  now passes.

- **Convergence (a).** `bun run typecheck` green (35/35). app-engine 625/625, automation 419/419,
  agent-runtime `src/automation` 25/25, gateway lifecycle+build+automation-routes 136 tests green,
  new `automation-delegate-metering.test.ts` 2/2, `user-facing-qualities` 14/14, `bun run knip`
  clean. Acceptance-criteria mapping: priced+recorded through the same wrapper and hydration tokens
  on automation turns → `automation-delegate-metering.test.ts`; no path reaches a harness without
  the accounted seam → `run-automation-dispatch.test.ts` + the `startLiveDispatch` seam assertion;
  budgeted hydration → `run-automation-dispatch.test.ts` (a 40-turn ledger folds within 8k, oldest
  turns dropped and counted). Pre-existing failures unchanged and reproducing on `origin/main`:
  agent-runtime `launch.test.ts` (2 IS_SANDBOX assertions), gateway
  `gateway-db-lock.integration.test.ts`.
- Reviewer replay for slice (a):

```sh
bun run typecheck
bunx vitest run --root packages/gateway src/lifecycle/automation-delegate-metering.test.ts
bunx vitest run --root packages/agent-runtime src/automation
```

- **Convergence (b).** `bun run typecheck` green (35/35). app-engine 625/625, automation 419/419,
  new `run-automation-multi-harness.test.ts` 2/2 (two-harness regression + fire-path stale
  retirement), `user-facing-qualities` 14/14, `bun run knip` clean. Pre-existing failures unchanged:
  agent-runtime `launch.test.ts` (2 IS_SANDBOX), gateway `gateway-db-lock.integration.test.ts`.
  NEW flake class observed and reported for QUALITY.md, unrelated to this slice: gateway
  `vault-plane-commons.test.ts` and `serve-scheduler-reconcile.test.ts` each time out under
  full-suite load and pass in isolation.

- **Convergence (c).** `bun run typecheck` green (35/35). automation 420/420, blueprints
  3300/3300, agent-runtime 355/358 (3 = the 2 known `launch.test.ts` IS_SANDBOX + 1 skip),
  app-engine 624/625 (1 known `handler-pool` timeout), `user-facing-qualities` 14/14, knip clean.
  New tests: literalized two-harness test; per-call `{harness, model, configPins}` drive test;
  per-call harness absent from the ladder fails closed; explicitly named harness failure never
  falls back; same-per-call-harness resumes its binding; real-worker-thread wire plumbing;
  `HEADLESS_COMPILE_WORK_ORDER` grounding text. Four gateway HTTP tests failed only under
  concurrent-sandbox contention and passed on isolated re-run.

- **Convergence (d).** `bun run typecheck` green (35/35). agent-runtime `src/backends/acp`
  215 passed across 3 repeated runs (journey, blueprint-parity, and all `fake-acp-agent.mjs`
  suites green); new `connection.test.ts` 9/9; app-engine 624/625; gateway 1433 passed;
  `user-facing-qualities` 14/14; `bun run knip` clean; `bun run format:check` PASS (4058 files);
  `bun run lint` PASS with `--deny-warnings`; `bun run lint:acp-min-versions` PASS.
- Reviewer replay for slice (d):

```sh
test ! -f packages/agent-runtime/src/backends/acp/json-rpc.ts && echo "wire layer deleted"
grep '"@agentclientprotocol/sdk"' packages/agent-runtime/package.json   # expect exact 1.3.0
bunx vitest run --root packages/agent-runtime src/backends/acp
```

- Further slices append their verification here as they land.

## Audit

Independent re-attestation against the CURRENT `git diff --cached`, fresh context, no reliance on
the committing agent's claims. This audit supersedes the previous (convergence-(c)-slice) audit
content below the heading. This is the **last implementation slice of #743**. Seven prior slices are
**already committed** (`git log --oneline -8`):

```
41dd8bd7 feat(automation)!: name a harness, model, and pins per ctx.delegate call (#743)
8d328597 refactor(app-engine)!: own harness bindings per (conversation, harness) (#743)
aeff86c0 refactor(automation)!: dispatch ctx.delegate through the accounted turn seam (#743)
6955ec4c docs(glossary)!: harness/delegate vocabulary write-back (#743)
9a07465d refactor(automation)!: rename the handler judgment rail to ctx.delegate (#743)
5624e365 refactor(harness)!: rename the installed-CLI axis to harness (#743)
4162072c refactor(vault)!: consent.agent, caller_id, enrollment_key, media_asset renames (#743)
3f12bdea fix(recognition): refresh rewritten text embeddings (#736) (#737)
```

This audit covers the **staged slice only** — "One door, part (d): the ACP SDK owns the wire"
(`git diff --cached --stat` → 13 files, 676 insertions(+), 325 deletions(-);
`packages/agent-runtime/src/backends/acp/**` alone is 594 insertions / 324 deletions). No
contamination: `git status --porcelain` shows nothing unstaged outside the 13 staged files.

**(1) `## What changed` faithfully describes the staged diff.**

- **(a) `json-rpc.ts` deleted; SDK pinned exactly, no caret — CONFIRMED, PASS.**
  `git diff --cached --diff-filter=D --name-only` returns exactly
  `packages/agent-runtime/src/backends/acp/json-rpc.ts`. `packages/agent-runtime/package.json`'s
  staged hunk adds `"@agentclientprotocol/sdk": "1.3.0"` — no `^`/`~`/range — alongside the two
  adapter packages already pinned bare (`0.63.0`, `1.1.7`). `bun.lock`'s staged hunk matches
  (`"@agentclientprotocol/sdk": "1.3.0"`). `node_modules/@agentclientprotocol/sdk/package.json`
  confirms the installed version is exactly `1.3.0`. `git grep -n "json-rpc"` across
  `packages/agent-runtime/src` after staging returns zero hits — no dangling import.
- **(b) `experimental/v2` imported nowhere — CONFIRMED, PASS.** `git diff --cached` contains the
  string `experimental/v2` in exactly two places, both prose: `connection.ts`'s header comment
  ("`experimental/v2` is imported nowhere") and the receipt's own Decisions bullet. Every staged
  import line was enumerated (`agent-errors.ts`, `backend.ts`, `connection.ts`,
  `enumerate-models.ts`, `probe-capabilities.ts`, `session-warm.ts`) — all import from
  `"@agentclientprotocol/sdk"` (the stable root entrypoint) or `./connection.js`; none touch
  `@agentclientprotocol/sdk/v2` or any `experimental` subpath. The package's own `dist/v2/**` exists
  on disk but is dead weight from this diff's perspective, never referenced.
- **(c) Warm pooling, probes, vault MCP, stream normalization retained and green — CONFIRMED,
  PASS.** `ls packages/agent-runtime/src/backends/acp` after staging still lists
  `session-warm.ts`/`session-warm.test.ts` (warm pooling), `probe-capabilities.ts` +
  `capabilities-cache.ts`/`.test.ts` (probe + cache), `vault-mcp-server.ts`/`.test.ts` +
  `vault-mcp-stdio-proxy.mjs` (loopback vault MCP), and `stream-events.ts`/`.test.ts` (stream
  normalization) — none deleted, none renamed. Independently ran
  `bunx vitest run --root packages/agent-runtime src/backends/acp` fresh in this audit (results
  below): 215 passed, only the 2 pre-existing `launch.test.ts` `IS_SANDBOX` failures, which the
  audit reproduced and confirmed are assertion-order artifacts unrelated to this diff (they assert
  `"1"` vs the code's `"yes"` — a pre-existing mismatch, not something this diff touches; `launch.ts`
  is untouched by `git diff --cached --name-only`).
- **(d) `session/update` bypass — real, and the justification is SOUND. This is the finding that
  matters most, so it gets full treatment.** Read `connection.ts`'s staged diff: `frameStream`'s
  `deliver()` intercepts any frame with `method === CLIENT_METHODS.session_update`, calls
  `sink?.onSessionUpdate?.(frame.params)` directly off the raw parsed JSON, and returns `true` so the
  frame is **never enqueued onto the `ReadableStream` the SDK's `client()` connection reads from** —
  the SDK's `ClientApp`/`Connection` machinery never sees a `session/update` frame at all. Confirmed
  this is not merely asserted but load-bearing: `backend.ts`'s new `HarnessTurnSink.onSessionUpdate`
  receives `params` and passes them straight to `stream.handleSessionUpdate(params)` with no
  intervening schema parse.
  Then independently read `node_modules/@agentclientprotocol/sdk/dist/acp.js` (installed 1.3.0, not
  taking the receipt's word for it) to check the specific factual claim — "`ClientApp`'s constructor
  unconditionally installs a static handler that runs `zSessionNotification.parse` ahead of every
  user handler ... a notification the generated union rejects is discarded with a `console.error` and
  no handler runs":
  - `class ClientApp` constructor (line 863): unconditionally calls
    `this.builder.withHandler({ handleMessage: (message, cx) => sessionUpdateRouter(cx).handleMessage(message), ... })`
    — this pushes onto `ConnectionBuilder.handlers`, an ordered array, **before any user code can
    call `.onRequest`/`.onNotification`** (those also route through `withHandler`, via
    `registerAppRequest`/`registerAppNotification` → `builder.onReceiveRequest`/`onReceiveNotification`
    → `withHandler`, appending to the *same* array). Registration order is array order, so the
    session-update router is always first — genuinely "ahead of every user handler," not just the
    default ones.
  - `SessionUpdateRouter.handleMessage` (line 675): for a `session/update` notification, calls
    `validate.zSessionNotification.parse(message.params)` — **`.parse`, not `.safeParse`** — which
    throws a `ZodError` on any shape the generated union rejects.
  - `Connection.processIncomingMessage` (jsonrpc.js, ~line 752): iterates
    `[...staticHandlers, ...dynamicHandlers.values()]` inside one `try`; a throw from any handler in
    that loop is caught by the single `catch` wrapping the whole loop, so **no later handler in the
    array runs for that message** — confirming "no handler runs," including a hypothetical user
    handler registered with a pass-through/identity parser, since it would sit later in the same
    array and the loop never reaches it.
  - The `catch` block: for a notification (`current.kind !== "request"`), it does
    `console.error("Error handling notification", message.raw, response.error)` and returns —
    **it does not rethrow and does not close the connection.** This exactly matches "discarded with a
    `console.error`" — the process is silent from the application's point of view (no handler fires,
    no thrown error reaches caller code), the connection survives, and the frame is gone.
  **Verdict on this sub-claim: the factual claim about `ClientApp` is TRUE, verified by reading the
  installed SDK source line-by-line, not inferred from the receipt's prose or documentation.** The
  design decision that follows from it — deliver `session/update` off the raw transport instead of
  through `ClientApp`'s dispatch — is therefore a **sound, necessary** consequence, not a
  hand-wave: routing through `ClientApp` as documented would silently drop any vendor `sessionUpdate`
  variant, a `usage_update` missing `used`/`size` (this codebase's `--cost`-only shape per the
  receipt), or a plan entry missing `priority`/`status`, exactly as claimed.
  **Judged plainly, per the audit brief's instruction not to rubber-stamp:** this is a **partial**,
  not full, satisfaction of "connection + frame types come from the SDK." Requests
  (`session/request_permission`) and the outbound wire (id allocation, `RequestError` codes,
  `initialize`/`session/new`/etc.) genuinely come from the SDK. The single highest-volume,
  highest-stakes inbound frame type — `session/update`, which is the entire turn-streaming path —
  is deliberately routed around the SDK's typed dispatch and interpreted by hand-parsing raw JSON,
  exactly as the 218-line `json-rpc.ts` it replaces did. The SDK still earns its keep here: framing
  (line splitting, JSON-RPC envelope validation via `isFrame`), id correlation for requests, and
  error-code semantics are now the SDK's, and those were the parts of `json-rpc.ts` most likely to
  drift from the wire spec. But "connection + frame types come from the SDK" oversold as a blanket
  statement would be wrong for the `session/update` shape specifically; the receipt does not oversell
  it — it discloses the bypass explicitly, at length, and names it "the most significant deviation in
  this PR" — so the receipt's own honesty is what keeps this a **PASS** rather than a **REFUTED**: the
  acceptance criterion is met in the sense the issue's Decision item 1 describes (adopt the SDK "for
  the JSON-RPC connection + typed protocol frames, replacing `json-rpc.ts`"), and the JSON-RPC
  connection layer (transport-level framing, ids, errors) is fully SDK-owned; the *interpretation* of
  one specific notification's payload is knowingly kept outside the SDK's schema for a documented,
  verified-correct reason. A maintainer should read the checked box as "the wire's connection
  mechanics are the SDK's; session/update's payload shape is still ours by necessity," not as
  "every frame is now SDK-typed end to end."
- **(e) Malformed frames surface as a typed error instead of being silently dropped — CONFIRMED,
  PASS, in both code and test.** `connection.ts`'s `frameStream`: a line starting with `{` that
  fails `JSON.parse` or fails the `isFrame` guard calls `fail(new AcpFrameError(line))`, which calls
  `controller.error(error)` on the `ReadableStream` — this propagates into the SDK's connection as a
  stream error, which (per the SDK's `Connection` machinery) rejects in-flight requests rather than
  hanging them. `connection.test.ts` (fresh-run in this audit, 9/9 pass) has the test
  `"a malformed frame fails the pending request instead of hanging"` — asserted twice in the same
  test body (`await expect(answer).rejects.toBeInstanceOf(AcpFrameError)`, twice, presumably one
  syntactically-broken-JSON case and one structurally-invalid-but-valid-JSON case) — confirming the
  rejection type is `AcpFrameError`, not a generic timeout/hang. `backend.ts`'s outer
  `catch (error)` block (unchanged in structure by this diff, confirmed by reading the staged hunk)
  feeds any thrown error, including a rejected `conn.request(...)` from a frame failure, through
  `classifyAgentFailureDetail` and emits it as a `TurnStreamEvent` — so the path from "malformed
  frame on stdout" to "typed error surfaced to the turn stream" is intact and did not silently regress
  to the old drop-and-hang behavior `json-rpc.ts` had. Also confirmed the deliberate scope limit
  the receipt discloses: `HarnessFailureClass` was not extended with a `protocol` member (the
  `classifyAgentFailureDetail` diff shows no new failure class added), so this classifies as
  `"unknown"` today — consistent with what the receipt says and not a broken promise, since the
  receipt only claims "surfaces as a typed error," not "surfaces as a *newly-classified* error."

**Overall verdict for (1): PASS**, with the single most consequential caveat — (d) — surfaced above
rather than buried: the slice satisfies the issue's Decision item 1 and the acceptance criterion's
literal text ("connection + frame types come from the SDK... json-rpc.ts is deleted"), but
`session/update` payload interpretation is knowingly, correctly, and disclosedly kept outside the
SDK's own dispatch for a reason verified true against the installed SDK source.

**(2) Each `- [x]` item realized; each `- [ ]` genuinely not done — PASS.** `grep -n "^\- \["` on
the staged receipt shows lines 5–12 all `[x]` (vault schema, harness axis, delegate rail,
docs/glossary, chat-spine dispatch, HarnessSessions, per-call harness/model/configPins, and — newly
flipped in this diff's hunk — `@agentclientprotocol/sdk` adoption / `json-rpc.ts` deleted) and line
13 `[ ]` ("Close #740 as absorbed by this issue") — **eight checked, exactly one unchecked**, matching
the audit brief's expectation exactly. Item 8's checkbox flip is the only checklist change in this
diff (`git diff --cached` hunk on the checklist touches only that line). The seven earlier items
remain realized at the seven already-committed slices listed above, unchanged by this diff. Item 9
("Close #740") has zero footprint in this diff — correctly left unchecked, since closing the GitHub
issue is a repository-hosting action outside any file diff, and the receipt does not claim it done.

**(3) `## Checklist` mirrors issue #743's `Scope > In:` bullets — PASS.** Fetched issue #743 fresh
via `mcp__github__issue_read` this turn (full body, not cached from a prior audit). The issue's
`# Scope > In:` list — every rename incl. vault schema/item-kind; `ctx.delegate` dispatch through the
chat spine + fork deletion; HarnessSessions extraction + settlement; metering + hydration-token
accounting; per-call `harness`/`model`/`configPins` + `#567` D13 consent + failover interplay;
compiler work order + skills + 5 blueprint handlers regenerated + lint messages;
`@agentclientprotocol/sdk` adoption; glossary/README/ARCHITECTURE/docs A1 write-back; closing #740 —
maps 1:1 onto the receipt's 9-line checklist. Read Part 2 Decision item 1 in full (quoted verbatim
above the acceptance criteria): "adopt `@agentclientprotocol/sdk` for the JSON-RPC connection + typed
protocol frames, replacing `json-rpc.ts` ... Keep everything the SDK does not do: launch specs, warm
pooling, capability probe/cache, stream→`TurnStreamEvent` normalization, the loopback vault MCP
server, usage normalization. Pin the stable entrypoint; do not use `experimental/v2`." Every clause of
that decision item was independently checked above in (1)(a)–(e) and confirmed true against the
staged diff and the installed SDK, not assumed from the receipt's paraphrase.

**Independent verification run fresh in this audit:**
- `bunx vitest run --root packages/agent-runtime src/backends/acp` → **215 passed**, 2 failed (both
  `launch.test.ts` `IS_SANDBOX` assertions, pre-existing and unrelated to this diff — `launch.ts` is
  not in `git diff --cached --name-only`), 21 of 22 test files fully green. Matches the audit brief's
  expectation exactly.
- `bunx vitest run --root packages/agent-runtime src/backends/acp/connection.test.ts` → **9/9
  passed**.
- `bun run typecheck` → green, **35/35** packages (turbo cache hit on most, fresh compile on
  `agent-runtime`/`gateway`/`desktop`/`web` which touch the changed files transitively).
- `bun run knip` → **clean**: only the 31 pre-existing configuration hints (unrelated
  `ignoreDependencies`/`ignoreBinaries`/entry-pattern housekeeping suggestions), zero "Unused
  files"/"Unused dependencies"/"Unused exports" sections, exit code 0. Specifically confirms
  `@agentclientprotocol/sdk` is not flagged as an unused dependency — it is genuinely imported by
  `connection.ts`, `backend.ts`, `enumerate-models.ts`, `probe-capabilities.ts`, and
  `agent-errors.ts`.

**Independent source-reading beyond what the task asked for, done because (d) is the crux finding:**
walked `node_modules/@agentclientprotocol/sdk/dist/acp.js` (`class ClientApp`, `SessionUpdateRouter`,
`registerAppNotification`/`registerAppRequest`) and `dist/jsonrpc.js`
(`ConnectionBuilder.onReceiveRequest`/`onReceiveNotification`/`withHandler`,
`Connection.processIncomingMessage`) to trace the exact control flow a `session/update` frame would
take if routed through `ClientApp` instead of bypassed. The trace confirms the receipt's claim
precisely, including the subtle detail that a user handler registered *after* `ClientApp` construction
(the only order application code can use, since `ClientApp` is constructed before user code can call
`.onNotification`) would never even be reached for a rejected frame, because the router's exception
aborts the whole per-message handler loop rather than falling through to the next handler.

**Overall verdict: PASS**, with the (d) caveat stated plainly rather than smoothed over: `json-rpc.ts`
is genuinely deleted; the SDK is pinned at exactly `1.3.0` with no caret; `experimental/v2` is
imported nowhere; warm pooling, probes, vault MCP, and stream normalization all still exist and their
tests are green (215/217, the 2 failures pre-existing and unrelated); malformed frames now reject a
typed `AcpFrameError` instead of hanging, proven in both `connection.ts` and `connection.test.ts`;
and the `session/update` SDK-dispatch bypass is real, disclosed at the length and prominence the
finding deserves, and — verified independently against the installed SDK's source rather than taken
on faith — factually correct that `ClientApp`'s constructor unconditionally installs a static
`zSessionNotification.parse` handler that would silently (from the app's perspective) discard vendor
`session/update` variants ahead of any user handler. The slice satisfies the letter of the acceptance
criterion and the issue's Decision item 1, but "connection + frame types come from the SDK" is true
of the JSON-RPC transport layer and not, by necessity and by design, of `session/update`'s payload
interpretation — a distinction the receipt itself draws, which is why this is a **PASS** rather than a
**REFUTED**, and not something a future reader should mistake for "everything is SDK-typed now."
`bunx vitest run --root packages/agent-runtime src/backends/acp` (215/217, 2 pre-existing),
`connection.test.ts` (9/9), `bun run typecheck` (35/35 green), and `bun run knip` (clean) all
reproduce independently in this audit.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 56e4d30a-2bce-4149-af0c-60147a8837f1 |
