# Issue #599 — household members + share-by-placement

## Checklist

- [x] Device role vocabulary (prerequisite): `DeviceRole` / `GrantableRole` lattice, `canWrite()` predicate, role-in-ticket, role picker in DevicePairPanel, glossary "Device roles" section
- [ ] L2 member layer: `members` table, roles authored on `(member, vault)`, devices as pure bindings that inherit
- [ ] Invitation tickets `(member_id, [(vault, role)…])` with atomic multi-grant redemption; self-pair vs invite split
- [ ] Two revocation verbs: revoke device vs remove member (atomic)
- [ ] Founding auto-creates the owner member; ≥1-owner-per-vault invariant
- [ ] People-first DevicesCard + member-picker pairing panel; CLI parity (`members`, `pair --member --grant`)
- [ ] Share-by-placement: hardlink-or-copy into audience CAS + projected row + `core_share_origin` sidecar, single-DB transaction
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

_Later commits will be appended per phase._

## Decisions

- The device-role vocabulary work is committed under #599 (rather than a separate issue) because #599 names it as its direct prerequisite and re-homes where the role fact is authored; splitting it would create a stacked PR, which this repo avoids.
- `revoked` is deliberately a tombstone state, not a member of `GrantableRole` — never offered in pickers, never mintable.
- The vault's `consent_device.trust` mirror is unchanged by design: `admin` and `write` both collapse to `full` (minting/revoking are gateway-plane concerns).

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

Result at commit time: 3 files, 23 tests, all passing. Full suites for gateway/client/tunnel were green in the authoring session, and `bun run check:pr:full` runs before requesting merge (shared packages `client`, `protocol`, `tunnel`, `gateway` all move). The `packages/tunnel/fixtures/wire-golden.json` diff is limited to dropping the client-supplied `"trust":"full"` field from the pair-request payload.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS**

Every claim now matches the staged diff. Gateway serve plane: `enrollment-store.ts` defines the `DeviceRole`/`GrantableRole` lattice with `canWrite()`, `pairing-store.ts` bakes the role in at mint (founding → `admin`), `gateway-db.ts` carries the CHECK constraints on both `devices.role` and `tickets.role`, `build-gateway.ts` renames the read-role gate and adds the `isDirectHostRequest` short-circuit for `_gateway/devices/ticket` (covered by the new `pairing-ticket-host-custody.test.ts`), and `serve.ts` is a 6/4 comment-only hunk with `publicPaths` itself untouched. Route gates: `replica-intent-route.ts:179` is the `canWrite` mutation gate, `replica-shape.ts:338` clamps `mayAct`, `replica-access.ts` is the `trust` → `role` rename keeping the `revoked` rejection, and `devices-routes.ts` gates mint/revoke on `role !== 'admin'` with `body.role ?? 'write'` and last-admin confirmation. Wire: `gateway-endpoint.ts` removes the client-supplied `trust` field (role is server-minted only), `wire-golden.json` shrinks 131 → 116 bytes accordingly, and `protocol/src/routes.ts` deletes the now-unreferenced `gatewayPair` constant. CLI, client, and docs claims all hold, the file list matches `git diff --cached --stat` exactly, and no files are invented.

### Check 2: Each "- [x]" checklist item is realized in the diff

**Verdict: PASS**

The single checked item — "Device role vocabulary (prerequisite)" — is realized in full: the `DeviceRole` / `GrantableRole` lattice and `canWrite()` in `enrollment-store.ts`, role-in-ticket in `pairing-store.ts` + `devices-routes.ts` + `device-admin.ts`, the `ROLE_PRESETS` picker in `DevicePairPanel.tsx`, and the "Device roles" section in `docs/glossary.md`. The nine unchecked items are later phases and correctly carry no claim.

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
