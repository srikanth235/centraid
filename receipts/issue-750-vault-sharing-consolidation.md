# Issue #750 — vault sharing lifecycle consolidation

## User impact

Vault identity now survives restart, recovery, movement, and endpoint rotation
without silently changing the key that peers trust. Every device enrolled to the
same owner sees the same sharing edges, and web plus native sharing surfaces use
the linked vault's human label. Commons members catch up by applying the signed
operation tail through the ordinary app command gateway, preserving unchanged
seat-local OCR, embeddings, and FTS state. Steward absence and recovery are
reachable from Devices, including successor-invitation delivery and an explicit
runbook for the v0 N≥3 re-pairing limit.

First-run: onboarding and initial Home behavior are unchanged. The desktop
first-run journey now continues to Devices and captures the sharing/recovery
surface at
`artifacts/e2e/ui-impact/issue-750-vault-sharing-consolidation.png`.

## Checklist

- [x] A newly created vault persists one identity, and opening a linked vault with missing or mismatched identity material fails closed rather than minting a replacement.
- [x] Moving/recovering a vault onto a new gateway or rotating its EndpointId causes production code to deliver a signed route assertion; an existing peer finds it without repeating link ceremony.
- [x] Two or more local vaults linked to the same peer vault all resolve through the peer vault's single updated route.
- [x] One owner sees the same share-edge list from each enrolled device; device ID remains available as creation/audit provenance.
- [x] `forPerson` with unavailable ticket/endpoint capability leaves zero new owners, vaults, ownership rows, keys, or tickets; replaying one operation ID cannot create duplicates.
- [x] Borrowed device bootstrap is paginated and bounded; no request loads or serializes the full shape.
- [x] Rebootstrap after a narrowed scope releases CAS bytes no longer referenced by any live row/shape.
- [x] Deleting a borrowed row releases its row-to-blob references and purges bytes once the final reference disappears.
- [x] Long-lived, high-churn borrowed shapes have bounded/compactable device change history, with lagging devices recovering through a defined rebootstrap path.
- [x] Live-edge receipts preserve a validated live scope payload and never store objects in an item-ID array.
- [x] Web and native share sheets receive and render the linked vault's human label without deriving it from borrowed scopes or raw vault IDs.
- [x] Local and peer edge execution share one reducer/state vocabulary; transport selection does not duplicate domain transitions.
- [x] Specialized state tables/drainers and duplicated replica code superseded by the new abstractions are deleted.
- [x] No legacy household/content migration, compatibility layer, or dual-write is introduced; unsupported pre-v0 state may be reset.
- [x] **A commons member one operation behind receives an increment, not a full closure; a domain write does not delete or re-enqueue any member seat's derived rows (OCR/embeddings/FTS) for unchanged items.**
- [x] **Commons blob chunk authorization does not re-export or re-sign the closure per chunk.**
- [x] **Steward-absence presence and the recovery ceremony are reachable from a user surface, successor invitations are actually delivered, and the N≥3 link gap is solved or documented with a `docs/recovery/` runbook.**
- [x] **Commons intents share the consolidated effect/outbox state vocabulary, or the deviation is recorded with a reason.**
- [x] **Commons command→container routing is declared data with a conformance check, not string heuristics; `declareCommonsCommands` is used by apps or deleted.**
- [x] **Every exported sharing-plane capability names its production caller via a mechanical check that sees through `index.ts` re-exports.**
- [x] The issue receipt documents what code/tables were deleted and any approved deviations.

## What changed

### Acceptance crosswalk

- A newly created vault persists one identity, and opening a linked vault with missing or mismatched identity material fails closed rather than minting a replacement. `VaultRegistry` now separates new-vault minting from existing-vault loading, validates the identity file against `VaultDirectory`, and emits named missing/mismatch faults; recovery fixtures restore identity custody as well as the seal key.
- Moving/recovering a vault onto a new gateway or rotating its EndpointId causes production code to deliver a signed route assertion; an existing peer finds it without repeating link ceremony. Endpoint startup, rotation, mounted-vault discovery, and recovery all call the production assertion publisher and tests exercise the host path.
- Two or more local vaults linked to the same peer vault all resolve through the peer vault's single updated route. `vault_directory` owns stable key/label metadata, `vault_routes` owns one replaceable route per peer vault, and link queries join that record for every pair.
- One owner sees the same share-edge list from each enrolled device; device ID remains available as creation/audit provenance. `RequestPrincipal` resolves owner and device once, owner-scoped edge queries authorize the list, and edge rows retain their creator device.
- `forPerson` with unavailable ticket/endpoint capability leaves zero new owners, vaults, ownership rows, keys, or tickets; replaying one operation ID cannot create duplicates. `ProvisionPerson` preflights ticket capability, persists a request hash and stable IDs, advances through explicit secret/vault/owner/ownership/ticket/finalize states, and resumes the same IDs after failure before or after every durable step.
- Borrowed device bootstrap is paginated and bounded; no request loads or serializes the full shape. The pre-v0 borrowed/lend replica was removed by #731, so the supported design has no borrowed shape or request capable of doing this; the remaining neighboring Commons peer bootstrap now emits resumable 256 KiB metadata pages and streams binary chunks separately.
- Rebootstrap after a narrowed scope releases CAS bytes no longer referenced by any live row/shape. The borrowed replica and its independent metadata/CAS lifecycle no longer exist on the supported v0 schema; projection removal uses the canonical vault row/blob lifecycle and the orphan sweep.
- Deleting a borrowed row releases its row-to-blob references and purges bytes once the final reference disappears. There is no supported borrowed row store after #731; canonical projected rows use the vault share-origin removal and final-reference CAS reclamation path rather than a second caller-managed store.
- Long-lived, high-churn borrowed shapes have bounded/compactable device change history, with lagging devices recovering through a defined rebootstrap path. The deleted borrowed change log cannot grow; the surviving replica log uses acknowledged cursors/epoch rebootstrap, while Commons retains ack-gated compaction and a 256-operation floor.
- Live-edge receipts preserve a validated live scope payload and never store objects in an item-ID array. Discriminated `SnapshotScope` and `LiveScope` parsers validate the wire and receipt boundary; only snapshot IDs enter `origin_item_ids_json`.
- Web and native share sheets receive and render the linked vault's human label without deriving it from borrowed scopes or raw vault IDs. Gateway edge DTOs carry origin/audience labels from `VaultDirectory`; desktop/web and mobile transports and screens render those labels.
- Local and peer edge execution share one reducer/state vocabulary; transport selection does not duplicate domain transitions. `reconcileEdgeWithTransport` is the only coordinator for target/source/status transitions and receipts; local and peer adapters return delivery facts only, while both edge and effect reducers reject illegal state transitions.
- Specialized state tables/drainers and duplicated replica code superseded by the new abstractions are deleted. `peer_pending_gives`, `peer_blob_pulls`, and `peer_pending_refusals` are replaced by `share_effects`; invitation delivery uses the same executor vocabulary; copied link routes/keys/labels are removed; the already-retired borrowed schema/store remains absent.
- No legacy household/content migration, compatibility layer, or dual-write is introduced; unsupported pre-v0 state may be reset. Schema installation rejects copied-route link schemas with an erase/re-onboard fault and adds no migration or dual-write branch.
- A commons member one operation behind receives an increment, not a full closure; a domain write does not delete or re-enqueue any member seat's derived rows (OCR/embeddings/FTS) for unchanged items. Both same-machine and peer catch-up execute the signed command tail through `invokeCommonsCanonical` with deterministic IDs; tests prove one-operation catch-up and preservation of member-local derived rows.
- Commons blob chunk authorization does not re-export or re-sign the closure per chunk. Bootstrap records an expiring `(grant, member, sha, size)` authorization once; chunk requests only verify that row and the CAS stat, while the member hashes and adopts a streamed temp file.
- Steward-absence presence and the recovery ceremony are reachable from a user surface, successor invitations are actually delivered, and the N≥3 link gap is solved or documented with a `docs/recovery/` runbook. Devices exposes degraded/absent/parked recovery, recovery queues real invitation effects, and `docs/recovery/commons-steward-loss.md` documents the explicit re-pair ceremony for members without a successor link.
- Commons intents share the consolidated effect/outbox state vocabulary, or the deviation is recorded with a reason. `share_commons_intent` now uses `queued|running|parked|executed|denied|failed|cancelled|expired`, the same visible lifecycle as `share_effects`, while retaining its signed-command fields because those are domain evidence rather than relay payload.
- Commons command→container routing is declared data with a conformance check, not string heuristics; `declareCommonsCommands` is used by apps or deleted. `COMMONS_COMMAND_ROUTES` is an explicit command/container/input-key registry; an AST/manifest-backed test resolves each action's real blueprint input schema and proves every declared command exposes a matching container or child key; the unused declaration API is deleted.
- Every exported sharing-plane capability names its production caller via a mechanical check that sees through `index.ts` re-exports. `sharing-capability-callers.test.ts` discovers root sharing operation exports and gateway peer-link exports from the TypeScript AST, scans non-test production references, and rejects newly unreachable operations; 13 test-only/internal operations were removed from the package root instead of exempted.
- The issue receipt documents what code/tables were deleted and any approved deviations. This receipt records the removed tables/branches, the v0 borrowed-plane structural deletion, frame-cache bound, intent-table choice, and N≥3 runbook decision.

### Deleted and consolidated mechanisms

- Removed copied `public_key_a/b`, `label_a/b`, and `route_a/b_json` columns from `vault_links`; all links resolve through `vault_directory` and `vault_routes`.
- Removed `peer_pending_gives`, `peer_blob_pulls`, and `peer_pending_refusals` from the gateway schema and replaced their table-specific SQL/state transitions with typed `share_effects` rows and shared retry/terminal-history rules.
- Removed the workflow-specific Commons command declaration API and command/input-key heuristics; the surviving exported registry is declared data with production consumers.
- Preserved the earlier #731 deletion of the borrowed/lend store, schema, route, change log, and lend-close queue. No compatibility facade or replacement borrowed state machine was added.
- Avoided a separate Commons replica executor: local compilation, peer catch-up, and crash replay use the canonical gateway command path and deterministic invocation IDs.

### Changed-path manifest

- `ARCHITECTURE.md`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/mobile/src/lib/replica/edges-transport.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/multi-vault-session.ts`
- `apps/mobile/src/lib/replica/placement-transport.test.ts`
- `apps/mobile/src/lib/replica/placement-transport.ts`
- `apps/mobile/src/screens/Sharing.tsx`
- `docs/decisions.md`
- `docs/logs.md`
- `docs/plans/commons-fixed-window-sync.md`
- `docs/protocol.md`
- `docs/recovery/commons-steward-loss.md`
- `packages/client/src/gateway-client-devices.contract.test.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client-edges.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/blueprints/centraid-inline.ts`
- `packages/client/src/react/screens/DevicePairPanel.test.tsx`
- `packages/client/src/react/screens/DevicePairPanel.tsx`
- `packages/client/src/react/screens/SharingCard.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/gateway/src/backup/backup.integration.test.ts`
- `packages/gateway/src/cli/endpoint-host-peer.test.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/routes/commons-recovery-routes.ts`
- `packages/gateway/src/routes/commons-routes-intents.test.ts`
- `packages/gateway/src/routes/commons-routes.ts`
- `packages/gateway/src/routes/device-invitations.ts`
- `packages/gateway/src/routes/device-ticket-mint.ts`
- `packages/gateway/src/routes/devices-routes-mint.test.ts`
- `packages/gateway/src/routes/devices-routes.test-fixtures.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/edge-answer-routes.ts`
- `packages/gateway/src/routes/edges-owner-visibility.test.ts`
- `packages/gateway/src/routes/edges-reconcile-remote.ts`
- `packages/gateway/src/routes/edges-reconcile.ts`
- `packages/gateway/src/routes/edges-routes.ts`
- `packages/gateway/src/routes/p1-owner-only-refusals.test.ts`
- `packages/gateway/src/routes/peer-commons-pages.ts`
- `packages/gateway/src/routes/peer-commons-route.ts`
- `packages/gateway/src/routes/peer-edge-give-route.ts`
- `packages/gateway/src/routes/peer-plane.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/commons-observability.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/gateway-schema-sharing.test.ts`
- `packages/gateway/src/serve/gateway-schema.ts`
- `packages/gateway/src/serve/owner-store.ts`
- `packages/gateway/src/serve/pairing-store.ts`
- `packages/gateway/src/serve/peer-blob-pull.ts`
- `packages/gateway/src/serve/peer-commons-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-client.ts`
- `packages/gateway/src/serve/peer-commons-docs-b6.test.ts`
- `packages/gateway/src/serve/peer-commons-tally-b6.test.ts`
- `packages/gateway/src/serve/peer-give.test-fixtures.ts`
- `packages/gateway/src/serve/peer-commons-invitations.ts`
- `packages/gateway/src/serve/peer-commons-pages-client.ts`
- `packages/gateway/src/serve/peer-commons-sweep.test.ts`
- `packages/gateway/src/serve/peer-commons-sweep.ts`
- `packages/gateway/src/serve/peer-plane-sweep.test.ts`
- `packages/gateway/src/serve/peer-plane-sweep.ts`
- `packages/gateway/src/serve/peer-refusal-relay.test.ts`
- `packages/gateway/src/serve/peer-refusal-relay.ts`
- `packages/gateway/src/serve/peer-remote-give.test.ts`
- `packages/gateway/src/serve/peer-transport-remote.test.ts`
- `packages/gateway/src/serve/provision-person.test.ts`
- `packages/gateway/src/serve/provision-person.ts`
- `packages/gateway/src/serve/request-principal.ts`
- `packages/gateway/src/serve/share-access-receipts.ts`
- `packages/gateway/src/serve/share-contracts.test.ts`
- `packages/gateway/src/serve/share-contracts.ts`
- `packages/gateway/src/serve/share-effects.test.ts`
- `packages/gateway/src/serve/share-effects.ts`
- `packages/gateway/src/serve/sharing-capability-callers.test.ts`
- `packages/gateway/src/serve/vault-directory.ts`
- `packages/gateway/src/serve/vault-link-row.ts`
- `packages/gateway/src/serve/vault-links-store.test.ts`
- `packages/gateway/src/serve/vault-links-store.ts`
- `packages/gateway/src/serve/vault-plane-commons.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/vault-registry-identity.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/commons-resilience.ts`
- `packages/vault/src/schema/share-commons.ts`
- `packages/vault/src/schema/vault-identity.ts`
- `packages/vault/src/share/actable.test.ts`
- `packages/vault/src/share/actable.ts`
- `packages/vault/src/share/commons-bootstrap.ts`
- `packages/vault/src/share/commons-invoke.test.ts`
- `packages/vault/src/share/commons-lifecycle.ts`
- `packages/vault/src/share/commons-sim.ts`
- `packages/vault/src/share/commons-tally-b6.test.ts`
- `packages/vault/src/share/commons.test.ts`
- `packages/vault/src/share/commons.ts`
- `receipts/issue-750-vault-sharing-consolidation.md`
- `tests/schema-export-fingerprint.json`

## Decisions

- Use the issue's explicit v0 hard cut. A gateway containing copied route columns is rejected with erase/re-onboard guidance; no migration, dual-write, or compatibility adapter exists.
- Treat the #731 deletion of lending/borrowed replicas as the strongest possible consolidation for the borrowed acceptance items. Reintroducing a generic facade over a nonexistent feature would increase the state-machine count and violate the issue's deletion goal.
- Keep `share_commons_intent` as domain evidence because it carries the signed command, nonce, actor, and based-on sequence. Its user-visible states are aligned exactly with the generic effect/outbox vocabulary, so this is not a third grammar.
- Cache at most four signed Commons metadata frames and 64 MiB total for five minutes. The steward spools record-delimited metadata to a temporary file one row at a time; the member writes resumable 256 KiB pages to a temporary file and parses records as a stream, so neither side creates a second full-frame byte buffer. Binary content remains independently streamed, hashed, and adopted from a temporary CAS file with no in-memory fallback.
- On an accepted signed-nonce crash replay, force one full projection repair before settling the intent. Ordinary one-operation catch-up remains incremental; the exceptional replay deliberately pays O(commons size) to repair evidence that durable commit and local rows diverged.
- Use the acceptance criterion's documented-limit option for N≥3 steward loss. The successor sends invitations over existing links; an unlinked member performs the runbook's explicit successor re-pair ceremony rather than gaining an implicit transitive trust path.

## Out of scope

- Legacy household/member/content migration, old role lattices, old link rows, and every other pre-v0 compatibility path.
- A new sharing product model or redesign of the user-facing meaning of Give versus Lend.
- Rebuilding the Commons hash chain, checkpoint/digest verification, nonce replay, or simulation harness.
- Automatic transitive link creation during N≥3 steward recovery; the explicit re-pair ceremony is the documented v0 trust boundary.

## Verification

The final shared-infrastructure gate and replayable focused commands are:

```sh
bun run format
bun run lint
bun run lint:schema-export
bun run --cwd packages/vault build
bun run --cwd packages/gateway typecheck
bun run --cwd packages/gateway test
bun run --cwd packages/gateway test -- src/serve/peer-commons-b6.test.ts
bun run test:qualities
bun run check:push
bun run check:full
bun run --cwd apps/desktop test:e2e -- tests/e2e/onboarding-home.spec.ts --grep '1.2'
bun run --cwd apps/web e2e
```

- Full gateway suite: 223 files passed, 1 skipped; 1,449 tests passed, 6 skipped.
- Push gate after the final routing fixes: 39/39 gates passed, including affected tests, affected typecheck, Knip, quality ratchets, schema/export, accessibility, and UI-receipt checks.
- Full diff coverage: 755 files passed, 1 skipped; 5,861 tests passed, 7 skipped; 96.2% changed-line coverage (1,503/1,562).
- Full repository coverage: 1,130 files passed, 4 skipped; 12,175 tests passed, 36 skipped. Mutation had no affected seeds, and every low-end performance budget passed.
- Desktop E2E: all 61 runnable scenarios passed across two full runs except for one pre-existing builder-preview timeout; that exact scenario passed immediately in isolation. The issue #750 onboarding → Devices journey passed after its locator and route-order fixes. Web E2E passed 16/16.
- Commons peer flagship: bounded multi-page metadata resume, consent, blob authorization/stream, signed write, catch-up, and revoke passed.
- Scale evidence: a 1,000-row Commons baseline caught up exactly three domain commands while preserving the member-local embedding; a 6 MiB blob used one steward export and member allocations never exceeded the 1 MiB chunk bound.
- Provisioning crash matrix: all 14 before/after failure points across plan, secret, vault, owner, ownership, ticket, and finalize resumed to exactly one owner, vault, ownership row, secret, and ticket.
- Schema/export ratchet: `ace03b033b7a839d5200dc1c77a1baf3a7fde76ed831f5cb91a91a10cfb82248`.
- UI evidence: `artifacts/e2e/ui-impact/issue-750-vault-sharing-consolidation.png` is emitted by `apps/desktop/tests/e2e/onboarding-home.spec.ts` and was visually inspected after the live link/recovery routes returned cleanly.

## Audit

REFUTED — pending the constitution-mandated fresh-context sub-agent audit after the final diff and verification record are complete.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-12 | codex | 019ff5d0-a07b-7f81-8fa1-46c2e3af156d |
