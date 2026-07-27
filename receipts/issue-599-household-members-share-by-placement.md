# Issue #599 — household members + share-by-placement

## Checklist

- [x] Device role vocabulary (prerequisite): `DeviceRole` / `GrantableRole` lattice, `canWrite()` predicate, role-in-ticket, role picker in DevicePairPanel, glossary "Device roles" section
- [x] L2 member layer: `members` table, roles authored on `(member, vault)`, devices as pure bindings that inherit
- [x] Invitation tickets `(member_id, [(vault, role)…])` with atomic multi-grant redemption; self-pair vs invite split
- [x] Two revocation verbs: revoke device vs remove member (atomic)
- [x] Founding auto-creates the owner member; ≥1-owner-per-vault invariant
- [x] CLI parity: `members list|add|rename|remove`, `pair --member --grant`, member column in `devices list`
- [ ] People-first DevicesCard + member-picker pairing panel (client)
- [x] Share-by-placement: hardlink-or-copy into audience CAS + projected row + `core_share_origin` sidecar, single-DB transaction (vault-package primitive; gateway routes follow in a later commit)
- [ ] Journal attribution (member + device) on writes
- [ ] Docs: glossary member vocabulary, decisions.md, SECURITY.md threat-model premise
- [x] Wire golden regenerated (invitation payload)

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

**Commit 3 — the L2 member layer in the gateway.** This realizes six checked checklist items — L2 member layer: `members` table, roles authored on `(member, vault)`, devices as pure bindings that inherit · Invitation tickets `(member_id, [(vault, role)…])` with atomic multi-grant redemption; self-pair vs invite split · Two revocation verbs: revoke device vs remove member (atomic) · Founding auto-creates the owner member; ≥1-owner-per-vault invariant · CLI parity: `members list|add|rename|remove`, `pair --member --grant`, member column in `devices list` · Wire golden regenerated (invitation payload):

- **New files:** `packages/gateway/src/serve/member-store.ts` (members + member_roles CRUD, `adminsOf`, `vaultsLosingLastAdmin`, atomic `remove(memberId)`, `removeVault`), `packages/gateway/src/routes/members-routes.ts` (member CRUD: GET list with roles+deviceCount, POST admin-only, PATCH self-or-admin rename, DELETE with `confirmLastAdmin`), `packages/gateway/src/routes/device-invitations.ts` (the self-pair-vs-invite authorization decision, isolated), `packages/gateway/src/cli/member-admin.ts` (`members list|add|rename|remove`), plus split/new tests `packages/gateway/src/routes/devices-routes.test-fixtures.ts`, `packages/gateway/src/routes/devices-routes-invitations.test.ts`, `packages/gateway/src/routes/members-routes.test.ts`.
- **Schema (`packages/gateway/src/serve/gateway-db.ts`, edited in place, no migration):** `members(member_id PK, label, created_at)`; `member_roles(member_id→members, vault_id, role CHECK admin|write|read, PK(member_id, vault_id))`; `devices` reshaped to a binding `(enrollment_id PK, endpoint_id UNIQUE, member_id NOT NULL→members, …, revoked)` — the per-vault `role` column and `UNIQUE(endpoint_id, vault_id)` are gone; new `device_checkpoints(endpoint_id, vault_id, checkpoint_json)` for the one genuinely per-(device, vault) fact; `tickets` become invitations `(kind found|enroll, member_id→members, grants_json, CHECK found ⇒ both NULL / enroll ⇒ both NOT NULL)`; `web_sessions` keeps `vault_id` (deferred re-key per the issue) with `device_key → devices(endpoint_id) ON DELETE CASCADE`.
- **Stores:** `packages/gateway/src/serve/enrollment-store.ts` — the device row is a binding; `DeviceEnrollment` becomes a derived `(device × member × member_roles)` view so ~30 call sites keep their shape, with `memberId`/`memberLabel` added and `enrollmentId` now the device id (repeats across a device's vaults); revocation is a tombstone and web sessions are deleted explicitly since the FK cascade no longer fires. `packages/gateway/src/serve/pairing-store.ts` — invitations with multi-grant atomic redemption (injected `beforeEnroll` crash leaves zero enrollment, zero grants, ticket unburned) and founding auto-creating the owner member ("You", admin).
- **Routes:** `packages/gateway/src/routes/devices-routes.ts` — mint accepts `memberId` (id or exact label) / `newMemberLabel` / `grants:[{vaultId, role}]` with legacy `vaultId`+`role` as a single grant; self-pair default bakes the caller's current roles; invite requires `admin` in every granted vault; new error codes `role_above_own`, `ambiguous_member`, `invalid_member_label`, `member_not_found`, `invalid_grants`, `grants_required`; device DTO adds `memberId`/`memberLabel`; `confirmLastAdmin` now guards the last live device of a vault's last admin member. `packages/gateway/src/routes/vault-routes.ts` — vault erase drops `member_roles`, `device_checkpoints`, `web_sessions`, and matching invitations. `packages/gateway/src/serve/build-gateway.ts` mounts the members route and resolves the acting member into the request scope; `packages/gateway/src/serve/vault-context.ts`, `packages/gateway/src/serve/replica-intent-context.ts`, `packages/gateway/src/routes/replica-access.ts`, `packages/gateway/src/routes/replica-intent-route.ts` thread `memberId` through the request path; `packages/gateway/src/serve/founding-recovery.ts` probes owner-commit via `member_roles`.
- **CLI:** `packages/gateway/src/cli/cli.ts`, `packages/gateway/src/cli/device-admin.ts` — `pair --member <id|label> | --new-member <label> | --grant <vaultId>:<role>…` (self-pair default), `devices add --member/--new-member`, member columns in `devices list`; `packages/gateway/src/cli/endpoint-host.ts` — multi-vault redemption with the capability mirror written per granted vault.
- **Wire:** `packages/tunnel/src/gateway-endpoint.ts` — `GatewayPairResponse` adds `memberId`/`memberLabel`/`vaultIds[]`; the request payload still carries no role and no member; `packages/tunnel/fixtures/wire-golden.json` regenerated (diff is exactly the `gatewayPairResponse` vector); `packages/tunnel/src/wire-conformance.contract.test.ts` updated.
- **Updated tests across the reshape:** `packages/gateway/src/serve/gateway-db.test.ts`, `device-plane.test.ts`, `packages/gateway/src/routes/devices-routes.test.ts` (trimmed; the invitation cases moved to the new split file), `founding-routes.test.ts`, `vault-erase.test.ts`, `packages/gateway/src/cli/admin.test.ts`, `packages/gateway/src/backup/recover-live.integration.test.ts`, plus `packages/tunnel/src/wire-conformance.contract.test.ts`.

_Later commits will be appended per phase._

## Decisions

- The device-role vocabulary work is committed under #599 (rather than a separate issue) because #599 names it as its direct prerequisite and re-homes where the role fact is authored; splitting it would create a stacked PR, which this repo avoids.
- `revoked` is deliberately a tombstone state, not a member of `GrantableRole` — never offered in pickers, never mintable.
- The vault's `consent_device.trust` mirror is unchanged by design: `admin` and `write` both collapse to `full` (minting/revoking are gateway-plane concerns).
- **Known gap surfaced by commit 2 (deliberate, deferred to the gateway-wiring commit):** there is no shipped *local-only* orphan sweep — `reconcileCustody` deletes only remote orphans and `BlobCache.runEviction` only sheds shas with replica evidence. #599's "the audience vault's own orphan-grace sweep already reclaims" is therefore not yet true for local bytes; the share tests compose the shipped primitives (`liveBlobShas` → `OrphanTombstoneIndex` grace gate → `BlobCustody.deleteLocalSync`) to prove the semantics, and the gateway phase must package that composition as a real sweep or unshared blobs accumulate.
- **Commit-3 deviations (deliberate):** `DeviceEnrollment` stays a derived per-(device, vault) view rather than rewriting ~30 call sites — authority is still authored in exactly one place (`member_roles`). Host-custody `enroll()` without a member creates one labelled with the device label (the communal-device story; never an "Unassigned" bucket). `tickets.member_id` is nullable for kind `found` only — founding mints before any vault exists, so the owner member is created at redemption. Self-pair with no explicit grants now bakes the member's **current** roles (an admin self-pairing gets admin) instead of defaulting to `write`. **Journal attribution stops at the gateway boundary in this commit**: `memberId` is resolved into the request scope and carried to `ReplicaIntentContext`/`ReplicaRequestAccess`, but the journal receipt writer (`packages/vault/src/gateway/gateway.ts` `writeReceipt`, `InvokeRequest.intentDeviceId`) is a vault-package seam landed in a later commit — same for the agent on-behalf-of hard-cap, whose `app` credential today has no principal dimension.
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

Commit-3 spot check:

```sh
cd packages/gateway && bun run test && bun run typecheck
```

Result at commit time: gateway 173 files passed / 1 skipped, 1167 tests passed / 6 skipped; tunnel 69 passed / 2 skipped with regenerated golden; protocol 32 passed; typecheck green in all three.

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

### Commit 3

**Check 1: the Commit-3 "What changed" block faithfully describes the staged diff**

**Verdict: PASS**

Verified line by line against the staged diff. The `gateway-db.ts` DDL matches every schema claim (members / member_roles PK / devices reshaped with `member_id NOT NULL` and no role column / `device_checkpoints` / tickets kind+member_id+grants_json CHECK / web_sessions FK). Mint authorization in `device-invitations.ts` self-pairs off the caller's current roles via `members.grants`, clamps by `roleWithin`, and requires `admin` in every granted vault on the invite path, with all six named error codes present. `pairing-store.ts` performs multi-grant atomic redemption in one transaction (injected-crash rollback proven in `device-plane.test.ts`: zero enrollment, zero grants, ticket unburned) and `enrollFounder` auto-creates the "You"/admin member (proven in `founding-routes.test.ts`). `enrollment-store.ts` is the derived `devices ⋈ members ⋈ member_roles` view with the `revoked` tombstone winning and explicit web-session deletion on the tombstone path; `member-store.ts#remove` is a single transaction dropping checkpoints → devices → member_roles → member. The `wire-golden.json` diff is confined to the `gatewayPairResponse` vector (adds `memberId`/`memberLabel`/`vaultIds`). The named test files account for exactly the 11 staged test files — no file named that is not in the diff, no staged file left unnamed. The spot-run (10 tests) passes, and the full gateway suite reproduces the Verification numbers exactly: 173 passed / 1 skipped files, 1167 passed / 6 skipped tests. (Earlier drafts of the block failed this check on file-list fidelity — eight commit-1 test files listed as updated, one wrong path, a miscounted header — all corrected before commit.)

**Check 2: each newly checked checklist item is realized in the diff**

**Verdict: PASS**

All six newly checked boxes are realized: the L2 member layer (DDL + `member-store.ts` + derived enrollment view, no role column on devices); invitation tickets with the self-pair/invite split (`tickets` CHECK, `mint(TicketInvitation)`, `redeemAndEnroll` returning `DeviceEnrollment[]` atomically, `device-invitations.ts`); two revocation verbs (`EnrollmentStore.revoke` tombstone vs `MemberStore.remove` atomic, surfaced as distinct routes); founding auto-member with the ≥1-owner invariant (`vaultsLosingLastAdmin` + `confirmLastAdmin` on route and CLI paths); CLI parity (`member-admin.ts`, `pair --member/--new-member/--grant`, `devices list` rows carrying `memberId`/`memberLabel` as fields); and the regenerated wire golden whose only changed vector is `gatewayPairResponse`, with the request payload still naming neither role nor member.

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
| claude-code-8a1af371-ccc-1785179823-1 | claude-code | 8a1af371-ccc1-4938-8f5b-6e749b8d9c7e | #599 | claude-fable-5 | 58 | 55535 | 7242481 | 27523 | 83116 | 9.3134 | 640 | 2935619 | 49386118 | 391765 | feat(gateway): L2 member layer — members, (member,vault) roles, invitation ticke |
