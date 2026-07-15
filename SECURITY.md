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
