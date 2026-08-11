# Issue #743 — one agent door: vocabulary rationalization + automation dispatch convergence

## Checklist

- [x] Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`), `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`, `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated
- [x] Harness axis rename (`RunnerKind` → `HarnessKind`, `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` → `requires.harness`, …)
- [x] Delegate rail rename (`ctx.agent` → `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix)
- [x] Glossary / docs A1 write-back (forbidden synonyms, delegate step, schema-naming rule)
- [x] `ctx.delegate` dispatched through the accounted chat spine (metering, budgeted hydration, kind-scoped resume)
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

- Further slices append their verification here as they land.

## Audit

Independent re-attestation against the CURRENT `git diff --cached`, fresh context, no reliance on
the committing agent's claims. This audit supersedes the previous (docs-write-back-slice) audit
content below the heading. Four prior slices are **already committed** (`git log --oneline -5`):

```
6955ec4c docs(glossary)!: harness/delegate vocabulary write-back (#743)
9a07465d refactor(automation)!: rename the handler judgment rail to ctx.delegate (#743)
5624e365 refactor(harness)!: rename the installed-CLI axis to harness (#743)
4162072c refactor(vault)!: consent.agent, caller_id, enrollment_key, media_asset renames (#743)
3f12bdea fix(recognition): refresh rewritten text embeddings (#736) (#737)
```

This audit covers the **staged slice only** — "One door, part (a)" (`git diff --cached --stat` →
13 files, 668 insertions(+), 66 deletions(-)): `run-automation-live-dispatch.ts` +3 test files,
`run-automation.ts`, the new `posture.ts`, `turn-sse.ts`, `app-engine/index.ts`, the new
`automation-delegate-metering.test.ts`, `headless-automation-compile.ts`,
`interactive-automation-turn.ts`, `build-gateway.ts`, and the receipt. This is the first slice of
the umbrella that is a real architectural change, not a rename — scrutinized accordingly.

**(1) `## What changed` faithfully describes the staged diff** — **REFUTED**, on a real,
non-trivial overstatement in the hydration-budget narrative (the metering/resume claims are
accurate and well-supported).

- **(a) `getHarness`/registry import dropped from the dispatch file** — **confirmed**. `git diff
  --cached` shows `- import { getHarness } from "../registry.js";` removed with no replacement
  import of the registry anywhere in `run-automation-live-dispatch.ts`. Fresh grep: `git grep -n
  'getHarness\|registry\.js' -- packages/agent-runtime/src/automation/` hits only test files
  (`live-automation-failover.test.ts` imports `HARNESSES` from `../registry.js` to *stub* a
  harness for the test; `run-automation-dispatch.test.ts` references `getHarness(` only inside a
  regex assertion that the production file must NOT contain it) and one unrelated same-named method
  `runsStore.getHarnessBinding(...)` (a `ConversationStore` method, not the registry's `getHarness`).
  Zero production hits. Confirmed.
- **(b) The gateway supplies the SAME `accountRunTurn`-wrapped driver chat uses** — **confirmed**,
  and this is the load-bearing, correctly-described fix of the slice. `build-gateway.ts` defines
  exactly one `accountRunTurn` wrapper (line 1050) that records `resourceAccounting.recordAgentRun`
  around any base `RunTurnFn`. Every caller applies the identical expression
  `accountRunTurn(options.runTurn ?? runTurn)`: the unified chat runner (2628), the automations-scoped
  headless-compile runner (2648), interactive automation turns (2671), automation revision rewriting
  (3038), and — newly, in this diff — the fire dispatch at `runAutomation({ ..., runTurn:
  accountRunTurn(options.runTurn ?? runTurn) })` (2307). There is no second/parallel wrapper; it is
  textually the same call. `run-automation.ts` threads it through as a new required
  `RunAutomationOptions.runTurn: RunTurnFn` field, and `run-automation-live-dispatch.ts` calls
  `opts.runTurn(...)` instead of `getHarness(harness).runTurn(...)`. Confirmed genuine, not cosmetic.
- **(c) "The unbudgeted `forceHydration: true` path is genuinely gone"** — **REFUTED**, overstated.
  Two independent problems with this claim:
  - `forceHydration: true` is **not removed** — it is still set unconditionally whenever a
    `hydrationPlan` exists, at the same call site (now line 394, was line 348 at `HEAD`), unchanged
    by this diff (`git diff --cached` shows no hunk touching that line).
  - The **numeric budget itself did not change**. `packages/app-engine/src/conversation/hydration.ts`
    (untouched by this diff — `git diff --cached -- .../hydration.ts` is empty) has defaulted
    `tokenBudget` to `Math.max(256, options.tokenBudget ?? 8_000)` and `minTurns` to `Math.max(1,
    options.minTurns ?? 2)` since commit `18784afe` (`#567`/`#600`), which predates issue #743
    entirely (`git log --oneline -S "tokenBudget ?? 8_000" -- .../hydration.ts` → one hit,
    `18784afe`). The pre-diff dispatch code (`git show HEAD:.../run-automation-live-dispatch.ts`)
    called `compileHydrationPlan(hydrationMessages, { includeAttachmentReferences: true })` with no
    `tokenBudget`/`minTurns` override — meaning it was **already** budgeted to exactly 8,000
    tokens / `minTurns: 2`, the same numbers `TURN_POSTURES.fire.hydration` states. Framing this as
    "the unbudgeted eager fold is gone" therefore overstates what changed: the fold was never
    numerically unbounded in the code as it stood at `HEAD`.
  - Likewise, `hydrationTokens`/`store.setTurnHydrationTokens(turnId, hydrationTokens)` — the
    mechanism that records hydration tokens on automation turns — **already existed** at `HEAD`
    (same commit `18784afe`, `git log --oneline -S "setTurnHydrationTokens" -- .../run-automation-
    live-dispatch.ts` → one hit, pre-#743). So "hydration tokens recorded on automation turns"
    (echoed from the issue's own comparison table, "today only chat records them") was already true
    before this slice landed.
  - What genuinely IS new and correctly attributable to this diff: budget/`minTurns` now flow from
    `TURN_POSTURES` (single source of truth, replacing three separately-hardcoded `8_000`/`minTurns:
    2` literals across `turn-sse.ts`, `headless-automation-compile.ts`, `interactive-automation-
    turn.ts`, and the automation dispatch — a real de-duplication win); a fold whose
    `compiled.includedTurns === 0` is now treated as no fold (`compileBudgeted`'s `undefined`
    branch), which the pre-diff code did not check; and the recovery-hydration gating changed from
    "any prior binding" to "only when a resume handle (`resumeSessionId`) exists and the watermark
    is meaningful" — a real, narrower correctness fix to the resume/recovery interaction, separate
    from the token-budget claim. These are legitimate, but they are not "the unbudgeted path is
    gone" — the budget number never moved.
  - **Test-quality consequence** (see also the closing test-quality judgment below): the new test
    `"automation hydration is compiled under the same token budget as chat"` asserts the fold fits
    8k tokens and drops old turns — true today, but that assertion would very likely have also
    passed against the pre-diff `HEAD` code, because `compileHydrationPlan`'s own default already
    enforced the identical 8,000/2 numbers with no caller override. The test is a valid smoke test
    of current behavior but is **not a regression guard for the specific "budgeted" claim** the
    receipt and the issue's acceptance criterion make; it doesn't have discriminating power against
    the bug being described.
- **(d) `latestHarness` keyed by harness kind (`Map`)** — **confirmed**. The single unkeyed
  `latestHarness`/`observedHarness` closure variables are replaced by `const resumable = new
  Map<HarnessKind, TouchedBinding>()` plus `lastObserved`/`lastSettled`; `resumeSessionId`/
  `resumeUsage` now read `resumable.get(harness)` before falling back to the store's persisted
  binding, and a successful call does `resumable.set(harness, lastObserved)`. A fire that calls two
  different harnesses can no longer hand harness B harness A's opaque session id. Confirmed.
- **(e) Behavior change disclosed: fire turns now send `permissionPolicy: "deny"`** — **confirmed**
  both that the change exists and that it is disclosed. Diff adds `permissionPolicy:
  POSTURE.permissions` at the `opts.runTurn(...)` call site, where `POSTURE = TURN_POSTURES.fire`
  and `fire.permissions === "deny"` (`posture.ts`); previously no `permissionPolicy` field was sent
  at all. The receipt's `## Decisions` section states this explicitly under "**Behavior change,
  called out explicitly:**" with the correct before/after description and the `#484` rationale
  (nobody is present to answer a permission request). Confirmed disclosed, not buried.
- **(f) Per-binding settlement honestly NOT done** — **confirmed**, receipt does not overclaim.
  `finalizeTurn` still calls `store.noteTurn(conversationId, "", lastSettled)` /
  `store.noteFailedTurn(conversationId, "", lastObserved)` — a single `adapter` argument, not one
  per touched binding. `ConversationStore.noteTurn`/`noteFailedTurn` in
  `packages/app-engine/src/conversation/store.ts` (lines 587, 730) both take exactly one optional
  `adapter: { kind, sessionId?, usageSnapshot?, hydrated? }` argument — there is no multi-binding
  entry point for either method to overload into, so a fire that touched two harnesses this turn
  still only settles the last one touched. The receipt's `## Decisions` bullet ("Per-binding
  settlement is deliberately NOT done here...") states this accurately, and the checklist correctly
  leaves the multi-harness settlement item ( `- [ ] HarnessSessions extraction...per-binding
  settlement + multi-harness regression test`) unchecked. Confirmed honest.

**(2) Each checked `- [x]` item is realized; each `- [ ]` is genuinely not claimed done** — **PASS**,
with the caveat noted in (1)(c) carried forward (the checklist line's literal claim — "budgeted
hydration" exists and is data-driven — is true; the overstatement lives in the prose narrative, not
the checkbox).

- The newly-flipped line — `- [x] ctx.delegate dispatched through the accounted chat spine
  (metering, budgeted hydration, kind-scoped resume)` — is realized in the staged diff: metering via
  (1)(b), hydration reads from `TURN_POSTURES` via (1)(c), kind-scoped resume via (1)(d). All three
  parenthetical sub-claims have code backing, even though "budgeted" is less of a fix than the prose
  implies.
- The four earlier checked items remain realized in `HEAD` (unchanged by this diff): vault schema
  (`4162072c`), harness axis (`5624e365`), delegate rail (`9a07465d`), docs/glossary write-back
  (`6955ec4c`) — `git log --oneline -5` confirms all four commit subjects reference `#743`.
- The two-harness **settlement** regression test is explicitly and correctly NOT claimed — it is
  named in the still-unchecked `- [ ]` item 6 ("HarnessSessions extraction... per-binding settlement
  + multi-harness regression test"), consistent with (1)(f) above and with the issue's own
  acceptance criterion ("A fire whose handler calls `ctx.delegate` twice with two different harnesses
  ... settles **both** bindings' watermarks") being left for a future slice.
- Remaining 4 unchecked items (HarnessSessions extraction, per-call `harness`/`model`/`configPins`,
  `@agentclientprotocol/sdk` adoption, closing #740) have **zero footprint in the staged diff** —
  `git diff --cached --name-only` touches only `packages/agent-runtime/src/automation/*`,
  `packages/app-engine/src/conversation/posture.ts`, `packages/app-engine/src/http/turn-sse.ts`,
  `packages/app-engine/src/index.ts`, `packages/gateway/src/lifecycle/*`,
  `packages/gateway/src/serve/build-gateway.ts`, and the receipt — no `registry.ts`,
  `backends/acp/*`, `gateway-db.ts` (schema), `manifest.ts`, blueprint handler, or skill file is
  staged. Correctly left unchecked.

**(3) `## Checklist` mirrors issue #743's `Scope > In:` bullets** — **PASS**. Fetched issue #743
fresh via `mcp__github__issue_read` (full body, not a cached summary). The issue's `# Scope > In:`
list (renames incl. vault schema/item-kind; `ctx.delegate` dispatch through the chat spine + fork
deletion; HarnessSessions extraction + per-binding settlement; metering + hydration-token accounting
for delegate turns; per-call `harness`/`model`/`configPins` + `#567` D13 consent + failover
interplay; compiler work order + skills + 5 blueprint handlers + lint messages; `@agentclientprotocol/
sdk` adoption; glossary/README/ARCHITECTURE/docs A1 write-back; closing #740) maps 1:1 onto the
receipt's 9-line checklist with no added or missing scope claim.

**Independent verification run fresh in this audit:**
- `bun run typecheck` → **green**, 35/35 tasks (turbo full-turbo replay/cache-hit on unaffected
  packages, fresh compile on touched ones).
- `bunx vitest run --root packages/gateway src/lifecycle/automation-delegate-metering.test.ts` →
  **2/2 passed** (22.5s). Both scenarios genuinely exercise the acceptance criterion: the first fires
  a real automation over HTTP against a booted gateway with a stubbed `runTurn`, asserts the turn
  reaches the injected seam (`turns` array populated, `permissionPolicy === "deny"`), asserts
  `resourceUsage.subsystems.agentRuns.runs` increases, and reads the `delegate` ledger item's
  `model`/`input_tokens`/`cost_source`/`cost_usd` straight out of the journal SQLite file — a
  genuinely end-to-end check, not a unit stub. The second fires twice with a non-session-minting
  stub and asserts exactly one `turns` row has `hydration_tokens > 0`.
- `bunx vitest run --root packages/agent-runtime src/automation` → **25 passed, 1 skipped** (3.04s).
- `bunx vitest run --config vitest.quality.config.ts user-facing-qualities` → **14/14 passed**
  (22.0s).
- `git grep -n 'getHarness\|registry\.js' -- packages/agent-runtime/src/automation/` → hits only in
  test files and the unrelated `getHarnessBinding` store method, as detailed in (1)(a). No
  production dispatch hit.

**Test-quality judgment (asked explicitly):**
- `run-automation-dispatch.test.ts`'s new `"no dispatch path reaches a harness without passing the
  accounted seam"` test is a genuinely strong regression guard: it asserts a *behavioral* invariant
  (accounted-seam call count equals harness-stub call count) **and** a *structural* one (source-text
  assertion that the file contains neither `from "../registry.js"` nor `getHarness(`), which is
  exactly the pairing the issue's own acceptance criterion asks for ("a test asserts no dispatch path
  reaches a harness without passing the accounted seam") and exactly what the receipt's own
  `## Decisions` bullet claims ("asserted at two levels: behaviorally... and structurally..."). Not
  shallow.
- `automation-delegate-metering.test.ts` is a real end-to-end gateway-boot test hitting the actual
  HTTP surface and reading the actual journal SQLite rows for pricing/hydration-token proof. Not
  shallow.
- `"automation hydration is compiled under the same token budget as chat"` (in
  `run-automation-dispatch.test.ts`) is comparatively **shallow** relative to what it's positioned to
  prove: as established in (1)(c), the 8,000-token/`minTurns: 2` bound it asserts was already the
  `compileHydrationPlan` default at `HEAD` before this diff, with no caller override in either the
  old or new dispatch code. The test verifies current, correct behavior, but does not discriminate
  between the pre-diff and post-diff code paths — it would very plausibly have also passed unmodified
  against `HEAD`'s dispatch file. It is not a meaningful regression guard for the "budgeted hydration"
  claim it is named after, even though the surrounding refactor (posture-sourced config, zero-turn-
  fold handling, recovery-gating) is real.
- The multi-harness **settlement** regression test the issue's acceptance criteria explicitly ask for
  is, correctly, **not present** in this slice — it is deferred with the rest of HarnessSessions, as
  disclosed.

**Overall verdict: REFUTED.** The core architectural claim of this slice — `ctx.delegate` now runs
on the identical `accountRunTurn`-wrapped `RunTurnFn` chat/compile/steering use, closing the one
truly unmetered path (wall-clock/run-count resource accounting via
`resourceAccounting.recordAgentRun`) — is real, correctly described, and well-tested; the kind-scoped
resume `Map`, the disclosed `permissionPolicy: "deny"` behavior change, and the honest
non-claim of per-binding settlement are all accurate. However, the receipt's narrative
("the unbudgeted eager fold is gone", "hydration tokens recorded... the one unmetered path... is
closed" in the hydration sense) and the newly-added regression test both overstate what changed on
the hydration-budget axis specifically: `packages/app-engine/src/conversation/hydration.ts`'s
`tokenBudget ?? 8_000` / `minTurns ?? 2` defaults, and the dispatch file's `setTurnHydrationTokens`
call, both predate issue #743 (commit `18784afe`, `#567`/`#600`) and were never overridden by the
pre-diff automation dispatch — so the numeric hydration budget in production automation turns did not
change in this diff, only its data source (hardcoded literal → `TURN_POSTURES`) and two narrower
edge-case fixes (zero-turn fold treated as no-fold; recovery fold gated to only apply when a resume
handle exists) did. This is a real inaccuracy in the receipt's own account of its diff, not merely a
tooling nit — it directly touches one of issue #743's acceptance criteria ("Automation hydration
respects the same token budget as chat (no unbudgeted `forceHydration` path)"), which reads as though
this slice closed a numeric gap that, on the evidence, was already closed by unrelated prior work.
Recommend: soften the `## What changed` hydration paragraph and the corresponding `## Decisions`/
`## Verification` bullets to describe the *actual* deltas (posture-sourced config, zero-turn no-fold,
recovery gating) rather than "the unbudgeted fold is gone," and note in the acceptance-criteria
mapping that the token-budget criterion was already satisfied before this slice by `#567`/`#600`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 56e4d30a-2bce-4149-af0c-60147a8837f1 |
