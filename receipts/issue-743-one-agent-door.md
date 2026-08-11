# Issue #743 — one agent door: vocabulary rationalization + automation dispatch convergence

## Checklist

- [x] Vault schema renames: `agent.agent` → `consent.agent` (`consent_agent`), `host_key` → `enrollment_key`, `journal` attribution `agent_id` → `caller_id`, `media_media_asset` → `media_asset`; replica unavailable-columns + replica-shape tests updated
- [ ] Harness axis rename (`RunnerKind` → `HarnessKind`, `RUNNER_BACKENDS` → `HARNESSES`, `adapterKind` → harness-named, `requires.runner` → `requires.harness`, …)
- [ ] Delegate rail rename (`ctx.agent` → `ctx.delegate`, ledger item `kind:"delegate"`, worker messages, failure prefix)
- [ ] Glossary / docs A1 write-back (forbidden synonyms, delegate step, schema-naming rule)
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

- Further slices append their verification here as they land.

## Audit

Independent re-attestation against the CURRENT `git diff --cached` (staged slice only; a large
concurrent unstaged rename in the working tree was excluded per instructions) and the CURRENT
receipt, after the two prior REFUTED findings were addressed.

1. **`## What changed` faithfully describes the staged diff** — **PASS** (previously REFUTED).
   The five leaked rename pairs are gone from the index: `git diff --cached -M --summary | grep
   rename` → empty (0 matches). `git diff --cached --stat` now shows 184 files, all with real
   `+`/`-` content hunks (no `{old => new}` 0-line entries) across exactly the packages "What
   changed" names — `vault`, `gateway`, `blueprints`, `apps/mobile`, `packages/client`, and the
   recognition-automation handler sources (e.g. `packages/vault/src/commands/media.ts` 176 lines,
   `packages/gateway/src/serve/vault-plane.ts` 24 lines, `apps/mobile/src/apps/photos/*`,
   `packages/blueprints/apps/*/automations/*/handler.js`) — consistent with a mechanical
   `agent_agent`/`host_key`/`agent_id`/`media_media_asset` rename propagated to every caller. No
   remaining file in the stat is unexplained by that description.

2. **Each checked `- [x]` item is realized; unchecked `- [ ]` items are not claimed done** —
   **PASS** (unchanged). The sole checked item (vault schema renames) is still fully realized:
   `packages/vault/src/schema/consent.ts` adds `CREATE TABLE consent_agent (... enrollment_key
   ...)`; `packages/vault/src/schema/agent.ts` drops `agent_agent`; `packages/vault/src/schema/
   journal.ts` renames `agent_command_invocation.agent_id` → `caller_id`;
   `packages/vault/src/commands/media.ts` renames every `media_media_asset` reference to
   `media_asset`; `unavailable-columns.ts` / `replica-shape.test.ts` updated to match. `git grep -n
   'agent_agent\|media_media_asset\|host_key' -- packages apps` → 0 hits. All 8 remaining items
   (including the newly added "Close #740 as absorbed by this issue...") stay unchecked, and none
   of their described work (`ctx.delegate` rail, `HarnessSessions`, SDK adoption, glossary
   write-back, closing #740) is present in the staged diff or reachable via GitHub (issue #740 is
   still open per this session's earlier fetch context; no GitHub-state change is a diff concern
   anyway).

3. **Checklist mirrors the issue's scope/acceptance-criteria structure** — **PASS** (previously
   REFUTED). The receipt now carries a 9th checklist line: `- [ ] Close #740 as absorbed by this
   issue (per-call harness/model is item 5 of the Decision)` (`grep -n '740'
   receipts/issue-743-one-agent-door.md` → line 13). This maps 1:1 onto the issue's final
   `# Scope > In:` bullet, "Closing #740 as absorbed by this issue (or converting it to a tracking
   sub-item)." All 9 `Scope > In:` bullets now have a corresponding checklist line (vault schema +
   ledger-kind renames, `ctx.delegate` dispatch/metering, `HarnessSessions`, per-call
   harness/model/configPins + compiler grounding, SDK adoption, glossary write-back, #740
   closure), and none of the checklist's 9 lines contradicts the issue text.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 56e4d30a-2bce-4149-af0c-60147a8837f1 |
