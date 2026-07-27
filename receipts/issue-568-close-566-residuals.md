# issue-568 — Close #566 residuals: loopback forwarders, CLI key custody, service install, and the #555 coverage/doc debt

GitHub issue: [#568](https://github.com/srikanth235/centraid/issues/568)

Follow-up to [#555](https://github.com/srikanth235/centraid/issues/555) /
[#566](https://github.com/srikanth235/centraid/issues/566). #566 is merged
(`1ab6fb4e`), so every item here was a live failure mode on the trunk. Nothing
in this change set is a redesign — each item is a localized fix in code #566
already touched, plus the tests and docs that should have locked it.

The organising observation, which most of the security items are instances of:
**loopback is not an identity.**

## Checklist

Acceptance criteria, mirroring the issue:

- [x] `desktop-tunnel.ts` strips any client-supplied device/proof header and stamps the proved identity, or refuses the founding routes; a test drives a request through that forwarder and asserts it cannot mint a founding ticket
- [x] `embedded-gateway.ts` passes `canMintFoundingTicket`; the embedded gateway no longer falls back to bare `isLoopbackRequest`
- [x] `GET /centraid/_gateway/info` returns `endpointTicket` only to a bearer-authenticated caller; a test asserts an unauthenticated loopback GET omits it
- [x] The founding-window admit-anyone rule keys on a deliberately chosen TTL, documented in the code, and the gateway-scope prefixes reachable on a fresh gateway are an explicit list rather than an accident of dispatch order
- [x] All five `openVaultRegistry` calls in `vault-admin.ts` / `device-admin.ts` / `status-admin.ts` receive `daemonKeyStore(layout.keysDir)`; `vault list`, `status`, `devices add --vault`, and `devices revoke` all work against a daemon-created (protected) data dir, asserted by a test
- [x] `devices revoke` performs its vault-local data erasure against a protected data dir — asserted positively, not by absence of an error
- [x] macOS `service install` validates/adopts before writing the Keychain credential; a failed install leaves custody exactly as it found it; the Keychain account is keyed per `keysDir`
- [x] Desktop and an installed OS service agree on the control bearer; opting into the service does not produce a permanent `'foreign'` refusal on the next desktop launch
- [x] An interrupted founding ceremony is resumable from the first-run screen; closing the app between kit download and verify does not require filesystem surgery
- [x] `devices list`, `backup status`, and `backup list` print the actionable "the running daemon owns this" message instead of a raw `database is locked`; `lock-admin.test.ts` actually reads a `gateway.db` table
- [x] macOS network-filesystem detection reads `statfs.f_fstypename` (not `stat -f %T`), returns true on a real NFS/SMB mount, and no longer suppresses the `statfsSync` fallback; a test covers the darwin branch
- [x] `mintFounding` cannot destroy an in-flight restore; a test mints a second founding ticket mid-restore and asserts the restore still commits
- [x] `parseRecoveryKit` requires the password — the unwrapped-kit acceptance branch is gone; `writeRecoveryKit` is deleted or justified
- [x] Every erase refusal path has a test asserting the refusal: wrong typed name, non-owner caller, unverified kit, missing custody, generic-delete ceremony guard
- [x] A test asserts the founding routes and `/centraid/_gateway/devices/ticket` 401 without a bearer, so re-adding them to `publicPaths` fails CI
- [x] `devices-routes.test.ts` covers DELETE idempotency, 405s, foreign-vault 404, peer-delete 403, self-unpair by a non-owner, `vault_required`, no-endpoint 409, and `uninitialized` 409
- [x] The create → kit → verify → erase → restore journey exists as an e2e flow, or #566's receipt records it as deliberately covered by integration only
- [x] `SECURITY.md` and `cli.ts` describe the landlord bearer accurately (derived, stable, not per-boot); the "every request resolves a real enrollment" sentence is corrected for the public and fresh-gateway surfaces
- [x] `vault-registry.ts`'s "never HTTP" contract, `sealed.ts`'s #298 framing, and `cli/paths.ts`'s `pairingTicketsFile` name match the code
- [x] `docs/recovery/` documents erase and restore-after-erase; `ARCHITECTURE.md` carries the at-rest format table; `CHANGELOG.md` has an entry for #555
- [x] This issue's receipt records the four #566 claims that outran their evidence (parity test, `init-ticket` mock citation, #298 crosswalk, "nothing deferred") with their true state — #566's own receipt is left byte-identical, since `doc-integrity` freezes merged receipts

## What changed

One commit. The items are one interlocking sweep — several source changes
forced the test updates that keep the suite honest, and the doc corrections in
item J are the same edit as the code they describe — so splitting them would
have produced intermediate trees that neither compile nor read coherently.

### Files touched

Every path in the change set, with the item it serves.

| Path | Why |
| --- | --- |
| `packages/tunnel/src/protocol.ts` | The three identity headers become the transport's own wire contract; adds `TUNNEL_FORWARDED_HEADER` (A) |
| `packages/tunnel/src/index.ts` | Re-exports those constants (A) |
| `packages/tunnel/src/desktop-tunnel.ts` | Strips client identity headers, stamps the forwarded marker (A) |
| `packages/tunnel/src/native-relay.ts` | The Rust desktop relay's `/authorize` returns the forwarded marker (A) |
| `packages/tunnel/data-plane/src/iroh_wire.rs` | Drops client copies of the identity headers; new unit test (A) |
| `packages/gateway/src/routes/route-helpers.ts` | New `isDirectHostRequest` — the single host-only capability gate (A/B) |
| `packages/gateway/src/routes/route-helpers.test.ts` | Covers that predicate, including that it is strictly stronger than bare loopback (A/B, L) |
| `packages/gateway/src/cli/endpoint-host.ts` | `canMintFoundingTicket` IS `isDirectHostRequest`; one `forwardedIdentityHeaders` helper; ticket-TTL admission (A/C) |
| `packages/gateway/src/serve/build-gateway.ts` | Hardened embed fallback, `FRESH_GATEWAY_SCOPE_PREFIXES`, `foundingPending` wiring (B/C/G) |
| `packages/gateway/src/index.ts` | Exports `isDirectHostRequest` and `landlordBearerForDataDir` (B/F) |
| `apps/desktop/src/main/embedded-gateway.ts` | Passes `canMintFoundingTicket` explicitly (B) |
| `packages/app-engine/src/http/http-server.ts` | Evaluates a credential on public paths and stamps `AUTHED_PLANE_HEADER` (C) |
| `packages/app-engine/src/index.ts` | Exports that header constant (C) |
| `packages/gateway/src/routes/gateway-info-routes.ts` | `endpointTicket` gated on the auth marker; serves `foundingPending` (C/G) |
| `packages/protocol/src/handshake.ts` | Additive `foundingPending` wire field; corrected `endpointTicket` doc (C/G) |
| `packages/gateway/src/serve/pairing-store.ts` | `hasOpenFoundingWindow`; `mintFounding` refuses a reserved slot; reservation methods delegate (C/K) |
| `packages/gateway/src/serve/founding-reservations.ts` | New: the reservation table's own module, extracted so `pairing-store.ts` stays under the size cap (C/K) |
| `packages/gateway/src/routes/founding-routes.ts` | 409 `founding_in_progress`; releases the slot on every non-consuming failure (K) |
| `packages/gateway/src/cli/vault-admin.ts` | `openVaultRegistry` receives `daemonKeyStore` (D) |
| `packages/gateway/src/cli/device-admin.ts` | Same, at all three call sites including the revoke cleanup registry (D) |
| `packages/gateway/src/cli/status-admin.ts` | Same (D) |
| `packages/gateway/src/cli/key-store.ts` | `keychainAccountFor` (per-`keysDir` account) and `hostCredentialKey` (E) |
| `packages/gateway/src/cli/service-admin.ts` | Adopt before writing; adopt the host credential rather than a random one (E) |
| `packages/gateway/src/cli/service-credential.ts` | New: the adopt-before-write rule, shared by both platform installers (E) |
| `packages/gateway/src/cli/landlord-auth.ts` | `landlordBearerForDataDir`; corrected per-boot doc (F/J) |
| `apps/desktop/src/main/detached-gateway.ts` | Probes the derived bearer as a second candidate (F) |
| `packages/client/src/react/screens/FoundingScreen.tsx` | New `verify` mode for a resumed ceremony (G) |
| `packages/client/src/react/screens/FirstRunGate.tsx` | Auto-selects verify, and always offers "I already have my kit" (G) |
| `packages/client/src/react/boot.tsx` | Threads `foundingPending` into the gate (G) |
| `packages/client/src/gateway-client-founding.ts` | Reads `foundingPending` off the handshake (G) |
| `packages/gateway/src/serve/gateway-db.ts` | Read-only lock probe; darwin mount-table filesystem detection (H/I) |
| `packages/gateway/src/serve/gateway-db.test.ts` | Covers the darwin branch in both directions (I, L) |
| `packages/gateway/src/cli/lock-admin.test.ts` | Repairs the false-positive leg; adds a real `gateway.db` read (H, L) |
| `packages/backup/src/recovery-kit.ts` | Deletes the unwrapped acceptance branch; password now required (J) |
| `packages/backup/src/recovery-kit.test.ts` | Drives the validator through `wrapRecoveryKit`; asserts the refusals (J, L) |
| `packages/backup/src/engine.ts` | Deletes `writeRecoveryKit` (J) |
| `packages/backup/src/index.ts` | Drops its exports (J) |
| `packages/gateway/src/backup/recover.ts` | Required password; canonical keyring comparison (J) |
| `packages/gateway/src/backup/recover.integration.test.ts` | Wrapped kits + password (J) |
| `packages/gateway/src/backup/recover-live.integration.test.ts` | Same; this file holds the erase → restore journey (J, L) |
| `packages/gateway/src/serve/vault-registry.ts` | Corrects the "never HTTP" contract on create/delete (J) |
| `packages/vault/src/schema/sealed.ts` | Records the #555 erase amendment to #298 item 2 (J) |
| `packages/gateway/src/cli/paths.ts` | Deletes the three misleading `gateway.db` aliases (J) |
| `packages/gateway/src/cli/cli.ts` | Corrects the "ephemeral per-boot secret" description (J) |
| `packages/gateway/src/routes/founding-forwarder.test.ts` | New: a real phone over a real tunnel cannot mint a founding ticket (A/B, L) |
| `packages/gateway/src/cli/admin-custody.test.ts` | New: the admin CLIs against a protector-ful data dir (D, L) |
| `packages/gateway/src/routes/vault-erase.test.ts` | The five erase refusal paths (L) |
| `packages/gateway/src/serve/authz-matrix.smoke.test.ts` | `publicPaths` 401 regression + the `endpointTicket` gate (C, L) |
| `packages/gateway/src/routes/devices-routes.test.ts` | The eight uncovered branches (L) |
| `packages/gateway/src/serve/device-plane.test.ts` | Second-mint-mid-restore and slot-release (K, L) |
| `packages/gateway/src/routes/founding-routes.test.ts` | Renamed window predicate (C) |
| `packages/gateway/src/serve/founding-recovery.test.ts` | Renamed window predicate (C) |
| `packages/gateway/src/cli/admin.test.ts` | Registries opened with daemon custody; `gatewayDbFile` (D/J) |
| `SECURITY.md` | Landlord bearer and the enrollment sentence corrected (J) |
| `ARCHITECTURE.md` | The at-rest format table (L) |
| `CHANGELOG.md` | The #555 entry plus this issue's fixes (L) |
| `docs/recovery/vault-erase.md` | New: erase and restore-after-erase runbook (L) |
| `docs/recovery/backup-restore.md` | Cross-links it; notes the unwrapped-kit refusal (L) |
| `AGENTS.md` | Docs-index row names the erase runbook (L) |
| `receipts/issue-568-close-566-residuals.md` | This receipt |

### A + B — loopback is not an identity, on both forwarders

The three identity headers moved into the transport's own wire contract
(`packages/tunnel/src/protocol.ts`): `DEVICE_IDENTITY_HEADER`,
`DEVICE_PROOF_HEADER`, and a new `TUNNEL_FORWARDED_HEADER`. Every forwarder
in the product now strips a client copy and stamps its own markings:

- `packages/tunnel/src/desktop-tunnel.ts` (`serveStream`) deletes the two
  identity headers and stamps the forwarded marker. This forwarder carries a
  paired PHONE to the desktop's loopback gateway under the HOST bearer, so it
  has no device key to stamp — it can only refuse to let the phone claim one,
  and mark the hop so host-only capabilities refuse it.
- `packages/tunnel/src/native-relay.ts` returns the same marker from the
  desktop relay's `/authorize`, and
  `packages/tunnel/data-plane/src/iroh_wire.rs` drops any client copy of the
  identity headers on the same pass it already dropped `host` and the relay
  proof. This matters because `startPreferredDesktopTunnel` prefers the Rust
  relay in production; fixing only the JS path would have been cosmetic.
- `packages/gateway/src/cli/endpoint-host.ts` stamps the marker alongside the
  proved identity from a single `forwardedIdentityHeaders` helper, and now
  re-exports the header names from `@centraid/tunnel` instead of redeclaring
  them.

`packages/gateway/src/routes/route-helpers.ts` gained `isDirectHostRequest` —
a loopback socket AND the absence of every forwarder marking — and it is now
the single definition of a host-only request. `endpoint-host.ts`'s
`canMintFoundingTicket` IS that function.

`embedded-gateway.ts` passes `canMintFoundingTicket`; the embedded gateway no
longer falls back to bare `isLoopbackRequest`: `apps/desktop/src/main/embedded-gateway.ts`
passes `canMintFoundingTicket: isDirectHostRequest` (newly exported from
`@centraid/gateway`), and `build-gateway.ts`'s own fallback for a
`hostDeviceEndpointId` embed was changed from `isLoopbackRequest` to the same
predicate, so a caller that forgets the option still gets the hardened gate.

`buildGateway`'s `embeddedAccess.deviceKeyFor` deliberately stays on
`isLoopbackRequest`, with a comment saying why: tightening it would sever
phone-link entirely, and ordinary vault access is not a host-only capability.

### C — the dial ticket is no longer public, and the founding window is bounded

`packages/app-engine/src/http/http-server.ts` now evaluates a presented
credential on public paths too (without requiring one) and stamps a new
server-owned `AUTHED_PLANE_HEADER`, stripped from every inbound request first
exactly like `AUTHED_DEVICE_HEADER`. `gateway-info-routes.ts` gates
`endpointTicket` on that marker instead of `isLoopbackRequest`, whose own doc
comment said "never publish this beyond the local host" while a browser fetch
to `http://127.0.0.1:<port>` satisfied it.

The founding-window admit-anyone rule keys on a deliberately chosen TTL,
documented in the code, and the gateway-scope prefixes reachable on a fresh
gateway are an explicit list rather than an accident of dispatch order:
`PairingTicketStore.hasActiveFounding` became `hasOpenFoundingWindow` and now
keys on the ticket's own ten minutes rather than the two-hour restore
reservation — the reservation exists to keep ONE already-admitted caller's
slow restore alive, and stretching admission to two hours widened the blast
radius of a leaked dial ticket twelvefold for no ceremony benefit. The
fresh-gateway surface is now a named `FRESH_GATEWAY_SCOPE_PREFIXES` constant
with a per-prefix rationale.

### D — the admin CLIs open key custody the way the daemon does

All five `openVaultRegistry` calls in `vault-admin.ts` / `device-admin.ts` /
`status-admin.ts` receive `daemonKeyStore(layout.keysDir)`; `vault list`,
`status`, `devices add --vault`, and `devices revoke` all work against a
daemon-created (protected) data dir, asserted by a test. The failure was
silent by construction: the protector-less store threw `unsupported_scheme`,
`vault-registry.ts` swallowed it into `failedMountsByDir`, and `list()`
returned `[]`.

### E + F — service install custody, and the desktop ↔ service control bearer

`packages/gateway/src/cli/service-admin.ts`: **macOS `service install`
validates/adopts before writing the Keychain credential; a failed install
leaves custody exactly as it found it; the Keychain account is keyed per
`keysDir`.** Three changes together:

1. `adoptKeyStoreCredential` runs BEFORE the credential is committed, on both
   the launchd and systemd paths.
2. `buildSpec` no longer mints `randomBytes(32)` when
   `CENTRAID_KEYSTORE_MASTER_KEY` is unset. It takes the external host
   credential the headless `serve` already wrapped every key under
   (`hostCredentialKey`, new in `cli/key-store.ts`), so adoption can succeed
   at all. `--dry-run` uses an in-memory placeholder so it still mutates
   nothing.
3. The Keychain account is `keychainAccountFor(keysDir, label)` — a
   `sha256(keysDir)` prefix, mirroring `headlessCredentialFile` — and
   `credentialWrappingKey` resolves the same default, so one data dir's
   install can no longer overwrite another's credential.

`landlordBearerForDataDir` (new, `cli/landlord-auth.ts`, exported from
`@centraid/gateway`) derives the bearer an already-running daemon uses when no
parent pinned `CENTRAID_GATEWAY_TOKEN`. `apps/desktop/src/main/detached-gateway.ts`
probes with its safeStorage token first and that derived bearer second, so
**desktop and an installed OS service agree on the control bearer; opting into
the service does not produce a permanent `'foreign'` refusal on the next
desktop launch.** Deriving was chosen over putting the token in the unit env:
a plist/unit file is world-readable, and deriving also works for a service the
desktop did not install.

### G — the founding ceremony resumes

An interrupted founding ceremony is resumable from the first-run screen;
closing the app between kit download and verify does not require filesystem
surgery. `GatewayInfo` gained an additive `foundingPending` flag (COMPAT(#568)),
set when a vault exists but its kit is unverified — the state where `/info`
reports `uninitialized` while Create, Restore, and erase all 409.
`FoundingScreen` gained a `verify` mode that renders the re-select step without
the in-memory `created` result, and `FirstRunGate` both auto-selects it when
the gateway reports the pending ceremony and always offers an "I already have
my kit" choice (an older gateway omits the flag, and the user still needs a way
back in).

### H + I — read-only lock errors, and darwin filesystem detection

`GatewayDatabase.open` probes with `SELECT 1 FROM sqlite_schema` inside its own
try for `read-only` opens. A read-only open against an EXCLUSIVE-locked
database succeeds — the constructor and pragmas never touch a page — so the
lock was not observed until the first real SELECT, outside every caller's
`GatewayLockError` handling. With the probe, **`devices list`, `backup status`,
and `backup list` print the actionable "the running daemon owns this" message
instead of a raw `database is locked`; `lock-admin.test.ts` actually reads a
`gateway.db` table.**

**macOS network-filesystem detection reads `statfs.f_fstypename` (not
`stat -f %T`), returns true on a real NFS/SMB mount, and no longer suppresses
the `statfsSync` fallback; a test covers the darwin branch.** BSD `stat -f`
takes a format string and `%T` is the `ls -F` type indicator — it exited 0 with
a value the regex could never match, and that success also short-circuited the
Linux fallback. The replacement parses the mount table (longest matching mount
point wins) and returns `undefined` when it cannot answer, so the fallback
still runs.

### J + K — stale contracts, the password-free kit branch, and the founding slot

`parseRecoveryKit` requires the password — the unwrapped-kit acceptance branch
is gone; `writeRecoveryKit` is deleted or justified. Both: the plain branch is
removed (it also silently ignored the supplied password, leaving a
password-free acceptance path on `vaults:restore`, `vaults:initialize/verify`,
and kit-confirmed), and `writeRecoveryKit` — the plaintext emitter with zero
production callers — is deleted along with `WriteRecoveryKitOptions`.
`RecoverInput.password` is now required rather than optional.

`mintFounding` cannot destroy an in-flight restore; a test mints a second
founding ticket mid-restore and asserts the restore still commits. Because
`one_founding_ticket` is a partial UNIQUE index, the fix is to REFUSE the mint
while a reservation is live (route: 409 `founding_in_progress`) rather than
replace the row a running ceremony depends on. A new `releaseFounding` hands
the slot back on every failure path that never consumed the ticket, so a
restore that dies on a wrong password does not wedge the ceremony for the
reservation's full two hours.

**`SECURITY.md` and `cli.ts` describe the landlord bearer accurately (derived,
stable, not per-boot); the "every request resolves a real enrollment" sentence
is corrected for the public and fresh-gateway surfaces.** Also corrected:
**`vault-registry.ts`'s "never HTTP" contract, `sealed.ts`'s #298 framing, and
`cli/paths.ts`'s `pairingTicketsFile` name match the code** — the registry's
create/delete comments now say "ADMIN act, not CLI-only" and name the founding
and erase HTTP callers; `sealed.ts` carries the #555 erase amendment; and the
three misleading `DaemonLayout` aliases (`pairingTicketsFile`, `devicesFile`,
`webSessionsFile`, all resolving to `gateway.db`) are deleted with callers
moved to `gatewayDbFile`.

### L — docs

`docs/recovery/` documents erase and restore-after-erase; `ARCHITECTURE.md`
carries the at-rest format table; `CHANGELOG.md` has an entry for #555. The new
[docs/recovery/vault-erase.md](../docs/recovery/vault-erase.md) covers the
roll-forward invariant, the refusal matrix with what to do about each, the
stranded-erase runbook, the same-box restore, and when to stop trying. The
ARCHITECTURE table names each on-disk slot's format, what protects it, and —
the column that actually matters — what a copy without custody yields.

### One fix outside the issue's list

`recover.ts` compared the custody keyring against the kit's with raw
`JSON.stringify`, which compares key ORDER. The custody file preserves its
write-time insertion order while a kit's keyring comes back from
`canonicalJson` inside the password wrap with keys sorted. That was latent
while an unwrapped kit was accepted; deleting the plain branch made every
restore-after-erase fail with "gateway custody contains a different backup
keyring". Now compared canonically.

## Corrections to #566's receipt

`doc-integrity` freezes merged `receipts/*.md` byte-immutable, on the principle
that a past receipt is evidence of what was true then. #566's receipt is left
byte-identical; these four claims outran their evidence and are corrected here
so the trunk carries an accurate account.

| #566 claim | True state |
| --- | --- |
| The laptop/VPS parity item describes a `centraid-gateway serve --data-dir` tree | The test drives an **in-process `serve()`** with `--init-vault` on both arms. It proves layout parity of the two option sets, not that two spawned daemon processes produce identical trees |
| The `init-ticket` guidance item cites `admin.test.ts` as evidence | `admin.test.ts` is a **mock that re-implements the asserted message** in its own fake fetch handler. It proves the CLI surfaces a message it was handed, not that the gateway emits that guidance |
| The crosswalk cites `vault-erase.test.ts` as evidence the #298 amendment is documented | The real evidence is `docs/decisions.md`'s "#298 erase amendment" row. A test can demonstrate the behaviour; it cannot be the documentation. `packages/vault/src/schema/sealed.ts` now carries the amendment note too (item J) |
| "Out of scope: none of #555's 92 items are deferred" | Contradicted by the docs gaps this issue closes: `docs/recovery/` had zero mentions of erase, `ARCHITECTURE.md` had no at-rest format table, and `CHANGELOG.md` had no #555 entry. Those were deferred, not done |

On the fifth item: **the create → kit → verify → erase → restore journey
exists as an e2e flow, or #566's receipt records it as deliberately covered by
integration only.** This receipt takes the second branch and records it here,
since #566's is frozen. Journey 1 is covered by
`packages/gateway/src/backup/recover-live.integration.test.ts` ("erase then
restore on the same box preserves gateway identity and drops prior
enrollments"), which drives a real `serve()`, a real provider, a real erase
over HTTP, and a real founding restore. It is deliberately NOT an
`agent-e2e-pairing` flow: those flows exist to exercise the **transport**
(iroh dial, QR scan, two hosts), and this journey's risk is entirely
gateway-local state and custody. Journey 2 (headless founding) genuinely needs
the transport and stays at `tests/agent-e2e-pairing/flows/vps-phone-founding.mjs`.

## Decisions

- **Item A: refuse-the-capability, not stamp-the-identity.** The issue offered
  both. Stamping the phone's EndpointId would have changed device resolution:
  against a detached daemon, `deviceKeyFor` requires the per-boot proof header
  (which this forwarder cannot produce), so a stamped-but-unproven device
  header would resolve to `undefined` and sever phone-link entirely. The
  forwarded marker refuses the host-only capability without touching ordinary
  vault access.
- **Item F: derive, don't ship the token in the unit.** Putting
  `CENTRAID_GATEWAY_TOKEN` in the plist/unit would write a long-lived secret
  into a world-readable file. Deriving it from the endpoint key the desktop
  already holds also works for a service the desktop did not install.
- **Item K: refuse the mint, don't allow two tickets.** `one_founding_ticket`
  is a partial UNIQUE index, so "keep the reserved ticket and add a new one" is
  not representable. Refusing with 409 `founding_in_progress` is the only safe
  answer, and it required adding `releaseFounding` so a failed attempt does not
  wedge the slot for two hours — that release is a behaviour change beyond the
  issue's text, and it is load-bearing.
- **Item E: adopt the existing host credential rather than mint a random one.**
  "Validate before writing" alone would have turned every
  `serve`-then-`service install` into a hard abort, because a fresh random key
  can never decrypt keys already wrapped under the fallback credential. Reusing
  that credential is what makes the ordering fix useful rather than merely safe.
- **A latent bug fixed outside the issue's list.** `recover.ts`'s keyring
  equality check compared JSON key order. Deleting the plain-kit branch made it
  fire on every restore-after-erase, so it is fixed here rather than filed.

## Out of scope

- Coding-agent runner sandboxing (still unfiled from #555 — spawned CLIs run at
  the user's uid and can read sealing keys regardless of at-rest wrapping).
  Named explicitly in the new ARCHITECTURE at-rest section so the limit is
  written down.
- Webhook ingress (still unfiled from #555 — needs a product decision first).
- Any redesign of the founding gate, the lock, or the custody seam.
- Rotation of the landlord bearer. The change in character (derived and stable,
  not per-boot) is now documented in `SECURITY.md`, `cli.ts`, and
  `landlord-auth.ts`; whether to add rotation is a separate decision and needs
  its own issue, since rotating `endpoint-key.bin` rotates the gateway's
  permanent EndpointId and forces every device to re-pair.
- The desktop `deviceKeyFor` privilege question. A QR-paired phone still
  resolves to the desktop OWNER's EndpointId over the phone tunnel. The issue
  bounds this as acceptable (that phone was paired by the user and already
  holds the bearer over the same tunnel) and asks only that the asserted
  invariants become true. Narrowing it would need a device-key story for the
  desktop tunnel, which is a design change, not a residual.

## Verification

Every checklist item above, restated as what was actually run.

- `desktop-tunnel.ts` strips any client-supplied device/proof header and stamps
  the proved identity, or refuses the founding routes; a test drives a request
  through that forwarder and asserts it cannot mint a founding ticket —
  `packages/gateway/src/routes/founding-forwarder.test.ts` pairs a real iroh
  phone client to a real `startDesktopTunnel`, forwards to the real founding
  route wired with the real `isDirectHostRequest`, and asserts 403
  `possession_required` while the host's own request mints. A header-mirror
  route proves WHAT arrived: the client's identity headers are gone, the
  forwarded marker is present, and an ordinary `x-passthrough` header still
  rides through (so the strip is targeted, not a blanket filter).
- `embedded-gateway.ts` passes `canMintFoundingTicket`; the embedded gateway no
  longer falls back to bare `isLoopbackRequest` — asserted by
  `route-helpers.test.ts`'s "is strictly stronger than the bare-loopback gate
  it replaced", which shows `isLoopbackRequest` says yes to exactly the request
  `isDirectHostRequest` refuses.
- `GET /centraid/_gateway/info` returns `endpointTicket` only to a
  bearer-authenticated caller; a test asserts an unauthenticated loopback GET
  omits it — `authz-matrix.smoke.test.ts`, against a real `serve()`. The same
  test asserts a WRONG bearer is treated as anonymous, not as "close enough
  because it is loopback", and that the handshake fields still answer.
- The founding-window admit-anyone rule keys on a deliberately chosen TTL,
  documented in the code, and the gateway-scope prefixes reachable on a fresh
  gateway are an explicit list rather than an accident of dispatch order — the
  TTL choice and its rationale are in `hasOpenFoundingWindow`'s doc comment and
  at the `authorizeEndpoint` call site; the prefix list is
  `FRESH_GATEWAY_SCOPE_PREFIXES` with a per-prefix reason.
- All five `openVaultRegistry` calls in `vault-admin.ts` / `device-admin.ts` /
  `status-admin.ts` receive `daemonKeyStore(layout.keysDir)`; `vault list`,
  `status`, `devices add --vault`, and `devices revoke` all work against a
  daemon-created (protected) data dir, asserted by a test —
  `packages/gateway/src/cli/admin-custody.test.ts` builds a data dir whose
  sealkey is an `aes-256-gcm-v1` envelope, asserts a protector-less reader sees
  `[]` (the precondition), then drives the CLI verbs. `admin.test.ts`'s own
  registries were moved onto `daemonKeyStore` for the same reason.
- `devices revoke` performs its vault-local data erasure against a protected
  data dir — asserted positively, not by absence of an error — the test seeds a
  `replica_intent_outcome` row for the device, revokes, and asserts
  `listReplicaIntentOutcomes` is empty afterwards.
- macOS `service install` validates/adopts before writing the Keychain
  credential; a failed install leaves custody exactly as it found it; the
  Keychain account is keyed per `keysDir` — code-level reordering plus the
  credential-selection change; `service-admin.test.ts` and
  `service-install.integration.test.ts` pass unchanged. Manual macOS validation
  (`serve` once, then `service install`) is listed in the issue's Validation
  and is a host-mutating gesture; it is **not** run here.
- Desktop and an installed OS service agree on the control bearer; opting into
  the service does not produce a permanent `'foreign'` refusal on the next
  desktop launch — `landlordBearerForDataDir` derives the same value
  `cli.ts` computes from the same custody, and `ensureDetachedGateway` tries it
  as a second candidate. The full desktop-onboarding round trip is the issue's
  manual step and is not run here.
- An interrupted founding ceremony is resumable from the first-run screen;
  closing the app between kit download and verify does not require filesystem
  surgery — `FirstRunGate`'s `verify` mode reaches
  `vaults:initialize/verify`, which is gated only on an owner enrollment (the
  ceremony already created one) and never on `isFresh()`.
- `devices list`, `backup status`, and `backup list` print the actionable "the
  running daemon owns this" message instead of a raw `database is locked`;
  `lock-admin.test.ts` actually reads a `gateway.db` table — the repaired test
  file now holds three legs: the pre-existing vault-list leg (annotated with
  why it can NOT stand in for the behaviour, since it never issues a
  `gateway.db` read), a new leg driving `commandDevices(['list'])` against a
  held EXCLUSIVE lock, and a leg proving a read-only open still reads a real
  table when nothing holds the lock.
- macOS network-filesystem detection reads `statfs.f_fstypename` (not
  `stat -f %T`), returns true on a real NFS/SMB mount, and no longer suppresses
  the `statfsSync` fallback; a test covers the darwin branch —
  `gateway-db.test.ts` drives the parser with a real `/sbin/mount` table
  containing apfs, smbfs, nfs, and autofs rows, asserts longest-mount-point
  wins, asserts true on the remote mounts and false on the local one, and
  asserts an unreadable table stays `undefined` so the fallback still runs. The
  mount-line format was verified against this machine's live `/sbin/mount`.
- `mintFounding` cannot destroy an in-flight restore; a test mints a second
  founding ticket mid-restore and asserts the restore still commits —
  `device-plane.test.ts` reserves and stages a founding restore, asserts the
  second mint is refused, asserts the staged vault ids survive, and then
  asserts the restore commits its owner enrollment.
- `parseRecoveryKit` requires the password — the unwrapped-kit acceptance
  branch is gone; `writeRecoveryKit` is deleted or justified —
  `recovery-kit.test.ts` asserts an unwrapped kit is refused even with the
  right password and even with an empty one, and that a wrapped kit still
  requires a non-empty password. The document-validation tests were rewritten
  to drive `wrapRecoveryKit`, which is where the validator is now reachable.
- Every erase refusal path has a test asserting the refusal: wrong typed name,
  non-owner caller, unverified kit, missing custody, generic-delete ceremony
  guard — `vault-erase.test.ts` gained six tests covering `owner_required`,
  `erase_unavailable`, `typed_name_required` (six near-miss names including
  leading/trailing space and case), `recovery_kit_not_verified`,
  `erase_ceremony_required`, and the pre-guard 405.
- A test asserts the founding routes and `/centraid/_gateway/devices/ticket`
  401 without a bearer, so re-adding them to `publicPaths` fails CI — five new
  rows in `authz-matrix.smoke.test.ts`'s table, plus one asserting
  `_gateway/info` stays public.
- `devices-routes.test.ts` covers DELETE idempotency, 405s, foreign-vault 404,
  peer-delete 403, self-unpair by a non-owner, `vault_required`, no-endpoint
  409, and `uninitialized` 409 — seven new tests, 5 → 12.
- `SECURITY.md` and `cli.ts` describe the landlord bearer accurately (derived,
  stable, not per-boot); the "every request resolves a real enrollment"
  sentence is corrected for the public and fresh-gateway surfaces — the
  enrollment sentence now scopes itself to vault-scoped requests and names both
  exceptions.
- `vault-registry.ts`'s "never HTTP" contract, `sealed.ts`'s #298 framing, and
  `cli/paths.ts`'s `pairingTicketsFile` name match the code — the three
  aliases are deleted rather than renamed, since all three were the same lie.
- `docs/recovery/` documents erase and restore-after-erase; `ARCHITECTURE.md`
  carries the at-rest format table; `CHANGELOG.md` has an entry for #555 — new
  `docs/recovery/vault-erase.md`, cross-linked from `backup-restore.md` and the
  AGENTS.md docs index; new "At-rest formats" subsection under On-disk layout;
  CHANGELOG gains Added/Changed/Removed/Fixed entries for #555 and #568.
- The create → kit → verify → erase → restore journey exists as an e2e flow,
  or #566's receipt records it as deliberately covered by integration only —
  recorded above under **Corrections to #566's receipt**, with the reasoning.
- This issue's receipt records the four #566 claims that outran their evidence
  (parity test, `init-ticket` mock citation, #298 crosswalk, "nothing
  deferred") with their true state — #566's own receipt is left byte-identical,
  since `doc-integrity` freezes merged receipts — the table above; `git status`
  shows no modification to `receipts/issue-555-*`.

### Commands

The gates, in the order they were run:

```sh
bun install && bun run build && bun run typecheck && bun run lint && bun run knip
```

The suites for every package this change set touches:

```sh
bunx turbo run test --filter='...[origin/main]' --concurrency=1
```

The Rust half of the tunnel (item A's relay fix and its new unit test):

```sh
cd packages/tunnel && cargo test --locked --manifest-path data-plane/Cargo.toml && bun run lint:data-plane
```

The tests written for this issue, on their own:

```sh
cd packages/gateway && ../../node_modules/.bin/vitest run src/routes/founding-forwarder.test.ts src/routes/route-helpers.test.ts src/routes/vault-erase.test.ts src/routes/devices-routes.test.ts src/cli/admin-custody.test.ts src/cli/lock-admin.test.ts src/serve/authz-matrix.smoke.test.ts src/serve/gateway-db.test.ts src/serve/device-plane.test.ts
```

The full pre-push gate, run at serial concurrency because `test:affected` at
`-c6` saturates this machine and trips vitest's `onTaskUpdate` RPC timeout:

```sh
bun run check:pr:full
```

### Gates

- `bun run typecheck` — green across all 32 tasks.
- `bun run lint` / `bun run format:check` — green.
- `bun run knip` — green (two pre-existing configuration hints, no errors).
- Full `@centraid/gateway` vitest suite, `@centraid/backup`, `@centraid/tunnel`,
  `@centraid/app-engine`, `@centraid/client` — see the run recorded below.
- `bun run check:pr` before push.

### Not run

- The two manual macOS gestures in the issue's Validation (a real
  `service install` after a `serve`, and the desktop onboarding opt-in round
  trip). Both mutate host custody / the user's LaunchAgents.
- A real NFS/SMB mount for the darwin filesystem probe. The parser is covered
  against captured `mount` output in both directions; mounting a share is a
  host gesture.

## Steering

No human-steering events (interrupts or mid-task corrections) were observed in the transcript. The session contained only the initial `/goal` command (an ordinary task instruction, not steering per governance rules), system messages, and tool results. 

- Check (1) every human-steering event recorded as a row: **PASS** — zero steering events, zero rows appended.
- Check (2) no non-steering recorded as steering: **PASS** — the initial /goal is an ordinary instruction, correctly excluded.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS** with one organizational note.

The receipt describes "Commit 1" covering code/test fixes (items A–K plus L's tests) and "Commit 2" covering prose deliverables (docs). The staged diff includes ALL files—both Commit 1 and Commit 2 content—staged together in one `git status`. The receipt's "## What changed" section's description of the two commits is an organizational/planning structure rather than a literal description of the git staging state.

However, the **FILES TOUCHED table accurately lists every file in the staged diff**, including all 60 paths with their item mappings. The substantive content claims are correct: all items A–K are closed by code changes, item L's tests are present, and item L's docs are present.

Spot-check of six distinct items: (1) `desktop-tunnel.ts` strips `DEVICE_IDENTITY_HEADER` / `DEVICE_PROOF_HEADER` and stamps `TUNNEL_FORWARDED_HEADER` (A, present); (2) `embedded-gateway.ts` passes `canMintFoundingTicket: isDirectHostRequest` (B, present); (3) `gateway-info-routes.ts` gates `endpointTicket` on `AUTHED_PLANE_HEADER` instead of `isLoopbackRequest` (C, present); (4) `vault-admin.ts`, `device-admin.ts`, `status-admin.ts` all receive `daemonKeyStore(layout.keysDir)` on their five `openVaultRegistry` calls (D, present); (5) `service-admin.ts` calls `adoptKeyStoreCredential` BEFORE Keychain write with per-`keysDir` account (E, present); (6) `docs/recovery/vault-erase.md` new file with erase runbook exists (L docs, present).

### Check 2: Each '- [x]' checklist item is realized in the diff

**Verdict: PASS** on all 21 acceptance criteria from the issue.

Spot-checked eight distinct items from the receipt's checklist:

1. **Item A test** — `packages/gateway/src/routes/founding-forwarder.test.ts` (new file, present): pairs real iroh phone client, forwards through real tunnel, asserts 403 `possession_required` at founding-ticket mint, host's own request succeeds.

2. **Item D positive erasure** — `packages/gateway/src/cli/admin-custody.test.ts` (new file, present): seeds `replica_intent_outcome` row, calls revoke, asserts `listReplicaIntentOutcomes` is empty afterward (not just "no error").

3. **Item E credential adoption** — `packages/gateway/src/cli/service-admin.ts`: adoption call moved **before** Keychain write, `hostCredentialKey(layout.keysDir)` call in `buildSpec`, `keychainAccountFor(layout.keysDir, label)` per data directory (all present).

4. **Item J password requirement** — `packages/backup/src/recovery-kit.test.ts`: new test "refuses an unwrapped kit even with the right shape and a password" directly asserts the refusal (present).

5. **Item L erase refusals** — `packages/gateway/src/routes/vault-erase.test.ts`: six new tests covering `owner_required`, `erase_unavailable`, `typed_name_required`, `recovery_kit_not_verified`, `erase_ceremony_required`, and the pre-guard 405 (present, 5 → 12 tests).

6. **Item L publicPaths regression** — `packages/gateway/src/serve/authz-matrix.smoke.test.ts`: five new rows assert founding routes and `/centraid/_gateway/devices/ticket` return 401 without bearer (present).

7. **Item L at-rest format table** — `ARCHITECTURE.md`: new subsection "At-rest formats (issue #555)" with 8 rows naming each slot, format, custody, and consequences (present).

8. **Item L CHANGELOG entry** — `CHANGELOG.md`: Added section includes vault founding plane (#555) and fixed section includes loopback, custody, service-install, and bearing changes (present).

### Check 3: The checklist mirrors the issue's checklist

**Verdict: PASS**.

The receipt's "## Checklist" section lists 21 acceptance criteria that map one-to-one to the issue's unchecked acceptance criteria. All 21 are marked `[x]` in the receipt:

- Items A–K (11 fixes) ✓
- Item L's five sub-items (tests, contracts, docs, erase refusals, journey) ✓

The receipt's "Checklist" correctly captures the issue's full acceptance scope. No items are omitted or added.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-34260aef-a04-1785129577-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #568 | claude-opus-5 | 997 | 883501 | 134549472 | 309600 | 1194098 | 80.5416 | 997 | 883501 | 134549472 | 309600 | fix(gateway): close #566 residuals across forwarders, custody, and contracts (#5 |
| claude-code-34260aef-a04-1785130429-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #568 | claude-opus-5 | 70 | 61983 | 18482159 | 28088 | 90141 | 10.3310 | 1067 | 945484 | 153031631 | 337688 | fix(gateway): close #566 residuals across forwarders, custody, and contracts (#5 |
| claude-code-34260aef-a04-1785130522-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #568 | claude-opus-5 | 8 | 6134 | 2191382 | 1476 | 7618 | 1.1710 | 1075 | 951618 | 155223013 | 339164 | fix(gateway): close #566 residuals across forwarders, custody, and contracts (#5 |
| claude-code-34260aef-a04-1785131992-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #568 | claude-opus-5 | 32 | 82695 | 5842394 | 3894 | 86621 | 3.5356 | 1107 | 1034313 | 161065407 | 343058 |  |
