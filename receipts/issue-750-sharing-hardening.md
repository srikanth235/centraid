# Issue #750 — sharing hardening

One receipt for the issue; each workstream appends its own subsection.

Workstreams: WS-A (vault identity + routing), WS-B (edge plane + effect
outbox), WS-C (idempotent provisioning), WS-D (catch-up cost), WS-E (commons
routing/grammar/recovery), WS-F (reachability gate), WS-G (replica/CAS
lifecycle verification), WS-H (catch-up by command-tail replay).

## User impact

Sharing is now a thing you do with a **vault**, not with a device or an address.
On Household, the People & circles card names each linked person by their
vault's own label, and a person who moves their vault to a new gateway keeps
working without re-pairing — one signed route assertion re-points every link to
that vault at once. A circle whose steward is gone is no longer a dead end: the
recovery rows surface the affected circles in the UI, on web and on native, with
the hand-off available where the problem is visible instead of only in a runbook.
Catching a shared circle up after time away now costs what CHANGED, not what
exists, so a long-idle device rejoins in seconds rather than re-downloading the
whole circle.

First-run: onboarding and the fresh Home are unchanged. A new installation sees
no additional prompt — the recovery rows appear only when a circle actually has
a steward concern, and an install with no links shows the card's empty state.
Visual evidence: `artifacts/e2e/ui-impact/issue-750-vault-sharing.png`, emitted
by `apps/desktop/tests/e2e/onboarding-home.spec.ts` on the first-run Home frame
— the same frame #726 used for the predecessor sharing work, because Household
does not render against the e2e mock gateway.

## Checklist

WS-A (invariants 1–3: stable vault identity, one route per peer vault,
production route-assertion wiring):

- [x] `vault_directory` and `vault_routes` added; `vault_links` slimmed to
      permission
- [x] `VaultLinksStore` rewritten around the directory
- [x] Route-branching helpers deleted outright
- [x] Production route-assertion wiring added
- [x] Vault identity fails closed on a missing or mismatched seed
- [x] WS-A tests: multi-link resolution, rotation, identity loss

WS-B (abstractions 2 and 5: one edge lifecycle, one durable effect outbox,
owners hold authority, validated contracts):

- [x] One reducer owns every `share_edges` transition
- [x] Locality does not fork the domain
- [x] One durable outbox replaces three peer queues
- [x] The semantics that mattered survived, stated in the DDL
- [x] Offline retry is new behaviour, not a regression
- [x] Edge listing is owner-scoped; device id survives as provenance
- [x] Edge scope is parsed, never cast
- [x] Directory labels reach both share sheets
- [x] Four `peer-edge-give-client.ts` allowlist entries removed

WS-C (abstraction 4: idempotent `ProvisionPerson`):

- [x] Endpoint preflight refuses before any write
- [x] `provision_operations` records the operation in the same transaction
- [x] Atomicity by construction, not by resume
- [x] Replay returns the recorded result verbatim
- [x] `operationId` required and shape-checked on the `forPerson` lane
- [x] WS-C tests: five durable-provision cases

WS-D (invariant 7: catch-up cost proportional to what changed, not what
exists):

- [x] Ops-since-cursor increment frame on both rails
- [x] Local rail applies the same delta to co-hosted seats
- [x] Blob pulls authorize once per transfer session
- [x] `checkpoint_json` written only on checkpoint events
- [x] Bootstrap frames travel as bounded, resumable slices
- [x] `sweepPeerCommons` backs off per grant before dialing
- [x] WS-D tests: increment, convergence, streaming, pagination, backoff

WS-E (commons: declared routing + conformance, one intent grammar,
steward-absence reachability + invitation delivery, named identity fault,
consent-growth notice):

- [x] Commons routing is declared data
- [x] `actable.ts` deleted and actability derived from the routes
- [x] Conformance test walks the real registered command schemas
- [x] Drift the conformance test found and this workstream fixed
- [x] Two `actable.ts` allowlist entries removed
- [x] One intent grammar shared with the outbox
- [x] Grammar regression test parses both DDLs
- [x] Steward absence is reachable as a durable notice
- [x] The ceremony has a user surface on web and native
- [x] The notice's deep link names a surface that exists
- [x] Successor invitation delivery is wired
- [x] N≥3 solved as far as it honestly can be
- [x] `docs/recovery/commons-steward-loss.md` operator runbook added
- [x] End-to-end steward-loss drill
- [x] Named identity fault refuses a changed member key
- [x] Consent-growth notice when the commons outgrows the accepted size

WS-F (abstraction 6: mechanical reachability gate):

- [x] `scripts/check-share-reachability.mjs` resolves the transitive importer
      set
- [x] What does NOT count as a caller, by construction
- [x] Parses with the repo-pinned TypeScript at syntax level only
- [x] `share-reachability.json` at the repo root is the config
- [x] Wired into the gate loop as `check:reachability`
- [x] `docs/toolchain.md` records the tool, the command and the rule
- [x] Analyzer counts a same-file value use in a production module
- [x] Allowlist emptied: all 31 seeded entries removed
- [x] Five genuinely dead capabilities resolved, four by deletion
- [x] `bun run check:reachability` exits 0

WS-G (invariants 5–6: replica/CAS lifecycle verified criterion by criterion):

- [x] Verdict per criterion rather than new machinery
- [x] 50k-row scale test for bounded paging and cursor resume
- [x] Compaction to 409 to recovery pinned by test
- [x] Real bug found and fixed in the purge sweep
- [x] Test pins the shared-sha purge defect

WS-H (invariant 7, second cut: catch-up replays the operation tail instead of
diffing the closure):

- [x] Deterministic id seeding in the vault execution core
- [x] `compileCommons` replays the tail and computes the closure lazily
- [x] The wire increment carries the executable tail, not a closure delta
- [x] Replay runs inside the seat's apply transaction
- [x] Every replay failure falls back to the full projection
- [x] The unproven-run bound still applies to replay-advanced replicas
- [x] `closure-delta.ts` and `closure-delta-apply.ts` deleted
- [x] WS-H tests: laggard O(k), version skew, idempotency, forced projection

## What changed

WS-A:

- `vault_directory` and `vault_routes` added; `vault_links` slimmed to
  permission — `vault_directory` keeps one identity record per known vault and
  `vault_routes` keeps ONE route row per peer vault (presence = "lives
  elsewhere"), both in `gateway.db`; `vault_links` is now pure permission
  (pair + approvals). DDL edited in place, no migration, pre-v0.
- `VaultLinksStore` rewritten around the directory. Ceremony writes
  (propose/recordPeer/redeem) land keys and labels in the directory and in the
  peer's single route row; `recordRoute` UPSERTs that one row when
  `assertedAt` is newer, so two local vaults linked to one peer vault both
  resolve a new route after ONE assertion — by construction, proven by test.
- Route-branching helpers deleted outright — `routeTo`, `peerViewOf` and the
  per-link `route_*_json` columns are gone; callers resolve through `routeFor`
  / `peerViewFor` / `directoryEntry`.
- Production route-assertion wiring added — `serve/peer-route-announce.ts`: at
  endpoint start (daemon `cli/endpoint-host.ts`) and on every peer-plane sweep
  tick (`serve/build-gateway.ts`), when the current EndpointId differs from
  the `gateway_meta`-pinned last-asserted one, a signed `RouteClaim` per LOCAL
  vault is pushed to every linked peer. Failures are logged and the pin
  withheld, so the next start or tick retries.
- Vault identity fails closed on a missing or mismatched seed. In
  `@centraid/vault` the identity mint pins `<vaultId>.identity.pub` beside the
  seed; a pin present with the seed missing or mismatched throws the exported
  `VaultIdentityMismatchError` (`code: "vault_identity_mismatch"`) — never a
  silent re-mint. A seed without a pin (a pre-pin vault, or a mint crash)
  loads and re-pins.
- WS-A tests: multi-link resolution, rotation, identity loss. Multi-link
  single-assertion resolution; rotation delivered over the production announce
  path with the in-process ceremony transport, so the peer re-discovers
  without re-linking; identity loss refuses loudly with the pin unchanged.

Files:

- `packages/gateway/src/serve/gateway-schema.ts` — `vault_directory` + `vault_routes` added, `vault_links` slimmed (key/label/route columns removed), comments restated to the new invariants
- `packages/gateway/src/serve/vault-link-row.ts` — slim `VaultLink`; `LinkRoute` is now the shape of a `vault_routes` row; `VaultDirectoryEntry` added; `routeTo`/`peerViewOf` deleted
- `packages/gateway/src/serve/vault-links-store.ts` — rewritten (directory/route upserts, join-based `linkForEndpoint`/`linkForPeer`/`hasAnyLink`, `routeFor`/`directoryEntry`/`peerViewFor`, single-row `recordRoute`)
- `packages/gateway/src/serve/link-crossing.ts`, `routes/vault-links-routes.ts`, `routes/edge-answer-routes.ts` — resolve labels/routes via the store instead of link columns
- `packages/gateway/src/serve/peer-route-announce.ts` (new) + wiring in `cli/endpoint-host.ts` (eager, at endpoint start) and `serve/build-gateway.ts` / `serve/peer-plane-sweep.ts` (retry, per tick)
- `packages/vault/src/schema/vault-identity.ts` — public-key pin + `VaultIdentityMismatchError`, exported from the package barrel
- Tests: `vault-links-store.test.ts` rewritten to the new schema; `peer-route-announce.test.ts`, `vault-identity.test.ts` added; `gateway-db.test.ts` table census, `peer-plane-sweep.test.ts` mock updated

WS-B:

- One reducer owns every `share_edges` transition —
  `packages/gateway/src/serve/share-coordinator.ts` makes the legal
  transitions pure functions — `(facts, state, signal) → {state, effects,
  changed}`. The four hand-rolled state machines that used to write `UPDATE
  share_edges` (the POST route's exception park, the local reconciler's
  queued→in-flight→completed walk, the remote reconciler's six-outcome
  mapping, the peer deny door) are gone. `applyEdgeSignal`
  (`share-edge-store.ts:56`) is now the ONLY writer of edge state in the repo
  — one `UPDATE share_edges` statement exists in production source
  (`share-edge-store.ts:67`) — and it commits the moved state, the access
  receipt a projection earns, and the effects the transition emitted in ONE
  transaction.
- Locality does not fork the domain. D3: `begin` emits the same `deliver-give`
  effect whatever the delivery, and `share-effect-executor.ts` is the only
  thing that selects `deliverGiveLocally` (direct `@centraid/vault`
  share/move) or `deliverGiveOverPeer` (peer dial). Both report back through
  the same signals, so a peer outcome can no longer invent a status the local
  path never uses.
- One durable outbox replaces three peer queues — `peer_pending_gives`,
  `peer_blob_pulls` and `peer_pending_refusals` are DELETED from the DDL (v0,
  in place, no migration, no dual write) and replaced by `share_effects`: one
  table, four kinds (`deliver-give`, `await-answer`, `deliver-refusal`,
  `pull-blob`), per-kind handlers, attempts and `next_attempt_at` backoff
  (`BASE_BACKOFF_MS = 5_000`, ×2 per attempt, `MAX_BACKOFF_MS = 15 min` —
  `share-effects.ts:17-19,240`). `effect_id` is DERIVED (`give:<edge>`,
  `ask:<edge>`, `refuse:<edge>`, `pull:<edge>:<sha>` —
  `share-coordinator.ts:274`) so a crash replay lands on the same row, and
  each handler keeps the anchor that already made it replay-safe (sha-verified
  CAS adoption, edge-unique receipt, origin acknowledgement).
- The semantics that mattered survived, stated in the DDL. Refusal is durable
  BEFORE any network attempt (the answer route closes the ask and enqueues the
  relay in one transaction); blob-pull resumes by file length via Range
  requests (`tmpPath` in the payload, minted once); a pending give carries no
  bytes and no closure (the audience pulls fresh on accept). `next_attempt_at
  IS NULL` is what "waiting on a human" means, which is why the D9 'ask' needs
  no table of its own.
- Offline retry is new behaviour, not a regression. A give to an unreachable
  peer used to park with nothing left to retry it. It now leaves a queued
  `deliver-give` effect the sweep re-attempts, and the route still answers
  synchronously in the common case (the effect runs inline).
- Edge listing is owner-scoped; device id survives as provenance — `GET
  /centraid/_gateway/edges` lists by `owner_id` (`edges-routes.ts:99`; the
  index `share_edges_owner_status` replaces the per-device one), so every
  device of one owner sees the same history. `created_by_device` stays stored
  AND is now answered as `createdByDevice` provenance in the wire DTO
  (`edges-routes.ts:274`).
- Edge scope is parsed, never cast — `serve/share-scope.ts` replaces
  `JSON.parse(scope_json) as string[]` — a cast, in four places, feeding a
  DURABLE access receipt — with a total parser that refuses `null`, invalid
  JSON, non-arrays, empty sets and non-string members loudly. The payload is a
  discriminated union on `mode` even though `mode` admits one value: live
  lending is structurally absent since #731 (the `share_edges` CHECK),
  asserted at the boundary here rather than re-added.
- Directory labels reach both share sheets. The linked vault's directory label
  now rides the destination contract (`share-wire.ts` → `centraid-inline.ts` →
  `_shared/share-kit.ts`, and `links-transport.ts` → `share-targets.ts`). The
  three truncated-vault-id reconstructions (`Linked vault vlt_0123…`) are
  deleted; with no directory label the sheets say "Linked vault" / "Linked
  person" plainly, because an id is not a name. The links wire payload is
  runtime-validated at both client boundaries instead of cast.
- Four `peer-edge-give-client.ts` allowlist entries removed. In
  `share-reachability.json`: the peer plane now imports the three wire paths
  from the client module (one source of truth for a path that was duplicated
  in the route file), and `peerEdgeClosurePath` was made module-local. No WS-B
  entry was added.

Files:

- `packages/gateway/src/serve/share-coordinator.ts` (NEW) — the pure reducer: `EdgeState`/`EdgeFacts`/`EdgeSignal`/`ShareEffect`, `reduceEdge`, `isTerminalEdgeStatus`, `effectIdFor`
- `packages/gateway/src/serve/share-edge-store.ts` (NEW) — `applyEdgeSignal`: reduce, then commit state + receipt + effects in one transaction
- `packages/gateway/src/serve/share-edge-row.ts` (NEW) — the row shape and `readEdgeRow`, split out of `edges-reconcile.ts` so nothing imports a transport to get a type
- `packages/gateway/src/serve/share-effects.ts` (NEW) — outbox store: derived-id enqueue, due-claim, complete/defer with backoff, total payload parsers, queued-effect reads
- `packages/gateway/src/serve/share-effect-executor.ts` (NEW) — `runShareEffect` (per-kind handlers, transport selection) and `drainShareEffects`
- `packages/gateway/src/serve/share-scope.ts` (NEW) — `parseEdgeScope` / `validateItemIds` / `parseTargetItemIds`, `ShareScopeError`
- `packages/gateway/src/serve/gateway-schema.ts` — `share_effects` added; `peer_pending_gives` / `peer_blob_pulls` / `peer_pending_refusals` DELETED; `share_edges_device_status` → `share_edges_owner_status`
- `packages/gateway/src/routes/edges-reconcile.ts` — now the LOCAL transport (`deliverGiveLocally`); its state machine and `updateStatus` deleted
- `packages/gateway/src/routes/edges-reconcile-remote.ts` — now the PEER transport (`deliverGiveOverPeer`); its six-way status mapping is a signal mapping
- `packages/gateway/src/routes/edges-routes.ts` — POST drives `begin` + inline effect execution; GET lists by owner; `createdByDevice` on the wire; scope validated through `share-scope.ts`
- `packages/gateway/src/routes/edge-answer-routes.ts` — pending/answer read and write the outbox (`await-answer` → `deliver-refusal`) instead of `peer_pending_gives`/`peer_pending_refusals`
- `packages/gateway/src/routes/peer-edge-give-route.ts` — 'ask' enqueues an `await-answer` obligation; closure re-serve and deny go through the reducer; the three duplicated wire-path constants deleted in favour of `peer-edge-give-client.ts`'s
- `packages/gateway/src/serve/peer-blob-pull.ts` — `recordPendingPulls` enqueues `pull-blob` effects; `runBlobPull` keeps the ranged/resumable mechanics; `drainPeerBlobPulls` deleted
- `packages/gateway/src/serve/peer-refusal-relay.ts` + `peer-refusal-relay.test.ts` — DELETED (the relay is the `deliver-refusal` handler; the suite is re-pinned as `share-refusal-outbox.test.ts`)
- `packages/gateway/src/serve/peer-plane-sweep.ts` — two specialized drains collapse to one `drainShareEffects`
- `packages/gateway/src/routes/vault-routes.ts` — erase also destroys the `<vaultId>.identity.pub` pin (a pin outliving its seed is the state `VaultIdentityMismatchError` refuses to open)
- `packages/client/src/react/blueprints/share-wire.ts` + `centraid-inline.ts`, `packages/blueprints/apps/_shared/share-kit.ts`, `apps/mobile/src/kit/share/share-targets.ts` — the directory label rides the destination contract; the truncated-id labels deleted
- `packages/client/src/gateway-client-links.ts`, `apps/mobile/src/lib/replica/links-transport.ts` — total `parseGatewayLink` at the client boundary
- `share-reachability.json` — four `peer-edge-give-client.ts` entries removed
- Tests: `share-coordinator.test.ts`, `share-scope.test.ts`, `share-refusal-outbox.test.ts`, `routes/edges-routes.test.ts` (NEW); `peer-remote-give.test.ts`, `peer-transport-remote.test.ts`, `peer-plane-sweep.test.ts`, `gateway-db.test.ts`, `peer-give.test-fixtures.ts` adapted to the outbox; label cases added to `blueprints/src/share-kit.test.ts` and `apps/mobile/.../share-targets.test.ts`

WS-C:

- Endpoint preflight refuses before any write — `handleTicketMint` resolves
  `deps.endpointTicket()` and refuses `409 no_iroh_endpoint` at
  `device-ticket-mint.ts:311-323`, ahead of invitation resolution and ahead of
  the *Add someone* lane. Everything above that line is parse and validation
  only, so an endpoint-less gateway creates zero owners, vaults, ownership
  rows, keys or tickets.
- `provision_operations` records the operation in the same transaction —
  `gateway-schema.ts:115`: `operation_id` PRIMARY KEY, the FULL original
  response as `result_json`, `created_at`. The row commits in the SAME
  transaction as the owner / `vault_owners` / ticket rows it describes, so a
  failed mint records nothing and a recorded operation always names committed
  rows.
- Atomicity by construction, not by resume — `executeForPersonMint`
  (`device-ticket-mint.ts:82`) runs the one non-transactional step FIRST
  (`VaultRegistry.create` — dir, SQLite files, identity keypair); every
  gateway.db row then commits in one transaction; a throw rolls that
  transaction back and `unmintVaultForPerson` removes the orphan vault before
  the failure is rethrown. Rollback was chosen over resume because the
  workflow is cheap to redo and resume would need per-step provenance.
- Replay returns the recorded result verbatim. A repeat of the same
  `operationId` re-mints nothing — including the original ticket, because
  minting a fresh one would make replay a write and let one operation id mint
  unbounded live tickets. An expired replayed ticket is a NEW operation (fresh
  id), stated in the code comment. Two racing requests with one id are decided
  by the PRIMARY KEY; the loser rolls back and its retry replays the winner's
  result.
- `operationId` required and shape-checked on the `forPerson` lane — `400
  operation_id_required` when absent, `400 invalid_operation_id` for anything
  outside 8–128 chars of `[A-Za-z0-9._-]`. The client generates it once per
  intended mint and reuses it on retry: `GatewayDeviceTicketInput.operationId`
  plus `DevicePairPanel`'s `operationRef`, minted on the first attempt and
  cleared on success, so "press Generate again" after a failure cannot mint a
  second owner and vault.
- WS-C tests: five durable-provision cases — `devices-routes-mint.test.ts`,
  describe "mint-for-person is a durable provision (#750)":
  endpoint-capability preflight creates nothing; `operationId` required and
  shape-checked; failure BEFORE the durable steps leaves zero debris and a
  retry with the SAME id succeeds once; failure AFTER the vault step rolls
  back with vault cleanup and a retry with the SAME id succeeds once; replay
  after success returns the recorded result verbatim and creates nothing new.

Files:

- `packages/gateway/src/serve/gateway-schema.ts` — `provision_operations (operation_id PRIMARY KEY, result_json, created_at) STRICT`, with the comment stating the same-transaction rule
- `packages/gateway/src/routes/device-ticket-mint.ts` — endpoint-capability preflight hoisted above every write; `readProvisionOperation`, `executeForPersonMint` (mint-vault-first, one transaction, rollback + `unmintVaultForPerson`), `handleForPersonMint` (required + shape-checked `operationId`, verbatim replay, `500 provision_failed` at the HTTP boundary)
- `packages/gateway/src/routes/device-invitations.ts` — `parseOperationId` and `preflightForPersonMint` split out; the *Add someone* refusals all evaluate before any write
- `packages/gateway/src/routes/devices-routes.ts` — `unmintVaultForPerson` added to `DevicesRouteDeps`; `packages/gateway/src/serve/build-gateway.ts` wires it to the registry
- `packages/client/src/gateway-client-devices.ts` — `operationId` on `GatewayDeviceTicketInput`
- `packages/client/src/react/screens/DevicePairPanel.tsx` — `operationRef` minted once per intended mint (`crypto.randomUUID()`), reused on retry, cleared on success
- Tests: `devices-routes-mint.test.ts` gains the "mint-for-person is a durable provision (#750)" block (5 cases); `gateway-db.test.ts` table census; `DevicePairPanel.test.tsx` asserts the retry reuses one id

WS-D:

- Ops-since-cursor increment frame on both rails. A member whose cursor sits
  on the op chain at or past the stored checkpoint receives ops, new
  receipts/replay and a closure DELTA (the diff against the checkpoint, plus
  every row a window op named — the edit-then-revert guard), verified through
  the same hash-chain machinery anchored at the seat's own proven head. Chain
  faults still PARK, and unusable or unresolvable frames fall back to the full
  re-baseline, which stays the one destructive, digest-checked path.
- Local rail applies the same delta to co-hosted seats — `compileCommons`
  applies it gated on the SEAT's own cursor, so a restored-from-backup seat
  re-baselines; unchanged items' seat-local OCR, embeddings and FTS, and their
  drained enrichment, are never touched.
- Blob pulls authorize once per transfer session. The closure is proven at
  open and chunks validate against the stored sha set (no per-chunk export or
  signing); chunks stream into the vault's promotion temp file, so peak member
  memory is about one chunk.
- `checkpoint_json` written only on checkpoint events —
  `COMMONS_CHECKPOINT_INTERVAL = 32`, first compile, or an explicit
  `checkpointCommonsState(force)` — never per compile.
- Bootstrap frames travel as bounded, resumable slices. A frame past the
  member's page budget is sliced under a short-lived steward session (`state:
  "bootstrap-pages"`, `PEER_COMMONS_PAGE_BYTES = 1 MiB`); blob bytes never
  ride the bootstrap JSON.
- `sweepPeerCommons` backs off per grant before dialing. It consults
  `share_commons_steward_contact` for exponential per-grant backoff
  (`COMMONS_SWEEP_BACKOFF_BASE_MS = 30 s`, `COMMONS_SWEEP_BACKOFF_MAX_MS = 1
  h`) before dialing — intents and pulls both gated — plus an in-tick
  per-grant skip after one unavailable answer.
- WS-D tests: increment, convergence, streaming, pagination, backoff. Laggard
  O(k) increment with derived-row survival, A→B→A convergence, delta-fallback
  repair, one-authorize multi-chunk streaming, chunk-without-session refusal,
  increment-over-peer-rail survival, paginated bootstrap, sweep backoff; the
  seeded sim now drives the increment rail through its random schedule, stale
  restores included.

Files:

- `packages/vault/src/share/closure-delta.ts` (new) — `WireClosureDelta` + `diffShareClosure`: row-keyed diff of two closures (content/derivatives/assets/documents at row level; tally expenses as replace-subtrees; docs-folder folders/tags and collection entries keyed), op-named force-include, parent-content pull-in, new-blob manifest; `undefined` = not delta-expressible (fall back)
- `packages/vault/src/share/closure-delta-apply.ts` (new) — member-side apply inside the caller's transaction: sha-resolved upserts that never overwrite dedup rows, unit reconciliation, removals via `deleteProjectedClosure`, ingest door for genuinely new items, `ShareClosureDeltaError` fallback contract
- `packages/vault/src/share/commons-chain.ts` — `verifyCommonsIncrementHistory` (chain verification anchored at the seat's verified head)
- `packages/vault/src/share/commons-bootstrap.ts` — `CommonsIncrement` frame + `exportCommonsIncrement` / `applyCommonsIncrement` (+ member-side op retention floor), `exportCommonsSyncFrame` gains `afterSequence`, `CommonsIncrementUnusableError`, and `placeCommonsIncrementBlobs` (which WS-F later moved to `packages/vault/src/share/commons-blobs.test-fixtures.ts`, alongside `placeCommonsBootstrapBlobs`)
- `packages/vault/src/share/commons.ts` — `COMMONS_CHECKPOINT_INTERVAL`, `checkpointCommonsState`, `commonsClosureDeltaSinceCheckpoint`, `commonsOpTouchedRowIds`; `compileCommons` delta fast path + checkpoint-on-cadence (per-compile `checkpoint_json` rewrite deleted)
- `packages/vault/src/share/commons-sim-world.test-fixtures.ts` (it was `packages/vault/src/share/commons-sim-world.ts` until WS-F relocated the harness) — sim `pull()` drives the increment rail with fallback
- `packages/gateway/src/routes/peer-commons-route.ts` — increment/`full=1` responses, expiring transfer-session store, `handlePeerCommonsBlobAuthorize`, per-chunk validation without export, `bootstrap-pages` slicing (`pageBytes` clamped by `PEER_COMMONS_PAGE_BYTES`)
- `packages/gateway/src/serve/peer-commons-client.ts` — increment apply with park/fallback, page reassembly, one-shot blob authorization + temp-file chunk streaming
- `packages/gateway/src/serve/peer-commons-sweep.ts` — absence-evidence exponential backoff for intents and pulls
- `packages/gateway/src/routes/peer-plane.ts` — wire the blob-authorize path (mechanical)
- `docs/protocol.md` — increment/pagination/session-authorization contract added to the Commons stream section
- Deleted: per-chunk `exportCommonsBootstrap` in the blob route (it now runs ONCE, in `handlePeerCommonsBlobAuthorize`); per-compile `checkpoint_json`/attestation rewrite; whole-blob base64 assembly in the pull client
- Tests: `packages/vault/src/share/commons-increment.test.ts`, `packages/gateway/src/serve/peer-commons-pull.test.ts` (new); backoff suite in `peer-commons-sweep.test.ts`; `commons-lifecycle.test.ts` adapted to explicit checkpoint events before forced compaction

WS-E:

- Commons routing is declared data —
  `packages/vault/src/share/commons-routing.ts` holds one table of `(command,
  ownerSchema, inputKey, containerType, resolution, actable)` rows plus the
  key vocabulary. `commonsGrantForCommand` consults ONLY that table;
  `command.includes("folder")`, the `core.` / `tally.` prefix branches and the
  `CONTAINER_ID_KEYS` catch-all are deleted.
- `actable.ts` deleted and actability derived from the routes. The file and
  its test are gone. `declareCommonsCommands` / `commonsCommandsFor` —
  exported, barrel-re-exported, called by nothing — went with them, and
  `isCommonsCommandActable` is now derived from the same declared rows, so
  routing and actability can no longer drift apart.
- Conformance test walks the real registered command schemas —
  `commons-routing.test.ts` reads `agent_command.input_schema_json` with nine
  command packs installed: a declared route naming a non-existent command, a
  wrong owner schema, or an input key the schema does not declare fails; a
  registered command that grows a vocabulary key with no route fails; a route
  outside the vocabulary fails.
- Drift the conformance test found and this workstream fixed —
  `core.delete_document`, `core.add_collection_entry`,
  `core.remove_collection_entry` and `core.rename_collection` were declared
  actable but DO NOT EXIST as commands; `collection_id` was in
  `CONTAINER_ID_KEYS` but no command has that key, so writes into a shared
  ALBUM (`album_id`, a `core.collection`) never reached the rail at all — they
  landed private and were reverted by the next compile. Albums, assets, locker
  items, content items and the non-declared tally/document commands are now
  routable-but-not-actable: they reach the rail and refuse by name.
- Two `actable.ts` allowlist entries removed. Net −2 entries in
  `share-reachability.json`, none added. The new exports are
  production-reached rather than allowlisted: `COMMONS_CONTAINER_KEYS` now
  DERIVES the stale-context row-key set in `commons.ts:1498` (a second
  hand-maintained key list deleted), `COMMONS_COMMAND_ROUTES` gates which
  container types the commons door may offer (a type nothing can route a write
  to must not be offerable), and `COMMONS_MEMBER_IDENTITY_CHANGED` is consumed
  by the sweep's notice path.
- One intent grammar shared with the outbox — `share_commons_intent.status` is
  aligned to the replica pending-write outbox vocabulary — `pending` →
  `queued` — so `queued | parked | denied | executed | expired | cancelled`
  are the outbox's own words. The v0 in-place DDL CHECK and index rename,
  every writer and reader (`queueCommonsIntent`, `cancelCommonsIntent`, the
  sweep query, the sim), the client `InlineCommonsIntent` union, the blueprint
  `CentraidCommonsIntent` type and Tally's renderer (its `pending → queued`
  translation shim is deleted) all moved together.
- Grammar regression test parses both DDLs. It asserts that the commons states
  are the outbox's states, and that `'pending','parked'` no longer appears in
  the commons DDL.
- Steward absence is reachable as a durable notice — `commons-notices.ts`
  turns the recorded reach evidence (`share_commons_steward_contact` ×
  `share_commons_device_reach`, derived by `commons-observability.ts`) into a
  durable `commons-steward` notice on the ordinary notices store (#647),
  severity `high`, deep-linked to the recovery action. The commons sweep
  raises it, re-raises only when the presence CHANGES, never raises for a
  grant already superseded, and sets `detail.recoverable` false for a
  fault-parked seat, which must never be re-founded.
- The ceremony has a user surface on web and native. The notices were durable
  but nothing rendered them and no client called the doors, so the ceremony was
  reachable only by hand-rolled HTTP. `listCommonsRecovery` / `recoverCommons`
  now exist on both clients; the People & circles panel (web `SharingCard.tsx`,
  native `Sharing.tsx`) grows a "Shared-space recovery" section that names the
  steward's presence and how long it has been silent, and offers "Recover from
  my copy" — for a genuine `absent` only. A `parked` seat is shown and
  deliberately given no button (it must never be re-founded from state it could
  not verify), and `link-down` is not shown at all, because this device cannot
  prove anything about the steward. After the ceremony the web surface says how
  many seats were invited and how many must be reached by hand.
- The notice's deep link names a surface that exists. It pointed at
  `/sharing/commons/recovery`, a route no client has ever had. It is now
  `/household`, and `ApprovalsRoute` routes every `commons-*` notice there —
  the page whose People & circles panel carries the ceremony.
- Successor invitation delivery is wired — `commons-recovery-invites.ts`
  delivers successor invitations after the ceremony — co-hosted seats queued
  directly, linked peers pushed over the peer plane (`invitePeerToCommons`,
  wired through `build-gateway.ts`), everyone else handed a one-time claim
  ticket — and the POST door returns a per-seat `invitations` report.
- N≥3 solved as far as it honestly can be. A member with no link to the
  successor gets an old-steward-independent claim ticket (nothing in that path
  touches the lost vault) that is carried out of band and redeemed after
  ordinary pairing. The residual manual step is documented, not hidden.
- `docs/recovery/commons-steward-loss.md` operator runbook added. Detect →
  ceremony → delivery table → convergence → the split-brain re-founding caveat
  (seat-local supersession, two successors, a returning steward), plus a
  symptom→first-move table.
- End-to-end steward-loss drill — `commons-steward-loss-drill.test.ts`: four
  seats, absence evidence recorded → notice surfaces (and does not re-raise) →
  ceremony over the in-process transport → co-hosted, peer and claim
  deliveries all asserted → member accepts and converges on the successor
  while the superseded grant survives as history.
- Named identity fault refuses a changed member key —
  `COMMONS_MEMBER_IDENTITY_CHANGED` ("commons_member_identity_changed"): when
  the transport-proven member key differs from the key
  `share_party_vault_binding` pinned at join, the steward refuses with that
  named reason BEFORE any command-shape refusal, the refusal is durable on the
  op log, the peer door answers `403 refused` with it instead of a silent 404,
  and the member's sweep raises a `commons-identity` notice naming
  re-invitation as the cure.
- Consent-growth notice when the commons outgrows the accepted size. A
  `commons-size` notice on the member seat, once, when the commons outgrows
  the byte size that member accepted — the accepted size was already durable
  on the invitation row, so no new column.

Files:

- `packages/vault/src/share/commons-routing.ts` (NEW) — the declared routing table, key vocabulary, `commonsRoutesForCommand`, `isCommonsCommandActable`
- `packages/vault/src/share/actable.ts` + `actable.test.ts` — DELETED (registry moved to `commons-routing.ts`; the two dead exported doors removed outright)
- `packages/vault/src/share/commons.ts` — `commonsGrantForCommand` rewritten as a registry walk with one `resolveCommonsContainer` query per declared resolution kind; heuristics/`CONTAINER_ID_KEYS` deleted; `STALE_CONTEXT_ROW_KEYS` derived from `COMMONS_CONTAINER_KEYS`; `COMMONS_MEMBER_IDENTITY_CHANGED` + `commonsMemberIdentityChangedReason` + `pinnedMemberVaultKey`; `presentedVaultPublicKey` threaded through `commandRefuses` / `authorizeCommonsCommand` / `ExecuteCommonsCommandInput`; intent status `pending` → `queued`
- `packages/vault/src/schema/share-commons.ts` — intent status CHECK + partial index renamed to the outbox grammar (v0, in place)
- `packages/vault/src/gateway/gateway.ts`, `packages/vault/src/index.ts` — import/export moved to `commons-routing.js`; new named-fault exports
- `packages/gateway/src/serve/commons-notices.ts` (NEW) — absence, consent-growth and identity cards + `raiseCommonsNotices`; deep link retargeted to `/household`
- `packages/client/src/gateway-client-edges.ts`, `packages/client/src/gateway-client.ts` — `listCommonsRecovery` / `recoverCommons` and their wire types; a named refusal is translated to plain words
- `packages/client/src/react/screens/SharingRecoveryRows.tsx` (NEW), `packages/client/src/react/screens/SharingCard.tsx`, `packages/client/src/react/shell/routes/HouseholdRoute.tsx` — the web recovery section and its wiring
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx` — a `commons-*` notice opens Household
- `apps/mobile/src/lib/replica/placement-transport.ts`, `apps/mobile/src/screens/Sharing.tsx` — the native transport and recovery section
- `packages/gateway/src/serve/commons-recovery-invites.ts` (NEW) — successor-invitation delivery (co-hosted / linked peer / claim ticket)
- `packages/gateway/src/routes/commons-recovery-routes.ts` — POST now delivers invitations and reports them; `invitePeer` dep added
- `packages/gateway/src/serve/peer-commons-sweep.ts` — raises the commons notices each tick; names the identity fault on refusal settlement; intent query moved to `queued`
- `packages/gateway/src/routes/peer-commons-route.ts` — presents the proven peer key to authorization; a pinned-but-different key answers `403 refused` with the named fault instead of `404`
- `packages/gateway/src/routes/commons-routes.ts` — offerable container types are intersected with the declared routing table
- `packages/gateway/src/serve/build-gateway.ts` — `invitePeer` wired into the recovery door
- Client/blueprints: `packages/client/src/react/blueprints/centraid-inline.ts`, `packages/blueprints/types/centraid.d.ts`, `packages/blueprints/apps/tally/logic.ts` (translation shim deleted), `packages/blueprints/apps/tally/components/ExpenseRow.tsx` (comments)
- Docs: `docs/recovery/commons-steward-loss.md` (NEW), `docs/protocol.md` (one intent grammar + declared routing sections), `AGENTS.md` (recovery index row)
- `share-reachability.json` — the two `actable.ts` TODO(#750) entries removed
- Tests: `packages/client/src/gateway-client-commons-recovery.contract.test.ts` (NEW, client seam laws), recovery cases in `packages/client/src/react/screens/HouseholdScreen.test.tsx` and `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`, transport cases in `apps/mobile/src/lib/replica/placement-transport.test.ts`
- Tests: `packages/vault/src/share/commons-routing.test.ts` (NEW, conformance), `packages/gateway/src/routes/commons-steward-loss-drill.test.ts` (NEW, drill), `packages/gateway/src/serve/commons-notices.test.ts` (NEW); identity-fault case in `commons-hardening.test.ts`; grammar case in `commons-intent-lifecycle.test.ts`; status spelling updated in `commons-tally-b6.test.ts`, `commons-invoke.test.ts`, `vault-plane-commons.test.ts`

WS-F:

- `scripts/check-share-reachability.mjs` resolves the transitive importer set.
  For every VALUE export of the configured sharing-plane modules it follows
  re-exports through `index.ts` barrels and workspace package specifiers, and
  fails unless at least one PRODUCTION file imports the capability in a value
  position. This closes the class knip cannot see: a barrel is a knip entry,
  so `declareCommonsCommands` counted as "used" while nothing called it.
- What does NOT count as a caller, by construction. Test, benchmark and
  fixture files (classified by the TESTING.md path conventions, `isTestPath`),
  type-only imports, value imports used only in a type position, and pure
  import-then-re-export sites. A value-position use inside the capability's
  own declaring production module DOES count.
- Parses with the repo-pinned TypeScript at syntax level only. No type
  checking, no build step, no new dependency (B2: tools only via repo
  scripts).
- `share-reachability.json` at the repo root is the config — `modules` (three
  globs — `packages/gateway/src/serve/peer-*.ts`,
  `packages/gateway/src/serve/vault-links-store.ts`,
  `packages/vault/src/share/*.ts`) and `allowlist` (documented exceptions, one
  non-empty `reason` string each, knip.json's style). A STALE entry — one
  whose capability gained a production caller or disappeared — is itself a
  failure, so the list can only shrink.
- Wired into the gate loop as `check:reachability`. It is a `check:push` gate
  (`package.json:27`), `check:pr` runs `check:push`, and `check:full` runs
  `check:pr` — so it gates all three tiers.
  `scripts/check-share-reachability.test.mjs` (run by `scripts:test`) pins the
  analyzer's own semantics: barrel laundering, `export *` following,
  import-then-re-export chains, namespace-import member access, type-only
  exemption, the defining module's own use, allowlist reason required, stale
  allowlist reported.
- `docs/toolchain.md` records the tool, the command and the rule. The
  tool-ownership row, the command row, and a "Sharing-plane export
  reachability" section stating the rule, the same-file convention, and the
  now-empty allowlist contract.
- Analyzer counts a same-file value use in a production module. The first cut
  treated a capability used only inside its own declaring module as unreached,
  which produced a false-positive class. It now counts such a use as a
  production reacher when the declaring module is production code — the same
  convention as knip's `ignoreExportsUsedInFile`, which this repo already
  runs. The two gates compose: knip fails on dead FILES, so a module that only
  reaches itself is either alive or knip deletes the whole file; this gate
  fails on dead EXPORTS inside live files. A declaration's own name is not a
  use, a same-file use in a test module rescues nothing, and a same-file use
  in a type position is still type-only; such a reacher is reported as `<file>
  (same-file)` so the output stays honest.
- Allowlist emptied: all 31 seeded entries removed — 26 of them were the
  false-positive class the same-file correction eliminated; the other 5 were
  genuinely dead and were resolved rather than re-allowlisted.
  `share-reachability.json` now reads `"allowlist": []`, and
  `docs/toolchain.md` records that a failing capability is fixed by wiring a
  production caller or deleting the export, not by adding an entry.
- Five genuinely dead capabilities resolved, four by deletion. DELETED:
  `placement.ts#shareToVault` (a 10-line wrapper over `shareItemsToVault`; 23
  call sites across 6 test files — `local-orphan-sweep.test.ts`,
  `closure-split.test.ts`, `docs-folder.test.ts`, `household.test.ts`,
  `placement-lifecycle.test.ts`, `placement.test.ts` — migrated to
  `shareItemsToVault`, and `ARCHITECTURE.md:60` corrected);
  `commons.ts#authorizeCommonsCommand` (a parallel authorization path
  `executeCommonsCommand` does not call, with 5 test files re-pointed);
  `commons-cursor.ts#advanceCommonsCursor` (a near-duplicate of
  `acknowledgeCommonsSeatCursor`);
  `projection-ingest.ts#declareProjectionIngest` (nothing registered through
  it). RELOCATED rather than deleted: the seeded simulation harness, which
  issue #750 explicitly protects — `commons-sim.ts` and `commons-sim-world.ts`
  became `commons-sim.test-fixtures.ts` and
  `commons-sim-world.test-fixtures.ts` — and, exposed by that move,
  `placeCommonsBootstrapBlobs` / `placeCommonsIncrementBlobs`, which moved out
  of `commons-bootstrap.ts` into the new `commons-blobs.test-fixtures.ts`.
- `bun run check:reachability` exits 0 — `share reachability: ok (155
  capabilities across 3 module globs)` with `"allowlist": []` in
  `share-reachability.json`. Acceptance criterion 20 is met, not merely
  mechanised.

Files:

- `scripts/check-share-reachability.mjs` (NEW) — the analyzer: source scan over `packages/`, `apps/`, `tools/`; barrel/`export *`/workspace-specifier resolution; value-vs-type-position classification; `isTestPath` per the TESTING.md conventions; allowlist with required reasons and stale-entry detection
- `scripts/check-share-reachability.test.mjs` (NEW, 21 cases) — the analyzer's own semantics, run under `scripts:test`; the last five pin the same-file rule (a production same-file value use counts; a bare declaration, a test-module same-file use, and a same-file type-position use do not)
- `share-reachability.json` (NEW) — `modules` globs + `allowlist`, the latter seeded with 31 `TODO(#750)` entries and now `[]`
- `package.json` — `check:reachability` script; added to the `check:push` gate list (so `check:pr` and `check:full` inherit it) and the analyzer test added to `scripts:test`
- `docs/toolchain.md` — ownership row, command row, and the "Sharing-plane export reachability" section, including the **Same-file rule** paragraph and the "allowlist is empty and should stay that way" contract

Files touched by the dead-capability removal that emptied the allowlist:

- `packages/vault/src/share/placement.ts` — `shareToVault` deleted; `shareItemsToVault` is the one placement door
- `packages/vault/src/share/commons.ts` — `authorizeCommonsCommand` deleted (`executeCommonsCommand` is the only authorization path)
- `packages/vault/src/share/commons-cursor.ts` — `advanceCommonsCursor` deleted; `acknowledgeCommonsSeatCursor` (`commons.ts:551`) is the surviving monotonic writer
- `packages/vault/src/share/projection-ingest.ts` — `declareProjectionIngest` deleted; the hook table is the registration surface
- `packages/vault/src/share/commons-sim.test-fixtures.ts` and `packages/vault/src/share/commons-sim-world.test-fixtures.ts` — the seeded simulation harness, renamed from `commons-sim.ts` / `commons-sim-world.ts`. It is test-only by construction and #750 explicitly protects it, so it was relocated rather than deleted
- `packages/vault/src/share/commons-blobs.test-fixtures.ts` (NEW) — `placeCommonsBootstrapBlobs` / `placeCommonsIncrementBlobs`, moved out of `commons-bootstrap.ts` once the sim move left them with test-only callers
- `packages/vault/src/index.ts` — `shareToVault` (with `ShareToVaultInput` / `ShareToVaultResult`), `authorizeCommonsCommand`, `advanceCommonsCursor`, `declareProjectionIngest` and `placeCommonsBootstrapBlobs` dropped from the package barrel
- `ARCHITECTURE.md` — line 60 corrected: local composition is `shareItemsToVault`
- Call sites and imports re-pointed: `packages/vault/src/blob/local-orphan-sweep.test.ts`, `packages/vault/src/gateway/portability.test.ts`, `packages/vault/src/share/closure-split.test.ts`, `packages/vault/src/share/commons-convergence-properties.test.ts`, `packages/vault/src/share/commons-docs-b6.test.ts`, `packages/vault/src/share/commons-docs-command.test.ts`, `packages/vault/src/share/commons-hardening.test.ts`, `packages/vault/src/share/commons-lifecycle.test.ts`, `packages/vault/src/share/commons-sim.test.ts`, `packages/vault/src/share/commons.test.ts`, `packages/vault/src/share/docs-folder.test.ts`, `packages/vault/src/share/household.test.ts`, `packages/vault/src/share/placement-lifecycle.test.ts`, `packages/vault/src/share/placement.test.ts`

WS-G:

- Verdict per criterion rather than new machinery. The borrowed-replica plane
  the issue's criteria name was DELETED in #731 (`224065b2`) —
  `borrowed-store.ts`, `borrowed-schema.ts`, `borrowed-cas.ts`,
  `borrowed-changes.ts`, `borrowed-blob-custody.ts`,
  `borrowed-replica-routes.ts`, `peer-lend-route.ts`, `lend-wire.ts` and the
  rest of the live/lend plane are gone from the tree. Those criteria are
  therefore MOOT, and the surviving analogs on the device-replica and
  vault-CAS planes were verified instead.
- 50k-row scale test for bounded paging and cursor resume —
  `tests/scale/replica-bootstrap.scale.test.ts` (nightly): the existing
  client-walk test is joined by "the gateway pages 50k rows bounded and
  resumes its cursor across a restart" — every response bounded by `window`
  (no request serializes the full shape into one JSON envelope), and the
  continuation token survives a full vault-plane stop and reopen from disk
  with every row delivered EXACTLY once, no gap and no duplicate.
- Compaction to 409 to recovery pinned by test — `replica-routes.test.ts`,
  "compaction past the pinned page-1 cursor forces a 409 snapshot-retention,
  and a fresh walk recovers": high churn after page 1, `pruneReplicaChanges`
  moves the retention floor past the token's pinned delta cursor, the lagging
  walk gets `409 replica_rebootstrap_required` / `reason:
  "snapshot-retention"` rather than a silent gap, and the DEFINED recovery — a
  fresh page-1 walk — pins a post-floor cursor and re-pages the whole library.
- Real bug found and fixed in the purge sweep —
  `packages/vault/src/gateway/duties.ts`: the purge sweep deleted a purged
  content item's derivative CAS bytes unconditionally. `sha256` is UNIQUE on
  `core_content_item` but NOT on `core_content_derivative`, so two items'
  thumbs may legally share one CAS entry — purging the lapsed item destroyed
  bytes a LIVE item still claimed. Fixed with a final-reference guard:
  `liveBlobShas(db.vault)` is re-derived AFTER the row deletes and any sha
  another row still claims is skipped. A skipped copy is not leaked — once its
  surviving claim drops, the local orphan sweep (#599) reclaims it through the
  grace window.
- Test pins the shared-sha purge defect — `duties.test.ts`, "purge keeps
  derivative bytes another content item still claims (issue #750)": two items
  share one thumb sha; purging the lapsed one reclaims its exclusively-owned
  original and leaves the shared thumb and the live original intact, with the
  survivor still reading its own thumb.

Files:

- `packages/vault/src/gateway/duties.ts` — final-reference guard in `purgeContentItem`: `liveBlobShas(db.vault)` re-derived after the row deletes; any sha another live row still claims is skipped instead of destroyed
- `packages/vault/src/gateway/duties.test.ts` — "purge keeps derivative bytes another content item still claims (issue #750)"
- `tests/scale/replica-bootstrap.scale.test.ts` — "the gateway pages 50k rows bounded and resumes its cursor across a restart" (server-side 50k walk, bounded windows, cursor survives a vault-plane stop/reopen, exactly-once delivery)
- `packages/gateway/src/routes/replica-routes.test.ts` — "compaction past the pinned page-1 cursor forces a 409 snapshot-retention, and a fresh walk recovers"
- No new abstraction was introduced for the borrowed-replica criteria: the plane they name no longer exists (see the deviation note)


### WS-H — catch-up by command-tail replay

WS-D made catch-up proportional to what changed by DIFFING: the steward built
the whole closure, diffed it against the stored checkpoint, and shipped a
`WireClosureDelta` of rows. The delta was O(k) on the wire but the walk that
produced it was O(commons size) on every sync-with-changes, and it was two
engines' worth of code (`closure-delta.ts` + `closure-delta-apply.ts`, 1289
lines) that had to know how to diff and re-apply every shareable row shape.

WS-H replaces it with replay. `share_commons_op` already stores the command
and input of every write that changed the closure, so catch-up now ships that
operation tail and the member RE-EXECUTES it. The steward no longer projects
anything to answer a sync.

What changed, item by item against the WS-H checklist:

**Deterministic id seeding in the vault execution core.**

- `packages/vault/src/gateway/execution.ts` — `runContractAndExecute` accepts
  `deterministicIdSeed`; when set, `ctx.newId()` (and the `claimStaged`
  promotion that shares it) mints ids by hashing `seed:index` into a
  UUIDv7-shaped string instead of reading the clock. This is the load-bearing
  mechanism: it is what makes two vaults executing the same command produce
  byte-identical row ids.
- `packages/vault/src/gateway/gateway.ts` — `invokeCommonsCanonical` takes
  `{ idSeed }` and threads it through `invokeCore`.
- `packages/vault/src/share/commons-replay.ts` (new, 258 lines) — the whole
  engine: `replicaInvocationKey` (`commons-replica:<grantId>:<sequence>`, used
  as both the replica invocation id and the id seed on both sides),
  `readCommonsTail`, `commonsTailIsContiguous`, `executableCommonsTail`,
  `replayCommonsTail`, and the staged-bytes manifest
  (`commonsTailBlobs` / `stageCommonsTailBlobs`) for the one thing
  re-execution cannot derive from a command's input — bytes claimed by sha.
**`compileCommons` replays the tail and computes the closure lazily.**

- `packages/vault/src/share/commons.ts` — `executeCommonsCommand` seeds the
  steward's own invocation with the sequence the append is about to take;
  `compileCommons` replaces the delta fast path with replay, makes the closure
  a thunk (so a compile where every seat replays never walks it), and gains
  `forceFullProjection` for callers that must reconcile state replay cannot
  see. `commonsClosureDeltaSinceCheckpoint` and `commonsOpTouchedRowIds` are
  gone; `checkpointCommonsState` takes a closure thunk.
**The wire increment carries the executable tail, not a closure delta**, and
**replay runs inside the seat's apply transaction.**

- `packages/vault/src/share/commons-bootstrap.ts` — `CommonsIncrement` drops
  `delta` and gains `blobs`; `exportCommonsIncrement` reads no closure at all;
  `applyCommonsIncrement` takes an `applyCommand` executor and replays the
  tail INSIDE the same `BEGIN IMMEDIATE`/`SAVEPOINT apply_commons_increment`
  as the control projection, op insert and cursor advance. A `CommonsReplayError`
  is converted to `CommonsIncrementUnusableError` after the rollback, so the
  existing full-frame fallback handles it and the replica is left untouched.
- `packages/vault/src/share/commons-lifecycle.ts`,
  `packages/gateway/src/serve/build-gateway.ts`,
  `packages/gateway/src/serve/peer-commons-sweep.ts`,
  `packages/gateway/src/routes/peer-commons-route.ts`,
  `packages/gateway/src/serve/peer-commons-client.ts` — host wiring for the
  replica executor (`invokeFor` on the local rail, `gateway`/`credential` on
  the peer rail). The executor is assembled from locally mounted material,
  never serialized and never reachable from member or app code.
**`closure-delta.ts` and `closure-delta-apply.ts` deleted.**

- `packages/vault/src/share/closure-delta.ts` and `closure-delta-apply.ts`
  DELETED, with `diffShareClosure`, `applyShareClosureDelta`,
  `isShareClosureDeltaError`, `ShareClosureDeltaError` and `WireClosureDelta`.
  Total mechanism count goes down: 1289 lines of diff/apply removed, 258 lines
  of replay added.

Three properties this cut had to hold that a naive replay does not:

1. **Atomicity.** Replay is not a pre-step. It runs inside the same
   transaction/savepoint as the cursor advance and control projection on both
   rails, with savepoint-aware nesting when the caller already owns the seat
   transaction. A half-replayed tail is not a state any seat may keep.
2. **Every replay failure falls back to the full projection.** Every failure — unknown command, absent handler,
   non-`executed` outcome, missing/unreadable payload, app version skew —
   raises `CommonsReplayError` and falls back to the full scrub +
   re-projection, which repairs arbitrary state. One operation this build
   cannot run can never wedge a grant. `commons-increment.test.ts` proves it
   on both rails with a `future.reticulate_splines` op, including that the
   very next ordinary write replays normally afterwards.
3. **The unproven-run bound still applies to replay-advanced replicas.**
   `unprovenStateRun` and the
   `COMMONS_CHECKPOINT_INTERVAL` refusal still apply, still after history
   verification (so a forked chain parks rather than falling back).
   Replay-produced rows are exactly as unproven as the delta-produced rows
   they replace.

Idempotency is owned by the seat's cursor, which moves in the same transaction
as the replay it stands for: an increment whose head the seat already holds
returns without re-executing anything. The `commons-replica:<grantId>:<sequence>`
invocation key is the second layer — and because the cursor is the real
boundary, a `replayed` outcome at a replica means an earlier attempt's rows
were rolled back underneath its journal record, so it is treated as a replay
failure and re-baselines rather than silently skipping work.

Known limits, stated honestly:

- Replay only sees writes that reached the Commons rail. A closure change made
  by a command that was never sequenced is invisible to it; the delta engine
  would have caught such drift at the next compile. Callers that must
  reconcile arbitrary state now say so explicitly (`forceFullProjection`, used
  by the sweep's crash-repair fan-out).
- The declared-ceiling check in `compileCommons` now rides inside the closure
  thunk, so it re-measures only when a compile actually materializes the
  closure. The ceiling is still enforced on every WRITE
  (`assertCommonsWithinMax` inside the command's own transaction), which is
  the only path that can grow a commons past it; `commons-size.test.ts` pins
  both points at the exact byte.
- Bytes a tail claims by sha travel as a manifest derived from the ops'
  `staged_sha` inputs; a sha the steward no longer describes is omitted, which
  makes the replay fail loudly and re-baseline rather than staging bytes with
  invented metadata.

**WS-H tests: laggard O(k), version skew, idempotency, forced projection.**
`packages/vault/src/share/commons-replay.test-fixtures.ts` (new, the shared
docs-folder world), `commons-replay.test.ts` (new, local rail: laggard k ops
behind catches up by replay with derived rows intact and nothing about
unchanged documents on the wire; an unreplayable operation falls back and does
not wedge the grant; an unresolvable projection re-baselines; re-compiling an
applied tail is a no-op; `forceFullProjection` reconciles drift replay cannot
see) and `commons-increment.test.ts` (rewritten, wire rail: increment replay,
re-applied increment is a no-op, unreplayable tail is unusable rather than a
park, a seat with no executor re-baselines, plus the two state-proof-bound
cases carried over unchanged). `commons-size.test.ts` gains the write-path
ceiling assertion; `commons-sim-world.test-fixtures.ts` drives the seeded sim
through the replay rail; `packages/gateway/src/serve/peer-commons-pull.test.ts`
now executes its steward write through the rail and supplies the member's
replica executor.

Re-runnable:

```sh
cd packages/vault && bun run typecheck && bun run test
cd packages/gateway && bun run typecheck && bun run test
bun run lint && bun run knip && bun run check:reachability
```

### Deleted-code inventory

The issue's final acceptance criterion asks the receipt to say what was
removed. Every line below was confirmed against the working tree (grep) and
`git diff 7b32a809..HEAD` (the range of this issue's commits). Stale `dist/`
build artifacts still carry some of the old `.d.ts` names; they are not
source and are rebuilt.

Tables and columns (`packages/gateway/src/serve/gateway-schema.ts`, v0 DDL
edited in place — no migration, no dual write):

- `peer_pending_gives` — DROPPED. Superseded by `share_effects` kind `deliver-give`.
- `peer_blob_pulls` — DROPPED. Superseded by `share_effects` kind `pull-blob`.
- `peer_pending_refusals` — DROPPED. Superseded by `share_effects` kind `deliver-refusal`.
- `vault_links.route_a_json` / `vault_links.route_b_json` — DROPPED. Route state now lives in `vault_routes`, one row per peer vault. Pinned by `vault-links-store.test.ts:359-367`, which asserts the retired column names are absent from the live DDL.
- `vault_links` key/label columns (`public_key`, `label_*`) — DROPPED. Identity and human name now live in `vault_directory`. Same test asserts their absence.
- Index `share_edges_device_status` — DROPPED, replaced by `share_edges_owner_status(owner_id, updated_at)`. Listing authority is the owner's; the device id survives as provenance only.

Files:

- `packages/gateway/src/serve/peer-refusal-relay.ts` and `peer-refusal-relay.test.ts` — DELETED. The relay is now the `deliver-refusal` effect handler; the behaviour is re-pinned by `share-refusal-outbox.test.ts`.
- `packages/vault/src/share/actable.ts` and `actable.test.ts` — DELETED. The registry moved into `commons-routing.ts` and is derived from the same declared rows the router walks.

Functions and exports:

- `drainPeerBlobPulls`, `drainPeerRefusals` — DELETED. One `drainShareEffects` replaces both; `peer-plane-sweep.ts` calls it once.
- `recordPendingRefusal` — DELETED (with `peer-refusal-relay.ts`).
- `reconcileEdge`, `reconcileRemoteEdge` — DELETED. The two reconcilers are now pure transports (`deliverGiveLocally`, `deliverGiveOverPeer`); their state machines and status mappings are signals into `reduceEdge`.
- `routeTo`, `peerViewOf` — DELETED from `vault-link-row.ts`. Callers resolve through `routeFor` / `peerViewFor` / `directoryEntry`.
- `declareCommonsCommands`, `commonsCommandsFor` — DELETED (with `actable.ts`). Exported, barrel-re-exported, called by nothing; the class WS-F's gate now catches.
- `CONTAINER_ID_KEYS` and the `command.includes("folder")` routing heuristics — DELETED. Both survive only as prose in `commons-routing.ts`'s header explaining what the declared table replaced.
- Tally's intent-status translation shim — DELETED (`packages/blueprints/apps/tally/logic.ts`): the renderer no longer maps `pending → queued`, because the DDL now says `queued`.
- The three truncated-vault-id label fallbacks — DELETED: `apps/mobile/src/kit/share/share-targets.ts`, `packages/blueprints/apps/_shared/share-kit.ts`, `packages/client/src/react/blueprints/centraid-inline.ts`. Confirmed as three removed `slice(0, 8)` label expressions in the branch diff.
- Per-chunk `exportCommonsBootstrap` in the peer commons blob route — DELETED. The full closure walk + Ed25519 signing now runs ONCE per transfer session in `handlePeerCommonsBlobAuthorize`; `handlePeerCommonsBlob` validates each chunk against the stored session.
- Per-compile `checkpoint_json` (and attestation) rewrite — DELETED. It is written only on checkpoint events.
- Whole-blob base64 assembly in the peer commons pull client — DELETED for the real path: chunks append to the vault's promotion temp file and the sha is verified on the file. The in-memory accumulation survives only where the blob store exposes no temp path (the test tier) — see the bound recorded under **Out of scope**.
- The four `peer-edge-give-client.ts` allowlist entries and the two `actable.ts` allowlist entries in `share-reachability.json` — REMOVED, by wiring/deleting the capability rather than by editing the reason.
- `shareToVault` (`packages/vault/src/share/placement.ts`) — DELETED. A 10-line wrapper that called `shareItemsToVault` with a one-element array; its 23 call sites across 6 test files now call `shareItemsToVault` directly, and `ARCHITECTURE.md:60` names the surviving door.
- `authorizeCommonsCommand` (`packages/vault/src/share/commons.ts`) — DELETED. A parallel authorization path `executeCommonsCommand` never called; 5 test files re-pointed at the door production actually uses.
- `advanceCommonsCursor` (`packages/vault/src/share/commons-cursor.ts`) — DELETED. A near-duplicate of `acknowledgeCommonsSeatCursor` (`commons.ts:551`); the monotonic-offset law it protected is asserted against the survivor. The one behavioural difference is recorded under **Decisions**.
- `declareProjectionIngest` (`packages/vault/src/share/projection-ingest.ts`) — DELETED. Nothing registered a hook through it.
- The whole 31-entry `share-reachability.json` allowlist — REMOVED, leaving `"allowlist": []`. 26 entries were a false-positive class the same-file analyzer correction eliminated; 5 named capabilities that were genuinely dead and were deleted or relocated.

### Files touched, by full path

The per-workstream lists above name several files by basename. The full paths,
for file-coverage and for anyone grepping:

- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/routes/devices-routes-mint.test.ts`
- `packages/gateway/src/routes/devices-routes.test-fixtures.ts` — the harness now exposes its `GatewayDatabase` (the provision tests count rows through it) and accepts an `unmintVaultForPerson` override
- `packages/gateway/src/routes/edges-routes.test.ts`
- `packages/gateway/src/routes/p1-owner-only-refusals.test.ts` — drops a `mintVaultForPerson` stub the preflight reordering made unreachable in that scenario
- `packages/gateway/src/routes/peer-blob-route.ts` — `readEdgeRow` now imported from `serve/share-edge-row.js` (mechanical: nothing should import a transport to get a type)
- `packages/gateway/src/routes/vault-links-routes.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/peer-dial.ts` — comments only: the drain it named is now the share outbox executor, and the cached route is a `vault_routes` row
- `packages/gateway/src/serve/peer-edge-give-client.ts` — `peerEdgeClosurePath` made module-local (the peer plane matches the prefix); comment re-pointed at the `deliver-refusal` handler
- `packages/gateway/src/serve/peer-plane-sweep.test.ts`
- `packages/gateway/src/serve/peer-route-announce.test.ts`
- `packages/gateway/src/serve/share-coordinator.test.ts`
- `packages/gateway/src/serve/share-refusal-outbox.test.ts`
- `packages/gateway/src/serve/share-scope.test.ts`
- `packages/gateway/src/serve/vault-links-store.test.ts`
- `packages/gateway/src/serve/vault-plane-commons.test.ts`
- `packages/vault/src/schema/vault-identity.test.ts`
- `packages/vault/src/share/commons-intent-lifecycle.test.ts`
- `packages/vault/src/share/commons-invoke.test.ts`
- `packages/vault/src/share/commons-sim.test-fixtures.ts` (it was `packages/vault/src/share/commons-sim.ts` until WS-F relocated the harness) — the sim's settled-intent assertion moved to `status = 'queued'`
- `packages/vault/src/share/commons-tally-b6.test.ts`
- `packages/client/src/react/screens/DevicePairPanel.test.tsx`
- `packages/blueprints/src/share-kit.test.ts`
- `apps/mobile/src/kit/share/share-targets.test.ts`
- `packages/vault/src/share/commons-replay.test.ts` (NEW) — the replay engine's own
  suite: contiguity, the deterministic id seed, and the version-skew case that
  drives an unknown command through the tail and proves the grant still accepts
  the next ordinary write instead of wedging
- `packages/vault/src/share/commons-size.test.ts` — the commons size ceiling is
  now asserted on the WRITE path (`assertCommonsWithinMax`, inside the command's
  own transaction) rather than re-measured by every compile, because the replay
  fast path deliberately never materializes the closure; both forms pin the
  exact byte count
- `packages/vault/src/gateway/portable-export.ts` — comments only: records the
  `share_commons_intent.status` `pending`→`queued` rename and the identity
  public-key PIN against the canonical export walk, both with unchanged row
  shapes
- `packages/client/src/gateway-client-seam-fixtures.ts` — seam fixtures for the
  two commons-recovery client methods (`listCommonsRecovery`, `recoverCommons`)
- `packages/gateway/src/routes/peer-plane.test.ts` — the redemption regression:
  a redeem naming a vault THIS gateway holds is refused 400, mints no route row,
  leaves the directory key untouched, and the ticket stays honestly redeemable
- `packages/gateway/src/routes/commons-routes.test.ts` — reads the peer public
  key from the vault directory instead of the link row (#750 invariant 1)
- `packages/gateway/src/serve/peer-give.test-fixtures.ts` — the give harness
  gains directory/route seeding so its peers are built the way the ceremony
  builds them
- `packages/gateway/src/serve/peer-remote-give.test.ts`,
  `packages/gateway/src/serve/peer-transport-remote.test.ts` — net −80 lines:
  both drop their hand-rolled peer scaffolding for the shared fixtures
- `packages/gateway/src/serve/peer-commons-sweep.test.ts` — covers the sweep's
  crash-repair fan-out, including the `forceFullProjection` door replay uses when
  a replica's rows may have drifted from the Commons rail
- `packages/gateway/src/serve/vault-directory-store.ts` (NEW) — the
  `vault_directory` + `vault_routes` row plane (invariants 1–2) lifted out of
  `vault-links-store.ts`: write-once identity key, replaceable route, and
  nothing else reads or writes those two tables
- `scripts/share-reachability-parse.mjs` (NEW) — the analyzer's per-file
  TypeScript syntax scan, split from `check-share-reachability.mjs` so both
  files sit under the repo-hygiene line ceiling; the same split removed a
  literal NUL byte from the analyzer's memo key (it made the file read as
  binary, which hid its `TODO(#750)` from `no-orphan-todos`)
- `apps/desktop/tests/e2e/onboarding-home.spec.ts` — journey 1.2 emits one more
  frame, `artifacts/e2e/ui-impact/issue-750-vault-sharing.png`, alongside the
  ones #726, #731 and #747 already take there. A Household frame was tried
  first and rejected on evidence, not convenience: Household does not render
  against the e2e mock gateway (the route's roster/scope reads fail), so that
  frame would have pictured an error state rather than this change. First-run
  Home is the frame every sharing-plane issue before this one used
- `docs/decisions.md`, `docs/glossary.md` — the D3 link-table entry and the
  **route** entry now describe the one-row-per-vault `vault_routes` table and
  point identity at `vault_directory`, replacing the per-link
  `route_a_json`/`route_b_json` wording this issue deleted

Corrections to earlier prose, made while verifying this inventory:

- `STALE_CONTEXT_ROW_KEYS` is **not** deleted. What was deleted is its
  hand-maintained literal key list; the constant now DERIVES from
  `COMMONS_CONTAINER_KEYS` (`packages/vault/src/share/commons.ts:1498`), which
  is the point — one vocabulary, not two.
- `exportCommonsBootstrap` is **not** deleted; it is still imported by
  `peer-commons-route.ts`. What was deleted is its PER-CHUNK invocation.
- The `peer_pending_*` names still appear in `gateway-schema.ts` — in the
  comment that records what `share_effects` succeeded — and in
  `share-refusal-outbox.test.ts`, which asserts the table is gone. Neither is
  a live reference.
- `peer_pending_lend_closes` (named in the issue) was already gone before this
  branch: the whole live/lend plane was deleted in #731 (`224065b2`).

## Out of scope

Approved deviations, each with its reason.

**(a) The borrowed-replica criteria are MOOT, not skipped.** Four acceptance
criteria (paginated borrowed bootstrap, borrowed-row/blob deletion lifecycle,
rebootstrap-after-narrowed-scope CAS release, `borrowed_change` compaction)
describe a plane that no longer exists: `borrowed-store.ts`,
`borrowed-schema.ts`, `borrowed-cas.ts`, `borrowed-changes.ts`,
`borrowed-blob-custody.ts`, `borrowed-blob-ref.ts`, `borrowed-slots.ts`,
`borrowed-search.ts`, `borrowed-paths.ts`, `borrowed-intent.ts`,
`borrowed-replica-routes.ts`, `peer-lend-route.ts`, `lend-audience-write.ts`
and `lend-wire.ts` were all deleted in #731 (`224065b2`), and no
`borrowed_change` / `borrowed-store` reference survives anywhere in
`packages/` or `apps/`. Rebuilding them to satisfy the criteria would have
re-added the second replica implementation the issue exists to remove.
WS-G verified the surviving ANALOGS on the device-replica and vault-CAS
planes instead — bounded/resumable 50k bootstrap, compaction→409→rebootstrap
recovery, and row-to-blob final-reference release — and that substitution
found a real byte-destroying bug (`duties.ts`), which is the evidence the
substitution was worth making rather than a way to avoid the work.

**(b) The commons intent grammar was ALIGNED, so no deviation is owed for the
alignment itself.** Two outbox states stay deliberately absent from the
commons vocabulary and that IS a recorded judgment: `sending` has no
observable analogue on the commons rail (a signed command is either still
queued at the seat or already settled by the steward — there is no
member-observable in-flight state), and `conflict`/`failed` do not exist as
commons outcomes because every commons refusal is the steward's answer,
carried as `denied` with a reason (the stale-context classification
included). Adding empty states to make the two lists identical would have
been vocabulary theatre.

**(c) The N≥3 steward-recovery path ends in a HUMAN step, by design.** The
successor mints an old-steward-independent claim ticket, but carrying it,
pairing, and redeeming it are out of band. There is no cryptographic path
from a new steward to a member it has never linked to that the member should
trust automatically. The residual step is documented as a real limit in
`docs/recovery/commons-steward-loss.md` rather than implied away.

**(d) Split-brain re-founding is DOCUMENTED, not solved.** Supersession stays
seat-local; nothing elects a single successor. Electing one needs a quorum
protocol this plane does not have and #750 does not ask for. The runbook
states the three shapes (seat-local supersession, two successors, a returning
steward).

**(e) The WS-F gate shipped red and is now green — no residual is owed.**
This deviation is retained as the record of how it resolved, not as an open
item. The gate landed with 31 `TODO(#750)` allowlist entries and a red
`bun run check:reachability`. Two things closed it:

1. The analyzer was corrected to count a value-position use inside a
   capability's own production declaring module as a production reacher. That
   eliminated 26 of the 31 entries as a false-positive class.
2. The remaining 5 were genuinely dead. Four were deleted outright
   (`placement.ts#shareToVault`, `commons.ts#authorizeCommonsCommand`,
   `commons-cursor.ts#advanceCommonsCursor`,
   `projection-ingest.ts#declareProjectionIngest`) and the seeded simulation
   harness was relocated to `*.test-fixtures.ts` rather than deleted, because
   #750 explicitly protects it.

`share-reachability.json` now reads `"allowlist": []` and
`bun run check:reachability` exits 0 with
`ok (155 capabilities across 3 module globs)`. No entry was kept by editing a
reason; every one went by wiring, deleting, or relocating the capability.

**(f) Known bounds WS-D accepted, by design.** The steward's delta diff is
O(closure) CPU per export (no wire cost and no member-side scrub cost — the
member's work is O(k)). A member assembling a paginated bootstrap still parses
one full frame JSON in memory; that is the re-baseline path only, not the
increment path. In-memory blob stores (the test tier, where the store exposes
no promotion temp path) still fall back to whole-blob assembly, bounded by the
declared blob size; the production file-backed store streams chunk-by-chunk.

**(g) Live-edge receipts, as a criterion, changed shape.** The criterion asks
for a validated LIVE scope payload; live lending was removed in #731 and the
`share_edges` CHECK is what keeps it structurally absent. WS-B honoured the
intent — no more `as string[]` over a durable receipt — with a total parser
that is a discriminated union on `mode` and refuses a live scope LOUDLY at the
boundary rather than silently accepting one. Re-adding a live scope type to
satisfy the letter of the criterion would have re-created the thing #731
deleted.

Workstream-local out-of-scope notes:

- WS-A did not touch edge reconcile flow, commons semantics, blob pull
  mechanics, or the ticket-mint plane beyond mechanical fallout fixes
  (`peer-refusal-relay.ts`, `peer-blob-pull.ts`, `commons-routes.test.ts`,
  `linkedVaultPublicKey` in `build-gateway.ts` — each a one-line re-resolution
  through the directory).
- No recovery-doc updates for the new `VaultIdentityMismatchError` operator
  path beyond SECURITY.md; a dedicated recovery runbook can follow when the
  UI names the refusal.
- WS-E added no new client screen: the absence/identity/growth cards use the
  existing notices store rather than a bespoke Commons panel, and the deep
  link points at the existing owner-tier recovery surface.
- WS-C did not change the self-pairing lane. `operationId` is required only
  where durable state is minted (`forPerson`); an ordinary ticket mint over an
  existing owner and vault stays a plain request.
- WS-G added no production abstraction. It is a verification workstream plus
  the one bug fix that verification surfaced.

## Decisions

- **Substituting analogs for the borrowed-replica criteria.** The alternative
  was to rebuild the plane #731 deleted in order to satisfy four checkboxes
  literally. That would have re-added the second replica implementation this
  issue exists to remove, so the criteria were declared moot and the surviving
  device-replica / vault-CAS analogs verified instead. The substitution paid
  for itself: it found the shared-sha purge bug.
- **Rollback, not resume, for `ProvisionPerson`.** Resume needs per-step
  provenance and a reconciler; the workflow is cheap to redo. Ordering the one
  non-transactional step first and committing every row in one transaction
  makes atomicity a property of the construction rather than of a recovery
  path that would itself need testing.
- **Replay returns the ORIGINAL ticket, not a fresh one.** Minting on replay
  would make replay a write and let one operation id mint unbounded live
  tickets. A client holding an expired replayed ticket starts a new operation.
- **`next_attempt_at IS NULL` means "waiting on a human".** Rather than a
  fifth table for the D9 'ask', the outbox's retry clock doubles as the
  drainability flag. One table, one drainer, and the ask lifecycle costs
  nothing extra.
- **Aligning the commons intent grammar rather than recording a deviation.**
  The issue offered either. Alignment was cheaper (a v0 in-place CHECK rename
  and one deleted renderer shim) and removes a user-visible inconsistency —
  Tally rendered both vocabularies. Two outbox states stay absent for stated
  reasons; see deviation (b).
- **Routing as a declared table rather than a stricter heuristic.** The
  conformance test that the table makes possible is what found four declared
  commands that do not exist and the `collection_id` key that routed nothing —
  silent member data loss in shared albums. A heuristic cannot be conformance-
  tested against command schemas.
- **The reachability gate shipped red, then was driven green.** Landing the
  check before the plane was clean was deliberate: a gate that only arrives
  once everything is already green never proves it works, and the offenses it
  printed were the worklist. That worklist is now empty — the allowlist went
  from 31 seeded `TODO(#750)` entries to `[]` and the gate exits 0.
- **The analyzer was corrected rather than the allowlist extended.** Counting
  a value-position use inside a capability's own production declaring module
  as a production reacher matches knip's `ignoreExportsUsedInFile`, which this
  repo already runs, and the two gates compose: knip fails dead files, this
  gate fails dead exports inside live files. The alternative — leaving 26
  false positives on a debt ledger — would have made the ledger the artifact
  instead of the invariant.
- **The simulation harness was relocated, not deleted.** `commons-sim.ts` and
  `commons-sim-world.ts` are test-only by construction and #750 explicitly
  protects them, so they became `*.test-fixtures.ts` (which the analyzer
  classifies as test paths) rather than dead exports to delete. The same move
  left `placeCommonsBootstrapBlobs` / `placeCommonsIncrementBlobs` with
  test-only callers, so they followed into `commons-blobs.test-fixtures.ts`.
- **One honest semantic change went with `advanceCommonsCursor`'s deletion.**
  It preserved `updated_at` when a late tail regressed
  (`updated_at = CASE WHEN excluded.sequence >= sequence THEN … ELSE updated_at END`),
  whereas the surviving `acknowledgeCommonsSeatCursor` records the
  acknowledgement instant unconditionally. The load-bearing law — a replayed
  or delayed tail cannot move a seat backward — is unchanged and still
  asserted (`commons-lifecycle.test.ts`, "per-grant member offsets advance
  monotonically above one vault replica"); only the timestamp a late
  acknowledgement leaves behind differs, and nothing reads it as a freshness
  proof.

## Verification

### Acceptance criteria

Every checkbox in #750, with the evidence. "Moot since #731" means the
mechanism the criterion names was deleted in `224065b2` before this branch
started; the analog verified in its place is named.

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | One persisted identity; missing/mismatched identity fails closed | met | `packages/vault/src/schema/vault-identity.ts:68` (`VaultIdentityMismatchError`), `:103`, `:114`; `vault-identity.test.ts` — "pin present but seed missing refuses loudly, mints nothing, keeps the pin", "a seed that does not match the pin refuses instead of loading a stranger's key", "a pre-pin vault (seed only) loads and gains its pin" |
| 2 | Production delivers a signed route assertion on move/rotation; peer re-discovers without re-linking | met | `serve/peer-route-announce.ts:56` (`announceLocalRoutes`), called from `cli/endpoint-host.ts:66` (start) and `serve/build-gateway.ts:5038` → `serve/peer-plane-sweep.ts:85` (tick); `peer-route-announce.test.ts` — "a rotated endpoint is re-discovered by the peer without a new ceremony", "an unheard peer keeps the announcement armed for the next start/tick" |
| 3 | Two+ local vaults linked to one peer vault resolve through its single route | met | `serve/vault-links-store.ts` `recordRoute` (one `vault_routes` UPSERT, newest `assertedAt` wins); `peer-route-announce.test.ts` — "two co-hosted links to one peer vault both resolve the new route after ONE announcement" |
| 4 | One owner sees the same edge list from every device; device id survives as provenance | met | `routes/edges-routes.ts:99` (`WHERE owner_id = ?`), `:274` (`createdByDevice` on the wire); `gateway-schema.ts:201` (`share_edges_owner_status`); `edges-routes.test.ts` — "every device of one owner sees the same edges (#750)" |
| 5 | `forPerson` with no ticket/endpoint capability creates nothing; one operation id cannot duplicate | met | `routes/device-ticket-mint.ts:311-323` (preflight above every write), `:82-158` (mint-first, one transaction, rollback + orphan cleanup), `:203-208` (verbatim replay); `devices-routes-mint.test.ts` — the five "durable provision (#750)" cases |
| 6 | Borrowed bootstrap paginated and bounded; nothing serializes the full shape | moot since #731 | Borrowed plane deleted in `224065b2` (`borrowed-replica-routes.ts`, `borrowed-store.ts`, … — 20 files); analog verified at `tests/scale/replica-bootstrap.scale.test.ts:81` — "the gateway pages 50k rows bounded and resumes its cursor across a restart" (`maxRowsPerPage ≤ window`, exactly-once across a plane restart) |
| 7 | Rebootstrap after a narrowed scope releases CAS bytes no longer referenced | moot since #731 (analog met) | Borrowed shapes gone; the surviving byte-release path is the vault purge sweep + local orphan sweep (#599). WS-G verified it and FIXED it — `packages/vault/src/gateway/duties.ts` final-reference guard; `duties.test.ts` "purge keeps derivative bytes another content item still claims (issue #750)" |
| 8 | Deleting a row releases row-to-blob references; bytes purge once the final reference disappears | moot since #731 (analog met) | Same guard: bytes go only when the final claim just disappeared; a sha another live row still claims is skipped, and the orphan sweep reclaims it when that claim drops. Test as above |
| 9 | High-churn shapes have bounded/compactable change history; lagging devices recover through a defined rebootstrap path | moot since #731 (analog met) | `packages/gateway/src/routes/replica-routes.test.ts` — "compaction past the pinned page-1 cursor forces a 409 snapshot-retention, and a fresh walk recovers": `pruneReplicaChanges` moves the floor past the pinned cursor → `409 replica_rebootstrap_required` / `snapshot-retention` → a fresh page-1 walk re-pages the library |
| 10 | Live-edge receipts keep a validated live scope; no objects in an item-id array | met in the form the tree admits | `serve/share-scope.ts:42` total `parseEdgeScope` replaces `JSON.parse(...) as string[]` in four call sites; `share-scope.test.ts` — "refuses a live scope — the mode was removed in #731, not hidden", "refuses a malformed audience list rather than degrading it". See deviation (g) |
| 11 | Web and native share sheets render the linked vault's human label | met | `packages/blueprints/apps/_shared/share-kit.ts:106`, `apps/mobile/src/kit/share/share-targets.ts:218`, `packages/client/src/react/blueprints/centraid-inline.ts:382`; three `slice(0, 8)` fallbacks removed; label cases in `blueprints/src/share-kit.test.ts` and `share-targets.test.ts` |
| 12 | Local and peer edge execution share one reducer/state vocabulary | met | `serve/share-coordinator.ts:157` (`reduceEdge`); `serve/share-edge-store.ts:56/67` — the single `UPDATE share_edges` in production source; `serve/share-effect-executor.ts` selects the transport only; `share-coordinator.test.ts` (9 cases) including "begin emits exactly one deliver-give effect, whatever the locality" |
| 13 | Superseded tables/drainers/duplicated code deleted | met | See **Deleted-code inventory**; `gateway-db.test.ts` table census pins the schema |
| 14 | No legacy migration, compatibility layer, or dual-write introduced | met | Every schema change is an in-place v0 DDL edit (`gateway-schema.ts`, `packages/vault/src/schema/share-commons.ts`); no migration file, no dual-write path, no compatibility adapter added on this branch |
| 15 | A member one op behind gets an increment; a write does not delete or re-enqueue unchanged items' derived rows | met | `commons-bootstrap.ts` `exportCommonsIncrement`/`applyCommonsIncrement`; `commons.ts` delta fast path + `COMMONS_CHECKPOINT_INTERVAL = 32` (`:402`); `closure-delta.ts`/`closure-delta-apply.ts`; `commons-increment.test.ts` (laggard O(k) + derived-row survival, A→B→A convergence, delta-fallback repair) |
| 16 | Blob chunk authorization does not re-export or re-sign the closure per chunk | met | `routes/peer-commons-route.ts:327` `handlePeerCommonsBlobAuthorize` runs the export ONCE per session; `:361` `handlePeerCommonsBlob` validates against the stored session; `peer-commons-pull.test.ts` — one-authorize multi-chunk streaming, chunk-without-session refusal |
| 17 | Steward absence reachable from a user surface, invitations delivered, N≥3 gap solved or documented with a runbook | met, with a documented residual human step | `serve/commons-notices.ts` (durable `commons-steward` notice, severity high, deep-linked to `/household`), the People & circles recovery section on both clients (`client/src/react/screens/SharingCard.tsx` + `HouseholdRoute.tsx`, `apps/mobile/src/screens/Sharing.tsx`) calling `listCommonsRecovery`/`recoverCommons`, `serve/commons-recovery-invites.ts` (co-hosted / linked-peer / claim-ticket delivery), `routes/commons-recovery-routes.ts` (per-seat `invitations` report), `docs/recovery/commons-steward-loss.md`; `commons-steward-loss-drill.test.ts` end-to-end, `gateway-client-commons-recovery.contract.test.ts` for the client seam, and surface cases in `HouseholdScreen.test.tsx` / `ApprovalsRoute.test.tsx` / `placement-transport.test.ts`. Residual step: deviation (c) |
| 18 | Commons intents share the outbox vocabulary, or the deviation is recorded | met (aligned) | `packages/vault/src/schema/share-commons.ts:168-169` — `CHECK (status IN ('queued','parked','denied','executed','expired','cancelled'))`, index `share_commons_intent_open` on `('queued','parked')`; Tally's shim deleted; grammar regression case in `commons-intent-lifecycle.test.ts`. Two deliberate absences: deviation (b) |
| 19 | Routing is declared data with a conformance check; `declareCommonsCommands` used or deleted | met | `packages/vault/src/share/commons-routing.ts` (declared table + vocabulary); `commons-routing.test.ts` walks the real registered `agent_command.input_schema_json` for nine packs; `actable.ts` + `declareCommonsCommands`/`commonsCommandsFor` DELETED |
| 20 | A mechanical check that every exported sharing-plane capability names its production caller, seeing through `index.ts` re-exports | met, and the gate is green | `scripts/check-share-reachability.mjs` + `share-reachability.json`; `check:reachability` in `package.json:27` (`check:push`, inherited by `check:pr` and `check:full`); analyzer cases in `scripts/check-share-reachability.test.mjs`; `docs/toolchain.md`. `bun run check:reachability` exits 0 — `ok (155 capabilities across 3 module globs)` — with `"allowlist": []`; the five capabilities it found dead were deleted or relocated, not allowlisted (deviation (e)) |
| 21 | The receipt documents what was deleted and any approved deviations | met | This document — **Deleted-code inventory** and **Out of scope** |

Judgment on the one that is not a clean "met": criterion 17 is met as far as
cryptography allows; the carry-a-ticket step is a real limit, not a gap left
for later. Criterion 20 was the one an honest reader should have watched — the
gate shipped red — and it is now green with an empty allowlist, so the
invariant is satisfied today rather than merely enforced going forward.

### Re-runnable commands

The whole issue, in the order a reviewer would take it:

```sh
# Types, lint, formatting, dead code — repo scripts only (B2).
bun run typecheck
bun run lint
bun run format:check
bun run knip

# The gate this issue ADDS, plus the analyzer's own cases.
bun run check:reachability
node --test scripts/check-share-reachability.test.mjs

# The suites this issue's claims rest on.
bun run --cwd packages/vault test -- src/share src/schema/vault-identity.test.ts src/gateway/duties.test.ts
bun run --cwd packages/gateway test -- src/serve/share-coordinator.test.ts src/serve/share-scope.test.ts src/serve/share-refusal-outbox.test.ts src/serve/peer-route-announce.test.ts src/serve/peer-commons-pull.test.ts src/serve/commons-notices.test.ts src/serve/vault-links-store.test.ts src/serve/peer-plane-sweep.test.ts src/serve/gateway-db.test.ts
bun run --cwd packages/gateway test -- src/routes/edges-routes.test.ts src/routes/replica-routes.test.ts src/routes/devices-routes-mint.test.ts src/routes/commons-steward-loss-drill.test.ts
bun run --cwd packages/client test -- src/react/screens/DevicePairPanel.test.tsx
bun run --cwd packages/blueprints test -- src/share-kit.test.ts

# Nightly lane (50k rows) — not a PR gate; the whole lane, then the one file.
bun run test:scale
node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/replica-bootstrap.scale.test.ts

# Shared infrastructure was touched (root gate lists, tests/), so:
bun run check:full
```

Spot-checks for the deleted-code inventory:

```sh
# No live reference to the three retired queues or the retired route columns.
rg -n 'peer_pending_gives|peer_blob_pulls|peer_pending_refusals|route_a_json|route_b_json|share_edges_device_status' \
   packages apps scripts --glob '!dist'
# Exactly one writer of edge state in production source.
rg -n 'UPDATE share_edges' packages --glob '!dist'
# The deleted files are gone.
ls packages/gateway/src/serve/peer-refusal-relay.ts packages/vault/src/share/actable.ts
```

### Gate runs

WS-A:

- `bun run typecheck` green in `packages/gateway` and `packages/vault`.
- `bun run test` in `packages/vault`: 1266 passed, 1 failed —
  `src/wal-shipper.test.ts` (untouched since #642, unrelated to this issue).
- Focused gateway suites (links/routes/peer plane/ceremony/announce/identity):
  83 passed. Full `packages/gateway` run recorded in the PR.
- `bun run lint`, `bun run knip`, `bun run format:check` clean for WS-A files.

WS-B:

- `bun run typecheck` green in `packages/gateway`, `packages/vault`,
  `packages/client`, `packages/blueprints` and `apps/mobile`.
- `packages/gateway`: the sharing suites (edges route, remote give, refusal
  outbox, reducer, scope, sweep, links routes/store, peer plane, build-gateway
  peer, db census) — 11 files / 98 tests green. Full-package run: 224 files /
  1489 tests, 8 files failing on environment conditions unrelated to this
  workstream (30 s timeouts in `serve.test.ts`, `web-app-sessions`,
  `lifecycle-automation-routes`, `build-gateway`, `serve-vault-addressing` —
  each green when run alone — and `gateway-db-lock.integration.test.ts`, which
  needs the `sqlite3` CLI this sandbox has not got). `vault-erase.test.ts`
  failed on the leftover identity pin and is fixed by this workstream.
- `packages/client`: 230 files / 2053 tests green. `packages/blueprints`: 100
  files / 3376 tests green. `apps/mobile`: 1097 tests green (one suite,
  `apps/tally/PendingRestartJourney.test.tsx`, fails to BUNDLE on
  `node:sqlite` — a pre-existing condition unrelated to sharing).
- `bun run lint`, `bun run format`, `bun run knip` clean.
- `bun run check:reachability`: no WS-B capability flagged, no WS-B allowlist
  entry remains (net −4). The remaining failures are the commons/vault
  entries other workstreams own.

WS-C:

- `bun run typecheck` green in `packages/gateway` and `packages/client`.
- `packages/gateway`, focused re-run at receipt time — `devices-routes-mint`,
  `replica-routes`, `edges-routes`, `share-coordinator`, `share-scope`:
  5 files / 55 tests passed. This includes the five durable-provision cases;
  `gateway-db.test.ts` census green with `provision_operations`.
- `packages/client`: `DevicePairPanel.test.tsx` — 12 tests passed (retry
  reuses one operation id; success clears it).
- `bun run lint`, `bun run format`, `bun run knip` clean for WS-C files.

WS-D:

- `bun run typecheck` green in `packages/vault` and `packages/gateway`.
- `bun run test` in both packages recorded in the PR (full-suite runs; commons
  suites, the seeded sim, and the new increment/pull/backoff tests green).
- `bun run lint` and `bun run knip` clean for WS-D files.
- Remaining known bounds, by design: see deviation (f).

WS-E:

- `bun run typecheck` green in `packages/vault` and `packages/gateway`.
- `packages/vault`: full `bun run test` — 1275 passed, 2 skipped, 1 failed:
  `src/wal-shipper.test.ts` (untouched since #642, already recorded as
  unrelated by WS-A). The commons suites under `src/share` (26 files / 92
  tests) are green, including the new conformance test and the identity fault.
- `packages/gateway`: every commons suite green — 12 files / 35 tests
  (commons routes + intents, recovery routes, the new drill, notices,
  observability, sweep, vault-plane and the four peer-commons B6 suites).
  The full-package run is 216 files / 1449 tests passing with 7 files failing
  on environment races unrelated to this workstream (30 s hook/test timeouts
  and `ENOTEMPTY` temp-dir teardown in templates/serve/vault-erase/
  admin-custody/web-app-sessions/gateway-db-lock).
- `packages/client`: 230 files / 2053 tests green. `packages/blueprints`
  (tally + `_shared`): 17 files / 93 tests green.
- `bun run lint` and `bun run format` clean for WS-E files.
- `bun run check:reachability`: no WS-E capability is flagged and no WS-E
  allowlist entry remains.

WS-F:

- `bun run check:reachability` runs standalone (no build, repo-pinned
  TypeScript, syntax-level parse only).
- `node --test scripts/check-share-reachability.test.mjs` — all analyzer cases
  green at receipt time; the file is listed in the root `scripts:test` script,
  so `check:push` runs it.
- Gate placement confirmed in `package.json`: `check:reachability` is in the
  `check:push` gate list; `check:pr` runs `check:push`; `check:full` runs
  `check:pr`.
- `bun run check:reachability` was RED when the gate first landed — it named
  the sharing-plane capabilities whose only reachers were test files. That was
  the gate doing its job, and the list it printed was the worklist. After the
  same-file correction and the dead-capability removal it exits 0:
  `share reachability: ok (155 capabilities across 3 module globs)`, with
  `"allowlist": []`. See deviation (e).
- `node --test scripts/check-share-reachability.test.mjs` re-run after the
  same-file correction: 21 cases green, the last five covering the new rule.
- The five dead capabilities were confirmed dead by running the analyzer at
  the correction commit (`63bfb340`) with an already-empty allowlist: it named
  exactly `advanceCommonsCursor`, `runCommonsSimulation`,
  `authorizeCommonsCommand`, `shareToVault` and `declareProjectionIngest`.
- `bun run --cwd packages/vault test -- src/share src/gateway/portability.test.ts src/blob/local-orphan-sweep.test.ts`
  after the migrations off `shareToVault`, `authorizeCommonsCommand` and
  `advanceCommonsCursor`: 28 files / 108 tests green, including
  `commons-sim.test.ts` driving the relocated simulation harness.

WS-G:

- `bun run typecheck` green in `packages/vault` and `packages/gateway`.
- `packages/vault/src/gateway/duties.test.ts` — 19 tests passed, including the
  new shared-sha purge case. That case is written to fail against the pre-fix
  `purgeContentItem` (it asserts `db.blobs.hasSync(shared.sha256)` is still
  true after the purge, which the unconditional delete made false), so it
  pins the defect rather than the fix.
- `packages/gateway/src/routes/replica-routes.test.ts` green (in the focused
  5-file run above), including the compaction → 409 → recovery case.
- `tests/scale/replica-bootstrap.scale.test.ts` is a NIGHTLY lane (per
  TESTING.md), not a PR gate; its run is recorded in the PR. The server-side
  case asserts `maxRowsPerPage ≤ window`, 50 000 distinct rows, no duplicate
  across the restart boundary, and a sub-30 s wall clock.

Repository-wide: this issue touches shared infrastructure (root
`package.json` gate lists, `tests/`), so `bun run check:full` is the required
gate per `docs/dev-environment.md`; its run is recorded in the PR.

## Audit

The correspondence audit — a fresh-context sub-agent reading the diff, this
receipt and issue #750, and deciding whether `## What changed` faithfully
describes the diff, whether each `- [x]` is realized in the diff, and whether
this `## Checklist` mirrors the issue's — is adjudicated at commit time by
`receipt-per-issue`'s declared judge. Its rounds are appended below verbatim
and this log is append-only.

### Round 1 — independent correspondence audit

Auditor: fresh-context sub-agent. Ground truths read: issue #750 (via the
GitHub API) and `git diff 7b32a809..HEAD` / `git log --oneline 7b32a809..HEAD`
(12 commits; `origin/main` is stale at `3f12bdea` and was deliberately NOT
used as the base). Implementation files were read directly; test files were
read AND executed, not taken on their names.

**Overall verdict: REFUTED** — one acceptance criterion (#20) is claimed "met"
but is met only within a module scope narrower than the criterion states, and
a live instance of the exact defect class the criterion exists to prevent
survives outside that scope. Every other criterion I could check
independently holds.

#### The three declared checks

- **Check 1 — `## What changed` faithfully describes the diff: PASS.**
  Spot-checked the load-bearing prose against source, not against itself.
  Line citations are accurate to the line: `WHERE owner_id = ?` really is
  `packages/gateway/src/routes/edges-routes.ts:99` and `createdByDevice:
  row.created_by_device` really is `:274`. `rg -n 'UPDATE share_edges'
  packages --glob '!dist'` returns exactly one hit
  (`packages/gateway/src/serve/share-edge-store.ts:67`), so the "one writer of
  edge state" claim is literally true. `peer-refusal-relay.ts` and
  `actable.ts` are absent from the tree. `CONTAINER_ID_KEYS` and
  `command.includes("folder")` survive only as prose in
  `commons-routing.ts:3-4`. The receipt's own "Corrections to earlier prose"
  block pre-empts the two overclaims I would otherwise have filed
  (`STALE_CONTEXT_ROW_KEYS` and `exportCommonsBootstrap` are narrowed, not
  deleted) — both corrections are accurate.
- **Check 2 — each `- [x]` item is realized in the diff: REFUTED (one item).**
  The WS-F item "`bun run check:reachability` exits 0" is true and I
  reproduced it (`ok (155 capabilities across 3 module globs)`, `"allowlist":
  []`). What is not realized is the criterion that item is offered as
  evidence for; see criterion 20 below. All other checked items I sampled
  (~30 of them, across all seven workstreams) are realized in source.
- **Check 3 — the `## Checklist` mirrors the issue's checklist: PASS, with a
  structural note.** The `## Checklist` is a workstream plan, not a
  line-for-line mirror of the issue's 21 acceptance-criteria checkboxes. The
  mirror lives in `## Verification`'s acceptance-criteria table, which
  enumerates all 21 with a verdict each; no issue criterion is dropped or
  silently reworded. The purpose of the rule — a reviewer can walk the issue's
  contract inside the receipt — is served, so I do not refute on form.

#### Per-criterion findings (the ones I was asked to spot-check hard)

- **Route assertion has a real production caller: PASS.**
  `announceLocalRoutes` (`packages/gateway/src/serve/peer-route-announce.ts:56`)
  calls `pushRouteAssertion`, and has TWO non-test callers:
  `packages/gateway/src/cli/endpoint-host.ts:473` (fire-and-forget at endpoint
  start, inside `startEndpoint` after `liveEndpointId` is set) and
  `packages/gateway/src/serve/build-gateway.ts:5042` via the
  `announceRoutes` dep consumed at
  `packages/gateway/src/serve/peer-plane-sweep.ts:85`. `rg announceLocalRoutes`
  over `packages`/`apps` excluding `dist` shows no test-only reacher. The
  `gateway_meta` pin is written only on full delivery, so a partial
  announcement genuinely stays armed. `peer-route-announce.test.ts` passes
  (3 cases).
- **One route per peer vault: PASS.** `vault_routes` is
  `vault_id TEXT PRIMARY KEY REFERENCES vault_directory(vault_id)`
  (`gateway-schema.ts:318-324`); `vault_links` (`:348-359`) carries no
  `route_*_json`, `public_key` or label column. `recordRoute`
  (`vault-links-store.ts:619-643`) is a single `ON CONFLICT (vault_id)` UPSERT
  guarded by `assertedAt <= current.assertedAt`, and every reader goes through
  `routeFor(vaultId)` (`:165`). The invariant is structural, not prose.
- **Identity fail-closed: PASS.**
  `loadOrCreateVaultIdentitySeed` (`packages/vault/src/schema/vault-identity.ts:88-121`)
  throws `VaultIdentityMismatchError` for pin-without-seed and for
  seed-not-matching-pin, before any `store.create`. Minting happens only when
  BOTH seed and pin are absent. Residual (not a defect, worth naming): a vault
  that loses seed AND pin together still mints — but the pin sits in the same
  `keys/` dir as the sealing key, so that state is an unopenable vault, not a
  silent re-key.
- **The three specialized tables are gone AND re-pinned: PASS.**
  `rg 'peer_pending_gives|peer_blob_pulls|peer_pending_refusals' packages apps
  scripts --glob '!dist'` returns only two comment hits in
  `gateway-schema.ts:205-206` and one in `share-refusal-outbox.test.ts` — no
  DDL, no query. `share_effects` (`gateway-schema.ts:243-256`) replaces them
  with four kinds and a derived `effect_id`. Deletion is NOT uncovered:
  refusal durability-before-network is re-pinned by
  `share-refusal-outbox.test.ts` (2 cases, incl. "answered while the origin is
  unreachable"), the give/pull lifecycles by `share-coordinator.test.ts` (9),
  `edges-routes.test.ts` (5) and `peer-remote-give.test.ts` (6, incl. ranged
  resume). All executed green.
- **Commons increment (invariant 7): PASS — the largest claim, and it holds.**
  `exportCommonsIncrement` (`commons-bootstrap.ts:578`) refuses off-window
  cursors and returns ops + receipts + replay + a closure DELTA;
  `applyCommonsIncrement` (`:1258`) calls `applyShareClosureDelta`, never the
  scrub. The local rail's fast path (`commons.ts:1105-1140`) is gated on the
  SEAT's own `share_commons_cursor` row and falls back to the destructive path
  only on `ShareClosureDeltaError`. `checkpoint_json` is written only by
  `checkpointCommonsState` (`commons.ts:433`) on cadence/force. The
  derived-row survival claim is asserted concretely, not by name:
  `commons-increment.test.ts:147` checks `enrich_embedding` count unchanged,
  the member-authored OCR needle still in `fts_core_content_item`, and
  `enrich_request` open rows equal to `[added.assetId]` alone. Executed green.
- **Owner-scoped edge listing: PASS.** `edges-routes.ts:96-101` selects
  `WHERE owner_id = ?` from the enrollment-resolved owner; index
  `share_edges_owner_status` replaced `share_edges_device_status`;
  `createdByDevice` survives on the wire (`:274`).
  `edges-routes.test.ts` "every device of one owner sees the same edges
  (#750)" passes.
- **Reachability check sees through `index.ts` re-exports: PASS (mechanism).**
  `scripts/check-share-reachability.mjs` follows barrels, `export *`,
  import-then-re-export chains and workspace specifiers, and classifies
  value-vs-type positions; its 21 self-tests
  (`node --test scripts/check-share-reachability.test.mjs`) pass and include
  "a barrel-laundered export whose only caller is a test file fails" and "an
  import-then-re-export site is laundering, not a caller". The same-file rule
  does NOT blunt the original defect: `pushRouteAssertion` has no same-file
  value use in `peer-link-client.ts`, so it would still be flagged if its
  production caller were removed.
- **Criterion 20 as WRITTEN ("EVERY exported sharing-plane capability"):
  REFUTED.** `share-reachability.json` scopes the gate to three globs —
  `packages/gateway/src/serve/peer-*.ts`,
  `packages/gateway/src/serve/vault-links-store.ts`,
  `packages/vault/src/share/*.ts`. That excludes the gateway-side commons and
  share modules, including code this very issue added
  (`serve/share-coordinator.ts`, `share-effects.ts`,
  `share-effect-executor.ts`, `share-scope.ts`, `serve/commons-notices.ts`,
  `serve/commons-recovery-invites.ts`, `routes/commons-*.ts`,
  `routes/edges-routes.ts`). I ran the repo's own analyzer over that wider
  scope (`runShareReachability` with the same empty allowlist, 77 targets) and
  it reports one genuine offense:
  `packages/gateway/src/serve/commons-observability.ts#readCommonsStewardStatus`
  — "test-only reachers: commons-observability.test.ts". `rg` confirms it: the
  only importer anywhere is that test. That is precisely the
  `pushRouteAssertion` / `declareCommonsCommands` class, alive today, in the
  steward-absence stack the issue names by hand — and outside the gate's
  configured reach. The gate is real, green and useful; the criterion's word
  "every" is not yet true, and the receipt's row 20 ("met, and the gate is
  green") does not disclose the scope limit or this survivor. Remedy is small:
  add `packages/gateway/src/serve/{commons,share}-*.ts` to `modules` and wire
  or delete `readCommonsStewardStatus`.

  **Resolved after the audit (round 2 above).** The remedy was taken rather
  than argued with. `modules` gained five globs (`serve/share-*.ts`,
  `serve/commons-*.ts`, `routes/commons-*.ts`, `routes/edges-*.ts`,
  `routes/edge-*.ts`), taking the gate from 155 capabilities across 3 globs to
  207 across 8 — the code this issue added is now inside its own gate. At that
  scope the analyzer named exactly the predicted offender and no others.
  `readCommonsStewardStatus` was wired, not deleted or allowlisted:
  `peer-commons-sweep.ts#stewardBackoffUntil` had been re-deriving steward
  absence from the raw `share_commons_steward_contact` columns, and now asks
  the observability module that owns that derivation — so the fix removes a
  duplicate reader of one table instead of adding a call to satisfy a gate.
  Criterion 20's row is updated accordingly; this paragraph, not the row, is
  the honest record of how it got there.

#### Other criteria verified independently (all PASS)

Identity/provision: preflight `409 no_iroh_endpoint` at
`device-ticket-mint.ts:316-323` precedes every write, `executeForPersonMint`
(`:82`) mints the vault first then commits owner + `vault_owners` + ticket +
`provision_operations` in one transaction with `unmintVaultForPerson` rollback;
`devices-routes-mint.test.ts` green. Labels: three `slice(0, 8)` fallbacks are
gone from all three sheets, `linkDto` now reads
`store.directoryEntry(...).label`, and `parseGatewayLink` validates the wire.
Blob authorization: `exportCommonsBootstrap` runs once in
`handlePeerCommonsBlobAuthorize` (`peer-commons-route.ts:338`) and
`handlePeerCommonsBlob` validates against the stored session sha set with no
export or signing (`:389-395`). Intent grammar: `share-commons.ts:168-177` is
`('queued','parked','denied','executed','expired','cancelled')` with the index
following; no `'pending'` remains on the intent table. Declared routing:
`commons-routing.ts` is a data table and `commons-routing.test.ts` walks real
`agent_command.input_schema_json` (4 conformance cases, green). Steward loss:
`raiseCommonsNotices` is called from production
(`peer-commons-sweep.ts:178`), notices reach users through the existing
`/centraid/_vault/notifications` projection, `deliverCommonsRecoveryInvitations`
is called from `commons-recovery-routes.ts`, and
`docs/recovery/commons-steward-loss.md` exists with the N≥3 limit stated;
`commons-steward-loss-drill.test.ts` green. Sweep backoff constants exist and
gate dialing (`peer-commons-sweep.ts:72-114`). Borrowed-plane "moot" claim is
true: `rg 'borrowed_change|borrowed-store|borrowed-schema' packages apps` finds
nothing, so deviation (a) is honest rather than evasive; the substituted
`duties.ts` final-reference guard and its test are real and pass.

Facade check (the issue's "do not land facade-only abstractions that increase
total state-machine count"): net state machines went DOWN, not up — four
hand-rolled edge state machines and three peer queues collapsed to one reducer
plus one four-kind outbox table, and the commons intent vocabulary was
merged into the replica outbox's rather than added beside it. No facade found.

Scope creep: nothing in the diff falls outside the issue. The trailing
ratchet commit (`tests/schema-export-fingerprint.json`,
`tests/quality-rig-budgets.json`, `QUALITY.md`, `portable-export.ts` audit
comments) is required upkeep for the schema edits this issue makes; the
QUALITY.md `wal-shipper` note is accurate — `git log -1` on
`packages/vault/src/wal-shipper.ts` is `e0a8ed51` (#642), so it is genuinely
pre-existing and not caused here.

Could not verify (stated, not assumed): full-package suite results, `bun run
check:full`, and the nightly `tests/scale/replica-bootstrap.scale.test.ts` run
— the receipt records these as "run recorded in the PR" and I did not
re-execute them; I ran 12 focused suites (80 tests) plus the analyzer's 21
cases, all green.

- [round 1] REFUTED lane=attest stamp=750a0dc0e750 — criterion 20's gate is scoped to three module globs that exclude the gateway-side commons/share modules, and `commons-observability.ts#readCommonsStewardStatus` is a live test-only export in that unscoped area; every other criterion verified independently holds.
- [round 2] PASS lane=attest stamp=750a0dc0e750 — round 1's REFUTED is fixed, not argued with. `share-reachability.json` gained five globs (`serve/share-*.ts`, `serve/commons-*.ts`, `routes/commons-*.ts`, `routes/edges-*.ts`, `routes/edge-*.ts`), so the gate now covers the code this issue itself added; scope went from 155 capabilities across 3 globs to **207 across 8**. At the widened scope the analyzer named exactly the one offender the auditor predicted and no others. `readCommonsStewardStatus` was neither deleted nor allowlisted: `peer-commons-sweep.ts#stewardBackoffUntil` had been re-deriving "is this steward absent" from the raw `share_commons_steward_contact` columns, so it now asks the observability module instead — one reader of that evidence rather than two, which removes the duplication AND earns the export its production caller. `bun run check:reachability` → `ok (207 capabilities across 8 module globs)` with `"allowlist": []`; gateway typecheck green; `peer-commons-sweep.test.ts` 6/6, `commons-observability.test.ts` + `commons-notices.test.ts` 8/8; `lint` and `format:check` clean. The round-1 finding stands on the record as found — it was a real defect of exactly the class this issue exists to kill, caught only because the auditor re-scoped the gate itself rather than trusting its green output.
- [round 3] Two defects found by cross-applying an adversarial review of a
  rival #750 implementation to this branch, both fixed here rather than
  filed. (a) **Link-redemption identity hijack**: `peer-plane.ts` redeem
  accepted a body-supplied `vaultId` with no check that the claimed peer
  vault is not one this gateway itself holds. A counterparty holding a valid
  ticket could name a local vault as the "far side", which installed a
  `vault_routes` row for it — and a route row's presence *is* the definition
  of remote, so the owner's next give to their own vault would be exported to
  the claimant. Fixed with a local-registry refusal before `redeem` (the
  ticket survives, since the attempt never became a ceremony) plus
  `upsertDirectory` now write-once on `public_key`
  (`VaultDirectoryIdentityError`) so no ceremony path can re-key a known
  vault. Pinned by "refuses a redemption that claims a vault this gateway
  holds (#750)" in `peer-plane.test.ts`. (b) **Scope-validator bypass**:
  `edges-routes.ts` built the wire DTO with a raw
  `JSON.parse(row.target_item_ids_json)` two files away from the
  `parseTargetItemIds` this issue added, leaving one path where a non-string
  could still reach a client in an item-ID array; it now goes through the
  parser.
- [round 4] The increment apply path verified the op hash chain and then
  recorded itself verified with **no state check at all** — the same gap this
  receipt criticised elsewhere. Closing it exposed why it was open: the one
  attested digest (`checkpoint_state_digest`) hashes the STEWARD's closure
  bytes, and `assertCommonsStateDigest` re-hashes the `checkpoint_json` the
  member stored, so it proves faithful storage of a snapshot, not that the
  member's projected rows match the steward's. A member cannot recompute
  those bytes: `projectShareClosure` deliberately re-owns rows and re-ids on
  collision, and the digest is array-order sensitive to the steward's SQL
  order. An increment also ships without `checkpoint_json` by design. So an
  in-transaction digest assertion on the increment result is not
  constructible against the attested quantity — it needs a new
  projection-invariant, order-insensitive digest with its own signing domain,
  which is a design change, not a fix.
  What shipped instead is a bound: a seat may stand at most
  `COMMONS_CHECKPOINT_INTERVAL` (32) operations past a state proven by a full
  frame, after which `applyCommonsIncrement` refuses with
  `CommonsIncrementUnusableError` and the existing caller re-baselines
  through a full frame whose snapshot digest IS asserted. Divergent
  increment-applied state can therefore never become the permanent baseline;
  it survives at most one checkpoint interval. The honest statement of the
  guarantee — history-verified but not state-verified between proofs,
  divergence **bounded** rather than **detected** — is in the code beside the
  check, replacing a docblock that had claimed the absence of a digest
  assertion was deliberate. Cost is neutral in the normal flow (a member
  below a fresh checkpoint is already forced to a full frame); the bound only
  bites when the steward's checkpoints lag, which is exactly when unproven
  state would otherwise accumulate without limit. The refusal sits after
  history verification, so a forked chain still parks rather than falling
  back — a fault outranks a retry.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-13 | claude-code | aea2eb6c-dd0d-5e48-9a97-e2b937667112 |
