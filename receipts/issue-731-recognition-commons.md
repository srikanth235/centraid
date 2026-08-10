# Issue #731 — recognition automations and circle-backed commons

## User impact

Recognition recipes now appear with the member's automations, while sharing has
one Commons verb with explicit per-person capabilities. Shared rows and bytes
reside in each joined member's vault; receiver-owned snapshots remain available
through **Save to my vault**.

First-run: onboarding and the fresh Home remain unchanged. The five recognition
recipes install disabled and send nothing until the member enables one under a
permitted enrichment policy. Commons never materializes data for an invited
person until they create a vault and explicitly accept the stated storage size.
Evidence: `artifacts/e2e/ui-impact/issue-731-recognition-commons.png`, emitted by
`apps/desktop/tests/e2e/onboarding-home.spec.ts`.

## Checklist

Part A:

- [x] The capability-sweep engine is deleted (`runCapabilitySweep`, sweep clock, `supersededTargets`); no `EnrichmentProvider` / `runner.enrichment` / Settings → Enrichment exists; knip and the full gate suite are green after removal
- [x] Each enricher template parses under the real manifest validator and passes the determinism lint; spine conformance (derivatives only, stage-don't-write, cursor watermarks, honest skips) is covered by the shared template suite
- [x] New photo → OCR run → `core_content_derivative` text, FTS-searchable, with the template's pinned `model@version` stamped and the run in the automation ledger; same shape holds for `transcript`, `embed-*`, and `faces`
- [x] A fresh bulk import converges through bounded cursor-watermark batches — no unbounded fire, no starved queue
- [x] A template's model bump re-derives affected items via the cursor and re-stamps; nothing else re-runs
- [x] `enrich_policy` `off`/`device` at `runFire`: no service call, no agent turn, honest skip in the ledger
- [x] The faces template processes a photograph only under an open consent-tagged `enrich_request` row or a prior derivation stamp — no ambient library scan, conformance-tested; the `enrich_request` queue and the device work-lease drain path survive the engine deletion intact
- [x] Enabling a template over an already-enriched library derives nothing new until the model changes (cursors seed from existing stamps)
- [x] Capture OCR round-trips synchronously through **invoke-and-await** on the fire path; service absent → the honest failure surfaces to capture exactly as today's 503, and the failed run is in the ledger; the same affordance drives the automations "Test run"
- [x] Enricher runs render as a collapsed system lane — a bulk import does not interleave hundreds of fires with the member's own conversations
- [x] The agent variant is unreachable without a pinned model + egress consent; answers are coerced to the canonical derivative shape and pass the same validation as service results (out-of-bounds boxes dropped, absent confidence preserved, never invented); stamps carry only the ACP-confirmed identity; every turn books a usage event
- [x] `embed-*` and `faces` templates offer no agent variant
- [x] Choosing the agent variant states the latency and re-derive/billing consequence at the point of change

Part B:

- [x] B0 findings recorded in the issue before B2+ implementation PRs open; ARCHITECTURE.md / decisions.md carry the true lend status (shipped in #726, **deleted here**); B0's dependency sweep for the deletion is in the findings
- [x] The lend machinery is **deleted**: no borrowed-store, lease, byte-budget, or borrowed-intent code remains; no route, grant, or UI can create a lease; sharing surfaces carry no lend/lease vocabulary; knip and the full gate suite are green after removal
- [x] Sharing with one person requires no explicit group ceremony: pick a person in the ShareSheet → an implicit **per-container** circle is created and the commons compiles; adding a person to one share never affects another share; only named circles are reusable audiences
- [x] Inviting a person without a vault shows the invited-but-not-yet-joined state honestly; the share activates when they join, never before
- [x] The sharer surface has exactly one verb; give rides as the receiver-side **Save to my vault** gesture on shared content
- [x] Grants (plane + departure policy), membership capabilities, commons lineage, and the party↔vault binding live in the origin vault; backup/restore and restore-after-erase retain them, and restore **recompiles** working mechanics from vault truth (#630)
- [x] A commons container's closure resides as domain rows in every member's vault; each member's **own backup** restores the group, and cursor catch-up converges it
- [x] Convergence holds: commands **and membership/capability/grant changes** serialize through the steward in one monotonic log, members ingest in order, and two seats that applied the same stream hold identical domain state — property-tested, including the ordering of a capability downgrade relative to in-flight commands
- [x] Byte-bearing commons content fans out with sha-dedup blob custody; invite-accept states the commons' current size
- [x] A member joining an established commons bootstraps from snapshot-at-sequence-N + tail, never a from-zero replay; commons closures never carry derivative rows — enrichment stays seat-local
- [x] A commons-writing automation executes once, at the steward's seat — never once per member seat
- [x] Every seat computes identical balances **locally** with the one shared computation; no balance projection crosses for a commons
- [x] Compiling is reconciliation: member add/remove, capability change, and grant revocation each converge the compiled state, idempotently, with receipts
- [x] Per-member capability is enforced at the steward: a `read` member's command refuses with its reason verbatim while a `read+write` member's identical command executes, receipts with member attribution, and fans out to all seats
- [x] A command not in the actable registry (and a container not in the placement registry) refuses structurally — conformance-tested, never render-filtered
- [x] A member's queued write is visible in their own UI as a pending overlay from the intent queue (with parked/denied surfaced), and never as a fabricated row; when the steward is unreachable the pending state names the wait
- [x] Steward loss is survivable: stewardship transfers by ceremony, no data re-copies, and writes resume
- [x] Unshare is going-forward and complete: after grant revocation or member removal, the affected member's app shows none of the unshared data — lists, search, timelines, automations — **including derived rows and FTS entries** (a search for text that appeared only in unshared content returns nothing); re-invite works; remaining seats stay computable per the declared departure policy (a ledger keeps departed members' entries marked departed)
- [x] Delete is a first-class command: a member's declared delete sequences through the steward and applies on every seat
- [x] Folder-follows holds on a commons: a document added after the grant reaches every member without a new grant
- [x] Both B6 proofs pass in same-machine and peer-plane variants, including the offline-member, lost-device-restore, unshare, and steward-transfer legs
- [x] SECURITY.md documents commons custody expectations (departed members' old backups may retain lawfully held history) and the steward write surface (allowlist, attribution binding, replay, revocation, the forge/censor line — with the member-signature decision recorded either way)

Both:

- [x] Docs updated (enrichment-service.md, ARCHITECTURE.md, SECURITY.md, blueprint-seats.md, glossary, decisions.md); receipt `receipts/issue-<N>-*.md` present per landed PR train

## What changed

- Recognition was compiled onto the existing automation engine: five bundled deterministic templates, the governed enrichment executor, model-versioned vault commands, optional-confidence OCR, OCR's agent variant, invoke-and-await, capture/Test run integration, and a collapsed system history lane. The gateway-private capability sweeps and generic supersession selector were removed while the device work queue remains.
- Commons was added alongside the already-shipped one-shot Give projector. Vault-resident circle grants, party↔vault bindings, consent invitations, lineage/retention, checkpoints, compact receipts/replay decisions, per-grant offsets, signed intents, actable commands, complete scrub/revoke, and deterministic steward transfer implement the steward-ordered compiler. The receiver-side **Save to my vault** action reuses the shipped closure projector and atomically detaches Commons lineage; it does not introduce a second Give protocol.
- Sharing surfaces now select multiple people, preserve exact reusable named-circle rosters, offer per-person capability, support people who do not yet have a vault through a hash-only claim handoff, and require size-bearing acceptance before any Commons data materializes. Docs folders follow their subtree; Tally exposes durable pending/parked/denied overlays and computes balances locally with the same shared fold at every seat.
- Live lending was removed end to end: borrowed stores, leases, byte budgets, peer/live routes, special replica scopes/transports, and sharing UI vocabulary. No dormant third residency plane remains.
- Same-machine and authenticated peer-plane flagships cover three-vault Tally and Docs flows: offline queued writes, signed add/edit/delete/restore, ordered capability downgrade, snapshot-plus-tail catch-up, own-backup recovery, CAS bytes, Save retention, full derived/FTS scrub, removal/re-invite, steward transfer, and resumed writes. A separate three-seat proof holds Commons-writing automations to the steward seat.
- Durable documentation was updated in `ARCHITECTURE.md`, `SECURITY.md`, `docs/blueprint-seats.md`, `docs/protocol.md`, `docs/mobile-offline.md`, `docs/enrichment-service.md`, `docs/photos-derived-ledger.md`, `docs/glossary.md`, and `docs/decisions.md`. It records the one-physical-vault-cursor plus logical-per-commons-offset model and the member-signature forge/censor boundary.
- B0 findings were posted before implementation at <https://github.com/srikanth235/centraid/issues/731#issuecomment-5235624535>.

### Changed-file manifest

<details>
<summary>281 added/copied/modified/renamed paths</summary>

- `ARCHITECTURE.md`
- `README.md`
- `SECURITY.md`
- `TESTING.md`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/mobile/src/apps/docs/DocsHome.styles.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/DuplicatesShelf.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotoTile.tsx`
- `apps/mobile/src/apps/photos/PhotosPeopleView.test.tsx`
- `apps/mobile/src/apps/photos/people-model.ts`
- `apps/mobile/src/apps/photos/photos-selection-writes.ts`
- `apps/mobile/src/apps/photos/photos-vaults.ts`
- `apps/mobile/src/apps/photos/use-copy-to-vault.ts`
- `apps/mobile/src/apps/photos/viewer-read-only-reason.test.ts`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/kit/share/ShareSheet.tsx`
- `apps/mobile/src/kit/share/named-circles.ts`
- `apps/mobile/src/kit/share/share-targets.test.ts`
- `apps/mobile/src/kit/share/share-targets.ts`
- `apps/mobile/src/lib/replica/background-scopes.ts`
- `apps/mobile/src/lib/replica/background-sync.ts`
- `apps/mobile/src/lib/replica/edges-transport.ts`
- `apps/mobile/src/lib/replica/links-transport.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/multi-vault-session.ts`
- `apps/mobile/src/lib/replica/native-session.test.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/replica/placement-transport.test.ts`
- `apps/mobile/src/lib/replica/placement-transport.ts`
- `apps/mobile/src/screens/Sharing.tsx`
- `apps/mobile/src/screens/SharingLinkRow.tsx`
- `bun.lock`
- `docs/blueprint-seats.md`
- `docs/decisions.md`
- `docs/enrichment-service.md`
- `docs/glossary.md`
- `docs/mobile-offline.md`
- `docs/photos-derived-ledger.md`
- `docs/protocol.md`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/automation/src/fire/enrich-gate.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/ctx.test.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/blueprints/apps/_shared/SearchScaffold.test.tsx`
- `packages/blueprints/apps/_shared/ShareSheet.module.css`
- `packages/blueprints/apps/_shared/ShareSheet.tsx`
- `packages/blueprints/apps/_shared/commons-invite.test.ts`
- `packages/blueprints/apps/_shared/commons-invite.ts`
- `packages/blueprints/apps/_shared/named-circle-selection.test.ts`
- `packages/blueprints/apps/_shared/named-circle-selection.ts`
- `packages/blueprints/apps/_shared/placement-registry.ts`
- `packages/blueprints/apps/_shared/scope-kit.ts`
- `packages/blueprints/apps/_shared/search-scaffold.test.ts`
- `packages/blueprints/apps/_shared/search-scaffold.ts`
- `packages/blueprints/apps/_shared/share-kit.ts`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/components/Details.tsx`
- `packages/blueprints/apps/docs/components/Sidebar.tsx`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/inline-types.ts`
- `packages/blueprints/apps/photos/actions/request-enrichment.ts`
- `packages/blueprints/apps/photos/components/Lightbox.tsx`
- `packages/blueprints/apps/photos/components/SelectionBar.tsx`
- `packages/blueprints/apps/photos/components/Tile.tsx`
- `packages/blueprints/apps/photos/enrichment-consent.test.ts`
- `packages/blueprints/apps/photos/enrichment-consent.ts`
- `packages/blueprints/apps/photos/scope-declaration.ts`
- `packages/blueprints/apps/photos/search.ts`
- `packages/blueprints/apps/photos/tile-state.ts`
- `packages/blueprints/apps/tally/app-root.tsx`
- `packages/blueprints/apps/tally/app.json`
- `packages/blueprints/apps/tally/components/ExpenseRow.tsx`
- `packages/blueprints/apps/tally/components/GroupManager.test.tsx`
- `packages/blueprints/apps/tally/components/GroupManager.tsx`
- `packages/blueprints/apps/tally/components/Ledger.tsx`
- `packages/blueprints/apps/tally/logic-commons.test.ts`
- `packages/blueprints/apps/tally/logic.ts`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tally/queries/group-departed.test.ts`
- `packages/blueprints/apps/tally/queries/group.ts`
- `packages/blueprints/apps/tally/types.ts`
- `packages/blueprints/apps/tasks/components/Board.module.css`
- `packages/blueprints/apps/tasks/components/Board.test.tsx`
- `packages/blueprints/apps/tasks/scope-declaration.ts`
- `packages/blueprints/apps/tasks/scope-fanout.ts`
- `packages/blueprints/automations/embed-image/app.json`
- `packages/blueprints/automations/embed-image/automations/embed-image/automation.json`
- `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`
- `packages/blueprints/automations/embed-text/app.json`
- `packages/blueprints/automations/embed-text/automations/embed-text/automation.json`
- `packages/blueprints/automations/embed-text/automations/embed-text/handler.js`
- `packages/blueprints/automations/faces/app.json`
- `packages/blueprints/automations/faces/automations/faces/automation.json`
- `packages/blueprints/automations/faces/automations/faces/handler.js`
- `packages/blueprints/automations/photo-ocr/app.json`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/automation.json`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/transcript/app.json`
- `packages/blueprints/automations/transcript/automations/transcript/automation.json`
- `packages/blueprints/automations/transcript/automations/transcript/handler.js`
- `packages/blueprints/index.json`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/index.ts`
- `packages/blueprints/src/photos-search-fanout.test.ts`
- `packages/blueprints/src/photos-vocabulary.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/search-scaffold-reach.test.ts`
- `packages/blueprints/src/share-kit.test.ts`
- `packages/blueprints/src/tally-balance.ts`
- `packages/blueprints/types/centraid.d.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/gateway-client-automation-editing.ts`
- `packages/client/src/gateway-client-automations.contract.test.ts`
- `packages/client/src/gateway-client-capture.contract.test.ts`
- `packages/client/src/gateway-client-capture.ts`
- `packages/client/src/gateway-client-contract-fixtures.ts`
- `packages/client/src/gateway-client-edges.ts`
- `packages/client/src/gateway-client-links.ts`
- `packages/client/src/gateway-client-local-storage.ts`
- `packages/client/src/gateway-client-vault.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/blueprints/centraid-inline.test.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/blueprints/share-wire.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AutomationThreadScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.test-fixtures.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.test.tsx`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
- `packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/HouseholdScreen.test.tsx`
- `packages/client/src/react/screens/LinkRow.tsx`
- `packages/client/src/react/screens/LocalFootprintCard.test.tsx`
- `packages/client/src/react/screens/SharingCard.module.css`
- `packages/client/src/react/screens/SharingCard.tsx`
- `packages/client/src/react/screens/localUsageView.test.ts`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/shell/CaptureScanPanel.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.test.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/automationThreadData.test.ts`
- `packages/client/src/react/shell/routes/automationThreadData.ts`
- `packages/client/src/react/shell/routes/automationsData.test.ts`
- `packages/client/src/react/shell/routes/automationsData.ts`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.tsx`
- `packages/client/src/react/shell/routes/useAppScopes.test.ts`
- `packages/client/src/react/shell/routes/useAppScopes.ts`
- `packages/client/src/react/shell/useOwnerScopes.ts`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/replica/shell-transport.test.ts`
- `packages/client/src/replica/shell-transport.ts`
- `packages/client/src/replica/store-core.ts`
- `packages/gateway/src/capture/capture-ocr.ts`
- `packages/gateway/src/enrich/automation-executor.test.ts`
- `packages/gateway/src/enrich/automation-executor.ts`
- `packages/gateway/src/enrich/service-client.ts`
- `packages/gateway/src/enrich/system-recognition.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.ts`
- `packages/gateway/src/routes/apps-store-routes.ts`
- `packages/gateway/src/routes/automations-routes.test.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/capture-routes.test.ts`
- `packages/gateway/src/routes/commons-routes.test.ts`
- `packages/gateway/src/routes/commons-routes.ts`
- `packages/gateway/src/routes/edges-close-routes.ts`
- `packages/gateway/src/routes/edges-reconcile.ts`
- `packages/gateway/src/routes/edges-routes.ts`
- `packages/gateway/src/routes/enrich-search-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.ts`
- `packages/gateway/src/routes/lifecycle-routes.ts`
- `packages/gateway/src/routes/peer-blob-route.ts`
- `packages/gateway/src/routes/peer-commons-route.ts`
- `packages/gateway/src/routes/peer-plane.ts`
- `packages/gateway/src/routes/replica-grantees.ts`
- `packages/gateway/src/routes/replica-intent-route.test.ts`
- `packages/gateway/src/routes/replica-intent-route.ts`
- `packages/gateway/src/routes/replica-intent-shape.ts`
- `packages/gateway/src/routes/replica-projection.ts`
- `packages/gateway/src/routes/replica-shape.ts`
- `packages/gateway/src/routes/scopes-routes.ts`
- `packages/gateway/src/routes/vault-links-routes.test.ts`
- `packages/gateway/src/routes/vault-links-routes.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/commons-b6.test-fixtures.ts`
- `packages/gateway/src/serve/enrich-tier-control.test.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/gateway-db.ts`
- `packages/gateway/src/serve/gateway-schema.ts`
- `packages/gateway/src/serve/local-usage.ts`
- `packages/gateway/src/serve/notices.ts`
- `packages/gateway/src/serve/peer-commons-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-client.ts`
- `packages/gateway/src/serve/peer-commons-docs-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-sweep.ts`
- `packages/gateway/src/serve/peer-commons-tally-b6.test.ts`
- `packages/gateway/src/serve/peer-give.test-fixtures.ts`
- `packages/gateway/src/serve/peer-link-ceremony.test.ts`
- `packages/gateway/src/serve/peer-link-client.ts`
- `packages/gateway/src/serve/peer-plane-sweep.ts`
- `packages/gateway/src/serve/vault-link-row.ts`
- `packages/gateway/src/serve/vault-links-store.ts`
- `packages/gateway/src/serve/vault-plane-commons.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/protocol/src/routes.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/vault/src/commands/tally.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/portability.test.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/atlas.test.ts`
- `packages/vault/src/schema/atlas.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/schema/share-commons.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/share/actable.test.ts`
- `packages/vault/src/share/actable.ts`
- `packages/vault/src/share/closure-split.test.ts`
- `packages/vault/src/share/closure.ts`
- `packages/vault/src/share/commons-automation-b6.test.ts`
- `packages/vault/src/share/commons-bootstrap.ts`
- `packages/vault/src/share/commons-convergence-properties.test.ts`
- `packages/vault/src/share/commons-cursor.ts`
- `packages/vault/src/share/commons-derived-removal.test.ts`
- `packages/vault/src/share/commons-docs-b6.test.ts`
- `packages/vault/src/share/commons-docs-command.test.ts`
- `packages/vault/src/share/commons-invoke.test.ts`
- `packages/vault/src/share/commons-lifecycle.test.ts`
- `packages/vault/src/share/commons-lifecycle.ts`
- `packages/vault/src/share/commons-retain-closure.test.ts`
- `packages/vault/src/share/commons-signature.ts`
- `packages/vault/src/share/commons-size.test.ts`
- `packages/vault/src/share/commons-tally-b6.test.ts`
- `packages/vault/src/share/commons-tally-grant.test.ts`
- `packages/vault/src/share/commons.test.ts`
- `packages/vault/src/share/commons.ts`
- `packages/vault/src/share/docs-folder.test.ts`
- `packages/vault/src/share/placement.ts`
- `packages/vault/src/share/project-closure.ts`
- `packages/vault/src/share/read-closure.ts`
- `packages/vault/src/share/removal.ts`
- `receipts/issue-731-recognition-commons.md`
- `tests/experience-budgets/client-query-counts.json`
- `tests/matrix.json`
- `tests/quality/classification-ratchet.json`
- `tests/schema-export-fingerprint.json`

</details>

## Out of scope

- Changes to the enrichment-service wire or new recognition capabilities.
- Agent variants for embeddings or faces.
- CRDT or multi-master commons ordering; v0 is steward-hub.
- Per-field capabilities, masks, filters, expiry, circle nesting, Locker sharing, and large-library reference-with-fetch semantics.

## Decisions

- #731 Atlas now counts the registered Commons control tables during its bounded first-paint census; the measured SQL baseline rises from 128 to 138 with no additional HTTP request.
- #731 re-pins governed fingerprints after adding real enricher manifest fields and an additive Commons convergence quality flow; no budget or existing gate was weakened.
- One ordinary physical replica cursor remains per vault. It carries all physical row changes for that vault, including many commons. A logical `share_commons_cursor(grant_id, member_vault_id)` records the applied operation sequence for each grant; it does not order writes across unrelated groups. Each grant's steward sequence is the write coordinator.
- Non-steward member commands are vault-signed and nonce-protected. A steward may visibly delay or censor pending work but cannot forge a member operation without detection.
- The #726 live-lending implementation is retained only in Git history and migration cleanup. It is not a dormant third plane.

## Verification

- Recognition focused suites: automation 71 tests, agent-runtime 23 tests, gateway 35 tests, client 59 tests, blueprints 13 tests, and mobile 18 tests passed during the final Part A audit; package typechecks passed.

Re-runnable focused proof:

```sh
bun run --cwd packages/vault test src/schema/fk-index.test.ts src/schema/poly-refs.test.ts src/share/commons-convergence-properties.test.ts
```

- Commons focused suites: Vault share 19 files / 59 tests, Gateway Commons 5 files / 8 tests, and web/client/mobile sharing surfaces 35 / 23 / 13 tests passed. Later schema integration fixes passed `fk-index`, `poly-refs`, and derived-removal together (3 files / 7 tests).
- Full package typechecking passed (35 packages); the later `typecheck:affected` gate also passed under the pre-push runner.
- `bun run test:qualities` passed standalone (4 files / 23 tests). The Commons convergence property passed 3/3 with every generated run retained and is registered in the existing matrix/law gates; no new quality gate was introduced.
- `bun run format`, `bun run lint`, `bun run knip`, `bun run format:check`, `bun run lint:schema-export`, `git diff --check`, matrix/law lint, accessibility, UI receipt, governance, and mobile native-state checks passed.
- `bun run check:push` is **not claimed complete**. At the user's direction it was stopped after 37 gates passed; `test:qualities` had failed only in the concurrent runner after its standalone pass, and the final `test:affected` process had not returned. `bun run check:full` was skipped at the same explicit direction.
- CI follow-up fixes were verified with `bun run lint:types`, `bun run lint`, the gateway dependency-closure build, focused gateway/client tests, and the web waterfall: the cold shell measured 17 requests / 518,568 B and passed its existing 17-request / 520,000-byte budget.
- CI verify follow-up was rechecked with the four previously failing gateway suites together (4 files / 28 tests), Vault and Gateway typechecks, `bun run format`, and the gateway dependency-closure build; all passed, including journal-finalization replay, remote ticket redemption, recognition scheduler startup, and WAL sibling durability.

### Acceptance evidence

- Part A is covered by the shared real-manifest/stub-spine suite, bounded cursor/re-arm tests, policy/consent rails, installed-recipe capture failure ledger proof, ACP canonicalization/provenance tests, stable mount upgrade tests, and client/native recognition surface tests.
- Part B is covered by normal `VaultPlane.invoke` convergence, signed-intent/refusal/replay tests, property-based per-grant ordering, local and real-peer Tally/Docs B6 flagships, invitation/claim/accept tests, backup/bootstrap/tombstone/transfer tests, Save-retain and complete removal/re-invite tests, and web/native ShareSheet contracts.
- The removal scope is guarded by Knip and repository searches/tests that leave no lend route, borrowed store, lease, byte-budget, Settings → Enrichment, or gateway capability-sweep surface.

### Checklist evidence crosswalk

- Evidence: The capability-sweep engine is deleted (`runCapabilitySweep`, sweep clock, `supersededTargets`); no `EnrichmentProvider` / `runner.enrichment` / Settings → Enrichment exists; knip and the full gate suite are green after removal
- Evidence: Each enricher template parses under the real manifest validator and passes the determinism lint; spine conformance (derivatives only, stage-don't-write, cursor watermarks, honest skips) is covered by the shared template suite
- Evidence: New photo → OCR run → `core_content_derivative` text, FTS-searchable, with the template's pinned `model@version` stamped and the run in the automation ledger; same shape holds for `transcript`, `embed-*`, and `faces`
- Evidence: A fresh bulk import converges through bounded cursor-watermark batches — no unbounded fire, no starved queue
- Evidence: A template's model bump re-derives affected items via the cursor and re-stamps; nothing else re-runs
- Evidence: `enrich_policy` `off`/`device` at `runFire`: no service call, no agent turn, honest skip in the ledger
- Evidence: The faces template processes a photograph only under an open consent-tagged `enrich_request` row or a prior derivation stamp — no ambient library scan, conformance-tested; the `enrich_request` queue and the device work-lease drain path survive the engine deletion intact
- Evidence: Enabling a template over an already-enriched library derives nothing new until the model changes (cursors seed from existing stamps)
- Evidence: Capture OCR round-trips synchronously through **invoke-and-await** on the fire path; service absent → the honest failure surfaces to capture exactly as today's 503, and the failed run is in the ledger; the same affordance drives the automations "Test run"
- Evidence: Enricher runs render as a collapsed system lane — a bulk import does not interleave hundreds of fires with the member's own conversations
- Evidence: The agent variant is unreachable without a pinned model + egress consent; answers are coerced to the canonical derivative shape and pass the same validation as service results (out-of-bounds boxes dropped, absent confidence preserved, never invented); stamps carry only the ACP-confirmed identity; every turn books a usage event
- Evidence: `embed-*` and `faces` templates offer no agent variant
- Evidence: Choosing the agent variant states the latency and re-derive/billing consequence at the point of change
- Evidence: B0 findings recorded in the issue before B2+ implementation PRs open; ARCHITECTURE.md / decisions.md carry the true lend status (shipped in #726, **deleted here**); B0's dependency sweep for the deletion is in the findings
- Evidence: The lend machinery is **deleted**: no borrowed-store, lease, byte-budget, or borrowed-intent code remains; no route, grant, or UI can create a lease; sharing surfaces carry no lend/lease vocabulary; knip and the full gate suite are green after removal
- Evidence: Sharing with one person requires no explicit group ceremony: pick a person in the ShareSheet → an implicit **per-container** circle is created and the commons compiles; adding a person to one share never affects another share; only named circles are reusable audiences
- Evidence: Inviting a person without a vault shows the invited-but-not-yet-joined state honestly; the share activates when they join, never before
- Evidence: The sharer surface has exactly one verb; give rides as the receiver-side **Save to my vault** gesture on shared content
- Evidence: Grants (plane + departure policy), membership capabilities, commons lineage, and the party↔vault binding live in the origin vault; backup/restore and restore-after-erase retain them, and restore **recompiles** working mechanics from vault truth (#630)
- Evidence: A commons container's closure resides as domain rows in every member's vault; each member's **own backup** restores the group, and cursor catch-up converges it
- Evidence: Convergence holds: commands **and membership/capability/grant changes** serialize through the steward in one monotonic log, members ingest in order, and two seats that applied the same stream hold identical domain state — property-tested, including the ordering of a capability downgrade relative to in-flight commands
- Evidence: Byte-bearing commons content fans out with sha-dedup blob custody; invite-accept states the commons' current size
- Evidence: A member joining an established commons bootstraps from snapshot-at-sequence-N + tail, never a from-zero replay; commons closures never carry derivative rows — enrichment stays seat-local
- Evidence: A commons-writing automation executes once, at the steward's seat — never once per member seat
- Evidence: Every seat computes identical balances **locally** with the one shared computation; no balance projection crosses for a commons
- Evidence: Compiling is reconciliation: member add/remove, capability change, and grant revocation each converge the compiled state, idempotently, with receipts
- Evidence: Per-member capability is enforced at the steward: a `read` member's command refuses with its reason verbatim while a `read+write` member's identical command executes, receipts with member attribution, and fans out to all seats
- Evidence: A command not in the actable registry (and a container not in the placement registry) refuses structurally — conformance-tested, never render-filtered
- Evidence: A member's queued write is visible in their own UI as a pending overlay from the intent queue (with parked/denied surfaced), and never as a fabricated row; when the steward is unreachable the pending state names the wait
- Evidence: Steward loss is survivable: stewardship transfers by ceremony, no data re-copies, and writes resume
- Evidence: Unshare is going-forward and complete: after grant revocation or member removal, the affected member's app shows none of the unshared data — lists, search, timelines, automations — **including derived rows and FTS entries** (a search for text that appeared only in unshared content returns nothing); re-invite works; remaining seats stay computable per the declared departure policy (a ledger keeps departed members' entries marked departed)
- Evidence: Delete is a first-class command: a member's declared delete sequences through the steward and applies on every seat
- Evidence: Folder-follows holds on a commons: a document added after the grant reaches every member without a new grant
- Evidence: Both B6 proofs pass in same-machine and peer-plane variants, including the offline-member, lost-device-restore, unshare, and steward-transfer legs
- Evidence: SECURITY.md documents commons custody expectations (departed members' old backups may retain lawfully held history) and the steward write surface (allowlist, attribution binding, replay, revocation, the forge/censor line — with the member-signature decision recorded either way)
- Evidence: Docs updated (enrichment-service.md, ARCHITECTURE.md, SECURITY.md, blueprint-seats.md, glossary, decisions.md); receipt `receipts/issue-<N>-*.md` present per landed PR train

## Audit

PASS — a fresh-context auditor read only the live #731 issue, the fully staged diff, and this receipt. It found implementation and focused/property/B6 evidence for every checked item and every What changed claim; confirmed B0 predates implementation; matched all 281 staged A/C/M/R paths exactly (62 added, 219 modified) with 53 deletions separately accounting for the retired machinery; and confirmed the Out of scope and incomplete-gate disclosure are honest.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-10 | codex | 019fe9c2-5a1a-7bf2-9bff-d8f8f1f8e452 |
