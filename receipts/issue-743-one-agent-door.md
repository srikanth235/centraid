# Issue #743 — one agent door

## User impact

Settings continues to call the installed coding tools **Agents**, while every
internal preference, status route, health record, and session binding now uses
one word: **harness**. Automation authors use `ctx.delegate` for bounded model
judgment and may explicitly select a consented harness, model, and configuration
pins for one step without leaking ACP clients or session handles into handlers.

First-run: onboarding and the fresh Home are unchanged. A new installation has
no additional consent prompt; unattended delegation remains fail-closed unless
the harness is present in the member-authored automation ladder. Visual evidence:
`artifacts/e2e/ui-impact/issue-743-one-agent-door.png`, emitted by
`apps/desktop/tests/e2e/settings-gateways.spec.ts` with Settings → Agents open.

## Checklist

- [x] The installed-CLI axis is `HarnessKind` / `HarnessPrefs` / `HarnessSpec` /
  `HARNESSES` / `getHarness`; remaining `runner` tokens are limited to the
  `ConversationRunner` chat spine, worker/handler entry files, and generic
  query/test/CI execution callbacks enumerated under Decisions.
- [x] `ctx.agent` and its worker/dispatcher/failure vocabulary are replaced by
  `ctx.delegate`; persisted model-turn items use `kind: "delegate"`.
- [x] The enrolled autonomous principal is `consent.agent` / `consent_agent`
  with `enrollment_key`; invocation attribution is `caller_id`; the media
  central table is logical `media.asset` / physical `media_asset`.
- [x] `HarnessSessions` owns resume, hydration plans, observations, and
  settlement independently for each `(conversationRef, harnessKind)`; a
  two-harness fire test verifies both bindings and watermarks.
- [x] Every production harness dispatch (chat, compile, delegate, and
  auto-title) enters the required host-injected, `accountRunTurn`-wrapped
  `TurnPlane` seam; turns are priced, harness cost provenance and hydration
  usage are persisted, and integration tests compare observed calls with the
  production accounting counter so no host/test injection is bypassed.
- [x] Chat and automation hydration share the 8,000-token budget and two-turn
  floor.
- [x] Per-call `harness`, `model`, and `configPins` reach the named harness;
  the provider-egress consent controller is mandatory and missing,
  unknown, or unauthored harness consent fails closed with typed metadata;
  explicit harness failures never silently cross providers.
- [x] The local enrichment tier still seals delegation and deterministic
  recognition steps remain available.
- [x] The handwritten ACP JSON-RPC connection is deleted; the stable, exact
  `@agentclientprotocol/sdk@1.3.0` entrypoint owns frames and request errors;
  its generated method, request, response, notification, capability, content,
  permission, usage, cost, and stop-reason types flow end-to-end through warm
  pooling, probes, vault MCP, and event normalization.
- [x] The glossary, architecture, harness guide, package READMEs, compiler
  grounding, governance directives, and five generated recognition handlers
  use the new vocabulary.
- [x] A real gateway compile → publish → fire test compiles “use opencode
  deepseek-ocr to OCR the images, then summarize with the default harness” and
  observes `opencode/deepseek-ocr` with pins followed by default `codex`.
- [x] Final `bun run check:pr` passes; the conventional commit and draft PR
  reference #743, and this `receipts/issue-743-one-agent-door.md` receipt has
  Checklist, What changed, Out of scope, Verification, Decisions, and Audit
  sections.

## What changed

### Acceptance crosswalk

- The installed-CLI axis is `HarnessKind` / `HarnessPrefs` / `HarnessSpec` /
  `HARNESSES` / `getHarness`, with the narrow `runner` exceptions recorded in
  Decisions.
- `ctx.agent` and its worker/dispatcher/failure vocabulary are replaced by
  `ctx.delegate`, including the persisted delegate item kind.
- The enrolled autonomous principal is `consent.agent` / `consent_agent`, with
  the paired enrollment, caller-attribution, and media-table renames.
- `HarnessSessions` owns resume, hydration plans, observations, and
  settlement independently for each conversation/harness binding.
- Every production harness dispatch (chat, compile, delegate, and
  auto-title), plus capture and instruction rewrite, crosses the accounted
  `TurnPlane` door.
- Chat and automation hydration share the 8,000-token budget and two-turn
  floor.
- Per-call `harness`, `model`, and `configPins` reach the named harness; consent
  and explicit-harness failure behavior remain fail-closed.
- The local enrichment tier still seals delegation and deterministic recognition
  remains available.
- The handwritten ACP JSON-RPC connection is deleted; the stable, exact SDK
  owns its connection and generated wire types.
- The glossary, architecture, harness guide, package READMEs, compiler grounding,
  governance directives, and generated handlers use the canonical vocabulary.
- A real gateway compile → publish → fire test compiles “use opencode
  deepseek-ocr to OCR the images, then summarize with the default harness” and
  verifies both harness calls, pins, costs, ledger items, and accounting totals.

- Replaced the multi-name installed-CLI surface with the harness vocabulary
  across runtime types, preferences, routes, settings identifiers, health,
  analytics, protocol declarations, and documentation. User-facing copy stays
  **Agents**.
- Replaced the automation model rail and worker protocol with `ctx.delegate`,
  including compiler instructions, lint guidance, scaffold output, generated
  recipes, typed failure marshalling, and ledger item values.
- Added `TurnPlane` as the one injected turn door and `HarnessSessions` as the
  per-conversation/per-harness resume and hydration owner. Automation fires now
  use the same accounted host driver as chat, including host-provided drivers.
- Added per-call harness/model/config pins, consent-derived validation, explicit
  no-failover behavior, multi-binding settlement, and shared hydration budgets.
- Replaced the handwritten ACP framing layer with the pinned stable SDK while
  retaining launch, pooling, probe, capability, vault-MCP, and normalized event
  behavior. The transport now preserves the SDK's method-literal request/
  response pairing and direct generated frame types instead of erasing them
  behind local `unknown`/`Record` facsimiles.
- Renamed the v0 vault and journal schema surfaces, updated replica security and
  portable-export coverage, and regenerated the bundled automation artifacts.
- Added focused regression tests and the end-to-end compile/publish/fire
  integration test. That production gateway test also compares every observed
  harness call with the host `ResourceAccounting` run counter and verifies the
  two delegate ledger items carry harness-sourced cost, so a direct dispatch
  bypass cannot masquerade as a passing fire.
- Closed the audit-discovered edges: auto-title now uses the same accounted
  driver and has a production-graph regression; every conversation runner and
  unattended compile requires a provider-egress controller, missing controllers
  deny before harness dispatch, and auto-title reuses an existing durable grant;
  public enrollment DTOs expose `enrollmentKey` without a `hostKey` alias; and
  assistant change events, harness artifacts, resource metrics, capture helpers,
  launch environments, and delegate ledger locals use their canonical role names.
- Closed the fifth audit's remaining boundary and vocabulary findings: ACP
  session/config/content/permission/usage/stop frames now stay SDK-typed at the
  connection boundary, while capture helpers, warm slots, failure classifiers,
  glyphs, health/cache keys, fixtures, perf/scale IDs, docs, and the Centraid City
  simulation use harness/delegate vocabulary.
- Closed the sixth audit's architectural and gate-integrity findings: auto-title,
  capture classification, and interactive instruction rewrite now enter
  `TurnPlane`; remaining route/test/doc aliases use harness vocabulary; the
  schema-naming rule distinguishes logical and physical stutter examples; and a
  matrix flow rename must identify its exact predecessor through a one-to-one
  `replacesMinimumTestsFlow` mapping. A regression proves one replacement cannot
  absorb two removed floors.
- Closed the seventh audit's consent and governance findings: `TurnPlane`
  itself now requires a positive host-owned provider-egress check before it can
  call the accounted driver; auto-title and delegation recheck their durable
  grants at that door; attended instruction rewrite records a direct grant; and
  universal capture records its attended direct grant against one hidden,
  vault-local build conversation before classification. Denial is tested to
  prove the harness driver is untouched. The oversized automation dispatch test
  was split along its durable-consent boundary, keeping both files below the
  unchanged 625-line governance ceiling.

### Changed-path manifest

Every postimage path in the final diff against origin/main is enumerated below,
including deletions and replacement destinations. The 28 rename sources are
enumerated separately after the 574 postimage paths so both endpoints remain
reviewable:

- `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/check.sh`
- `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/constitution.md`
- `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/directive.yaml`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CONSTITUTION.md`
- `README.md`
- `TESTING.md`
- `apps/desktop/scripts/screenshot-automations.mjs`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/app-sessions.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/preload-core.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/desktop/tests/e2e/settings-gateways.spec.ts`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/assistant/useAssistant.test.ts`
- `apps/mobile/src/apps/assistant/useAssistant.ts`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/FaceReview.test.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.tsx`
- `apps/mobile/src/apps/photos/camera-roll-import-run.ts`
- `apps/mobile/src/apps/photos/camera-roll-import.ts`
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
- `apps/mobile/src/lib/assistant.test.ts`
- `apps/mobile/src/lib/assistant.ts`
- `apps/mobile/src/lib/automations.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/placement-transport.test.ts`
- `apps/mobile/src/screens/Capture.tsx`
- `apps/mobile/src/screens/home/blueprint-search.ts`
- `apps/mobile/src/screens/home/tile-model.test.ts`
- `apps/mobile/src/screens/home/useSearchRecents.ts`
- `apps/mobile/src/screens/home/useSpringboardTiles.ts`
- `bun.lock`
- `centraid-city/README.md`
- `centraid-city/SPEC.md`
- `centraid-city/src/core/content.sample.ts`
- `centraid-city/src/core/content.ts`
- `centraid-city/src/core/types.ts`
- `centraid-city/src/sim/sim.ts`
- `centraid-city/src/ui/ui.ts`
- `centraid-city/src/world/landmarks-core.ts`
- `centraid-city/src/world/world.ts`
- `docs/blueprint-seats.md`
- `docs/config-ownership.md`
- `docs/decisions.md`
- `docs/glossary.md`
- `docs/harnesses.md`
- `docs/photos-derived-ledger.md`
- `docs/protocol.md`
- `docs/recognition-automations.md`
- `oxlint.config.ts`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/scripts/live-harness-smoke.ts`
- `packages/agent-runtime/scripts/probe-all-harnesses.ts`
- `packages/agent-runtime/src/automation/live-automation-failover.test.ts`
- `packages/agent-runtime/src/automation/run-automation-consent.test.ts`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.test.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/agent-runtime/src/backends/acp/backend.attachments.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.model-usage.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/backends/acp/backend.vault-tools.test.ts`
- `packages/agent-runtime/src/backends/acp/blueprint-harness-parity.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/capabilities-cache.test.ts`
- `packages/agent-runtime/src/backends/acp/capabilities-cache.ts`
- `packages/agent-runtime/src/backends/acp/connection.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.test.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.ts`
- `packages/agent-runtime/src/backends/acp/fake-acp-harness.mjs`
- `packages/agent-runtime/src/backends/acp/harness-errors.test.ts`
- `packages/agent-runtime/src/backends/acp/harness-errors.ts`
- `packages/agent-runtime/src/backends/acp/journey.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/json-rpc.ts`
- `packages/agent-runtime/src/backends/acp/launch.ts`
- `packages/agent-runtime/src/backends/acp/permissions.test.ts`
- `packages/agent-runtime/src/backends/acp/permissions.ts`
- `packages/agent-runtime/src/backends/acp/probe-capabilities.ts`
- `packages/agent-runtime/src/backends/acp/safe-stdin-write.test.ts`
- `packages/agent-runtime/src/backends/acp/safe-stdin-write.ts`
- `packages/agent-runtime/src/backends/acp/session-config.test.ts`
- `packages/agent-runtime/src/backends/acp/session-config.ts`
- `packages/agent-runtime/src/backends/acp/session-warm.test.ts`
- `packages/agent-runtime/src/backends/acp/session-warm.ts`
- `packages/agent-runtime/src/backends/acp/stop-reason.test.ts`
- `packages/agent-runtime/src/backends/acp/stop-reason.ts`
- `packages/agent-runtime/src/backends/acp/stream-events.test.ts`
- `packages/agent-runtime/src/backends/acp/stream-events.ts`
- `packages/agent-runtime/src/backends/acp/test-fixtures.ts`
- `packages/agent-runtime/src/backends/acp/turn-vault-tools.test.ts`
- `packages/agent-runtime/src/backends/acp/turn-vault-tools.ts`
- `packages/agent-runtime/src/backends/acp/types.ts`
- `packages/agent-runtime/src/backends/acp/usage.test.ts`
- `packages/agent-runtime/src/backends/acp/usage.ts`
- `packages/agent-runtime/src/backends/acp/vault-mcp-server.test.ts`
- `packages/agent-runtime/src/backends/acp/vault-mcp-server.ts`
- `packages/agent-runtime/src/backends/acp/vault-mcp-stdio-proxy.mjs`
- `packages/agent-runtime/src/cli/centraid-cli-dir.ts`
- `packages/agent-runtime/src/cli/centraid-cli.ts`
- `packages/agent-runtime/src/conversation-driver.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/low-priority.ts`
- `packages/agent-runtime/src/matrix-concurrency.test.ts`
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
- `packages/agent-runtime/src/multimodal.test.ts`
- `packages/agent-runtime/src/multimodal.ts`
- `packages/agent-runtime/src/preflight.test.ts`
- `packages/agent-runtime/src/preflight.ts`
- `packages/agent-runtime/src/registry.test.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/agent-runtime/src/runtime.invalid-kind.test.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/spawn-env.ts`
- `packages/agent-runtime/src/types.ts`
- `packages/agent-runtime/src/vault-sql-tool.ts`
- `packages/app-engine/README.md`
- `packages/app-engine/src/changes/change-bus.ts`
- `packages/app-engine/src/conversation/archive/segment.ts`
- `packages/app-engine/src/conversation/auto-title.test.ts`
- `packages/app-engine/src/conversation/auto-title.ts`
- `packages/app-engine/src/conversation/capture-classifier.test.ts`
- `packages/app-engine/src/conversation/capture-classifier.ts`
- `packages/app-engine/src/conversation/harness-health.test.ts`
- `packages/app-engine/src/conversation/harness-health.ts`
- `packages/app-engine/src/conversation/harness-sessions.test.ts`
- `packages/app-engine/src/conversation/harness-sessions.ts`
- `packages/app-engine/src/conversation/history.test.ts`
- `packages/app-engine/src/conversation/history.ts`
- `packages/app-engine/src/conversation/hydration.test.ts`
- `packages/app-engine/src/conversation/hydration.ts`
- `packages/app-engine/src/conversation/provider-egress-consent.test.ts`
- `packages/app-engine/src/conversation/provider-egress-consent.ts`
- `packages/app-engine/src/conversation/rehydrate.test.ts`
- `packages/app-engine/src/conversation/reprice.test.ts`
- `packages/app-engine/src/conversation/reprice.ts`
- `packages/app-engine/src/conversation/run-summary-sink.ts`
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
- `packages/app-engine/src/conversation/turn-plane.test.ts`
- `packages/app-engine/src/conversation/turn-plane.ts`
- `packages/app-engine/src/conversation/turn.test.ts`
- `packages/app-engine/src/conversation/turn.ts`
- `packages/app-engine/src/handlers/build-extra-prompt.ts`
- `packages/app-engine/src/http/changes-sse.test.ts`
- `packages/app-engine/src/http/conversation-routes.ts`
- `packages/app-engine/src/http/router.ts`
- `packages/app-engine/src/http/security.ts`
- `packages/app-engine/src/http/static-server.ts`
- `packages/app-engine/src/http/turn-routes.test.ts`
- `packages/app-engine/src/http/turn-routes.ts`
- `packages/app-engine/src/http/turn-sse-support.ts`
- `packages/app-engine/src/http/turn-sse.test.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/insights/README.md`
- `packages/app-engine/src/insights/index.ts`
- `packages/app-engine/src/insights/insights-sql.ts`
- `packages/app-engine/src/insights/insights-store.test.ts`
- `packages/app-engine/src/insights/insights-store.ts`
- `packages/app-engine/src/insights/insights-types.ts`
- `packages/app-engine/src/model-pricing.test.ts`
- `packages/app-engine/src/model-pricing.ts`
- `packages/app-engine/src/registry/app-paths.ts`
- `packages/app-engine/src/registry/manifest.ts`
- `packages/app-engine/src/registry/token-purity.ts`
- `packages/app-engine/src/runtime.ts`
- `packages/app-engine/src/settings/settings-merge.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/app-engine/src/stores/prefs-store.test.ts`
- `packages/app-engine/src/stores/prefs-store.ts`
- `packages/app-engine/src/stores/vault-workspace.ts`
- `packages/automation/README.md`
- `packages/automation/src/fire/connector.test.ts`
- `packages/automation/src/fire/enrich-gate.test.ts`
- `packages/automation/src/fire/enrich-gate.ts`
- `packages/automation/src/fire/enrich-refusal-outcome.test.ts`
- `packages/automation/src/fire/fire-vault.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/audit.test.ts`
- `packages/automation/src/handler/audit.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/delegate-answer.ts`
- `packages/automation/src/handler/lint.test.ts`
- `packages/automation/src/handler/lint.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/automation/src/manifest/manifest.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold-files.test.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/scaffold/webhook.ts`
- `packages/automation/src/worker/runner.ts`
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
- `packages/blueprints/apps/photos/enrichment-consent.ts`
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
- `packages/blueprints/automations/doc-entity-linker/automations/doc-entity-linker/handler.js`
- `packages/blueprints/automations/doc-filer/automations/doc-filer/handler.js`
- `packages/blueprints/automations/doc-text-extractor/automations/doc-text-extractor/handler.js`
- `packages/blueprints/automations/embed-image/automations/embed-image/automation.json`
- `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`
- `packages/blueprints/automations/faces/automations/faces/handler.js`
- `packages/blueprints/automations/obligation-extractor/automations/obligation-extractor/handler.js`
- `packages/blueprints/automations/photo-ocr/app.json`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/automation.json`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/release-notes-drafter/automations/release-notes-drafter/handler.js`
- `packages/blueprints/automations/transcript/automations/transcript/automation.json`
- `packages/blueprints/automations/transcript/automations/transcript/handler.js`
- `packages/blueprints/index.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/__snapshots__/scaffold-defaults.test.ts.snap`
- `packages/blueprints/src/no-inference-client.test.ts`
- `packages/blueprints/src/photos-library-store.test.ts`
- `packages/blueprints/src/photos-shelves-v4.test.ts`
- `packages/blueprints/src/photos-vocabulary.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/query-handlers.test.ts`
- `packages/blueprints/src/scaffold-defaults.ts`
- `packages/blueprints/src/scaffold-types.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/app-format.ts`
- `packages/client/src/capture.test.ts`
- `packages/client/src/capture.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-automations.contract.test.ts`
- `packages/client/src/gateway-client-capture.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-conversation.ts`
- `packages/client/src/gateway-client-editing.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/blueprints/centraid-inline-scopes.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/blueprints/kit-ask-inline.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/AutomationCompilePane.test.tsx`
- `packages/client/src/react/screens/AutomationCompilePane.tsx`
- `packages/client/src/react/screens/AutomationEditorAccountChoice.test.tsx`
- `packages/client/src/react/screens/AutomationEditorHarnessPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.test-fixtures.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.test.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/BuilderChatPane.test.tsx`
- `packages/client/src/react/screens/BuilderChatPane.tsx`
- `packages/client/src/react/screens/InsightsScreen.test.tsx`
- `packages/client/src/react/screens/InsightsScreen.tsx`
- `packages/client/src/react/screens/ResourceReceiptPanel.test.tsx`
- `packages/client/src/react/screens/ResourceReceiptPanel.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsHarnessEntries.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.module.css`
- `packages/client/src/react/screens/SettingsHarnessesScreen.test.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.tsx`
- `packages/client/src/react/screens/SettingsHarnessesSelects.tsx`
- `packages/client/src/react/screens/harnessGlyphs.tsx`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/screens/privacyStores.test.ts`
- `packages/client/src/react/screens/resource-summary.ts`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/CaptureOverlay.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.test.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/InsightsRoute.test.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/assistantTranscript.ts`
- `packages/client/src/react/shell/routes/automationCompileData.ts`
- `packages/client/src/react/shell/routes/automationEditorCreateData.ts`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/automationEditorHarnessData.ts`
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts`
- `packages/client/src/react/shell/routes/automationEditorRoute.fixture.ts`
- `packages/client/src/react/shell/routes/automationLiveMessages.ts`
- `packages/client/src/react/shell/routes/automationThreadData.test.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.test.ts`
- `packages/client/src/react/shell/routes/automationTurnMessages.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.test.ts`
- `packages/client/src/react/shell/routes/automationsOverviewLoad.ts`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationConfigView.test.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPaneShared.test.ts`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.test.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderCode.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderPreview.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderShell.tsx`
- `packages/client/src/react/shell/routes/builder/useBuilder.test.ts`
- `packages/client/src/react/shell/routes/builder/useBuilder.ts`
- `packages/client/src/react/shell/routes/connectorPlatform.ts`
- `packages/client/src/react/shell/routes/homeTileContent.test.ts`
- `packages/client/src/react/shell/routes/homeTileContent.ts`
- `packages/client/src/react/shell/routes/runViewData.test.ts`
- `packages/client/src/react/shell/routes/runViewData.ts`
- `packages/client/src/react/shell/routes/scopedDirectory.ts`
- `packages/client/src/react/shell/routes/settingsHarnessesData.test.ts`
- `packages/client/src/react/shell/routes/settingsHarnessesData.ts`
- `packages/client/src/replica/shell-session-scopes.test.ts`
- `packages/design/kit/elements-base.js`
- `packages/design/kit/kit.ts`
- `packages/design/kit/turn-stream.d.ts`
- `packages/gateway/README.md`
- `packages/gateway/package.json`
- `packages/gateway/scripts/embed-web.mjs`
- `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
- `packages/gateway/skills/automation-authoring/SKILL.md`
- `packages/gateway/src/brief/daily-brief.test.ts`
- `packages/gateway/src/brief/daily-brief.ts`
- `packages/gateway/src/cli/cli.test.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/config.ts`
- `packages/gateway/src/cli/harness-prefs.ts`
- `packages/gateway/src/enrich/semantic-search.test.ts`
- `packages/gateway/src/enrich/semantic-search.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/lifecycle/automation-harness-selection.test.ts`
- `packages/gateway/src/lifecycle/automation-harness-selection.ts`
- `packages/gateway/src/lifecycle/automation-revision.test.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.test.ts`
- `packages/gateway/src/lifecycle/automation-turn-context.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts`
- `packages/gateway/src/lifecycle/headless-automation-compile.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.test.ts`
- `packages/gateway/src/lifecycle/interactive-automation-turn.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.test.ts`
- `packages/gateway/src/lifecycle/rewrite-automation-instructions.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/apps-store-draft-files.ts`
- `packages/gateway/src/routes/apps-store-routes.ts`
- `packages/gateway/src/routes/assistant-routes.test.ts`
- `packages/gateway/src/routes/assistant-routes.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/capture-routes.ts`
- `packages/gateway/src/routes/commons-recovery-routes.test.ts`
- `packages/gateway/src/routes/commons-routes-intents.test.ts`
- `packages/gateway/src/routes/commons-routes.test.ts`
- `packages/gateway/src/routes/commons-routes.ts`
- `packages/gateway/src/routes/connection-providers.ts`
- `packages/gateway/src/routes/enrich-search-routes.test.ts`
- `packages/gateway/src/routes/harnesses-routes.test.ts`
- `packages/gateway/src/routes/harnesses-routes.ts`
- `packages/gateway/src/routes/import-routes.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/routes/lifecycle-routes.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/gateway/src/routes/route-helpers.ts`
- `packages/gateway/src/routes/route-security.ts`
- `packages/gateway/src/runs/assistant-conversation-runner.ts`
- `packages/gateway/src/runs/assistant-prompt.ts`
- `packages/gateway/src/runs/run-events-sse.test.ts`
- `packages/gateway/src/runs/unified-conversation-runner.test.ts`
- `packages/gateway/src/runs/unified-conversation-runner.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/commons-observability.test.ts`
- `packages/gateway/src/serve/demo-seed.test.ts`
- `packages/gateway/src/serve/harness-prefs.test.ts`
- `packages/gateway/src/serve/harness-prefs.ts`
- `packages/gateway/src/serve/health-registry.test.ts`
- `packages/gateway/src/serve/health-registry.ts`
- `packages/gateway/src/serve/local-usage.ts`
- `packages/gateway/src/serve/peer-commons-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-hardening.test.ts`
- `packages/gateway/src/serve/peer-commons-sweep.test.ts`
- `packages/gateway/src/serve/peer-give.test-fixtures.ts`
- `packages/gateway/src/serve/peer-remote-give.test.ts`
- `packages/gateway/src/serve/peer-transport-remote.test.ts`
- `packages/gateway/src/serve/resource-accounting.test.ts`
- `packages/gateway/src/serve/resource-accounting.ts`
- `packages/gateway/src/serve/runner-prefs.test.ts`
- `packages/gateway/src/serve/runner-prefs.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-plane-assistant.test.ts`
- `packages/gateway/src/serve/vault-plane-links.test.ts`
- `packages/gateway/src/serve/vault-plane-scopes.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/skills/index.ts`
- `packages/gateway/src/validate-app-css.ts`
- `packages/gateway/src/validate-manifest.ts`
- `packages/gateway/src/worktree-store/git.ts`
- `packages/gateway/src/worktree-store/types.ts`
- `packages/gateway/src/worktree-store/worktree-store.ts`
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
- `packages/vault/src/enrich/policy.ts`
- `packages/vault/src/gateway/cards.test.ts`
- `packages/vault/src/gateway/cards.ts`
- `packages/vault/src/gateway/duties.test.ts`
- `packages/vault/src/gateway/duties.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.contract.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/identity.ts`
- `packages/vault/src/gateway/portability.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/host.ts`
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
- `scripts/docs-site/src/content/devices.html`
- `scripts/docs-site/src/content/ontology-body.html`
- `scripts/docs-site/src/content/understand.html`
- `scripts/docs-site/src/pages/devices.astro`
- `scripts/home-site/public/index.html`
- `scripts/lint-acp-min-versions.mjs`
- `scripts/lint-aria-labels.mjs`
- `scripts/test-report/ratchet-floors.mjs`
- `scripts/test-report/ratchet-floors.test.mjs`
- `tests/design-token-css-budget.json`
- `tests/experience-budgets/gateway.json`
- `tests/matrix.json`
- `tests/matrix.schema.json`
- `tests/perf/automation-fire.perf.test.ts`
- `tests/perf/harness-turn.perf.test.ts`
- `tests/quality-rig-budgets.json`
- `tests/quality/classification-ratchet.json`
- `tests/quality/first-paint-query-counts.test.ts`
- `tests/quality/fixtures/kill-mid-write-child.ts`
- `tests/quality/user-facing-qualities.test.ts`
- `tests/scale/harness-sessions.scale.test.ts`
- `tests/scale/large-vault.scale.test.ts`
- `tests/scale/phash-clustering.scale.test.ts`
- `tests/scale/photos-memories.scale.test.ts`
- `tests/scale/photos-timeline.scale.test.ts`
- `tests/schema-export-fingerprint.json`
- `tests/skips.json`
- `tools/recognition-automations/automation-handlers/embed-image.js`
- `tools/recognition-automations/automation-handlers/faces.js`
- `tools/recognition-automations/automation-handlers/photo-ocr.js`
- `tools/recognition-automations/automation-handlers/transcript.js`
- `vitest.config.ts`

#### Rename source paths

- `docs/runners.md`
- `packages/agent-runtime/scripts/live-adapter-smoke.ts`
- `packages/agent-runtime/scripts/probe-all-adapters.ts`
- `packages/agent-runtime/src/backends/acp/blueprint-agent-parity.integration.test.ts`
- `packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`
- `packages/agent-runtime/src/backends/acp/agent-errors.test.ts`
- `packages/agent-runtime/src/backends/acp/agent-errors.ts`
- `packages/agent-runtime/src/conversation-adapter.ts`
- `packages/app-engine/src/conversation/runner-health.test.ts`
- `packages/app-engine/src/conversation/runner-health.ts`
- `packages/automation/src/handler/agent-answer.ts`
- `packages/client/src/react/screens/AutomationEditorAgentPicker.tsx`
- `packages/client/src/react/screens/SettingsProvidersAgents.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersSelects.tsx`
- `packages/client/src/react/screens/agentGlyphs.tsx`
- `packages/client/src/react/shell/routes/automationEditorAgentData.ts`
- `packages/client/src/react/shell/routes/settingsProvidersData.test.ts`
- `packages/client/src/react/shell/routes/settingsProvidersData.ts`
- `packages/gateway/src/cli/runner-prefs.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.test.ts`
- `packages/gateway/src/lifecycle/automation-agent-selection.ts`
- `packages/gateway/src/routes/agents-routes.test.ts`
- `packages/gateway/src/routes/agents-routes.ts`
- `tests/perf/agent-turn.perf.test.ts`
- `tests/scale/agent-sessions.scale.test.ts`


## Out of scope

- The npm package remains `@centraid/agent-runtime`; its README records that
  this historical package name does not define the domain vocabulary.
- No `ctx.acp` rail, handler-owned ACP client, handler process spawning, or
  autonomous tool-enabled delegation was added.
- No SDK `experimental/v2` entrypoint is used.
- Worktree-store/publish mechanics and new consent UI are unchanged.
- Live provider dogfood requiring local credentials/model assets is not claimed;
  deterministic gateway and ACP integration suites cover the same host seams.

## Verification

Replay the final repository-owned gates with:

```sh
bun run test
bun run test:qualities
bun run check:pr
git diff --check
```

- `bun run format` — pass.
- `git diff --check` — pass.
- `bun run --cwd packages/app-engine test` — 60 files, 630 tests passed.
- `bun run --cwd packages/automation test` — 27 files, 419 tests passed.
- `bun run --cwd packages/agent-runtime test` — 36 files / 323 tests passed;
  one file / one credential-gated live test skipped.
- Focused vault contracts — 2 files, 57 tests passed.
- Focused client/mobile rename contracts — 14 tests passed.
- Gateway harness status, replica-shape, and compile/publish/fire contracts —
  passed; the round trip observed exactly two injected harness calls.
- `bun run test:qualities` — pass.
- `bash .governance/run.sh` — all 25 directives passed, including the unchanged
  repository-hygiene file-size ceiling.
- Desktop Settings e2e — one test passed in 12.4 seconds; the emitted screenshot
  was inspected with Settings → Agents open.
- `bun run check:pr` — pass on the final remediated diff; all 39 push gates,
  repository-wide typecheck, type policy, and workflow-pin policy passed; 1,001
  test files passed and two were skipped, 10,872 tests passed with eight
  environment-gated skips, and diff coverage was 92.6% (2,217 / 2,393), above
  the 80% gate. The final isolated run passed every gate; its concurrent
  affected test/typecheck graphs also exercise the gateway's atomic bundled-web
  publish step without racing on `dist/web`.
- Final `bun run check:pr` passes; the conventional commit and draft PR
  reference #743: commit `55f9aca58d8ab2386816f150d16c194af2ec6a11`
  and draft PR https://github.com/srikanth235/centraid/pull/749. The push
  independently replayed all 39 push gates successfully.
- Crash-quality concurrency — all 23 tests passed inside the standard four-lane
  push gate. The recovery child reopens and integrity-checks the vault and
  journal planes directly instead of starting unrelated HTTP, scheduler,
  catalog, and code-host services after the deliberate SIGKILL.
- Gateway bundled-web publication — eight concurrent embed processes passed;
  the same concurrency path then passed inside `check:pr`.
- Post-audit focused gateway remediation — the compile → publish → fire
  accounting test passed alone in 11.59 seconds; harness route/preference/CLI
  suites passed 31 tests with one environment-gated skip; the blueprint
  conformance suite passed 2,149 cases.
- Fourth-audit remediation — app-engine runner/capture suites passed 22 tests,
  agent-runtime preflight/registry suites passed 57 tests, and gateway headless
  compile/unified runner/production graph suites passed 41 tests; all three
  packages typechecked.

## Decisions

- **Agents in copy, harness in identifiers.** “Agent” remains the market word
  in Settings and is otherwise reserved for autonomous principals.
- **Provider remains legitimate egress language.** `providerEgressConsent` is
  intentionally retained because it describes the vendor receiving data, not
  the installed CLI.
- **No v0 compatibility aliases or migrations.** Current schemas, values,
  preferences, routes, and generated artifacts are renamed in place.
- **Media names describe the row.** The logical entity is `media.asset`; its
  SQLite table is `media_asset`, avoiding both schema stutter and a broken
  logical-to-physical mapping.
- **Tolerated `runner` cases.** `ConversationRunner` / `runner-core` name the
  retained chat spine; worker/handler runner files execute isolated scripts;
  generic vault/query/queue/test/CI runners are callbacks, not installed CLIs.
- **Governed classification re-pin.** #743 re-pins governed fingerprints after manifest harness capability, harness route security vocabulary, and explicit one-to-one matrix flow rename metadata; every floor is unchanged and the ratchet rejects many-to-one replacements.

## Audit

REFUTED — the first fresh-context audit found installed-CLI `runner` prose, a
stale desktop `runner-status` fixture, remaining “agent variant” descriptions,
and an accounting test that trusted a mock name instead of the production
counter. Those gaps were remediated.

REFUTED — the second fresh-context audit found plural harness prose, stale
`agent` trace-row comments and Photo OCR delegate copy, one harness-named local
identifier, and an incomplete publication checklist item. Those gaps were
remediated; a third fresh-context audit of the new diff is required before
publication.

REFUTED — the third fresh-context audit found an unaccounted auto-title turn, an
optional/fail-open provider-egress controller, stale adapter/provider/agent and
`hostKey` aliases, two old change/artifact wire values, and a prematurely
checked publication item. The behavioral, vocabulary, DTO, and receipt gaps
were remediated; the publication item remains unchecked until the commit and
draft PR exist, and a new fresh-context audit is required before publication.

REFUTED — the fourth fresh-context audit found headless compile still accepted a
missing provider-egress controller and found internal installed-CLI, capture,
delegate-item, and automation-ledger identifiers that still overloaded
`agent`. Compile, all conversation runners, and auto-title now fail closed or
reuse an existing durable grant before dispatch; the cited vocabulary was
renamed without aliases. A new fresh-context audit is required before
publication.

REFUTED — the fifth fresh-context audit found that the first SDK migration still
erased generated request/notification types behind local wire facsimiles, and
found remaining Centraid-owned `agent` identifiers in capture, warm-session,
failure, glyph, perf/scale, fixture, and documentation surfaces. The ACP boundary
now preserves SDK 1.3.0 types and method pairing end to end, and the cited
vocabulary/file IDs plus adjacent health, cache, usage, and simulation names use
harness/delegate. A new fresh-context audit of this postimage is required before
publication.

REFUTED — the sixth fresh-context audit found remaining installed-CLI aliases, a
contradictory schema-stutter glossary example, three accounted one-shot calls
that had not entered the `TurnPlane` class, and a many-to-one hole in the
vocabulary-only matrix-flow rename exception. The aliases and glossary example
were corrected; all three calls now dispatch through `TurnPlane`; the ratchet
requires an exact predecessor ID on a new replacement with the same matrix cell
and an unchanged-or-higher floor; and the exploit has a regression test. A new
fresh-context audit of this postimage is required before publication.

REFUTED — the seventh fresh-context audit found that `TurnPlane` labelled
egress posture without enforcing consent, so capture classification and
interactive instruction rewrite could reach the accounted driver without a
positive provider grant; it also found one 693-line test above the unchanged
625-line governance ceiling and seven omitted rename-source endpoints in the
manifest. `TurnPlane` now fails closed on a mandatory host-owned consent check;
rewrite and capture create durable attended grants before the door rechecks
them; the test was split below the ceiling; all 25 governance directives pass;
and the manifest independently accounts for 574 postimage paths plus all 28
rename sources. A new fresh-context audit of this postimage is required before
publication.

PASS — the eighth fresh-context audit independently substantiated acceptance
criteria 1–11 and found no material receipt contradiction. It rechecked the
mandatory consent proof at every `TurnPlane` caller, durable rewrite/capture FK
semantics, exact SDK 1.3.0 wire typing, two-harness resume/settlement and shared
hydration, the real compile → publish → fire accounting equality, the local
seal, vocabulary/schema rules, the one-to-one matrix ratchet, unchanged
governance ceilings, the standard four-lane quality run, and the exact 574
postimage plus 28 rename-source manifest. Criterion 12 remains honestly
pending until the conventional commit and draft PR exist.

REFUTED — the ninth fresh-context publication audit found that the changed-path
manifest mixed 21 rename sources and unchanged `QUALITY.md` into the postimage
block while the dedicated source block listed only seven of the 28 detected
renames. The manifest now matches the committed diff exactly: 574 postimage
paths and all 28 rename sources are separated, with no extras or omissions. A
new fresh-context audit of the corrected publication receipt is required.

PASS — the tenth fresh-context publication audit found no substantive gap. It
independently matched all 574 unique postimage paths and all 28 unique rename
sources without extras, omissions, or duplicates; revalidated acceptance
criteria 1–11; and confirmed criterion 12 through conventional commit
`55f9aca58d8ab2386816f150d16c194af2ec6a11`, the matching local, upstream, and
PR heads, and open draft PR #749 targeting `main` with authoritative closing
references for #743 and absorbed issue #740.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-12 | codex | 019ff1ab-1620-76e0-93c7-fb048335b5d7 |
