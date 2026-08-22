# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Centraid, please report it privately rather than filing a public issue.

- Email: **srikanth@crowdshakti.com**
- Subject line: `[centraid security] <short description>`

Please include:

- The affected component (`apps/desktop`, `apps/mobile`, `packages/design`, or the build setup).
- Steps to reproduce, including OS and runtime versions.
- The impact you anticipate (e.g., local code execution, exfiltration of stored data, privilege escalation).
- Any suggested mitigations.

You should expect an initial acknowledgement within five business days. Please give a reasonable disclosure window before going public — at minimum until a fix has shipped or a workaround is documented.

## Supported versions

Centraid is pre-1.0 and ships from `main`. Only the latest commit on `main` is supported for security fixes. Older tags are not patched.

## Scope

In scope: code in this repository (`apps/`, `packages/`, CI workflows under `.github/workflows/`).

Out of scope: third-party dependencies (report upstream), generic phishing or social-engineering reports against the maintainer's accounts, denial-of-service against personal infrastructure.

## Threat model: pairing, relay, and gateway (F2)

Honest boundary for the always-on personal gateway. This is not a guarantee of future features — it is what the product claims **today**. Product decisions that affect process lifetime: [docs/decisions.md](docs/decisions.md) (H1).

### Trust anchors

| Anchor | What it is | Compromise means |
| --- | --- | --- |
| **Vault owner / sealing material** | Owner holds vault sealing keys (on-disk `keys/` outside backup) and, once they export one from the backup plane, the recovery kit | Attacker can decrypt backups and read vault plaintext offline |
| **Gateway device identity** | Wrapped `keys/endpoint-key.bin` (iroh) | Attacker can impersonate the gateway on the tunnel plane |
| **Filesystem access to `--data-dir`** | Shell/OS access to the gateway's data directory | The landlord anchor: whoever can read/write `--data-dir` runs the admin CLI (`vault`/`pair`/`devices`/`key`), which operates on those files directly and never over HTTP (issue #505) |
| **Paired device key + trust tier** | EndpointId enrollment in `gateway.db` + a device-local private key; `consent_device.trust` (`full`/`readonly`) is the vault-side capability mirror, sourced from ownership rather than a role | Attacker acts as that device within its consent/trust tier until the enrollment is revoked |
| **Pairing ticket secret** | One-time redeem secret (hashed at rest on gateway) | Single enrollment if redeemed before burn/expiry; wrong guesses do not consume the real owner's ticket |
| **Backup provider credentials** | Object-store grants / API keys | Provider traffic + ability to delete/orphan remote objects — **not** vault plaintext (E2E encrypted) |

There is **no multi-tenant server** and no Centraid-operated cloud that can read vault contents. Hosted storage is ciphertext + metadata shape (see below).

**Credential issuance is iroh pairing-only.** There is no durable gateway bearer, per-device HTTP token, direct-URL pairing route, or wildcard admin plane — and no password/session/OIDC plane by design ([#599](https://github.com/srikanth235/centraid/issues/599), its auth model superseded by [#726](https://github.com/srikanth235/centraid/issues/726); [docs/decisions.md](docs/decisions.md)): authentication is the transport, and identity-proofing for a new owner is an existing owner handing them a ticket. Since [#603](https://github.com/srikanth235/centraid/issues/603) there is exactly **one ticket kind — the pair ticket**, and it always means _join an existing gateway_. A gateway founds itself: a **fresh data dir** creates one marked `Personal` vault at construction and enrolls the host's own device identity as its owner, recorded in `vault_owners`, in one `gateway.db` transaction — founding is simply the first mint (#726 D2). Shared vaults are created later by an explicit owner action. Ordinary pairing then binds a device to its owner, and the device reaches exactly the vaults that owner owns; there is no per-device role, only the orthogonal `grant_profile_json` attenuation mask. Every **vault-scoped** request resolves a real enrollment in one vault and fails closed without a proved device identity. One surface is deliberately outside that rule: `GET /centraid/_gateway/info` is public so a client can read the version/schema handshake before it can pair — it answers version and capabilities to anyone, withholds the iroh dial ticket from an unauthenticated caller, and reports `authenticated: boolean` so a bearer mismatch is distinguishable from an endpoint that is not up yet. The fresh-gateway allowlist and the `uninitialized` 409 wall from #568 item C are **gone** with the founding window they existed to serve — a gateway is never zero-vault, so no unenrolled EndpointId is ever admitted. Revocation removes the enrollment, cascades its web sessions in SQLite, and makes the QUIC admission check refuse the device. The filesystem-anchored CLI remains the recovery path if the sole owner is lost.

**KeyStore boundary (issue #555).** `keys/` is the only secret-bearing directory inside the gateway data dir, and every file there is an authenticated encrypted envelope. Desktop custody roots the wrapping key in Electron `safeStorage`; systemd/launchd services use system credentials. A manually launched headless gateway falls back, with a warning, to one external `0600` host credential under the platform configuration directory. Copying the gateway data dir alone therefore does not copy a usable wrapping key. This remains a host-account/filesystem-permission boundary—not protection from an attacker controlling the running process—and operators should use full-disk encryption. Vault DEKs are independent, never derived from the backup keyring, and never stored in `gateway.db` or snapshots. The passphrase-wrapped recovery kit is the only off-box bundle of backed-up-vault DEKs and the backup keyring; since #603 it is a deliberate **backup-plane export** (`backup kit` / the Backup screen), never something first run mints on the owner's behalf.

**Locker user-presence boundary (issue #630).** Locker is an additional application-level gate inside an already authenticated vault session. It boots locked. A passphrase verifier in `locker_auth_credential` is derived from `HMAC(vault DEK, credential)` and then scrypt-hardened with a random salt, so a copied `vault.db` is not by itself an offline passphrase oracle. Successful verification mints only memory-resident, inactivity-bounded sessions and single-item, short-lived, one-use reveal permits. Backgrounding, explicit lock, gateway restart, or timeout destroys those capabilities; the UI also erases reveals, detail models, search results, generated values, and the exact secret it last placed on the clipboard. This does not protect against malware or root inside the running gateway process, and Companion autofill remains a separate, origin-bound device-gesture reveal lane rather than reusing Locker UI tokens. The native Locker cover uses the same online-only authentication RPC: it never puts a passphrase, device credential, session token, item permit, or revealed secret into the mobile replica or durable intent outbox. An optional biometric credential is a random device secret protected by SecureStore with `requireAuthentication`; the gateway stores only its vault-key-peppered verifier. Native Locker masks the app switcher, relocks on background, and clears copied secrets after 30 seconds.

**Mobile device lock (issue #630).** The phone can require platform authentication before mounting the replica or hydrating gateway credentials. Its gate value is device-only SecureStore material with `requireAuthentication`; backgrounding clears the JS credential cache and unmounts the replica session behind an opaque lock surface. This is defense in depth over iOS Data Protection / Android credential encryption, not protection from a rooted device or malware running after successful user authentication.

**Untrusted content boundary (issue #630).** Values arriving from imports, connectors, OCR, capture, share targets, and other owners on the gateway are data, never markup. Blueprint JSX renders them as React text/attribute values through the shared `displayText` boundary, which also neutralizes invisible control and bidi-override characters. A separate allowlist is mandatory for dynamic URL sinks: user links permit HTTP(S), mail, and telephone schemes; media/document sources permit bounded known media MIME data URLs and same-origin vault blobs, but never active HTML/SVG data documents or script schemes. CSS cover URLs use the same media policy plus explicit CSS escaping. Adversarial coverage renders the shared 13-case corpus through a real component from every bundled app.

The file-import border validates exactly one text/base64 body, strict UTF-8, file/record/field bounds, complete ICS/vCard records, and inert CSV display cells before staging. ZIP imports are never extracted to disk and reject traversal names, encryption, unsupported compression, inconsistent/truncated headers, excessive entry/aggregate expansion, and suspicious compression ratios. Any validation failure occurs before the draft batch is created, so canonical state is unchanged.

### Derived data and sensitive enrichments

Derived rows (embeddings in `enrich_embedding`, extracted text in `core_content_derivative`, machine tags) are ordinary owner-custody vault rows: they follow the same backup, erase, and replication paths as authored data, which is precisely why they need naming here — enrichment never creates a second store with its own weaker custody. Face data (detected regions in `media_face_region`) is the most sensitive derived class in the product, and owner-owned custody does not soften that: a "delete this person" gesture must provably cascade through every derived row keyed to that identity and every replica holding copies. That gate is now met (issue #724 workstream W5). The cascade is the `media.forget_person` command (`packages/vault/src/commands/media.ts`): for one `core_party` it deletes every `media_face_region` naming them through either `party_id` or `confirmed_by_party_id`, their face vectors in `enrich_embedding`, their `enrich_derivation` stamps, and their rows in the `media_face_cluster` grouping projection — with a postcondition asserting zero rows across all four, so an incomplete cascade refuses to commit rather than shipping. It is `risk: high` and confirmation-gated: an agent proposing it parks for the owner. `packages/vault/src/commands/media-forget-person.test.ts` proves the three obligations named above — the cascade itself, the recovery scenario (an export taken after the forget carries no trace of the region ids, and a restore from it brings nothing back), and the offline phone (every deleted row is announced to replicas as a `delete` in the change log a replica catches up through, so a phone that was offline loses them on reconnect). Face detection itself is consent-gated rather than ambient: the bundled `faces` automation reads no photograph without an open, capability-tagged `enrich_request` or a prior derivation stamp proving past consent, and identity is never inferred — grouping proposes, and only the owner's own `media.answer_face_proposal` names anyone.

### Owners, hosting, and the v0 storage premise (#726, supersedes #599)

- **Five-layer model, L3 corrected (#726).** L0 custody (the box; landlord bearer; an exported backup recovery kit) · L1 authentication (iroh device keys — the only cryptographically provable layer) · L2 principals (**owners** and agents) · L3 authorization (`vault_owners(vault_id, owner_id)` — one owner per vault, the primary key IS the invariant; devices reach exactly the vaults their owner owns) · L4 attribution (the journal records the acting owner — and the agent when one acted — whenever a principal is known; scheduler-fired automations carry none). A vault owner is not root; owning one vault grants zero access to anyone else's vault. Root remains host custody (L0).
- **A machine can hold more than one person's vaults, and hosting confers no authority but does confer the ability to act (#726 D2).** The gateway owner — the person whose machine it is — can read every vault their machine hosts while it is hosted there: local blobs are plaintext, and a process that runs a vault holds its plaintext regardless (see the v0 storage premise below). The same machine also **signs unattended** on a hosted vault's behalf — nobody is present when a device re-asserts a route or a commons steward compiles a member's departure — so a gateway owner can act as any vault they host even though they do not own it. Both halves are stated on purpose; a design that documents only the reading half is telling half the truth.
- **What hosting keeps, and what it lost (#726 P1).** Host custody — the landlord bearer, unqualified by ownership — keeps process control (start/stop the gateway that serves a hosted vault), disk visibility (it can see a hosted vault exists and what it costs), and the unattended signing above. It lost, as typed `403 owner_only` refusals naming the vault's actual owner label: erasing a vault it does not own (`POST /centraid/_vault/vaults:erase`), minting a pairing ticket for a vault it does not own (the _Add someone_ mint lane, `POST /centraid/_gateway/devices/ticket`), and configuring that vault's backup target (`PUT /centraid/_gateway/backup/policy/:vaultId`) — a scheduled or manual backup run silently skips any vault it does not own rather than including it. `owner_only` is deliberately distinct from the ordinary `not_found` an enrolled remote device gets for the same acts: host custody can already see the vault on disk, so it earns the honest, owner-naming refusal instead of topology hiding it cannot benefit from anyway.
- **The vault boundary is the isolation.** There are no row-level ACLs inside a vault (Model B rejected in #599 — fail-open filtering, "as whom?" in every agent-generated query). Selective sharing is **placement**: a projection into an audience vault, journaled and removable. The product promise: no one can ever query your vault; what others see is only what was placed where they are.
- **Agents act on behalf of an owner**: an agent turn constructed inside an owner's request scope is denied writes when that owner cannot write (the cap's granularity is the write bit), and the journal records the owner behind it. Scheduler-fired automations have no human behind them — they run uncapped and journal no owner; capping those awaits a durable owning principal on the automation row.
- **v0 storage premise: the local gateway is L0-trusted.** Local CAS blobs are plaintext under `<vault-dir>/blobs/`; blob sealing exists for _untrusted remote storage_ and activates exactly when a storage/CAS provider is configured. Protection against a stolen disk is the operating system's full-disk encryption, not application-layer sealing. Shared blobs are hardlinked between vault CAS directories on the same filesystem — the link count is the cross-vault refcount, and each vault's GC only ever unlinks its own directory entry.
- **Household Locker placement does not share a key.** The trusted local gateway briefly unseals the selected item with the origin vault DEK and immediately seals each secret cell under the audience vault's independent DEK and destination-cell AAD. Ciphertext is never copied between vaults, provider storage never receives either plaintext or a universal key, connection bindings are stripped, and list/search/notification/receipt payloads remain secret-free. Compromise of the running L0 gateway remains inside the accepted v0 premise above; compromise of one backup/provider key does not decrypt the other vault.
- **Revocation removes authority, not history.** Revoking a device (`EnrollmentStore.revoke`) tombstones that binding immediately — device admission fails closed — without touching the owner's other devices or their vaults' data. Removing an owner (`OwnerStore.remove`) is refused while they still own any vault, so a person can never be deleted out from under their own data. Neither undoes a placement already made: an explicit unshare removes the audience's independent projection, and share/unshare access receipts retain the acting owner id after revocation so an administrator cannot erase the audit by removing a principal.
- **Tally participants are accounting data, not authenticated principals.** `core_party` and `social_circle_member` rows name who paid or owes; only the gateway's `owners`, via `vault_owners`, grant access. There is deliberately no pointer between those models. A Tally group becomes readable to someone else only by placing it in a vault they own, and offline placements are link-token-idempotent before any source move.

### Commons custody and steward writes (#731)

Joining a commons is consent to hold a complete independent copy of its domain rows and blobs in the member's vault, replica, and backup. The acceptance surface states the current size (and configured maximum when present) before joining. This is intentionally different from an expiring reference: membership, not a lease clock, is consent. The lease-based lending plane and its borrowed stores were deleted in #731.

A departing member loses going-forward access. The compiler uses grant lineage to scrub the current vault projection, its search entries, derivatives, and derived recognition rows; a re-invite can project a clean current snapshot. That cannot claw back history the person lawfully held before departure: an old offline device, exported recovery kit, or pre-departure backup may retain it. For accounting commons, `retain-ledger-history` may also preserve departed-party entries in the remaining members' ledgers so balances stay computable; the departed identity is data, not continuing authority.

The steward is the serialization point and therefore an availability and censorship risk. A malicious or offline steward can delay or omit a command, but the member's own durable intent remains visible as unsequenced pending work, so the delay is observable rather than silently rewritten as success. Steward transfer changes only the ordering role and log; it does not copy custody data or confer vault ownership.

The steward must not be able to forge a member command. Every non-steward command is signed by the member vault's Ed25519 identity over a canonical tuple containing the grant, actor, command, input, member vault, and fresh nonce. The steward resolves the vault public key through `share_party_vault_binding`, verifies the signature before invocation, and rejects a repeated `(grant, signing vault, nonce)` as replay. The verified signature, signing vault, nonce, member attribution, outcome, and reason remain in the ordered `share_commons_op` row. A `read` capability, a missing/revoked binding, an invalid signature, a replay, an undeclared command, or a command targeting a different container all refuse at the steward before the ordinary vault command runs.

Control changes are not an unsigned side channel: membership, capability, grant revocation, delete, and steward transfer are sequenced in the same per-commons log. A member applying the same checkpoint and tail therefore observes the same authorization order as the data order. The physical device replica still has one cursor per vault; logical `(grant_id, member_vault_id)` offsets only prove which commons operations that vault applied and do not widen the replica's authority.

### The peer plane (#726 P3)

Two owners' gateways can now share directly, over their own iroh dial rather than through a third party. This is a new attack surface — a gateway that used to trust only its own paired devices now accepts connections from a stranger's process — so every control below exists to keep a peer confined to exactly the vaults it is linked to and nothing about the rest of the gateway.

**The plane got smaller in #825.** Copy-as-share retired, and with it every frame that let one gateway push or pull an item set across a link on its own initiative: `POST /_peer/edge/give`, `GET /_peer/edge/closure/:id`, `POST /_peer/edge/deny`, and the ranged `GET /_peer/blob/chunk` a give's audience pulled originals with all answer `not_found`, and their handlers are deleted rather than gated. What a proved peer may still reach is the **link ceremony**, the **route assertion**, and the **commons rail** (bootstrap, signed command, its own blob doors, invite/claim/refuse). The controls below apply to what remains; the give-specific ones — the audience's per-link accept/ask/refuse receive preference, and `hasGivenEdge`'s "a peer may only pull bytes we actually gave it" check on the blob route — are gone with the surfaces they guarded, not weakened. Closure reading and projection survive **beneath** a grant as internal fulfillment transport within one gateway, never as something a peer can ask for.

- **The link ceremony is a single-use, time-boxed credential exchange, not a password.** A link ticket (`{vaultId, vaultPublicKey, endpointTicket, ticketId, secret}`, shown as a QR/paste) carries a 15-minute TTL; the secret is stored only as its sha256, never in the clear, so a stolen `gateway.db` yields no redeemable secrets. Redemption is a single conditional-DELETE-and-insert transaction, so a ticket can be spent exactly once even under concurrent redeem attempts, and it binds to the **first** endpoint and key that present it — a second claimant, correct secret or not, finds the ticket gone. The peer protocol version wall is judged **before** the ticket is touched (`409 protocol_refused` short-circuits ahead of the ticket lookup): a peer running an incompatible protocol cannot burn a legitimate ticket just by trying and failing.
- **Path confinement exists because the router does not confine anything on its own.** Every peer request must address a path that extends `/centraid/_peer/` — no other route on the gateway is reachable from this lane. The rule is enforced independently in three places: the production Rust relay (`iroh_relay.rs::peer_target_allowed`), the pure-JS endpoint (`protocol.ts::isPeerPlaneTarget`), and the route layer itself (`routes/peer-plane.ts`), and all three **ban** percent-escapes and `.`/`..` segments outright rather than decoding and then checking them — decode-then-check is exactly the shape that lets an encoded traversal slip past a naive guard. The reason there are three independent guards, not one shared function two languages both call, is a fact about how Node's HTTP layer works: `new URL()` resolves `..` **before** the request ever reaches route dispatch, so `/centraid/_peer/../_gateway/devices` arrives at the owner-tier device handler by pathname — registering `/centraid/_peer/*` as a route confines nothing by itself. It reads as paranoia until that's understood: the real defense is the forwarders' own string checks on the raw wire target, done before any URL parsing happens, and the route-layer check is a backstop for a future forwarder that forgets, not the primary gate. Do not "simplify" the three guards into one.
- **A peer can never satisfy an owner-tier check, by construction of the lane, not by a role check.** Peer requests arrive on their own control routes (`/tunnel/peer-authorize` beside `/tunnel/authorize`, `Plane::Peer` beside `Plane::Device` in the Rust relay) with their own authorize decision — the device-pairing `authorize()` a peer might otherwise reuse would make a peer gateway indistinguishable from a paired owner device, so it is never shared. The forwarders strip five client-supplied identity headers before stamping the proved one on both lanes, and `x-centraid-device` is never stamped on the peer lane at all — `deviceKeyFor` returns `undefined` for any request carrying the peer endpoint header. As a second, independent lock: any request still carrying that header answers `404 not_found` above the composed handler, before it reaches any route — closing the case where a request escaped path confinement and arrived at loopback carrying a peer marker.
- **Route assertions are signed by the vault's own key, and an EndpointId is never treated as identity.** A route assertion (`{vaultId, endpointId, relayHints, ts, signature}`, domain-separated and length-framed, not JSON) is verified against the public key **stored in `vault_directory` at link time** — the one identity record for that vault that survives a keypair rotation or a move to new hardware (#750). An accepted assertion replaces that vault's single `vault_routes` row, so every link to it re-routes at once; it can never write a key. This is the one route a peer may reach from an endpoint the gateway does not yet recognize: after a rotation, by definition, it is unrecognized, so the authority is the signature, never the caller's address. `vault_links`, `vault_directory`, and every table alongside them are grepped by a test for any column whose name contains `endpoint` outside `vault_routes` — the route cache is replaceable, identity is not. The vault's own signing seed is fail-closed on the sending side too: the mint pins the public key beside the seed, and a missing or swapped seed for a pinned vault refuses (`VaultIdentityMismatchError`) rather than silently minting a key its peers would reject.
- **Per-link budgets are ordinary hygiene, not a defense against a determined attacker.** Each link carries its own token-bucket rate limit so one misbehaving or compromised peer cannot exhaust the gateway on behalf of every other link it holds.
- **An unknown, revoked, or never-linked peer learns nothing.** Redemption failure, an unrecognized ticket, a wrong secret, and an expired ticket all answer the identical `404 not_found` — one answer for all four, so a probe cannot distinguish "wrong password" from "no such vault." The same topology hiding applies to edge crossing: unapproved, revoked, unlinked, and never-heard-of vaults all answer `not_found` from `judgeEdgeCrossing`, matching the existing same-machine posture rather than adding a second disclosure surface for the remote case. An APPROVED cross-owner pair is the one case that no longer hides: since #825 it is refused `400 cross_owner_give_retired` with copy naming the grant plane, deliberately — the caller already holds a link to that vault, so `not_found` would tell them a lie about a relationship they can see, and the refusal discloses nothing they did not already know.

### Local-socket / loopback boundary

- Desktop and daemon gateways bind **loopback HTTP** with **Bearer** auth for the control plane. The daemon's loopback bearer is **derived from custody, not minted per boot** (issue #568 item J corrects the earlier #505 description): it is `HMAC(endpoint-key.bin, "centraid/landlord-http/v1")`, so it is **stable for the life of the gateway's endpoint identity** and is not rotated. It is never written to disk as a token and never printed, but it is reproducible by any local process that can open the gateway's `KeyStore` — which is the point: the CLI and the desktop derive it rather than sharing a secret. Compromising `endpoint-key.bin` therefore yields lasting loopback HTTP admin, which is why that key sits behind OS custody (Keychain / systemd creds / an external 0600 credential) rather than a bare file. Rotating it means rotating the gateway's permanent EndpointId and re-pairing every device, so it is deliberately not routine; a parent process may still pin a per-launch value via `CENTRAID_GATEWAY_TOKEN` (the desktop does). The bearer only unlocks the loopback door — forwarded requests also carry the per-boot device proof header, so real per-device identity is what scopes them. Anyone who can inject into the local user session, or read that secret out of the process, can call gateway APIs as that gateway — the **OS user boundary** is the primary local boundary.
- The renderer is a **thin client**: Electron IPC is for native operations (keychain, window, lifecycle), not a second authorization system for vault data.
- **OS user boundary** is the primary local boundary. Centraid does not claim protection against malware running as the same user.
- Detached gateways retain the same loopback and enrollment boundaries when the desktop window exits.

### Loopback / browser control-plane (Host, CORS, auth placement)

Posture after issue **#504 batch 0** (fixed; do not document the old reflective-CORS hole as current).

| Control | Behavior |
| --- | --- |
| **Host allowlist** | Loopback HTTP rejects requests whose `Host` is outside `localhost` / `127.0.0.1` / IPv6 loopback / configured hostnames **before** auth and handlers (DNS rebinding). |
| **CORS — Bearer** | Authorization is carried in the `Authorization` header (or preflight lists `authorization`). Reflecting Origin with credentials is allowed for Bearer intent because the token is not ambient. `Origin: null` / missing Origin still use `*` (desktop `file://`). |
| **CORS — cookie / PWA** | Credentialed CORS (`Access-Control-Allow-Credentials: true` + reflected Origin) is limited to **session-bound shell origins** (`credentialedCorsOrigins` from control/app sessions). Foreign origins never get reflective credentialed CORS; they may see `*` without credentials so `credentials: 'include'` cannot read the body. |
| **Preflight vs auth** | `OPTIONS` still answers **before** Bearer/cookie auth (browsers omit Authorization on preflight). CORS headers on the preflight already encode the credentialed-vs-not decision; the real request is still auth-gated. |
| **Auth transport** | Desktop/daemon loopback: a Bearer the daemon derives from its KeyStore-custodied endpoint key, or a per-launch value pinned by the spawning desktop (no persisted shared token, issues #505/#568). Remote clients prove their enrolled EndpointId in the iroh QUIC handshake; no direct HTTP tier or per-device bearer exists. PWA shell: Origin-bound HttpOnly control cookie + app cookies; `authorizeRequest` enforces origin bind in addition to CORS defense-in-depth. |
| **WS / tunnel** | Device-plane admission is enrollment-based at the iroh handshake; it is not cookie ambient. |

**Non-loopback / Docker operators (packaging 5C):**

- Binding `0.0.0.0` (the gateway Docker image default) does **not** open Host or CORS. Loopback Host names remain allowed; any other `Host` clients send must be listed via `--allowed-host <name>` (repeatable) and/or `CENTRAID_ALLOWED_HOSTS=host1,host2`.
- Vault and ledger data live under the process `--data-dir` (image: `/data`). **Bind-mount a host directory or use a named volume** at `/data`. A bare `docker run` without a durable mount loses data when the container is removed — the image `VOLUME` alone is not a backup strategy.
- Image process runs as non-root UID/GID `10001` (`centraid`); ensure the mounted volume is writable by that user.

**Honest not-yet (control plane):**

- Formal third-party review of the PWA cookie + CORS combination.
- GHCR publish / multi-arch / signed images (release path).

### Pairing and transport

| Property | Reality |
| --- | --- |
| Pairing | One-time ticket binds a device key to a vault; successful redeem **burns** the ticket; expiry is enforced |
| Transport | Iroh QUIC between capable peers; **browsers are relay-only** (no UDP) via WASM path |
| Relay | Public/default relay infrastructure can observe **that** connections exist and traffic volume; it must not obtain vault sealing keys from the protocol design |
| PWA HTTP fallback | One origin-bound HttpOnly control session per vault. #799 retired the per-app browser session along with the served plane: an app is shell code inside that same session, and its data reach is bounded by its consent grants, not by a second cookie |
| Consent | Device replicas and app handlers are **consent-scoped**; compromise of one app grant is not automatically full vault admin |

### What the transport can and cannot do

**Can:** move authorized requests and encrypted blob bytes between paired endpoints; support offline-ish device replicas with intent replay; keep provider-held backup/CAS objects unreadable without owner keys.

**Cannot (and must not be assumed to):** hide traffic metadata from relays or storage providers; protect against a malicious app the owner installed with broad grants; protect against root on the gateway host; provide anonymity.

### Explicitly not yet implemented / incomplete

Treat the following as **open**, not as shipping guarantees:

- Store-submission verification of platform secure-storage behavior on the supported iOS and Android device matrix.
- Comprehensive **renderer/GPU crash** isolation on desktop (K12).
- Hard **capability walls** on every client surface (C1) — protocol policy is set; not every feature may be gated yet.
- Extension pairing surface ([#462](https://github.com/srikanth235/centraid/issues/462)) — must follow C1–C3 before ship.
- Formal third-party audit of the pairing/tunnel implementation.

### Related recovery

- [docs/recovery/pairing.md](docs/recovery/pairing.md)
- [docs/logs.md](docs/logs.md)

## Centraid Assist OAuth: Model B code courier

Centraid Assist gives desktop/PWA clients paired to a non-public gateway a working Google OAuth path without turning Centraid's cloud edge into a credential vault. The complete design and user-facing behavior are in [docs/oauth-assist.md](docs/oauth-assist.md); incident response is in [docs/recovery/oauth-assist.md](docs/recovery/oauth-assist.md).

### Trust and custody boundary

| Material | Custodian | Lifetime / storage |
| --- | --- | --- |
| OAuth `state` | Gateway | Random, in-memory, single-use, ten-minute TTL |
| PKCE verifier | Gateway | In-memory ceremony only; sent only in gateway→Worker `/exchange` HTTPS body |
| Client-session/device binding | Gateway + initiating client | Ceremony lifetime; prevents a copied authorization URL from planting another account |
| Browser binding | Gateway → scrubbed Worker `/start` fragment → signed HttpOnly cookie | Random, one ceremony, ten-minute TTL; absent from Google's shareable authorization URL |
| Authorization code | Google → Worker → client → gateway → Worker | Short-lived courier material; fragment/in-memory only, never a token |
| Callback receipt | Worker HMAC secret + courier | Two-minute HMAC over code, state, and browser-binding hash; no receipt database |
| Google client secret | Cloudflare Worker secret | Never shipped to client/gateway/repository |
| Access/refresh tokens | Gateway vault | Token response transits Worker process memory; gateway seals before use |
| Imported Google data | User's gateway vault | Never traverses the Assist Worker |

The Worker has no KV, D1, Durable Object, R2, cache, queue, connection table, or user identity scope. Its only cookie is a signed, HttpOnly, ten-minute browser-binding envelope containing no OAuth code, token, identity, or connection record; all state remains in the browser. It requests neither `openid`, `email`, nor `profile`. Aggregate Analytics Engine metrics contain route, outcome, status, and count only. Workers Logs, invocation logs, and automatic traces are disabled because callback query strings contain code/state and Cloudflare traces retain full URLs; any zone Logpush configuration must likewise omit or redact query strings, bodies, and headers.

### Data flow and fixed return targets

The client first opens `https://oauth.centraid.dev/start#…`. That page scrubs its fragment before network I/O, validates the fixed Google authorization URL, seals the gateway's one-ceremony browser binding into a signed HttpOnly cookie, then navigates to Google. The binding is deliberately absent from the Google authorization URL: someone who obtains only that URL cannot produce a callback accepted for the initiating browser.

Google redirects only to `https://oauth.centraid.dev/callback`. The callback does **not** exchange the code. It requires the signed binding cookie, then a gateway-generated `d.`/`w.` state prefix selects exactly one compiled return target:

- desktop: `centraid://oauth/finish#code=…&state=…&receipt=…`
- PWA: `https://app.centraid.dev/oauth/finish#code=…&state=…&receipt=…`

No query parameter, Origin header, or arbitrary state value can choose a redirect. The PWA scrubs the fragment synchronously before network work. The desktop main process accepts only a bounded, exact OAuth finish shape and never logs the link. The renderer validates it again. The client then calls an owner-authenticated gateway endpoint using the same per-tab/window session nonce and enrolled device identity recorded at start.

The gateway validates the live state and client/device binding before consuming it. It then calls the Worker's `/exchange` with the code, receipt, fixed redirect, PKCE verifier, and its original browser binding. The Worker validates the receipt against the exact code/state/browser-binding tuple before any Google call, attaches the confidential secret, and returns only allowlisted OAuth token fields. Replays fail on the consumed gateway state; expired/foreign state fails without a Worker call. A foreign gateway cannot redeem because it has neither the pending state, verifier, nor browser binding.

### Confused-deputy and availability threat

`/exchange` and `/refresh` are intentionally internet-facing server-to-server proxies. The Google secret is not exposed—it travels only Worker→Google—but an attacker can try to make the shared client use it. PKCE and the browser-bound callback receipt make direct or authorization-URL-only exchange attempts fail before Google and make successful theft impossible without the gateway-held verifier. The receipt proves that this Worker recently accepted the exact bound callback tuple; it does not, by itself, authenticate Google as the HTTP caller. Google establishes authorization-code validity during the token exchange. `/refresh` has no preceding callback, so the defended residual risk is fleet availability/reputation: failing attempts could consume quota or trigger Google's abuse heuristics.

Required layered controls:

- production hostname only; `workers.dev` and preview URLs disabled;
- zone per-IP rate limits for `/exchange` and `/refresh`;
- Worker per-IP and per-location ceiling bindings;
- WAF managed rules, Bot Fight Mode, TLS-only, HSTS, CSP, no-store, and no browser CORS access to token responses;
- strict bounded JSON/body/provider/PKCE/redirect/state/browser-binding/receipt validation before Google;
- Worker-side scope allowlisting and an exact comparison with Google's granted scope response before any token is returned;
- aggregate failure-ratio, 429, 5xx, and volume alerts;
- `EXCHANGE_ENABLED` kill switch and credential-rotation runbook.

The binding named `GLOBAL_LIMITER` is per Cloudflare location, not a true fleet-global counter. It is defense in depth, not a substitute for zone rules and alerts. Turnstile is deliberately absent: these endpoints are gateway server-to-server calls, not interactive browser forms.

The complete `/start#…` URL is a short-lived ceremony capability. A party that steals it before the page scrubs the fragment can reproduce the browser binding. It is therefore never logged, persisted, or placed in a referrer; the more widely exposed Google authorization URL intentionally omits the binding.

Assist deliberately supports self-hosted gateways without a Centraid cloud account or per-gateway edge credential. The Worker therefore cannot distinguish a legitimate new installation from a caller completing a valid consent flow for that caller's own Google account. It limits such flows to the audited scope allowlist and exact Google-granted scope set; WAF/rate limits/alerts protect the shared client's quota and reputation. This is not a claim that `/exchange` authenticates a Centraid installation, and it does not let a caller obtain another user's grant.

### Failure posture and non-claims

- Worker outage blocks new Assist exchanges and makes refresh attempts retry once then skip the current fire. It does not expose tokens or erase imported data. BYO remains available.
- Google `invalid_grant` moves the connection to `needs-auth` with a **Reconnect with Centraid Assist** note. Silent refresh is otherwise normal.
- BYO is unchanged and refreshes directly, but its provider callback must be browser-reachable; pairing/relay reachability alone is insufficient.
- Assist does not proxy Google API calls, store connection rows in Centraid cloud, protect against compromise of the gateway/paired client, or remove Google Workspace administrator policy.
- Standard Assist must not be called GA until the production consent/brand and sensitive-scope evidence passes. Restricted Gmail/Drive scopes remain disabled until restricted-scope verification and CASA evidence pass. The executable evidence checklist is [docs/release/oauth-assist-google.md](docs/release/oauth-assist-google.md).

## Automated security gates (#671)

Complementary controls on top of manual review and the threat model above. These are **not** a substitute for CodeQL or for the local toolchain (oxlint, TypeScript, knip, Vitest/mutation floors).

| Gate | Where | What it catches | What it does not replace |
| --- | --- | --- | --- |
| **GitHub secret scanning + push protection** | Repo setting (enabled) | Known provider token patterns on push/PR | Non-provider high-entropy strings |
| **Gitleaks** | `ci.yml` job `gitleaks` → required `check` | High-entropy / generic secrets in the current tree; fixtures allowlisted in [`.gitleaks.toml`](.gitleaks.toml) | Full git-history archaeology (intentionally not a merge gate) |
| **dependency-review** | `ci.yml` (PR only) | _New_ high-severity advisories and banned copyleft licenses introduced by the PR | Latent vulns already in `bun.lock` |
| **OSV-Scanner** | `ci.yml` job `osv-scanner` → required `check` | Full `bun.lock` inventory; **fails on CRITICAL** only ([`scripts/ci/osv-lockfile-scan.mjs`](scripts/ci/osv-lockfile-scan.mjs)); HIGH is logged | Typosquat/malware behavioral signals (Socket) |
| **CodeQL** `security-extended` | [`security.yml`](.github/workflows/security.yml) on main + weekly | SAST for TS/JS, Actions YAML, Rust | Per-PR wall-clock budget |
| **Trivy** | [`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml) after image push | CRITICAL/HIGH OS and package CVEs in the gateway image; exceptions in [`.trivyignore`](.trivyignore) with reason + review date | Scanning every app surface |
| **DAST** (#842 W2.4) | [`e2e.yml`](.github/workflows/e2e.yml) job `dast-scan` → [`scripts/security/dast-scan.mjs`](scripts/security/dast-scan.mjs) | Live-surface probes against a running gateway; known findings ledgered with an owning issue | SAST's reach into code paths no request exercises |
| **Handler sandbox** (#842 W7.1) | [`packages/server/src/engine/sandbox/`](packages/server/src/engine/sandbox/), installed by the engine and automation worker runners | A handler reaching `node:fs`, sockets, subprocesses, `process.env`, `process.binding`/`dlopen`, or rebuilding the loader through `node:module` | An OS boundary — see the honest limits below |
| **Rust supply chain** (#842 W7.2) | [`security.yml`](.github/workflows/security.yml) job `rust-supply-chain` | `cargo-audit` advisories and `cargo-deny` licence/banned-crate/duplicate findings across all three crates | The JS lockfile, which OSV and dependency-review own |
| **Rust unsafe-edge ratchet** (#842 W7.2) | `check:push` → [`scripts/security/unsafe-edge-audit.mjs`](scripts/security/unsafe-edge-audit.mjs) | A new `unsafe` block, or one without a `// SAFETY:` justification; tighten-only in both directions, so the ledger must be lowered when unsafe is removed | Whether an existing justification is _correct_ |
| **Update signature custody** (#842 W6.1) | [`apps/desktop/src/main/update-signature-core.ts`](apps/desktop/src/main/update-signature-core.ts), wired in `update-watcher.ts` | A packaged build installs only a payload whose SHA-512 appears in a release manifest signed by a pinned Ed25519 release key: unsigned, wrong-signed, tampered-manifest, tampered-payload, wrong-version and no-key-enrolled updates are all refused | OS code-signing / Gatekeeper / SmartScreen, which prove a certificate, not a release |
| **SBOM + provenance** (#842 W6.2) | [`lane-release-desktop.yml`](.github/workflows/lane-release-desktop.yml) job `supply-chain` → [`scripts/security/supply-chain.mjs`](scripts/security/supply-chain.mjs) | A deterministic CycloneDX 1.6 BOM of `bun.lock` and an in-toto/SLSA v1 statement over the real artifact digests, both re-verified in the same run | Signed container images (cosign, not yet enrolled) |
| **Dependency behaviour** (#842 W6.3) | `check:push` → [`scripts/security/lifecycle-audit.mjs`](scripts/security/lifecycle-audit.mjs) | What a dependency _runs_ at install time, digested over the command **and the bytes of the scripts it invokes**, so a republished tarball that changes `install.js` under the same version fails. Proves `trustedDependencies` is empty — no third-party install-time code executes here | Runtime behaviour after install |
| **CI egress** (#842 W6.3) | `check:push` → [`scripts/security/lint-ci-egress.mjs`](scripts/security/lint-ci-egress.mjs) | A new workflow that installs dependency code without `harden-runner`; the 15-workflow debt in [`egress-ledger.json`](scripts/security/egress-ledger.json) can only shrink | Enforcement inside the 15 ledgered lanes until each is hardened |
| **Diagnostics redaction** (#842 W8.1, #846 P8) | [`packages/server/src/serve/support-bundle.ts`](packages/server/src/serve/support-bundle.ts), canaried by `tests/quality/diagnostics-redaction-canary.test.ts` | Vault content, secrets and personal data reaching a support bundle: every field is emitted through a declared leaf policy, and a tripwire sweeps the serialized document for literals harvested from the live system. `GET /centraid/_gateway/diagnostics` serves this document — there is one bundle, not a shareable one beside a legacy one that emitted the owner-authored vault name verbatim | A value the policy admits as a machine setting that is in fact a credential — the residual the tripwire exists for, and which it counts rather than hides |

**Roles (lockfile):** dependency-review = “don’t _add_ a known-bad dep on this PR.” OSV = “what is _already_ in the lockfile?” so inventory debt cannot hide behind an unrelated change.

**Structural contract:** `node --test scripts/ci/hygiene-gates.test.mjs` asserts the three gates stay wired into real workflows (part of `scripts:test`).

**Two postures worth stating plainly, because both look like regressions and neither is:**

_Auto-update is fail-closed and currently refuses every packaged update._ `TRUSTED_RELEASE_KEYS` is empty, so a packaged build rejects any downloaded payload with `no-trust-anchor` and falls back to a plain relaunch — it never calls `quitAndInstall` on those bytes. This is correct rather than broken: the desktop lane ships unsigned scaffolding and attaches installers to a release only once a signing group is enrolled, so today there is no release a build could legitimately trust. Enrolling a key (`docs/enrollment.md`, secret `CENTRAID_RELEASE_SIGNING_KEY`) restores auto-update, and the empty state is asserted by a test, so the enrollment flips that test and the flip is the review signal.

_The handler sandbox is a JS-level boundary by construction, not by omission._ Handlers share the gateway's process, address space, descriptors and uid. A per-handler OS boundary needs a child process under seccomp/AppArmor, Seatbelt or an AppContainer; none of those is per-thread, and handlers are dispatched as `worker_threads` for the latency budget. So: not an OS sandbox, not a V8 isolate (one heap, crudely bounded by the pool's `resourceLimits`), and native addons defeat it entirely — `modelRuntimePolicy` grants them for `onnxruntime-node`, declared in code and pinned by a test. Filesystem confinement is userland and TOCTOU-exposed: `fs-guard.ts` realpaths immediately before each syscall, which is the narrowest window a wrapper achieves, not zero.

**Re-apply / local:**

```bash
gitleaks detect --source . --no-git --config .gitleaks.toml
# with osv-scanner on PATH:
node scripts/ci/osv-lockfile-scan.mjs
```

SonarCloud Autoscan remains a second-opinion maintainability/security check on PRs; it is not one of these three gates, and it is **token-gated**: analysis is SonarCloud-side Automatic Analysis on the `srikanth235_centraid` project, and the project's configuration — scope exclusions, silenced noise rules, quality profiles and gate — is applied by `scripts/ci/configure-sonarcloud.mjs`, run from [`.github/workflows/sonarcloud.yml`](.github/workflows/sonarcloud.yml) on pushes that touch the configurator, weekly, and on manual dispatch. That lane runs only when the optional `SONAR_TOKEN` secret is present (a personal token with project administer); without it every step is skipped and the run logs an explicit skip notice, so a clone or fork with no token gets no SonarCloud coverage rather than a silent half-configured one. Policy detail lives in [the toolchain contract](docs/toolchain.md#sonarcloud-autoscan).

## Known metadata exposure to backup providers

Backup objects are end-to-end encrypted (AES-256-GCM, keys never leave the owner — `packages/backup/FORMAT.md`), so a storage provider reads no vault content. It does observe **traffic shape**: object counts and sizes always told a provider roughly how much a vault stores, and the continuous WAL segment stream (issue #408) sharpens that into **write volume and cadence** — segment sizes and upload timing correlate with when and how much the owner writes. This is an accepted trade for continuous, point-in-time backup; the shipper's tick/threshold knobs are where padding or batching would land if a deployment needs that correlation blunted.

The snapshot format compresses chunk objects _before_ encrypting them (entropy-gated zstd, issue #405 §1), which introduces a **compressibility side channel**: because compression happens inside the seal, a chunk object's ciphertext _length_ now reveals how compressible — how redundant — its plaintext was. Two 16 MiB parts seal to visibly different object sizes if one is highly repetitive (a text-heavy SQLite base) and the other is high-entropy (already-compressed media, random blobs). The provider learns nothing about _what_ the bytes are, only a coarse redundancy estimate per object, on top of the size/cadence it already saw. This is accepted for Centraid's threat model: a **personal, single-tenant** vault where the owner holds the keys and there is no cross-tenant secret to sift out via a chosen-plaintext/CRIME-style adaptive-injection attack (the classic setting where compress-then-encrypt is dangerous — an attacker mixing controlled and secret data in one compression context). The gain — materially smaller, cheaper, faster backups of the bulk data — outweighs a redundancy estimate a provider could largely infer from raw sizes anyway. The escape hatch is in the format: the per-chunk algorithm-id byte carries a **stored-raw** encoding (`0x00`), and the keep-if-smaller gate already selects it for any part compression does not shrink, so incompressible data is stored verbatim and a deployment that wants to forgo the channel entirely can force raw storage without a format change.
