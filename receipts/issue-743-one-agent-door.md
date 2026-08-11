# Issue #743 — one agent door: vocabulary rationalization + automation dispatch convergence

## Checklist

- [x] Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`), `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`, `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated
- [x] Harness axis rename (`RunnerKind` → `HarnessKind`, `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` → `requires.harness`, …)
- [x] Delegate rail rename (`ctx.agent` → `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix)
- [x] Glossary / docs A1 write-back (forbidden synonyms, delegate step, schema-naming rule)
- [x] `ctx.delegate` dispatched through the accounted chat spine (metering, budgeted hydration, kind-scoped resume)
- [x] HarnessSessions extraction keyed `(conversationRef, harnessKind)`; per-binding settlement + multi-harness regression test
- [ ] Per-call `harness`/`model`/`configPins` on `ctx.delegate`; consent fail-closed (#567 D13); compiler grounding + blueprint handlers regenerated
- [ ] `@agentclientprotocol/sdk` adoption; `backends/acp/json-rpc.ts` deleted
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

- Further slices append their verification here as they land.

## Audit

Independent re-attestation against the CURRENT `git diff --cached`, fresh context, no reliance on
the committing agent's claims. This audit supersedes the previous (convergence-(a)-slice) audit
content below the heading. Five prior slices are **already committed** (`git log --oneline -6`):

```
aeff86c0 refactor(automation)!: dispatch ctx.delegate through the accounted turn seam (#743)
6955ec4c docs(glossary)!: harness/delegate vocabulary write-back (#743)
9a07465d refactor(automation)!: rename the handler judgment rail to ctx.delegate (#743)
5624e365 refactor(harness)!: rename the installed-CLI axis to harness (#743)
4162072c refactor(vault)!: consent.agent, caller_id, enrollment_key, media_asset renames (#743)
3f12bdea fix(recognition): refresh rewritten text embeddings (#736) (#737)
```

This audit covers the **staged slice only** — "One door, part (b): HarnessSessions" (`git diff
--cached --stat` → 22 files, 1154 insertions(+), 798 deletions(-)): the new
`packages/app-engine/src/conversation/harness-sessions.ts` (286 lines), its wiring into
`ConversationStore.harnessSessions` / `ConversationHistoryStore.harnessSessions` (`store.ts`,
`history.ts`), the four call-site extractions (`turn-sse.ts`, `run-automation-live-dispatch.ts`,
`headless-automation-compile.ts`, `interactive-automation-turn.ts`), the per-binding settlement
change to `noteTurn`/`noteFailedTurn`, the new
`packages/agent-runtime/src/automation/run-automation-multi-harness.test.ts`, and the receipt. Also
confirmed clean: `git status` shows no unstaged files at audit time — nothing from a concurrently
running agent leaked into this diff.

**(1) `## What changed` faithfully describes the staged diff** — **PASS**, with one minor
arithmetic imprecision noted (not materially misleading).

- **(a) Extraction, net deletion, not a new layer** — **substantially confirmed**. `git diff
  --cached --numstat` totals 1154 insertions / 798 deletions across 22 files. Splitting out the two
  wholly-new files (`harness-sessions.ts`, 286/0) and the wholly-new regression test
  (`run-automation-multi-harness.test.ts`, 262/0) and the receipt itself (83/1) leaves the 19
  remaining files — the ones that actually held duplicated planning logic plus their tests — at
  **523 insertions / 797 deletions** (net **-274**), a genuine net deletion. The receipt states
  "Net 522 insertions / 791 deletions ... about 555 lines of duplicated planning deleted"; the
  insertions figure is off by 1 and the deletions figure by 6 (three small, unrelated-to-planning
  files — `automations-routes.test.ts` 3/4, `kill-mid-write-child.ts` 1/1,
  `user-facing-qualities.test.ts` 3/1 — appear to be excluded from the receipt's manual tally). This
  is a trivial bookkeeping slip, not a false characterization: the diff genuinely is net-negative
  across the extraction site, and the receipt is explicit that the 286-line owner is an addition
  ("Net ... plus the 286-line owner"), so it is not hiding the new file's size. All four claimed
  duplicate-copy sites really did lose their private planning code, confirmed by reading each hunk:
  - `turn-sse.ts`: the `resumeStates`/`plans`/`planFor` memo block (~100 lines, including its own
    `compileHydrationPlan` call and the post-turn stale-binding retirement `if` block) is deleted
    and replaced by `const harnessSessions = conversationStore?.harnessSessions(...)`; `runner-core.ts`
    now calls `input.harnessSessions?.plan(kind)` instead of `input.resumeForKind?.(kind)`.
  - `run-automation-live-dispatch.ts`: the `resumable: Map<HarnessKind, TouchedBinding>` +
    `compileBudgeted` + inline cold/watermark/recovery-fold computation (~110 lines) is deleted;
    replaced by `harnessSessions.plan(harness)` / `.observe(...)` / `.observeFailure(...)`, and
    `finalizeTurn` now reads `harnessSessions.bindings` instead of the old single `lastSettled`/
    `lastObserved` locals.
  - `headless-automation-compile.ts`: the inline `getHarnessBinding` + `hydrationMessagesFromLedger`
    (x2) + `compileHydrationPlan` (x2) block is deleted (~90 lines including the local `adapter`
    accumulator and its two `noteTurn`/`noteFailedTurn` object-literal reconstructions); replaced by
    `store.harnessSessions(conversationId, { hydration, attachmentPath })`, `harnessSessions:` passed
    straight to `opts.runner.run`, and `store.noteTurn(conversationId, "", harnessSessions.bindings)`.
  - `interactive-automation-turn.ts`: the identical shape of block (~90 lines, including the local
    `adapter` accumulator) is deleted the same way.
- **(b) Per-binding settlement is real** — **confirmed**. `ConversationStore.noteTurn`/
  `noteFailedTurn` (`packages/app-engine/src/conversation/store.ts`) now take
  `bindings: readonly TouchedHarnessBinding[] = []` and `for (const binding of bindings)` loop,
  writing/updating a `conversation_harness_sessions` row and (for delivered bindings) advancing each
  one's `hydrated_through_seq` watermark individually; the conversation row's single denormalized
  "active harness" column is set from `delivered.at(-1)` (last delivered binding), and `hydratedCount`
  (not a 0/1 flag) is now threaded into `noteTurnWithAdapter`/`noteTurnKindOnly`. All four call sites
  (`run-automation-live-dispatch.ts` `finalizeTurn`, `headless-automation-compile.ts`,
  `interactive-automation-turn.ts`, `turn-sse.ts` via `ConversationHistoryStore.recordTurn`'s new
  `bindings` field) now pass an array (`harnessSessions.bindings`), not a single adapter object. The
  old single-`adapter?: {...}` parameter is gone from both `noteTurn` and `noteFailedTurn` signatures
  and from `RecordTurnInput` (`adapter`/`failedAdapter` fields deleted in favor of one `bindings`
  field). `finalizeTurn` genuinely no longer settles only the last binding.
- **(c) Multi-harness test characterization** — **confirmed fair, and the invariant is genuinely
  proven with real DB rows**. Read `run-automation-multi-harness.test.ts` in full. It configures
  `startLiveDispatch({ harness: "codex", ... })` and calls `dispatch.delegateDispatcher(...)` twice
  with no per-call harness argument (that argument does not exist yet — item (c) of the umbrella).
  Both calls therefore route through `accountedRunTurn` to `HARNESSES["codex"].runTurn`, which is
  the single stub installed by `stubHarness("codex", ...)`; the stub's own `landing` counter makes
  it *report* `{ harnessKind: "claude-code", sessionId: "session-claude-new" }` on the first call and
  `{ harnessKind: "codex", sessionId: "session-codex-new" }` on the second. This is exactly what the
  receipt's `## Decisions` bullet says: "the test drives the fire twice while the injected accounted
  `runTurn` reports `claude-code` for the first call and `codex` for the second — legitimate, because
  `TurnResult.harnessKind` documents itself as echoing the kind that produced `sessionId`." It is a
  faithful, non-misleading description, not a test dressed up as something it isn't — and the
  in-file comment says the same thing openly (lines 13-17). The invariant under test — "a session id
  belongs to whoever minted it, not whoever was asked" — is identical whether the harness switch
  comes from a per-call `harness` argument (future) or from the accounted seam's own failover/landing
  behavior (today); `HarnessSessions.observe` keys strictly on `observed.harnessKind ?? plannedKind`
  and has no way to tell the two apart, so the code path exercised is the real one. The test proves,
  with **real DB rows read via raw SQL against `conversation_harness_sessions`** (not mocked
  assertions): (i) resume — both `codex.calls[0].prevSessionId` and `codex.calls[1].prevSessionId`
  equal the seeded `"session-codex-old"`, and explicitly `codex.calls[1].prevSessionId` is asserted
  `not.toBe("session-claude-new")`, which is precisely the `latestAdapter` bug reproduced-if-absent;
  (ii) settlement — after the turn, `getHarnessBinding(ref, "claude-code")` and
  `getHarnessBinding(ref, "codex")` both independently return rows with `hydratedThroughSeq: 1`, and
  the raw `conversation_harness_sessions` query confirms three rows: the new claude-code binding
  (`warm`), the new codex binding (`active`), and the **old** codex session correctly demoted to
  `stale` (superseded-as-audit, never re-offered) rather than deleted. A second test in the same file
  exercises the fire path's stale-binding retirement (a `hydrationKind: "recovery"` response) and
  confirms the abandoned session id's row flips to `stale` via direct SQL. This is a strong,
  discriminating regression test — not shallow — and the receipt's own characterization of its
  limits (substance-not-yet-literal, pending item (c)) is honest rather than overclaiming.
- **(d) `ConversationTurnInput.prevBindingId` deletion + `hydration_count` per-binding change** —
  both **confirmed**. `packages/app-engine/src/conversation/runner.ts` diff removes `/** Durable
  binding row that supplied \`prevAdapterSessionId\`. */ prevBindingId?: string;` with no replacement
  field (the interface's other resume fields are untouched or migrated to `harnessSessions`). In
  `store.ts`, `noteFailedTurn`'s `hydration_count` update changed from unconditional `+ 1` gated on a
  single `adapter?.hydrated` boolean to `SET hydration_count = hydration_count + ?` parameterized by
  `hydratedCount` (`bindings.filter((b) => b.hydrated === true).length`), and `noteTurn`'s
  `hydratedCount`/`hydrated` pair is likewise now a per-binding count rather than a single flag,
  threaded into `noteTurnWithAdapter`/`noteTurnKindOnly`. Confirmed as described.

**(2) Each checked `- [x]` item is realized; each `- [ ]` is genuinely not claimed done** —
**PASS**.

- Item 6 — `- [x] HarnessSessions extraction keyed (conversationRef, harnessKind); per-binding
  settlement + multi-harness regression test` — newly flipped in this staged diff and realized by
  (1)(a)-(c) above: the module exists, is keyed as claimed, per-binding settlement is real, and the
  regression test exists and is strong.
- The five earlier checked items (1-5) remain realized at `HEAD` (unchanged by this diff): vault
  schema (`4162072c`), harness axis (`5624e365`), delegate rail (`9a07465d`), docs/glossary
  write-back (`6955ec4c`), and slice (a) "`ctx.delegate` dispatched through the accounted chat spine"
  (`aeff86c0`) — `git log --oneline -6` confirms all five commit subjects reference `#743`.
- The three remaining unchecked items — per-call `harness`/`model`/`configPins` on `ctx.delegate`
  (item 7), `@agentclientprotocol/sdk` adoption (item 8), closing #740 (item 9) — have **zero
  footprint in the staged diff**. `git diff --cached --name-only` touches only:
  `docs/runners.md`, `packages/agent-runtime/src/automation/{run-automation-dispatch.test.ts,
  run-automation-live-dispatch.ts, run-automation-multi-harness.test.ts}`,
  `packages/app-engine/src/conversation/{harness-sessions.ts, history.ts, history.test.ts,
  runner-core.ts, runner-core.failover.test.ts, runner.ts, store.ts, store.test.ts}`,
  `packages/app-engine/src/http/{turn-sse.ts, turn-sse.test.ts}`, `packages/app-engine/src/index.ts`,
  `packages/gateway/src/lifecycle/{headless-automation-compile.ts,
  interactive-automation-turn.ts, interactive-automation-turn.test.ts}`,
  `packages/gateway/src/routes/automations-routes.test.ts`, `receipts/issue-743-one-agent-door.md`,
  `tests/quality/fixtures/kill-mid-write-child.ts`, `tests/quality/user-facing-qualities.test.ts`.
  No `registry.ts`, `backends/acp/*`, `manifest.ts`, `ctx.ts`, blueprint handler, skill file, or
  anything referencing `ctx.delegate({ harness })`, the SDK package, or issue #740's closure is
  staged. Correctly left unchecked. `delegate-answer`/`ctx.delegate` call sites in this diff are
  unchanged from `HEAD` — grep for `harness:` inside a `ctx.delegate(` call site in the staged diff
  returns nothing.

**(3) `## Checklist` mirrors issue #743's `Scope > In:` bullets** — **PASS**. Fetched issue #743
fresh via `mcp__github__issue_read` (full body). The issue's `# Scope > In:` list (every rename incl.
vault schema/item-kind; `ctx.delegate` dispatch through the chat spine + fork deletion; HarnessSessions
extraction + per-(conversationRef, harnessKind) settlement; metering + hydration-token accounting for
delegate turns; per-call `harness`/`model`/`configPins` + `#567` D13 consent + failover interplay;
compiler work order + skills + 5 blueprint handlers + lint messages; `@agentclientprotocol/sdk`
adoption; glossary/README/ARCHITECTURE/docs A1 write-back; closing #740) maps 1:1 onto the receipt's
9-line checklist, unchanged in shape from the prior audit (only item 6's checkbox flipped) — no added
or missing scope claim.

**Independent verification run fresh in this audit:**
- `bun run typecheck` → **green**, 35/35 tasks (full-turbo cache-hit/replay).
- `bunx vitest run --root packages/agent-runtime src/automation/run-automation-multi-harness.test.ts`
  → **2/2 passed** (2.36s).
- `bunx vitest run --root packages/app-engine src/conversation src/http` → **391/391 passed**, 37
  test files, no failures or skips (11.01s).
- `bunx vitest run --config vitest.quality.config.ts user-facing-qualities` → **14/14 passed**
  (22.30s).
- `git status --porcelain` at audit time shows only the files listed above staged, no unstaged
  residue — the "concurrently-running agent on a different slice" caveat in the task did not
  materialize in this diff.

**Test-quality judgment (asked explicitly): the multi-harness test is genuinely strong.**
`"each harness resumes its own session id and both watermarks settle"` is not a shallow smoke test:
it asserts the resume invariant on the exact call-site field the bug would corrupt
(`prevSessionId`), explicitly asserts the negative (`not.toBe("session-claude-new")`) that would
catch a regression to the old unkeyed slot, and — critically — verifies settlement by reading real
rows out of `conversation_harness_sessions` via a raw SQL query rather than only inspecting in-memory
return values, including confirming the *superseded* old codex row demotes to `stale` rather than
vanishing (an audit-trail requirement, not just a happy-path check). The companion test for stale
retirement in the fire path closes the other half of the acceptance criterion. The one honest
limitation — driving one *configured* harness twice with the *seam* varying its reported kind, rather
than two literal `ctx.delegate({ harness })` calls — is disclosed plainly in both the test's own
header comment and the receipt, is technically accurate (per-call harness naming genuinely does not
exist yet), and exercises the identical code path (`HarnessSessions.observe` keys on
`observed.harnessKind`, never on what was requested) that a literal two-`ctx.delegate` call would
exercise once item (c) lands. This is disclosure of a real scope boundary, not a paper-thin test
posing as a strong one.

**Overall verdict: PASS.** The staged diff is what the receipt says it is: a genuine extraction of
four independently-drifted planning copies into one `(conversationRef, harnessKind)`-keyed owner,
net-negative across the 19 extraction-site files (523 ins / 797 del vs. the receipt's slightly
imprecise but directionally correct 522/791), landing per-binding settlement in `noteTurn`/
`noteFailedTurn` for real (confirmed by reading the loop and all four call sites), and shipping a
multi-harness regression test that is honestly scoped and substantively strong — it proves both the
resume-isolation and the dual-watermark-settlement halves of the acceptance criterion against real
SQLite rows, with only the per-call-harness-naming literalism correctly and openly deferred to a
later slice. The checklist's newly-checked item is realized, the three remaining unchecked items have
zero footprint in the diff, and the checklist continues to mirror the issue's Scope > In list 1:1.
`bun run typecheck` (35/35), the multi-harness suite (2/2), `packages/app-engine` conversation+http
suites (391/391), and `user-facing-qualities` (14/14) all reproduce green independently. The one
imperfection found — a small (≈1%) arithmetic slip in the receipt's line-count tally — does not rise
to a REFUTED-level inaccuracy; it is noted for the record but does not misrepresent the shape or
substance of the change.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 56e4d30a-2bce-4149-af0c-60147a8837f1 |
