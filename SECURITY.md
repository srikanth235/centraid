# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Centraid, please report it privately rather than filing a public issue.

- Email: **srikanth@crowdshakti.com**
- Subject line: `[centraid security] <short description>`

Please include:

- The affected component (`apps/desktop`, `apps/mobile`, `packages/design-tokens`, or the build setup).
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

Honest boundary for the always-on personal gateway. This is not a guarantee of
future features — it is what the product claims **today**. Product decisions
that affect process lifetime: [docs/decisions.md](docs/decisions.md) (H1).

### Trust anchors

| Anchor | What it is | Compromise means |
| --- | --- | --- |
| **Vault owner / sealing material** | Owner holds vault sealing keys (on-disk `keys/` outside backup) and recovery kit | Attacker can decrypt backups and read vault plaintext offline |
| **Gateway device identity** | `endpoint-key.bin` (iroh) + local bearer `token.bin` / device tokens | Attacker can impersonate the gateway on the tunnel plane and/or call authenticated HTTP as that gateway |
| **Paired device key** | Device enrollment in `devices.json` + client private key | Attacker acts as that device within its consent/trust tier until revoked |
| **Pairing ticket secret** | One-time redeem secret (hashed at rest on gateway) | Single enrollment if redeemed before burn/expiry; wrong guess burns ticket |
| **Backup provider credentials** | Object-store grants / API keys | Provider traffic + ability to delete/orphan remote objects — **not** vault plaintext (E2E encrypted) |

There is **no multi-tenant server** and no Centraid-operated cloud that can read vault contents. Hosted storage is ciphertext + metadata shape (see below).

### Local-socket / loopback boundary

- Desktop and daemon gateways bind **loopback HTTP** with **Bearer** auth for the control plane. Anyone who can read the bearer token file (mode `0600`) or inject into the local user session can call gateway APIs as that gateway.
- The renderer is a **thin client**: Electron IPC is for native operations (keychain, window, lifecycle), not a second authorization system for vault data.
- **OS user boundary** is the primary local boundary. Centraid does not claim protection against malware running as the same user.
- Until detached gateway work (H1–H7) fully lands, quitting the desktop may take the gateway down — availability, not a different trust model.

### Loopback / browser control-plane (Host, CORS, auth placement)

Posture after issue **#504 batch 0** (fixed; do not document the old reflective-CORS hole as current).

| Control | Behavior |
| --- | --- |
| **Host allowlist** | Loopback HTTP rejects requests whose `Host` is outside `localhost` / `127.0.0.1` / IPv6 loopback / configured hostnames **before** auth and handlers (DNS rebinding). |
| **CORS — Bearer** | Authorization is carried in the `Authorization` header (or preflight lists `authorization`). Reflecting Origin with credentials is allowed for Bearer intent because the token is not ambient. `Origin: null` / missing Origin still use `*` (desktop `file://`). |
| **CORS — cookie / PWA** | Credentialed CORS (`Access-Control-Allow-Credentials: true` + reflected Origin) is limited to **session-bound shell origins** (`credentialedCorsOrigins` from control/app sessions). Foreign origins never get reflective credentialed CORS; they may see `*` without credentials so `credentials: 'include'` cannot read the body. |
| **Preflight vs auth** | `OPTIONS` still answers **before** Bearer/cookie auth (browsers omit Authorization on preflight). CORS headers on the preflight already encode the credentialed-vs-not decision; the real request is still auth-gated. |
| **Auth transport** | Desktop/daemon: Bearer (`token.bin` / device tokens). PWA shell: Origin-bound HttpOnly control cookie + app cookies; `authorizeRequest` enforces origin bind in addition to CORS defense-in-depth. |
| **WS / tunnel** | Device plane auth is enrollment/token based on the tunnel; not cookie ambient. |

**Non-loopback / Docker operators (packaging 5C):**

- Binding `0.0.0.0` (the gateway Docker image default) does **not** open Host or CORS. Loopback Host names remain allowed; any other `Host` clients send must be listed via `--allowed-host <name>` (repeatable) and/or `CENTRAID_ALLOWED_HOSTS=host1,host2`.
- Vault and ledger data live under the process `--data-dir` (image: `/data`). **Bind-mount a host directory or use a named volume** at `/data`. A bare `docker run` without a durable mount loses data when the container is removed — the image `VOLUME` alone is not a backup strategy.
- Image process runs as non-root UID/GID `10001` (`centraid`); ensure the mounted volume is writable by that user.

**Honest not-yet (control plane):**

- Formal third-party review of the PWA cookie + CORS combination.
- Full detached gateway supervision (H2–H7) remains open.
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

- Full **detached** gateway supervision and adopt-don't-kill ownership (H2–H7) — policy decided, code may still embed.
- **Platform secure storage** for all mobile secrets (J4 decided; verify before store submission).
- Comprehensive **renderer/GPU crash** isolation on desktop (K12).
- Hard **capability walls** on every client surface (C1) — protocol policy is set; not every feature may be gated yet.
- Extension pairing surface ([#462](https://github.com/srikanth235/centraid/issues/462)) — must follow C1–C3 before ship.
- Formal third-party audit of the pairing/tunnel implementation.

### Related recovery

- [docs/recovery/pairing.md](docs/recovery/pairing.md)
- [docs/logs.md](docs/logs.md)

## Centraid Assist OAuth: Model B code courier

Centraid Assist gives desktop/PWA clients paired to a non-public gateway a
working Google OAuth path without turning Centraid's cloud edge into a
credential vault. The complete design and user-facing behavior are in
[docs/oauth-assist.md](docs/oauth-assist.md); incident response is in
[docs/recovery/oauth-assist.md](docs/recovery/oauth-assist.md).

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

The Worker has no KV, D1, Durable Object, R2, cache, queue, connection table,
or user identity scope. Its only cookie is a signed, HttpOnly, ten-minute
browser-binding envelope containing no OAuth code, token, identity, or
connection record; all state remains in the browser. It requests neither
`openid`, `email`, nor `profile`. Aggregate Analytics Engine metrics contain
route, outcome, status, and count only. Workers Logs, invocation logs, and
automatic traces are disabled because callback query strings contain
code/state and Cloudflare traces retain full URLs; any zone Logpush
configuration must likewise omit or redact query strings, bodies, and headers.

### Data flow and fixed return targets

The client first opens `https://oauth.centraid.dev/start#…`. That page scrubs
its fragment before network I/O, validates the fixed Google authorization URL,
seals the gateway's one-ceremony browser binding into a signed HttpOnly cookie,
then navigates to Google. The binding is deliberately absent from the Google
authorization URL: someone who obtains only that URL cannot produce a callback
accepted for the initiating browser.

Google redirects only to `https://oauth.centraid.dev/callback`. The callback
does **not** exchange the code. It requires the signed binding cookie, then a
gateway-generated `d.`/`w.` state prefix selects exactly one compiled return
target:

- desktop: `centraid://oauth/finish#code=…&state=…&receipt=…`
- PWA: `https://app.centraid.dev/oauth/finish#code=…&state=…&receipt=…`

No query parameter, Origin header, or arbitrary state value can choose a
redirect. The PWA scrubs the fragment synchronously before network work. The
desktop main process accepts only a bounded, exact OAuth finish shape and never
logs the link. The renderer validates it again. The client then calls an
owner-authenticated gateway endpoint using the same per-tab/window session
nonce and enrolled device identity recorded at start.

The gateway validates the live state and client/device binding before consuming
it. It then calls the Worker's `/exchange` with the code, receipt, fixed
redirect, PKCE verifier, and its original browser binding. The Worker validates
the receipt against the exact code/state/browser-binding tuple before any
Google call, attaches the confidential secret, and returns only allowlisted
OAuth token fields. Replays fail on the consumed gateway state; expired/foreign
state fails without a Worker call. A foreign gateway cannot redeem because it
has neither the pending state, verifier, nor browser binding.

### Confused-deputy and availability threat

`/exchange` and `/refresh` are intentionally internet-facing server-to-server
proxies. The Google secret is not exposed—it travels only Worker→Google—but an
attacker can try to make the shared client use it. PKCE and the browser-bound
callback receipt make direct or authorization-URL-only exchange attempts fail
before Google and make successful theft impossible without the gateway-held
verifier. The receipt proves that this Worker recently accepted the exact bound
callback tuple; it does not, by itself, authenticate Google as the HTTP caller.
Google establishes authorization-code validity during the token exchange.
`/refresh` has no preceding callback, so the defended residual risk is fleet
availability/reputation: failing attempts could consume quota or trigger
Google's abuse heuristics.

Required layered controls:

- production hostname only; `workers.dev` and preview URLs disabled;
- zone per-IP rate limits for `/exchange` and `/refresh`;
- Worker per-IP and per-location ceiling bindings;
- WAF managed rules, Bot Fight Mode, TLS-only, HSTS, CSP, no-store, and
  no browser CORS access to token responses;
- strict bounded JSON/body/provider/PKCE/redirect/state/browser-binding/receipt
  validation before Google;
- Worker-side scope allowlisting and an exact comparison with Google's granted
  scope response before any token is returned;
- aggregate failure-ratio, 429, 5xx, and volume alerts;
- `EXCHANGE_ENABLED` kill switch and credential-rotation runbook.

The binding named `GLOBAL_LIMITER` is per Cloudflare location, not a true
fleet-global counter. It is defense in depth, not a substitute for zone rules
and alerts. Turnstile is deliberately absent: these endpoints are gateway
server-to-server calls, not interactive browser forms.

The complete `/start#…` URL is a short-lived ceremony capability. A party that
steals it before the page scrubs the fragment can reproduce the browser
binding. It is therefore never logged, persisted, or placed in a referrer; the
more widely exposed Google authorization URL intentionally omits the binding.

Assist deliberately supports self-hosted gateways without a Centraid cloud
account or per-gateway edge credential. The Worker therefore cannot distinguish
a legitimate new installation from a caller completing a valid consent flow
for that caller's own Google account. It limits such flows to the audited scope
allowlist and exact Google-granted scope set; WAF/rate limits/alerts protect the
shared client's quota and reputation. This is not a claim that `/exchange`
authenticates a Centraid installation, and it does not let a caller obtain
another user's grant.

### Failure posture and non-claims

- Worker outage blocks new Assist exchanges and makes refresh attempts retry
  once then skip the current fire. It does not expose tokens or erase imported
  data. BYO remains available.
- Google `invalid_grant` moves the connection to `needs-auth` with a
  **Reconnect with Centraid Assist** note. Silent refresh is otherwise normal.
- BYO is unchanged and refreshes directly, but its provider callback must be
  browser-reachable; pairing/relay reachability alone is insufficient.
- Assist does not proxy Google API calls, store connection rows in Centraid
  cloud, protect against compromise of the gateway/paired client, or remove
  Google Workspace administrator policy.
- Standard Assist must not be called GA until the production consent/brand and
  sensitive-scope evidence passes. Restricted Gmail/Drive scopes remain
  disabled until restricted-scope verification and CASA evidence pass. The
  executable evidence checklist is
  [docs/release/oauth-assist-google.md](docs/release/oauth-assist-google.md).

## Known metadata exposure to backup providers

Backup objects are end-to-end encrypted (AES-256-GCM, keys never leave the
owner — `packages/backup/FORMAT.md`), so a storage provider reads no vault
content. It does observe **traffic shape**: object counts and sizes always
told a provider roughly how much a vault stores, and the continuous WAL
segment stream (issue #408) sharpens that into **write volume and cadence**
— segment sizes and upload timing correlate with when and how much the
owner writes. This is an accepted trade for continuous, point-in-time
backup; the shipper's tick/threshold knobs are where padding or batching
would land if a deployment needs that correlation blunted.

The snapshot format compresses chunk objects *before* encrypting them
(entropy-gated zstd, issue #405 §1), which introduces a **compressibility
side channel**: because compression happens inside the seal, a chunk object's
ciphertext *length* now reveals how compressible — how redundant — its
plaintext was. Two 16 MiB parts seal to visibly different object sizes if one
is highly repetitive (a text-heavy SQLite base) and the other is high-entropy
(already-compressed media, random blobs). The provider learns nothing about
*what* the bytes are, only a coarse redundancy estimate per object, on top of
the size/cadence it already saw. This is accepted for Centraid's threat model:
a **personal, single-tenant** vault where the owner holds the keys and there is
no cross-tenant secret to sift out via a chosen-plaintext/CRIME-style
adaptive-injection attack (the classic setting where compress-then-encrypt is
dangerous — an attacker mixing controlled and secret data in one compression
context). The gain — materially smaller, cheaper, faster backups of the bulk
data — outweighs a redundancy estimate a provider could largely infer from
raw sizes anyway. The escape hatch is in the format: the per-chunk algorithm-id
byte carries a **stored-raw** encoding (`0x00`), and the keep-if-smaller gate
already selects it for any part compression does not shrink, so incompressible
data is stored verbatim and a deployment that wants to forgo the channel
entirely can force raw storage without a format change.
