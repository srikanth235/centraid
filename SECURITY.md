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
