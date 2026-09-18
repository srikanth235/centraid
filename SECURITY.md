# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Centraid, please report it privately rather than filing a public issue.

- Email: **srikanth@crowdshakti.com**
- Subject line: `[centraid security] <short description>`

Please include:

- The affected component (a crate under `crates/`, `mobile/`, `desktop/`, `extension/`, `packages/design`, or the build setup).
- Steps to reproduce, including OS and runtime versions.
- The impact you anticipate (e.g., local code execution, exfiltration of stored data, privilege escalation).
- Any suggested mitigations.

You should expect an initial acknowledgement within five business days. Please give a reasonable disclosure window before going public — at minimum until a fix has shipped or a workaround is documented.

## Supported versions

Centraid is pre-1.0 and ships from `main`. Only the latest commit on `main` is supported for security fixes. Older tags are not patched.

## Scope

In scope: code in this repository (`crates/`, `mobile/`, `desktop/`, `extension/`, `packages/`, `deploy/`, CI workflows under `.github/workflows/`).

Out of scope: third-party dependencies (report upstream), generic phishing or social-engineering reports against the maintainer's accounts, denial-of-service against personal infrastructure.

## Threat model: pairing, relay, and gateway

The boundary this document states is what the code does **today**. The gateway is the `centraid gateway` process; a seat is a device's own replica (`centraid seat` on desktop, the Rust core linked through `crates/core-ffi` on mobile). Product decisions behind it: [docs/decisions.md](docs/decisions.md) ([R-1020-9](docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)).

### Trust anchors

| Anchor | What it is | Compromise means |
| --- | --- | --- |
| **Filesystem access to `--data-dir`** | Shell/OS access to the gateway's data directory, including `keys/` | The landlord anchor: whoever can read the directory can read the vault's rows, its blobs, and the keys in `keys/` |
| **Vault seal key (DEK)** | AES-256-GCM key in the gateway's `keys/`; seals sealed-column cells as `sealed:v1:` with a `<table>.<column>:<rowId>` AAD (`crates/vault/src/custody/seal.rs`) | Attacker can open every sealed column except Locker secrets |
| **Gateway endpoint key** | `keys/gateway.endpoint.key`, the iroh identity, **long-term** — a gateway that re-minted it would be unreachable at the address every paired seat holds ([D-1025-S7-81](docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)) | Attacker can impersonate the gateway to paired seats |
| **Backup master key** | `keys/backup.master.key`; HKDF-SHA-256 derives the backup data and dedup keys | Attacker can open sealed WAL segments and manifests (see [Backups](#backups)) |
| **Locker member key `K`** | Minted on the seat that founds the vault and held only in seat key stores, wrapped under the member's Locker passphrase | Attacker can open Locker secret cells |
| **Paired device key** | The device's `access_device` row and its private `access_device_secret.public_key` sibling in the vault ([D-1025-S7-80](docs/decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)), plus the device-local private key. Enrollment is full trust ([#996](https://github.com/srikanth235/centraid/issues/996) R11) | Attacker acts as that owner until the device is revoked |
| **Pairing ticket secret** | One-time redeem secret, stored only as its BLAKE3 hash | A single enrollment if redeemed before burn or expiry |
| **Recovery kit passphrase** | Wraps the kit written by `centraid export` | Attacker holding the kit file can open the keys it carries |

There is **no multi-tenant server** and no Centraid-operated cloud that can read vault contents.

**Key files at rest.** `crates/vault/src/custody/keystore.rs` writes every key file as an envelope with one of two schemes: `aes-256-gcm-v1` under a host wrapping key, or `file-0600-v1`. The CLI opens its key stores with no host wrapping key, so on a gateway today the key files are **mode-0600 files readable by the gateway user** — there is no OS keychain in the path on desktop or server. Loose permissions are repaired to 0600 with a warning, and writes are atomic (temp file at `O_EXCL` 0600, then rename). This is a host-account boundary, not protection from anyone who can read the data directory; operators should use full-disk encryption. `keys/` sits outside the directories that export and backup move around, so a copied vault carries ciphertext for its sealed cells and no key.

**Credential issuance is pairing-only.** There is no bearer token, password, session, or HTTP pairing route. A device enrolls by redeeming a pair ticket (`crates/net/src/pairing.rs`), which the gateway mints when started with `--print-qr` and prints as a QR:

- The ticket has a 15-minute TTL (`TICKET_TTL_MS`, `crates/net/src/ticket.rs`), exclusive at its edge. Only the BLAKE3 hash of its secret is stored, and tickets live in gateway memory, so a restart invalidates every unredeemed one.
- Redemption enrolls the device and burns the ticket under one lock, enrollment first: a failed vault write leaves the ticket unburnt and retryable, and nothing else can redeem it meanwhile. A wrong secret and an unknown ticket are the same refusal.
- A redeeming device's connection is accepted **provisional** (`Endpoint::accept`, `crates/net/src/endpoint.rs`): one stream, one `pair` request, a short deadline. A successful redemption promotes that connection in place; every other connection is admitted only if its peer key is a live device in the allowlist (`crates/centraid/src/allowlist.rs` over `crates/vault/src/devices.rs`).
- The device reaches exactly what the vault's owner owns. There is no per-device tier. Revoking a device deletes its `access_device_secret` row, so an unknown device and a revoked one get the same refusal (`crates/vault/src/access.rs`). **`centraid devices list` and `centraid devices revoke` are not wired yet** — both exit as not available — so revocation has no CLI today.

**The gateway opens no listening port.** The transport is iroh QUIC on one ALPN, `centraid/v1` (`crates/protocol/src/alpn.rs`). There is no HTTP server in the product; `crates/centraid/tests/no_listener.rs` asserts that a running gateway owns no listening TCP socket, and the `no-listening-socket` rule in `cargo xtask rules` refuses new listener code.

**Relays.** Hole-punching falls back to relays reached over outbound TCP 443, so reachability depends on relay availability. The default is n0's public relays; `--relay <url>` selects a self-hosted relay and `--no-relay` disables them. A relay operator sees connection metadata, never vault bytes.

### The gateway on rented hardware ([#1020](https://github.com/srikanth235/centraid/issues/1020))

- **Trusted for data, blind for secrets.** The gateway is a headless daemon the member runs wherever they choose — a VPS, a home server, Docker, or their own laptop. **For data, the host operator is trusted**: whoever can read the gateway's disk or process memory can read the vault's rows and blobs, because the gateway runs every app's queries over real tables. **For secrets, the host operator is blind**: Locker secret cells are sealed under the member key `K`, which the gateway never holds.
- **Why not end-to-end for everything.** Full end-to-end encryption would make the gateway a dumb relay: app logic — queries, projections, automations, search, recognition — runs on the gateway. Secrets are the one class where a blind host is worth its cost.
- **How the blindness is built** (`crates/vault/src/custody/README.md`). `K` is born on a seat and the vault stores only its id (`locker_key(key_id, created_at, retired_at)`); a vault with no seat holds no key, and a Locker write that arrives carrying plaintext is a receipted refusal (`assert_sealed_cell`). The reveal door is deleted rather than refused: `crates/vault::access::Verb` has no reveal arm, `SealedSubject::new` cannot be built for the `locker` schema, `MemberKeyCustody::on_seat` is the only custody constructor, and `crates/core`'s reveal refuses on the gateway role. `K` moves to a second seat as an `mk1:` envelope under HKDF over a one-time transfer secret, with the recipient device id in the AAD, so a relaying host cannot open it.
- **On the seat.** `K` is wrapped at rest with **Argon2id** (m = 64 MiB, t = 3, p = 1) and AES-GCM ([D-1025-S4-4](docs/decisions.md#slice-s4--one-hash-1025); `crates/seat/src/locker/unlock.rs`). The passphrase minimum is 12 characters, and there is no stored verifier — a wrong passphrase fails AEAD authentication. An unlocked session lasts five minutes of idle time and a reveal window thirty seconds (`crates/seat/src/locker/session.rs`). The gateway's only part in a reveal is the access receipt.
- **What this costs.** The gateway cannot compute a Watchtower score, a one-time code, or a plaintext export, so those run on the seat (`crates/apps/locker`). The recovery kit is the single custody path between a member and total loss of `K`: a kit exported from a gateway carries no member key and says so.
- **What the gate does not prove.** `crates/vault/tests/member_key_gate.rs` (`a_gateway_without_the_key_door_cannot_produce_plaintext`) searches every door that returns bytes, the seat snapshot, the backup base and the vault file for planted plaintext, and asserts no member-key reader exists. It proves that a **gateway process** cannot produce plaintext. It does not prove that a host with root cannot read `K` off a seat's disk or memory while that seat is unlocked: an unlocked session holds `K` in process memory, and no OS keystore is in that path.
- **Connector tokens are host-readable, deliberately.** `sync_connection_credential`'s token columns are sealed under the vault DEK, which the gateway holds, because the gateway injects and refreshes the token ([#996](https://github.com/srikanth235/centraid/issues/996) W6-D1). The blindness above is scoped to Locker secret cells and nothing else; after a host compromise, revoking the connection at the provider is the remedy.

### Seats and replicas

- **A seat snapshot carries no private table.** `crates/vault/src/snapshot.rs` drops the 28 private tables named in `contracts/schema/v0-registries.json` (device secrets, agent secrets, `locker_key`, blob keys, `sync_connection_credential` and others), removes the excluded JSON keys — `access_receipt.detail_json.output`, the verbatim return value of every command — truncates `replica_log`, and vacuums, so no trace survives in freed pages. The log plane never captures a private table.
- **The audit band is append-only in the engine.** Triggers in `contracts/schema/vault-ddl.sql` refuse UPDATE and DELETE on `access_receipt`, `access_provenance`, and the agent evidence tables, except through the archive pass. The conversation ledger band is deliberately mutable, because a turn is amended as it streams.
- **A seat holds the rest of `vault.db`** ([#996](https://github.com/srikanth235/centraid/issues/996) R1), including conversation history and the Locker access log. The seat's file is the boundary: a compromised seat is a compromised device of that owner, which is why revocation removes its key.
- **The mobile core** is the Rust core behind a five-symbol C ABI (`centraid_open`, `centraid_call`, `centraid_next_event`, `centraid_free`, `centraid_close`, `crates/core-ffi/src/lib.rs`). Payloads are protobuf; a panic is caught and poisons the handle rather than unwinding across the ABI. Device secrets live in the Keychain on iOS (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and in `EncryptedSharedPreferences` under an Android Keystore master key (`mobile/shared/src/*Main/kotlin/dev/centraid/shared/platform/`). There is no biometric or device-lock gate in the mobile app today.

### Derived data and sensitive enrichments

Derived rows (embeddings in `enrich_embedding`, extracted text in `core_content_derivative`, machine tags) are ordinary owner-custody vault rows: they follow the same backup, erase, and replication paths as authored data. Face data (detected regions in `media_face_region`) is the most sensitive derived class in the product. The `media.forget_person` command (`crates/vault/src/commands/media.rs`) deletes every face region that names a person and the rows derived from them; `crates/vault/tests/media_commands.rs` covers it (`forgetting_a_person_takes_every_face_that_names_them_and_nothing_else`, `forgetting_the_only_member_clears_their_judgements_and_erases_nobody_elses_face`). Identity is never inferred: grouping proposes, and only the owner's own answer names anyone.

### Desktop

- **The local seat socket is authenticated by peer credentials.** Electron main spawns the `centraid seat` sidecar and reaches it over a Unix socket. `crates/centraid/src/cmd/seat/peer.rs` sets the socket to 0600 and its directory to 0700, and admits only a peer with the owning uid (`the_owning_uid_is_admitted_and_a_second_uid_is_refused`). Windows is refused rather than served over an unprotected pipe. The **OS user boundary** is the primary local boundary; Centraid does not claim protection against malware running as the same user.
- **Stored bytes are treated as attacker-authorable.** Blob responses served to the renderer carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` (`desktop/electron/src/main/media-response-core.ts`), so a stored media type cannot become script in the renderer's origin.
- **Auto-update is fail-closed and currently refuses every packaged update.** `desktop/electron/src/main/update-signature-core.ts` installs only a payload whose SHA-512 appears in a release manifest signed by a pinned Ed25519 key, and `TRUSTED_RELEASE_KEYS` in `update-signature-gate.ts` is empty, so a packaged build rejects every downloaded payload and falls back to a plain relaunch. A test asserts the empty list; enrolling a key (`docs/enrollment.md`, secret `CENTRAID_RELEASE_SIGNING_KEY`) flips that test, and the flip is the review signal.

### Browser extension

The Companion extension (`extension/`) talks to `centraid native-host`, which the browser launches under the member's user. The native-messaging manifest allowlists the extension ids. The host connects to the seat socket — passing the same uid check — and presents a per-session seat token (`crates/centraid/src/cmd/native_host.rs`). The host derives a page's origin itself rather than trusting the extension's claim, and Locker matching is by registrable domain or exact host (`crates/apps/locker/src/origin.rs`, vectors in `contracts/origin-matching-v1.json`). An autofill reveal requires a top-level frame whose origin matches the active tab, over HTTPS or loopback (`lockerGestureRefusal`, `extension/src/page-origin.ts`).

### Backups

`centraid backup now` takes a generation (`crates/vault/src/backup/mod.rs`): a base copy, the WAL segments after it, and a manifest. WAL segments are sealed under the backup data key with deterministic nonces, and the manifest is sealed and hash-chained to the previous generation, so a gap is visible. Storage is the local filesystem only.

**The base copy is not sealed.** It is a gzipped `VACUUM INTO` of the vault written to the blob store as is. Sealed columns and Locker `lk1:` cells inside it stay encrypted; everything else in it is plaintext. The comment in `crates/vault/src/backup/base.rs` says the base is sealed under the backup data key, and the code does not do that — see the claim register.

The recovery kit (`crates/vault/src/backup/kit.rs`, written by `centraid export`, read by `centraid recover --password-file`) is wrapped with scrypt (N = 2^17, r = 8, p = 1) and AES-GCM. A passphrase must be at least 12 characters or four words when a kit is sealed, and the floor is never applied when a kit is opened, so it cannot lock an owner out of their own recovery material.

### Docker

The gateway image (`deploy/docker/Dockerfile`) runs as non-root UID/GID `10001` (`centraid`), exposes no port, and runs `gateway --data-dir /data`. It declares no `VOLUME`: **bind-mount a host directory or a named volume at `/data`**, writable by that user, or the vault is lost when the container is removed.

### What the transport can and cannot do

**Can:** move authorized requests and blob bytes between paired endpoints over `centraid/v1`; let a seat work offline against its own replica and replay its intents on reconnect.

**Cannot (and must not be assumed to):** hide traffic metadata from relays; protect against a malicious app the owner installed; protect against root on the gateway host; provide anonymity.

### Explicitly not yet implemented / incomplete

Treat the following as **open**, not as shipping guarantees:

- Device revocation from the CLI (`centraid devices`).
- Sealing the backup base copy.
- An OS keystore for gateway key files and for `K` on an unlocked seat.
- A biometric or device-lock gate on mobile.
- Formal third-party audit of the pairing and transport implementation.

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
| Refresh capability | Worker HMAC secret → gateway vault | HMAC over the refresh token minted at `/exchange` (issue #865); sealed beside the token and presented on every `/refresh`, so a stolen refresh token alone is worthless without it |
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

`/exchange` and `/refresh` are intentionally internet-facing server-to-server proxies. The Google secret is not exposed—it travels only Worker→Google—but an attacker can try to make the shared client use it. PKCE and the browser-bound callback receipt make direct or authorization-URL-only exchange attempts fail before Google and make successful theft impossible without the gateway-held verifier. `/refresh` additionally requires the **exchange-minted refresh capability**: an HMAC over the presented refresh token that only `/exchange` can mint (issue #865), verified timing-safely before any Google call — so a stolen refresh token alone can neither redeem fresh tokens nor use the endpoint as a validity oracle, and a rotated token re-mints its capability in the same response. The receipt proves that this Worker recently accepted the exact bound callback tuple; it does not, by itself, authenticate Google as the HTTP caller. Google establishes authorization-code validity during the token exchange. The defended residual risk on both endpoints is fleet availability/reputation: failing attempts could consume quota or trigger Google's abuse heuristics.

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

## The claim register ([#1014](https://github.com/srikanth235/centraid/issues/1014))

Every security claim this document makes, what enforces it, and — where nothing does — who owns the gap. A row is **ENFORCED-BY-TEST** only when the named test fails if the property stops holding; anything weaker says so in its own words.

Adding a claim to this document without adding its row is the thing this table is here to stop.

| Claim | Status | Enforced by |
| --- | --- | --- |
| A seat snapshot carries no private table, and no readable trace of one in freed pages | ENFORCED-BY-TEST | `the_private_canary_is_absent_from_the_files_bytes`, `crates/vault/tests/snapshot_faults.rs` — asserted over the file's bytes |
| The log plane never captures a private table | ENFORCED-BY-TEST | `a_private_table_is_never_captured_at_all`, `crates/vault/tests/log_plane.rs` |
| Command output (`access_receipt.detail_json.output`) never reaches a seat | IMPLEMENTED, **no dedicated test named here** | `redact_columns` in `crates/vault/src/snapshot.rs`, driven by `jsonKeyExclusions` in `contracts/schema/v0-registries.json` |
| The audit band is append-only in the engine | IMPLEMENTED IN SCHEMA | the `RAISE(ABORT, …)` triggers in `contracts/schema/vault-ddl.sql` |
| A gateway process cannot produce Locker plaintext | ENFORCED-BY-TEST | `a_gateway_without_the_key_door_cannot_produce_plaintext` and `the_gateway_cannot_be_talked_into_storing_a_plaintext_secret`, `crates/vault/tests/member_key_gate.rs` |
| A plaintext secret is refused at every door that takes one | ENFORCED-BY-TEST | `a_plaintext_secret_is_refused_at_every_door_that_takes_one`, `crates/vault/tests/locker_commands.rs` |
| A host with root cannot read `K` off an **unlocked** seat | **NOT ENFORCED — open** | the gate above covers a gateway process only; no OS keystore is in the seat's path. Owned by [#1020](https://github.com/srikanth235/centraid/issues/1020) |
| Connector tokens are readable by a gateway host, deliberately | **DOCUMENTED NON-CLAIM** | sealed under the vault DEK per [#996](https://github.com/srikanth235/centraid/issues/996) W6-D1; the row exists so a reader cannot carry the Locker premise across to connections |
| A running gateway owns no listening TCP socket | ENFORCED-BY-TEST | `a_running_gateway_owns_no_listening_tcp_socket`, `crates/centraid/tests/no_listener.rs`; the `no-listening-socket` rule in `cargo xtask rules` |
| A pairing ticket stores only its secret's hash and expires after 15 minutes | ENFORCED-BY-TEST | `minting_stores_only_the_hash_and_sets_a_fifteen_minute_ttl`, `crates/net/src/pairing.rs`; `the_secret_itself_is_never_stored`, `an_expired_ticket_is_refused_at_its_own_edge`, `crates/net/src/allowlist.rs` |
| A pairing ticket is single-use, and a wrong secret reads as an unknown ticket | ENFORCED-BY-TEST | `a_redemption_enrols_the_device_and_burns_the_ticket`, `a_wrong_secret_and_an_unknown_ticket_are_the_same_refusal`, `crates/net/src/allowlist.rs` |
| A revoked device reaches no vault door | IMPLEMENTED, **no CLI to revoke** | `crates/vault/src/access.rs` (revocation deletes the key row); `centraid devices revoke` is not wired yet |
| Only the owning uid is served on the desktop seat socket | ENFORCED-BY-TEST | `the_owning_uid_is_admitted_and_a_second_uid_is_refused`, `crates/centraid/src/cmd/seat/peer.rs` |
| A stored media type never becomes script in the desktop renderer | ENFORCED-BY-TEST | `desktop/electron/src/main/media-response-core.test.ts` |
| A packaged desktop build refuses every update until a release key is enrolled | ENFORCED-BY-TEST | `desktop/electron/src/main/update-signature-gate.test.ts` asserts `TRUSTED_RELEASE_KEYS` is empty |
| A forgotten person's face regions are deleted, and nobody else's | ENFORCED-BY-TEST | `crates/vault/tests/media_commands.rs` |
| A panic inside the mobile core poisons the handle instead of crossing the ABI | ENFORCED-BY-TEST | `a_real_panic_inside_call_poisons_the_handle_through_the_abi`, `crates/core-ffi`, run by the `fault-door` gate step |
| A kit passphrase meets a strength floor when sealed, and never when opened | IMPLEMENTED | `assert_passphrase_floor`, `crates/vault/src/backup/kit.rs`, called from `crates/centraid/src/cmd/export.rs` |
| A backup never leaves vault plaintext on the backup store | **NOT ENFORCED — open** | WAL segments and manifests are sealed, but `take_generation` writes the base copy unsealed (`crates/vault/src/backup/mod.rs`), contradicting the comment in `crates/vault/src/backup/base.rs` |

## Automated security gates

Complementary controls on top of manual review and the threat model above. The PR gate is `cargo xtask gate --profile pr` in `.github/workflows/gate.yml` (`crates/xtask/src/gate.rs`).

| Gate | Where | What it catches | What it does not replace |
| --- | --- | --- | --- |
| **GitHub secret scanning + push protection** | Repo setting (enabled) | Known provider token patterns on push/PR | Non-provider high-entropy strings |
| **Gitleaks** | gate step `secrets` (`gitleaks detect --no-git --config .gitleaks.toml`) | High-entropy / generic secrets in the current tree; fixtures allowlisted in [`.gitleaks.toml`](.gitleaks.toml) | Full git-history archaeology |
| **dependency-review** | `gate.yml` job `dependency-review` (PR only) | _New_ high-severity advisories and banned copyleft licenses introduced by the PR | Latent vulnerabilities already in the lockfiles |
| **OSV-Scanner** | gate step `osv` → [`scripts/ci/osv-lockfile-scan.mjs`](scripts/ci/osv-lockfile-scan.mjs) | Full `bun.lock` inventory; **fails on CRITICAL** only; HIGH is logged | Typosquat/malware behavioral signals |
| **cargo-deny** | gate step `deny` (`cargo deny --all-features --config deny.toml check`) | Rust advisories, licences, banned and duplicate crates | The JS lockfile, which OSV and dependency-review own |
| **Advisory register** | gate step `advisory` | An accepted advisory past its expiry | Deciding whether an advisory should be accepted |
| **CI policy** | gate step `ci-policy` (`lint:workflow-pins`, `lint:ci-egress`, `lint:path-filters`) | Unpinned actions, and a workflow that installs dependency code without `harden-runner` beyond the shrink-only [`egress-ledger.json`](scripts/security/egress-ledger.json) | Enforcement inside the ledgered workflows |
| **Prompt injection** | gate step `prompt-injection` | The assistant's prompt-injection suite | — |
| **CodeQL** `security-extended` | [`candidate.yml`](.github/workflows/candidate.yml) job `codeql`, on every push to `main` | SAST for TS/JS, Actions YAML, Rust | Per-PR wall-clock budget |
| **Rust supply chain** | [`candidate.yml`](.github/workflows/candidate.yml) job `rust-supply-chain`, on every push to `main` | `cargo-audit` and `cargo-deny` findings, plus [`scripts/security/unsafe-edge-audit.mjs`](scripts/security/unsafe-edge-audit.mjs): a new `unsafe` block, or one without a `// SAFETY:` justification | Whether an existing justification is _correct_ |
| **Trivy** | [`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml) after image push | CRITICAL/HIGH OS and package CVEs in the gateway image; exceptions in [`.trivyignore`](.trivyignore) with reason + review date | Scanning every app surface |
| **SBOM + provenance** | [`lane-release-desktop.yml`](.github/workflows/lane-release-desktop.yml) job `supply-chain` → [`scripts/security/supply-chain.mjs`](scripts/security/supply-chain.mjs) | A deterministic CycloneDX 1.6 BOM of `bun.lock` and an in-toto/SLSA v1 statement over the real artifact digests, both re-verified in the same run | Signed container images (cosign, not yet enrolled) |

**Roles (lockfile):** dependency-review = “don’t _add_ a known-bad dep on this PR.” OSV = “what is _already_ in the lockfile?” so inventory debt cannot hide behind an unrelated change.

**Re-apply / local:**

```bash
cargo xtask gate --profile pr
# or one tool at a time:
gitleaks detect --source . --no-git --config .gitleaks.toml
node scripts/ci/osv-lockfile-scan.mjs   # with osv-scanner on PATH
```

SonarCloud Autoscan remains a second-opinion maintainability/security check on PRs; it is not one of these gates, and it is **token-gated**: analysis is SonarCloud-side Automatic Analysis on the `srikanth235_centraid` project, and the project's configuration — scope exclusions, silenced noise rules, quality profiles and gate — is applied by `scripts/ci/configure-sonarcloud.mjs`, run from [`.github/workflows/sonarcloud.yml`](.github/workflows/sonarcloud.yml) on pushes that touch the configurator, weekly, and on manual dispatch. That lane runs only when the optional `SONAR_TOKEN` secret is present (a personal token with project administer); without it every step is skipped and the run logs an explicit skip notice, so a clone or fork with no token gets no SonarCloud coverage rather than a silent half-configured one. Policy detail lives in [the toolchain contract](docs/toolchain.md#sonarcloud-autoscan).
