# Issue #743 — one agent door: vocabulary rationalization + automation dispatch convergence

## Checklist

- [x] Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`), `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`, `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated
- [x] Harness axis rename (`RunnerKind` → `HarnessKind`, `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` → `requires.harness`, …)
- [x] Delegate rail rename (`ctx.agent` → `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix)
- [x] Glossary / docs A1 write-back (forbidden synonyms, delegate step, schema-naming rule)
- [ ] `ctx.delegate` dispatched through the accounted chat spine (metering, budgeted hydration, kind-scoped resume)
- [ ] HarnessSessions extraction keyed `(conversationRef, harnessKind)`; per-binding settlement + multi-harness regression test
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

- Further slices append their verification here as they land.

## Audit

Independent re-attestation against the CURRENT `git diff --cached`, fresh context, no reliance on
the committing agent's claims. This audit supersedes the previous (delegate-rail-slice) audit
content below the heading. Four slices are now in play — three **already committed**
(`git log --oneline -4`):

```
9a07465d refactor(automation)!: rename the handler judgment rail to ctx.delegate (#743)
5624e365 refactor(harness)!: rename the installed-CLI axis to harness (#743)
4162072c refactor(vault)!: consent.agent, caller_id, enrollment_key, media_asset renames (#743)
3f12bdea fix(recognition): refresh rewritten text embeddings (#736) (#737)
```

`git show --stat` on each of the three confirms they landed as real, substantive commits (184 / 204
/ 62 files respectively, all referencing `#743`). This audit covers the **new staged slice only**:
the docs/glossary A1 write-back — `git diff --cached --stat` → 13 files changed, 115 insertions(+),
56 deletions(-) (ARCHITECTURE.md, CHANGELOG.md, CONSTITUTION.md, README.md, TESTING.md, 7
`docs/*.md` files, and the receipt itself). The working tree also carries large **unstaged** `.ts`
changes from a concurrently-running agent (`git status --porcelain` shows
`packages/app-engine/src/conversation/posture.ts` and
`packages/gateway/src/lifecycle/automation-delegate-metering.test.ts` untracked, plus modifications
in `run-automation-live-dispatch.ts`, `turn-sse.ts`, `build-gateway.ts`, etc. — these are correctly
**not** staged and are excluded from this audit; they match the still-unchecked "`ctx.delegate`
dispatched through the accounted chat spine" checklist item).

1. **`## What changed` faithfully describes the staged diff** — **REFUTED**, on a real
   verification-claim inaccuracy (glossary content itself is accurate; see detail).
   - **Glossary additions, checked individually against `git diff --cached -- docs/glossary.md`**:
     - Ledger item-kind list now includes `delegate`: **confirmed** — `item.kind ∈ {message_in,
       step, tool, delegate}` (was `..., agent}`), both in the vocabulary table and in the new
       forbidden-synonym row.
     - "agent variant" → "delegate step": **confirmed** — the recognition-vocabulary row's term
       column changed from `**agent variant**` to `**delegate step**`, definition now reads
       "`ctx.delegate`, the pinned-harness and provider-egress-consent rails" (was `ctx.agent`,
       pinned-runner).
     - Forbidden-synonym row for the harness axis: **confirmed** — `"runner" / "adapter" /
       "backend" / "provider" as a stand-in for the installed CLI` → **harness**, with the
       `RunnerKind`→`HarnessKind` etc. mapping and the `provider`/`adapter`/ACP-role carve-outs, at
       `docs/glossary.md:185`.
     - Forbidden-synonym row for agent→delegate: **confirmed** — `"agent" for the model-turn item
       kind` → **delegate**, `*agent* is reserved for principals — owners, devices, and enrolled
       autonomous callers (`consent.agent`) — not the judgment rail (#743)`.
     - Schema-naming rule: **confirmed** — new forbidden-synonym row `"<schema>_<schema>>" as a
       table name (a plane repeating its own schema name for its central table)` → `name the
       **row**, not the schema — agent_agent → consent_agent, media_media_asset → media_asset
       (#743)`.
     - Tolerated dual-vocabulary row for "Agents" UI copy: **confirmed** — new row under
       "Inconsistencies" — `agent / harness` → **harness** in identifiers/prefs/tables/code, "Agents"
       tolerated in UI copy (Settings → Agents, agent picker), citing the chat/conversation
       precedent and `#743`.
     All six claimed glossary additions genuinely exist as described. `docs/runners.md` was also
     confirmed rewritten to harness vocabulary throughout (56 changed lines, all mechanical
     `runner`→`harness` / `RunnerKind`→`HarnessKind` substitutions plus one added filename-rationale
     paragraph at the top), and ARCHITECTURE.md / CONSTITUTION.md / README.md / TESTING.md /
     `docs/decisions.md` / `docs/blueprint-seats.md` / `docs/recognition-automations.md` /
     `docs/photos-derived-ledger.md` / `docs/config-ownership.md` all show only the claimed
     identifier-rename sweep (`ctx.agent`→`ctx.delegate`, `runner`→`harness`,
     `media.media_asset`→`media.asset`, `runner_kind`→`harness_kind`) with no other semantic change.
   - **CHANGELOG.md gained an entry**: confirmed — one new `### Changed` bullet under
     `## [Unreleased]` documenting the full breaking-rename list, citing `#743`.
   - **Receipt does not overstate the docs sweep** in its narrative prose — the "Files touched (docs
     write-back slice)" list (13 paths) matches `git diff --cached --name-only` exactly.
   - **Real inaccuracy found**: the receipt's own newly-added `## Verification` bullet for this
     slice claims `bash .governance/run.sh` → **"all 25 directives pass."** Independently re-running
     it now (fresh, this audit) gives **24 passed, 1 failed**:
     ```
     ✗ format-check (3 violations)
         CHANGELOG.md - not formatted (run: bun run format)
         docs/config-ownership.md - not formatted (run: bun run format)
         docs/glossary.md - not formatted (run: bun run format)
     ```
     These three files are **staged docs-slice files**, not the concurrently-running agent's
     unstaged `.ts` work, so this is squarely attributable to this slice, not a false positive from
     the other agent's tree state. Diffing each file against its oxfmt-formatted form (copied to a
     scratch dir, not written back into the repo) shows the exact cause: CHANGELOG.md and
     docs/glossary.md use `*agent*` (asterisk emphasis) where oxfmt's markdown style requires
     `_agent_` (underscore emphasis), and docs/config-ownership.md has a stale table column width
     (the `Owner` header/divider in the `model-catalog.json` row wasn't re-padded after "Runner
     status" → "Harness status" changed the longest cell in that column). All three are real,
     mechanical, pre-existing-tool-detectable defects in the staged diff. This directly contradicts
     the receipt's "all 25 directives pass" claim, so `## What changed`/`## Verification` overstates
     the actual governance-clean state of this slice.

2. **Each checked `- [x]` item is realized; unchecked `- [ ]` items are not claimed done** —
   **PASS**.
   - Vault schema (checked): realized in `HEAD`, commit `4162072c` (`git show --stat` confirms,
     184 files, `#743` in subject).
   - Harness axis (checked): realized in `HEAD`, commit `5624e365` (204 files, `#743`).
   - Delegate rail (checked): realized in `HEAD`, commit `9a07465d` (62 files, `#743`).
   - Docs write-back (checked, flipped `[ ]`→`[x]` in **this** staged diff — confirmed via `git diff
     --cached -- receipts/issue-743-one-agent-door.md`): realized in the staged diff — all six
     glossary claims verified above, plus a new "### Files touched (docs write-back slice)" section
     and three new "## Decisions" bullets (runners.md filename rationale, frozen-section exclusion,
     runners.md signature-fix correction, glossary L2/L4 preservation) added in this same diff.
   - The remaining 5 unchecked items (`ctx.delegate` dispatched through the accounted chat spine,
     `HarnessSessions` extraction, per-call harness/model/configPins, `@agentclientprotocol/sdk`
     adoption, closing #740) have **zero footprint in the staged diff** — `git diff --cached
     --stat` touches only markdown plus the receipt; no `.ts`/`.js` file is staged. They correctly
     remain unchecked; their in-progress (unstaged) work belongs to the other, concurrently-running
     agent and is out of scope here.

3. **`## Checklist` mirrors issue #743's `Scope > In:` bullets** — **PASS**. Fetched issue #743
   fresh via `mcp__github__issue_read` (srikanth235/centraid, unchanged since the prior audit — same
   9-bullet `# Scope > In:` list: renames incl. vault schema/item-kind; `ctx.delegate` dispatch
   through the chat spine + fork deletion; HarnessSessions extraction + settlement; metering/hydration
   accounting; per-call harness/model/configPins + consent + failover; compiler work order + skills +
   5 handlers + lint messages; `@agentclientprotocol/sdk` adoption; glossary/docs A1 write-back; and
   closing #740). The receipt's 9-line checklist maps 1:1 onto these (the issue's single "every
   rename…" bullet is faithfully split across the receipt's 3 rename lines; "metering +
   hydration-token accounting" folds into the `ctx.delegate` dispatch line's parenthetical). The
   docs/glossary checklist line's parenthetical ("forbidden synonyms, delegate step, schema-naming
   rule") exactly echoes the issue's own "Glossary (A1 write-back, same PR)" scope bullet. No
   checklist line asserts anything the issue text contradicts.

**Independent verification run fresh in this audit:**
- `bash .governance/run.sh` → **24 passed, 1 failed** (`format-check`, 3 violations — see above).
  All other 24 directives, including `doc-integrity` and `internal-doc-links`, pass. This failure is
  **not** attributable to the other agent's unstaged `.ts` work — the three flagged files
  (`CHANGELOG.md`, `docs/config-ownership.md`, `docs/glossary.md`) are staged docs-slice files.
- `bun run test:qualities` → **green**, 4 files / 23 tests passed (86.97s).
- `git grep -nE 'RunnerKind|RUNNER_BACKENDS|getRunnerBackend|ctx\.agent|agent_agent|media_media_asset' -- '*.md' ':!receipts' ':!CHANGELOG.md'`
  → 3 hits, all justified:
  - `CONSTITUTION.md:247` and `QUALITY.md:42` — both fall under `frozen-section` protection
    (`.governance/packs/governance-kit/audit/directives/doc-integrity/directive.yaml` defaults:
    `frozen-section QUALITY.md Resolved`, `frozen-section CONSTITUTION.md Evolution Log`); these are
    dated historical entries (2026-08-10 and earlier) correctly quoting the vocabulary current at
    the time they were written, exactly as the receipt's own "Decisions" section claims.
  - `docs/glossary.md:185-186` — the two new forbidden-synonym rows themselves, which must name the
    retired terms (`RunnerKind`, `RUNNER_BACKENDS`, `getRunnerBackend`, `agent_agent`,
    `media_media_asset`) to document the rename — self-referential and expected, per the task's own
    carve-out for a doc quoting an old name while describing the rename.

**Overall verdict: REFUTED.** The glossary content itself is fully faithful — all six specifically
claimed additions (item-kind list, "agent variant"→"delegate step", the two new forbidden-synonym
rows, the schema-naming rule, and the tolerated "Agents" UI-copy dual-vocabulary row) genuinely
exist in the staged diff exactly as described, the CHANGELOG entry is real, the checklist state is
correct (3 items realized in prior commits, 1 newly and correctly realized in this staged diff, 5
correctly left unchecked), and the checklist mirrors issue #743's Scope > In list. However, the
receipt's own `## Verification` section asserts `bash .governance/run.sh` → "all 25 directives
pass," and an independent fresh run of that exact command in this audit shows **24/25**, with a real
`format-check` failure across three of the thirteen staged files (`CHANGELOG.md`,
`docs/config-ownership.md`, `docs/glossary.md`) — a stray `*emphasis*` vs. `_emphasis_` style
mismatch and one stale markdown-table column width, both squarely inside this slice's own edits, not
the concurrently-running agent's unstaged `.ts` changes. Since the governance pre-commit hook itself
would block this exact staged tree on `format-check`, and the receipt affirmatively (and incorrectly)
claims that gate is clean, this slice should not land as staged — run `bun run format` (or fix the
three spots by hand) and restage before commit, then correct the Verification bullet's directive
count.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 56e4d30a-2bce-4149-af0c-60147a8837f1 |
