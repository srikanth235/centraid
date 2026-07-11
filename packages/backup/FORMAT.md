# centraid-snapshot/1 — Snapshot Format

**Status:** Normative. Version string: `centraid-snapshot/1`.

What a Centraid backup actually *is*: the object layout, key custody,
chunking, encryption, and manifest format the engine writes to a provider's
data plane (see `PROTOCOL.md` for the provider seam). Providers never parse
any of this. **Future Centraid must**: engines MUST read format `N` and
`N-1` (widening to `N-2` once three versions exist) — a restore in three
years of a snapshot written today is the promise this document makes.

## Key custody — keyring with epochs

- The user holds one **keyring** file (mode `0600`, JSON):

```jsonc
{
  "version": 1,
  "active": 2,
  "epochs": [
    { "epoch": 1, "key": "<base64 32 bytes>", "createdAt": "…" },
    { "epoch": 2, "key": "<base64 32 bytes>", "createdAt": "…" }
  ]
}
```

- Per-vault keys derive via HKDF-SHA256 from the epoch's master key:
  `dataKey = HKDF(master, salt=∅, info="centraid-backup:data:" + vaultId)`,
  `dedupKey = HKDF(master, salt=∅, info="centraid-backup:dedup:" + vaultId)`.
  One keyring covers all vaults with no cross-vault key reuse.
- **Rotation = a new epoch.** New snapshots use the active epoch; old
  snapshots remain readable via retained epochs; retention gradually prunes
  the old epoch's snapshots. Dedup does not span epochs (chunk ids are keyed
  per epoch) — the first post-rotation snapshot is a full re-upload. This is
  the deliberate trade: rotation is cheap to *initiate* and honest about
  when old-key ciphertext actually leaves the provider.
- Losing every epoch in the keyring means losing the backups. By design.
  Which is why the **recovery kit** (below) is a first-class artifact, not a
  power-user afterthought.

## Object layout (under the target's prefix)

```
chunks/{chunkId}                    — encrypted chunk objects
manifests/{createdAtMs13}-{hash8}.json — manifest objects
```

Manifest keys MUST live under `manifests/`; chunk objects under `chunks/`.
The registry (provider-side) maps `seq → manifestKey`; the key itself carries
no semantics.

## Chunking

FastCDC content-defined chunking with a **deterministic, seeded gear table**
(boundaries — and therefore dedup ids — must be stable across processes,
machines, and versions; the gear table is part of this format and MUST NOT
change within format `/1`). Parameters: min 512 KiB, average 1 MiB (mask
bits 20), max 4 MiB. Files smaller than min are a single chunk.

`chunkId = HMAC-SHA256(dedupKey, plaintextChunkBytes)` (hex). Keyed ids leak
nothing to the provider while enabling client-side dedup and GC planning
against the *public* chunk index without decryption.

## Encryption

All objects are AES-256-GCM: `iv (12 random bytes) || ciphertext || tag`.

- Chunk objects: encrypted under the epoch's per-vault `dataKey`. Identical
  plaintext chunks within an epoch share one `chunkId` and one object
  (dedup); ciphertext differs per write (random IV) — last write wins,
  content is identical by construction.
- Manifest sealed payload: encrypted under the same `dataKey`.

## Manifest

Canonical JSON (sorted keys, no insignificant whitespace); the registered
`manifestHash` is SHA-256 over the stored object bytes exactly.

```jsonc
{
  "format": "centraid-snapshot/1",
  "keyEpoch": 2,
  "createdAt": "2026-07-11T12:00:00.000Z",
  "generation": 3,                       // must equal the registered generation
  "prevManifestHash": "…",              // or null for a chain head
  "chunkIndex": [ { "id": "…", "size": 1048576 }, … ],  // PUBLIC: every chunk this snapshot references
  "appMeta": {
    "gatewayVersion": "0.1.0",
    "vaultUserVersion": "1",
    "ontologyVersion": "1.2",
    "sourceInstanceId": "…"             // random id minted per gateway install
  },
  "sealedPayload": "<base64 AES-256-GCM blob>"
}
```

`chunkIndex` is public (ids are HMAC-keyed) so restore planning, integrity
verification, and GC reference-counting work **without any key**. The sealed
payload holds everything with semantic content:

```jsonc
{
  "entries": [
    { "path": "vault.db",      "kind": "db",        "size": …, "chunks": ["…", …] },
    { "path": "journal.db",    "kind": "db",        "size": …, "chunks": [ … ] },
    { "path": "blobs/ab/cd…",  "kind": "blob",      "size": …, "chunks": [ … ] },
    { "path": "apps.bundle",   "kind": "git-bundle","size": …, "chunks": [ … ] },
    { "path": "seal.key",      "kind": "seal-key",  "size": …, "chunks": [ … ] }
  ]
}
```

## What a Centraid vault snapshot contains

| entry kind | source | why |
|---|---|---|
| `db` | `vault.db` + `journal.db` via `VACUUM INTO` staging (point-in-time, consistent) | the vault |
| `blob` | every object in the blob CAS (immutable, content-addressed — dedups trivially) | attachments/media |
| `git-bundle` | `git bundle --all` of the gateway code store (`apps.git`) | installed apps snapshot into the code store; a restore without it is data with no apps |
| `seal-key` | the vault's sealed-columns DEK file | it deliberately lives *outside* the vault dir, so a snapshot without it restores sealed columns as permanent ciphertext — this entry is the difference between a backup and a placebo |

Ordering rule: take the DB staging copy **first**, then snapshot blobs — the
CAS is append-only from the engine's perspective, so every blob the staged DB
references already exists; blobs added mid-snapshot are extras, never holes.
Upload chunks → manifest → register, in that order.

## Restore rules (normative for engines)

1. Fetch the registry row; **gate on compatibility before downloading
   anything**: refuse unknown `format`; refuse `vaultUserVersion` or
   `ontologyVersion` newer than the running code (v0 stance: no migrations —
   tell the user to update the gateway, never "best effort"). Refuse older
   than the reader guarantee.
2. Verify the manifest object against the registered `manifestHash`; decrypt
   the payload; after decrypting each chunk, recompute its keyed id and
   refuse mismatches; reject path-traversal entries (`..`, absolute paths).
3. Materialize into a **fresh directory** — never over a live vault.
4. **Side-effect quarantine**: a restored vault resurrects yesterday's
   outbox and automations. The engine marks the restore so the gateway, on
   first mount, parks all outbox rows, disables automations, and flags
   connections for re-auth review until the user re-arms them. Restoring a
   backup must never re-send an email.
5. **Fencing**: after a successful restore-takeover, register the next
   snapshot with `generation + 1` (see PROTOCOL.md) so the superseded
   machine finds out.

## Verification (scheduled, client-side)

Because providers verify nothing (by design), the engine periodically:
- HEADs every object referenced by the newest manifest (existence), and
- downloads + decrypts a random sample, recomputing keyed ids (integrity).

`lastVerifiedAt` and `lastBackupAt` are health signals, not log lines.

## Recovery kit

Everything needed to restore **from nothing but this document**: the
acceptance test for the whole feature is a restore on a blank machine with
only the kit in hand.

```jsonc
{
  "version": 1,
  "kind": "centraid-recovery-kit",
  "createdAt": "…",
  "keyring": { … },                                  // the full keyring, verbatim
  "targets": [
    { "provider": "https://api.clawgnition.com", "targetId": "…", "vaultId": "…", "label": "…" }
  ]
}
```

The kit contains live key material: emit it only on explicit user action,
to a user-chosen destination, with a loud "store this offline" warning. The
provider api-key is deliberately NOT in the kit (it's rotatable server-side;
keys are not) — restore re-authenticates to the provider interactively.
