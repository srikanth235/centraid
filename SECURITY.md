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
| **Paired device key + trust tier** | EndpointId enrollment in `gateway.db` + a device-local private key; the `owner` tier is the per-device, revocable capability | Attacker acts as that device within its consent/trust tier until the enrollment is revoked |
| **Pairing ticket secret** | One-time redeem secret (hashed at rest on gateway) | Single enrollment if redeemed before burn/expiry; wrong guesses do not consume the real owner's ticket |
| **Backup provider credentials** | Object-store grants / API keys | Provider traffic + ability to delete/orphan remote objects — **not** vault plaintext (E2E encrypted) |

There is **no multi-tenant server** and no Centraid-operated cloud that can read vault contents. Hosted storage is ciphertext + metadata shape (see below).

**Credential issuance is iroh pairing-only.** There is no durable gateway bearer, per-device HTTP token, direct-URL pairing route, or wildcard admin plane — and no password/session/OIDC plane by design ([#599](https://github.com/srikanth235/centraid/issues/599); [docs/decisions.md](docs/decisions.md)): authentication is the transport, and identity-proofing for a new household member is an owner handing them a ticket. Since [#603](https://github.com/srikanth235/centraid/issues/603) there is exactly **one ticket kind — the pair ticket**, and it always means _join an existing gateway_. A gateway founds itself: a **fresh data dir** creates `Shared` + `Personal` at construction and enrolls the host's own device identity as the owner **member** with the `admin` role on both, in one `gateway.db` transaction. Ordinary pairing then binds a device to its member, and the device inherits that member's `(member, vault)` roles (`admin`/`write`/`read`). Every **vault-scoped** request resolves a real enrollment in one vault and fails closed without a proved device identity. One surface is deliberately outside that rule: `GET /centraid/_gateway/info` is public so a client can read the version/schema handshake before it can pair — it answers version and capabilities to anyone, withholds the iroh dial ticket from an unauthenticated caller, and reports `authenticated: boolean` so a bearer mismatch is distinguishable from an endpoint that is not up yet. The fresh-gateway allowlist and the `uninitialized` 409 wall from #568 item C are **gone** with the founding window they existed to serve — a gateway is never zero-vault, so no unenrolled EndpointId is ever admitted. Revocation removes the enrollment, cascades its web sessions in SQLite, and makes the QUIC admission check refuse the device. The filesystem-anchored CLI remains the recovery path if the sole owner is lost.

**KeyStore boundary (issue #555).** `keys/` is the only secret-bearing directory inside the gateway data dir, and every file there is an authenticated encrypted envelope. Desktop custody roots the wrapping key in Electron `safeStorage`; systemd/launchd services use system credentials. A manually launched headless gateway falls back, with a warning, to one external `0600` host credential under the platform configuration directory. Copying the gateway data dir alone therefore does not copy a usable wrapping key. This remains a host-account/filesystem-permission boundary—not protection from an attacker controlling the running process—and operators should use full-disk encryption. Vault DEKs are independent, never derived from the backup keyring, and never stored in `gateway.db` or snapshots. The passphrase-wrapped recovery kit is the only off-box bundle of backed-up-vault DEKs and the backup keyring; since #603 it is a deliberate **backup-plane export** (`backup kit` / the Backup screen), never something first run mints on the owner's behalf.

**Locker user-presence boundary (issue #630).** Locker is an additional application-level gate inside an already authenticated vault session. It boots locked. A passphrase verifier in `locker_auth_credential` is derived from `HMAC(vault DEK, credential)` and then scrypt-hardened with a random salt, so a copied `vault.db` is not by itself an offline passphrase oracle. Successful verification mints only memory-resident, inactivity-bounded sessions and single-item, short-lived, one-use reveal permits. Backgrounding, explicit lock, gateway restart, or timeout destroys those capabilities; the UI also erases reveals, detail models, search results, generated values, and the exact secret it last placed on the clipboard. This does not protect against malware or root inside the running gateway process, and Companion autofill remains a separate, origin-bound device-gesture reveal lane rather than reusing Locker UI tokens. The native Locker cover uses the same online-only authentication RPC: it never puts a passphrase, device credential, session token, item permit, or revealed secret into the mobile replica or durable intent outbox. An optional biometric credential is a random device secret protected by SecureStore with `requireAuthentication`; the gateway stores only its vault-key-peppered verifier. Native Locker masks the app switcher, relocks on background, and clears copied secrets after 30 seconds.

**Mobile device lock (issue #630).** The phone can require platform authentication before mounting the replica or hydrating gateway credentials. Its gate value is device-only SecureStore material with `requireAuthentication`; backgrounding clears the JS credential cache and unmounts the replica session behind an opaque lock surface. This is defense in depth over iOS Data Protection / Android credential encryption, not protection from a rooted device or malware running after successful user authentication.

**Untrusted content boundary (issue #630).** Values arriving from imports, connectors, OCR, capture, share targets, and other household members are data, never markup. Blueprint JSX renders them as React text/attribute values through the shared `displayText` boundary, which also neutralizes invisible control and bidi-override characters. A separate allowlist is mandatory for dynamic URL sinks: user links permit HTTP(S), mail, and telephone schemes; media/document sources permit bounded known media MIME data URLs and same-origin vault blobs, but never active HTML/SVG data documents or script schemes. CSS cover URLs use the same media policy plus explicit CSS escaping. Adversarial coverage renders the shared 13-case corpus through a real component from every bundled app.

The file-import border validates exactly one text/base64 body, strict UTF-8, file/record/field bounds, complete ICS/vCard records, and inert CSV display cells before staging. ZIP imports are never extracted to disk and reject traversal names, encryption, unsupported compression, inconsistent/truncated headers, excessive entry/aggregate expansion, and suspicious compression ratios. Any validation failure occurs before the draft batch is created, so canonical state is unchanged.

### Members, households, and the v0 storage premise (#599)

- **Five-layer model.** L0 custody (the box; landlord bearer; an exported backup recovery kit) · L1 authentication (iroh device keys — the only cryptographically provable layer) · L2 principals (**members** and agents) · L3 authorization (`(member, vault) → role`; devices inherit) · L4 attribution (the journal records the acting member — and the agent when one acted — whenever a principal is known; scheduler-fired automations carry none). A vault owner is not root; being co-owner of a shared vault grants zero access to anyone's personal vault. Root remains host custody (L0).
- **The vault boundary is the isolation.** There are no row-level ACLs inside a vault (Model B rejected in #599 — fail-open filtering, "as whom?" in every agent-generated query). Selective sharing is **placement**: a projection into an audience vault, journaled and removable. The product promise: no one can ever query your vault; what others see is only what was placed where they are.
- **Agents act on behalf of a member**: an agent turn constructed inside a member's request scope is denied writes when that member cannot write (the cap's granularity is the write bit), and the journal records the member behind it. Scheduler-fired automations have no human behind them — they run uncapped and journal no member; capping those awaits a durable owning member on the automation row.
- **v0 storage premise: the local gateway is L0-trusted.** Local CAS blobs are plaintext under `<vault-dir>/blobs/`; blob sealing exists for _untrusted remote storage_ and activates exactly when a storage/CAS provider is configured. Protection against a stolen disk is the operating system's full-disk encryption, not application-layer sealing. Shared blobs are hardlinked between vault CAS directories on the same filesystem — the link count is the cross-vault refcount, and each vault's GC only ever unlinks its own directory entry.
- **Household Locker placement does not share a key.** The trusted local gateway briefly unseals the selected item with the origin vault DEK and immediately seals each secret cell under the audience vault's independent DEK and destination-cell AAD. Ciphertext is never copied between vaults, provider storage never receives either plaintext or a universal key, connection bindings are stripped, and list/search/notification/receipt payloads remain secret-free. Compromise of the running L0 gateway remains inside the accepted v0 premise above; compromise of one backup/provider key does not decrypt the other vault.
- **Revocation removes authority, not history.** Clearing a `(member, vault)` role makes device admission and replica scope removal fail closed immediately; it does not erase the audience's independent projection for the remaining members. An explicit unshare removes that projection. Share/unshare access receipts retain the acting member id after revocation so an administrator cannot erase the audit by removing a principal.
- **Tally participants are accounting data, not authenticated principals.** `core_party` and `social_circle_member` rows name who paid or owes; only the gateway's `members` plus `member_roles` grant access. There is deliberately no pointer between those models. A Tally group becomes household-readable only by placing it in an audience vault whose authenticated members hold roles, and offline placements are link-token-idempotent before any source move.

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
| PWA HTTP fallback | Origin-bound HttpOnly control session; generated apps get **narrower** app sessions and must not reach shell/admin routes |
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

**Roles (lockfile):** dependency-review = “don’t _add_ a known-bad dep on this PR.” OSV = “what is _already_ in the lockfile?” so inventory debt cannot hide behind an unrelated change.

**Structural contract:** `node --test scripts/ci/hygiene-gates.test.mjs` asserts the three gates stay wired into real workflows (part of `scripts:test`).

**Re-apply / local:**

```bash
gitleaks detect --source . --no-git --config .gitleaks.toml
# with osv-scanner on PATH:
node scripts/ci/osv-lockfile-scan.mjs
```

SonarCloud Autoscan remains a second-opinion maintainability/security check on PRs; it is not one of these three gates. Scope exclusions, silenced noise rules, and the idempotent apply script live in [docs/sonarcloud.md](docs/sonarcloud.md) (`scripts/ci/configure-sonarcloud.mjs`).

## Known metadata exposure to backup providers

Backup objects are end-to-end encrypted (AES-256-GCM, keys never leave the owner — `packages/backup/FORMAT.md`), so a storage provider reads no vault content. It does observe **traffic shape**: object counts and sizes always told a provider roughly how much a vault stores, and the continuous WAL segment stream (issue #408) sharpens that into **write volume and cadence** — segment sizes and upload timing correlate with when and how much the owner writes. This is an accepted trade for continuous, point-in-time backup; the shipper's tick/threshold knobs are where padding or batching would land if a deployment needs that correlation blunted.

The snapshot format compresses chunk objects _before_ encrypting them (entropy-gated zstd, issue #405 §1), which introduces a **compressibility side channel**: because compression happens inside the seal, a chunk object's ciphertext _length_ now reveals how compressible — how redundant — its plaintext was. Two 16 MiB parts seal to visibly different object sizes if one is highly repetitive (a text-heavy SQLite base) and the other is high-entropy (already-compressed media, random blobs). The provider learns nothing about _what_ the bytes are, only a coarse redundancy estimate per object, on top of the size/cadence it already saw. This is accepted for Centraid's threat model: a **personal, single-tenant** vault where the owner holds the keys and there is no cross-tenant secret to sift out via a chosen-plaintext/CRIME-style adaptive-injection attack (the classic setting where compress-then-encrypt is dangerous — an attacker mixing controlled and secret data in one compression context). The gain — materially smaller, cheaper, faster backups of the bulk data — outweighs a redundancy estimate a provider could largely infer from raw sizes anyway. The escape hatch is in the format: the per-chunk algorithm-id byte carries a **stored-raw** encoding (`0x00`), and the keep-if-smaller gate already selects it for any part compression does not shrink, so incompressible data is stored verbatim and a deployment that wants to forgo the channel entirely can force raw storage without a format change.
