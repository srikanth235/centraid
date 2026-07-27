# Issue #599 — household members + share-by-placement

## Checklist

- [x] Device role vocabulary (prerequisite): `DeviceRole` / `GrantableRole` lattice, `canWrite()` predicate, role-in-ticket, role picker in DevicePairPanel, glossary "Device roles" section
- [ ] L2 member layer: `members` table, roles authored on `(member, vault)`, devices as pure bindings that inherit
- [ ] Invitation tickets `(member_id, [(vault, role)…])` with atomic multi-grant redemption; self-pair vs invite split
- [ ] Two revocation verbs: revoke device vs remove member (atomic)
- [ ] Founding auto-creates the owner member; ≥1-owner-per-vault invariant
- [ ] People-first DevicesCard + member-picker pairing panel; CLI parity (`members`, `pair --member --grant`)
- [x] Share-by-placement: hardlink-or-copy into audience CAS + projected row + `core_share_origin` sidecar, single-DB transaction (vault-package primitive; gateway routes follow in a later commit)
- [ ] Journal attribution (member + device) on writes
- [ ] Docs: glossary member vocabulary, decisions.md, SECURITY.md threat-model premise
- [ ] Wire golden regenerated (invitation payload)

## What changed

**Commit 1 — device role vocabulary (prerequisite branch folded in).** This realizes the checked checklist item — Device role vocabulary (prerequisite): `DeviceRole` / `GrantableRole` lattice, `canWrite()` predicate, role-in-ticket, role picker in DevicePairPanel, glossary "Device roles" section — across these files:

- **Gateway serve plane:** `packages/gateway/src/serve/enrollment-store.ts` introduces `DeviceRole` (`admin`/`write`/`read` + `revoked` tombstone), `GrantableRole`, and `canWrite()`; `packages/gateway/src/serve/pairing-store.ts` bakes the role into the ticket at mint; `packages/gateway/src/serve/gateway-db.ts` DDL gains the role column with its CHECK constraint (v0 — edited directly, no migration); `packages/gateway/src/serve/build-gateway.ts` renames the read-role gate (`readonlyRequestAllowed` → `readRoleRequestAllowed`, `trust === 'readonly'` → `role === 'read'`, founding `trust: 'owner'` → `role: 'admin'`) **and opens a host-custody CLI lane**: `/centraid/_gateway/devices/ticket` short-circuits to `prefixDispatch` when `isDirectHostRequest(req)`, skipping the device-identity gate so a headless daemon can mint a second enrollment ticket from the CLI (covered by `pairing-ticket-host-custody.test.ts`); `packages/gateway/src/serve/serve.ts` is a comment-only change updating `publicPaths` to the #555 no-public-pairing stance. Tests: `packages/gateway/src/serve/gateway-db.test.ts`, `packages/gateway/src/serve/device-plane.test.ts`, `packages/gateway/src/serve/revocation-severs-planes.test.ts`, `packages/gateway/src/serve/vault-registry.test.ts`, `packages/gateway/src/serve/desktop-founding.integration.test.ts`, and the new `packages/gateway/src/serve/pairing-ticket-host-custody.test.ts`.
- **Route gates:** the mutation gate is `packages/gateway/src/routes/replica-intent-route.ts` (`!canWrite(context.access.role)` → denied), with `packages/gateway/src/routes/replica-shape.ts` clamping `mayAct`; `packages/gateway/src/routes/replica-access.ts` renames `trust` → `role` and keeps the pre-existing `revoked` rejection; `packages/gateway/src/routes/devices-routes.ts` makes mint/revoke admin-only (`body.role ?? 'write'`, last-admin confirmation); role-aware adjustments in `packages/gateway/src/routes/backup-routes.ts`, `packages/gateway/src/routes/founding-routes.ts`, `packages/gateway/src/routes/vault-routes.ts`, `packages/gateway/src/routes/replica-routes.ts`. Tests: `packages/gateway/src/routes/devices-routes.test.ts`, `packages/gateway/src/routes/backup-routes.test.ts`, `packages/gateway/src/routes/founding-routes.test.ts`, `packages/gateway/src/routes/replica-intent-route.test.ts`, `packages/gateway/src/routes/replica-shape.test.ts`, `packages/gateway/src/routes/vault-erase.test.ts`.
- **CLI:** `packages/gateway/src/cli/device-admin.ts` (role column in `devices list`, `--role` on mint), `packages/gateway/src/cli/cli.ts`, `packages/gateway/src/cli/endpoint-host.ts`. Tests: `packages/gateway/src/cli/admin.test.ts`, `packages/gateway/src/cli/admin-custody.test.ts`, plus `packages/gateway/src/backup/recover-live.integration.test.ts` updated for the role-bearing enrollment shape.
- **Protocol + tunnel wire:** `packages/tunnel/src/gateway-endpoint.ts` **removes** the client-supplied `trust` field from `GatewayPairRequest` — there is deliberately no role field on the wire request, because the role is baked into the server-minted ticket and read back at redemption (a joining device can never name its own authority); `packages/tunnel/fixtures/wire-golden.json` regenerated (shrank by dropping `"trust":"full"`); `packages/tunnel/src/wire-conformance.contract.test.ts` updated; `packages/protocol/src/routes.ts` deletes the now-unused `gatewayPair` route constant.
- **Client:** `packages/client/src/react/screens/DevicePairPanel.tsx` gains the ROLE_PRESETS picker (default `write`); `packages/client/src/react/screens/DevicesCard.tsx` + `packages/client/src/react/screens/DevicesCard.module.css` show the role; `packages/client/src/gateway-client.ts` and `packages/client/src/gateway-client-devices.ts` carry the role in the device types. Tests: `packages/client/src/react/screens/DevicesCard.test.tsx`, `packages/client/src/device-enrichment-worker.test.ts`.
- **Docs:** `docs/glossary.md` gains the role vocabulary row and the "Device roles" section (trust vs role axes, founding-ticket-is-admin invariant, last-admin confirmation, `consent_device.trust` capability-mirror mapping).
- **This receipt:** `receipts/issue-599-household-members-share-by-placement.md`.
- **Gate repair (in passing):** `.governance/packs/srikanth235/centraid/directives/format-check/check.sh` now passes `-c oxfmt.config.mjs` to oxfmt, mirroring CI's `bun run format:check`. The hook had drifted after the #565 toolchain bump: it invoked oxfmt with no config ("No config found, using defaults"), flagging files that the repo's own config formats correctly, which blocked every commit on this branch. governance: allow-receipt-per-issue gate drift blocked all commits; fix is the minimal CI-mirroring change.

**Commit 2 — share-by-placement primitive in `packages/vault`.** This realizes the checked checklist item — Share-by-placement: hardlink-or-copy into audience CAS + projected row + `core_share_origin` sidecar, single-DB transaction (vault-package primitive; gateway routes follow in a later commit):

- **New `packages/vault/src/share/` module:** `packages/vault/src/share/placement.ts` (public `shareToVault` / `unshareFromVault` / `readShareOrigin`; `isShareableItemType` lives in `closure.ts`; hardlink first, then one `BEGIN IMMEDIATE` transaction in the audience vault only; origin never written; rejects origin === audience), `packages/vault/src/share/closure.ts` (projection closure: `media.media_asset` → asset + its `core_content_item` + all derivative rows (the `sha256`-bearing ones contribute CAS addresses); cross-vault FK columns — `creator_party_id`, `origin_device_id`, `place_id`, `camera_device_id` — projected NULL, never carried; tags/links/collections/annotations/enrichment deliberately excluded; `freeId()` mints a fresh uuidv7 only on a genuine PK collision), `packages/vault/src/share/removal.ts` (the projected-row deletes, guarding content-item deletion with a runtime `PRAGMA foreign_key_list` referrer scan; the `core_share_origin` DELETE and the refuse-audience-authored-rows guard live in `placement.ts#unshareFromVault`), `packages/vault/src/share/blobs.ts` (link-or-copy byte placement), and the tests split for the 500-line cap into `packages/vault/src/share/placement.test.ts` (placement: projection + origin-untouched, id reuse, inode identity `ino`/`dev`/`nlink === 2` hardlink proof, copy fallback, real-EPERM `linkFromSync` classification, idempotent re-share by same and different member), `packages/vault/src/share/placement-lifecycle.test.ts` (injected mid-transaction failure with orphan-grace reclamation, unshare inode survival, re-share after unshare, refuse-audience-authored, origin-sweep-cannot-delete-audience-bytes, unknown item, self-share), and the shared fixture `packages/vault/src/share/placement-fixture.ts` (two real on-disk vaults under one root; the composed local orphan sweep).
- **Schema:** `packages/vault/src/schema/core.ts` gains `SHARE_ORIGIN_DDL` (`core_share_origin`, PRIMARY KEY `(item_type, item_id)`, STRICT, `idx_share_origin_vault`); composed in `packages/vault/src/schema/migrate.ts`; registered in `packages/vault/src/schema/tables.ts` and `packages/vault/src/schema/poly-refs.ts` (policy `delete` — mandatory, the poly-refs conformance test scans live DDL) with a curated label in `packages/vault/src/schema/atlas.ts`. `core_link` untouched.
- **Blob store:** `packages/vault/src/blob/local.ts` gains `linkFromSync` + `BlobLinkOutcome` (EEXIST → `exists`; EXDEV/EPERM/EACCES/EOPNOTSUPP/ENOSYS/EMLINK → `unsupported` → copy fallback; ENOSPC → `VaultDiskFullError`; everything else rethrows) so the two-hex fan-out stays a `local.ts`-owned detail.
- **Errors/exports:** `packages/vault/src/errors.ts` (`VaultShareError`), `packages/vault/src/index.ts` barrel exports.

_Later commits will be appended per phase._

## Decisions

- The device-role vocabulary work is committed under #599 (rather than a separate issue) because #599 names it as its direct prerequisite and re-homes where the role fact is authored; splitting it would create a stacked PR, which this repo avoids.
- `revoked` is deliberately a tombstone state, not a member of `GrantableRole` — never offered in pickers, never mintable.
- The vault's `consent_device.trust` mirror is unchanged by design: `admin` and `write` both collapse to `full` (minting/revoking are gateway-plane concerns).
- **Known gap surfaced by commit 2 (deliberate, deferred to the gateway-wiring commit):** there is no shipped *local-only* orphan sweep — `reconcileCustody` deletes only remote orphans and `BlobCache.runEviction` only sheds shas with replica evidence. #599's "the audience vault's own orphan-grace sweep already reclaims" is therefore not yet true for local bytes; the share tests compose the shipped primitives (`liveBlobShas` → `OrphanTombstoneIndex` grace gate → `BlobCustody.deleteLocalSync`) to prove the semantics, and the gateway phase must package that composition as a real sweep or unshared blobs accumulate.
- `core_share_origin.shared_at` is INTEGER epoch-ms, diverging from core.ts's "timestamps are TEXT ISO-8601" header rule — it is gateway-plane boundary machinery on the same clock as `blob_orphan.first_orphaned_at` (justified in the DDL comment).

## Out of scope

- Row-level ACLs inside a vault (Model B — rejected in #599)
- Accounts/passwords/sessions/OIDC
- Encryption-at-rest for local blobs; storage/backup-provider work (Decision 12: deferred)
- Cross-gateway federation; member-switching on one device
- member ⇄ `core_party` link
- Served (iframe) apps multi-scope mounting

## Verification

Commit-1 spot check (re-run by the reviewer):

```sh
cd packages/gateway && bun run test -- src/serve/device-plane.test.ts src/serve/gateway-db.test.ts src/serve/pairing-ticket-host-custody.test.ts
```

Commit-2 spot check:

```sh
cd packages/vault && bun run test -- src/share/placement.test.ts && bun run typecheck
```

Result at commit time: 13/13 share tests passing (full package: 117 files, 985 passed, 1 pre-existing skip), typecheck clean.

Commit-1 result: 3 files, 23 tests, all passing. Full suites for gateway/client/tunnel were green in the authoring session, and `bun run check:pr:full` runs before requesting merge (shared packages `client`, `protocol`, `tunnel`, `gateway` all move). The `packages/tunnel/fixtures/wire-golden.json` diff is limited to dropping the client-supplied `"trust":"full"` field from the pair-request payload.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS**

Every claim now matches the staged diff. Gateway serve plane: `enrollment-store.ts` defines the `DeviceRole`/`GrantableRole` lattice with `canWrite()`, `pairing-store.ts` bakes the role in at mint (founding → `admin`), `gateway-db.ts` carries the CHECK constraints on both `devices.role` and `tickets.role`, `build-gateway.ts` renames the read-role gate and adds the `isDirectHostRequest` short-circuit for `_gateway/devices/ticket` (covered by the new `pairing-ticket-host-custody.test.ts`), and `serve.ts` is a 6/4 comment-only hunk with `publicPaths` itself untouched. Route gates: `replica-intent-route.ts:179` is the `canWrite` mutation gate, `replica-shape.ts:338` clamps `mayAct`, `replica-access.ts` is the `trust` → `role` rename keeping the `revoked` rejection, and `devices-routes.ts` gates mint/revoke on `role !== 'admin'` with `body.role ?? 'write'` and last-admin confirmation. Wire: `gateway-endpoint.ts` removes the client-supplied `trust` field (role is server-minted only), `wire-golden.json` shrinks 131 → 116 bytes accordingly, and `protocol/src/routes.ts` deletes the now-unreferenced `gatewayPair` constant. CLI, client, and docs claims all hold, the file list matches `git diff --cached --stat` exactly, and no files are invented.

### Check 2: Each "- [x]" checklist item is realized in the diff

**Verdict: PASS**

The single checked item — "Device role vocabulary (prerequisite)" — is realized in full: the `DeviceRole` / `GrantableRole` lattice and `canWrite()` in `enrollment-store.ts`, role-in-ticket in `pairing-store.ts` + `devices-routes.ts` + `device-admin.ts`, the `ROLE_PRESETS` picker in `DevicePairPanel.tsx`, and the "Device roles" section in `docs/glossary.md`. The nine unchecked items are later phases and correctly carry no claim.

### Commit 2

**Check 1: the Commit-2 "What changed" block faithfully describes the staged diff**

**Verdict: PASS**

Every load-bearing claim is realized in the staged diff, and the file list matches `git diff --cached --stat` exactly. `share/placement.ts` exports `shareToVault`/`unshareFromVault`/`readShareOrigin` with blobs placed first, then exactly one `BEGIN IMMEDIATE` on the audience vault only (origin never written; origin === audience throws `VaultShareError`). `share/closure.ts` projects asset + content item + derivatives with the four cross-vault FK columns as literal NULLs and `freeId()` minting a fresh uuidv7 only on a genuine PK collision. `share/removal.ts` does a live `PRAGMA foreign_key_list` referrer scan skipping `ON DELETE CASCADE`. `blob/local.ts#linkFromSync` classifies EEXIST → `exists`, EXDEV/EPERM/EACCES/EOPNOTSUPP/ENOSYS/EMLINK → `unsupported`, ENOSPC → `VaultDiskFullError`, everything else rethrows. Schema claims (STRICT DDL, poly-refs `delete` policy mandatory per the conformance test, `core_link` untouched, pure-append core.ts) all verified. The 13 tests were re-run by the auditor: 13/13 pass; the hardlink test asserts `ino`/`dev` equality and `nlink === 2` on both entries, and the classification test drives a real EPERM (link(2) on a directory) plus a real ENOENT rethrow. The Decisions bullets were verified independently: `reconcileCustody` only deletes remote-listed orphans and `runEviction` requires replica evidence, so the "no shipped local-only orphan sweep" gap is honestly stated; the `shared_at` INTEGER divergence is real and carries its DDL justification.

**Check 2: the newly checked checklist item is realized in the diff**

**Verdict: PASS**

Hardlink-or-copy (`linkFromSync` + `placeBlob`, proved by inode/nlink assertions and the copy-fallback test), the projected row (`projectShareClosure`), the `core_share_origin` sidecar (DDL + insert in `shareToVault`), and the single-DB transaction (one `BEGIN IMMEDIATE` on the audience handle, origin read-only) are all present. The scoping parenthetical is honest — the diff touches only `packages/vault` and adds no gateway routes. The nine unchecked items correctly carry no claim in the diff.

## Steering

### Check 1: Every human-steering event in the session transcript is recorded as a row

**Verdict: PASS**

The implementation for this commit was carried out in a prior session. This session's only operator input was the opening `/goal` directive ("work on the entire scope of #599 and create a PR, act as orchestrator and spawn opus subagents") — an initial instruction, not an interruption or redirection of agent work in flight. No steering events occurred, so there are no `### Steering` data rows.

### Check 2: No non-steering message is recorded as steering

**Verdict: PASS**

No steering rows recorded; the opening goal directive was correctly not logged as steering.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8a1af371-ccc-1785176329-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 255 | 2541075 | 14760714 | 206545 | 2747875 | 56.8540 | 255 | 2541075 | 14760714 | 206545 | feat(gateway): device role vocabulary — DeviceRole lattice, role-in-ticket (#599 |
| claude-code-8a1af371-ccc-1785176831-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 101 | 105706 | 6170828 | 50345 | 156152 | 10.0104 | 356 | 2646781 | 20931542 | 256890 | feat(gateway): device role vocabulary — DeviceRole lattice, role-in-ticket (#599 |
| claude-code-8a1af371-ccc-1785177015-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 34 | 17710 | 2380205 | 12990 | 30734 | 3.2514 | 390 | 2664491 | 23311747 | 269880 | feat(gateway): device role vocabulary — DeviceRole lattice, role-in-ticket (#599 |
| claude-code-8a1af371-ccc-1785178492-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 116 | 165515 | 10316658 | 72923 | 238554 | 16.0329 | 506 | 2830006 | 33628405 | 342803 | feat(vault): share-by-placement primitive — hardlink CAS + core_share_origin (#5 |
| claude-code-8a1af371-ccc-1785179223-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 76 | 50078 | 8515232 | 21439 | 71593 | 10.2139 | 582 | 2880084 | 42143637 | 364242 | feat(vault): share-by-placement primitive — hardlink CAS + core_share_origin (#5 |
