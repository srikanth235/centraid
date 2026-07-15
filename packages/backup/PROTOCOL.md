# centraid-storage-provider/1 — Storage Provider Wire Protocol

**Status:** Normative. Version string: `centraid-storage-provider/1`.

The contract between a Centraid gateway (the *client*) and any offsite
storage *provider* (Clawgnition is the first; anyone who passes the
conformance kit is a provider).

The protocol has two layers:

- **Layer 1 — Account & grants.** Store-agnostic: discovery, target
  lifecycle, capability flags, and short-lived credential grants scoped to
  one *store class* at a time. Nothing here knows what bytes mean.
- **Layer 2 — Workload semantics**, layered on top, one section per store
  class. `/1` defines two: `backup` (snapshot registry, generation fencing,
  retention, purge) and `cas` (content-addressed blob replication). A
  provider declares which store classes it offers in discovery; the
  protocol grows additively as new store classes are added, and existing
  ones never need to change to make room for a new one.

Across both layers:

- The **client owns all data semantics** — snapshot contents, chunking,
  encryption, manifest format, restore, content-level GC, and (for `cas`)
  what the opaque objects contain. Providers never see plaintext, keys, or
  format internals (see `FORMAT.md`).
- The **provider owns durability and lifecycle bookkeeping** — an
  S3-compatible object namespace per target (isolated per store class it
  grants), workload-specific registries where a workload needs one,
  quota/metering, and the delete/undelete/purge lifecycle.

The protocol and the snapshot format are versioned **independently**. A
provider stores opaque snapshot objects and must not need any change when a
future snapshot format is introduced — that is the test of whether a proposed
provider feature belongs in this document at all.

## Terminology

- **Target** (called a `vault` in endpoint paths): one Centraid vault's
  namespace at one provider. A target hosts one
  isolated prefix per store class it has been granted for.
- **Store class**: a named workload sharing Layer 1's account/grant
  machinery — `backup` or `cas` in `/1`.
- **Snapshot**: one registered manifest in the `backup` store (a
  point-in-time revision).
- **Grant**: short-lived, store-and-prefix-scoped S3 credentials for one
  store class's data plane.

## Auth

Two tiers, declared per-operation:

- **`api-key`** — a bearer secret the gateway holds (`Authorization: Bearer …`).
  Sufficient for everything *except* irreversible destruction.
- **`interactive`** — an authenticated human session on the provider's own
  surface (dashboard, account portal). **`purge` MUST require this tier.**
  A provider MUST reject an api-key purge with `403 interactive_auth_required`.
  Rationale: the api-key lives on the gateway; a compromised gateway must not
  be able to irreversibly destroy the user's data (registry soft-delete
  alone protects rows, not the user). Purge is target-wide — it destroys
  every store class's data under that target, not just one.

## Error envelope

Non-2xx responses carry:

```json
{ "error": { "type": "invalid_request_error", "code": "conflict_generation", "message": "…" } }
```

Reserved `code` values (clients branch on these; providers MUST use them for
the matching condition and MAY add others):

| code | HTTP | meaning |
|---|---|---|
| `invalid_request` | 400 | malformed input |
| `auth_expired` | 401 | key revoked/expired — re-auth needed |
| `payment_required` | 402 | subscription lapsed; writes will be refused |
| `interactive_auth_required` | 403 | operation needs the interactive tier |
| `quota_exceeded` | 403 | storage budget exhausted |
| `not_found` | 404 | unknown target/snapshot |
| `undelete_window_expired` | 404 | undelete after window or after purge request |
| `conflict_generation` | 409 | stale generation (see `backup` § Fencing) — body includes `currentGeneration` |
| `purge_pending` | 409 | target has a pending purge; operation refused |
| `provider_error` | 502 | provider-internal upstream failure |

---

## Layer 1 — Account & grants

### Discovery — `GET /v1/backup/provider`

Bearer-authed. The capabilities document; everything a client adapts to MUST
be declared here, not discovered behaviorally:

```jsonc
{
  "data": {
    "protocol": ["centraid-storage-provider/1"],
    "dataPlane": "s3",
    "capabilities": ["backup", "cas", "usage"],  // additive — omit what you don't offer
    "maxCredentialTtlSeconds": 86400,
    "purgeAuthTier": "interactive",              // MUST be "interactive"

    // Present iff `capabilities` includes "backup" — see Layer 2 § backup.
    "backup": {
      "softDeleteWindowDays": 14,
      "retention": {                       // or { "kind": "none" }
        "kind": "ladder",
        "keepAllDays": 7,
        "dailyDays": 30,
        "weeklyDays": 365,
        "neverPruneNewest": true           // MUST be true
      },
      "restoreCostClass": "free-egress",   // or "metered-egress"
      "objectLock": false,                 // provider can make objects immutable
      "conditionalWrites": false           // data plane honors If-None-Match
    }
  }
}
```

`capabilities` is the seam that lets the protocol grow: a new store class
(or `usage`) ships as an additive flag plus its own Layer-2 section, and a
provider that doesn't implement it simply never advertises it — existing
clients and existing store classes are unaffected.

Clients MUST surface `backup.retention` and `backup.restoreCostClass` to the
user when `"backup"` is offered — a provider's prune ladder is part of the
product the user bought, and a restore that will meter 300 GB of egress must
be priced before it starts.

### Target lifecycle

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/backup/provider` | api-key | discovery/capabilities |
| `POST /v1/backup/vaults` | api-key | create target — `{ "name": "<opaque label>" }`. Clients MUST NOT send real vault names; the label is an opaque handle. |
| `GET /v1/backup/vaults` | api-key | list caller's targets + `backup` usage + `accountStatus` |
| `POST /v1/backup/vaults/:id/credentials` | api-key | issue grant — `{ "ttlSeconds": 3600, "mode": "read-write" \| "read", "store": "backup" \| "cas" }` |
| `GET /v1/backup/vaults/:id/usage` | api-key | per-store-class usage report — only when `capabilities` includes `"usage"` |
| `DELETE /v1/backup/vaults/:id` | api-key | soft delete (declared undelete window) — every store class under the target |
| `POST /v1/backup/vaults/:id/undelete` | api-key | cancel soft delete |
| `POST /v1/backup/vaults/:id/purge` | **interactive** | irreversible erasure of the whole target (one-way; blocks undelete forever) |

`store` and `mode` on the credentials route are REQUIRED — neither has a
default. A provider MUST reject a missing field or a grant request naming a
store class it doesn't advertise in
`capabilities` with `400 invalid_request`.

All responses wrap payloads as `{ "data": … }`. All timestamps on the wire
are **unix epoch seconds** (integers) — `expiresAt`, `createdAt`, `prunedAt`,
`period.start`, `period.end`.

### Target list — `GET /v1/backup/vaults`

```jsonc
{
  "data": {
    "accountStatus": "ok",               // "ok" | "payment_due" | "suspended"
    "vaults": [{
      "id": "…", "name": "…", "status": "active",
      "currentGeneration": 3,
      // The backup store's own figure (Layer 2). quotaBytes and meteredAt
      // are OPTIONAL (a provider may not meter or cap).
      "usage": { "storedBytes": 1234, "objectCount": 42, "quotaBytes": 107374182400, "meteredAt": 1760003600 }
    }]
  }
}
```

`accountStatus` exists so the client can warn *before* credential issuance
starts failing — silent write stoppage after a payment lapse is the failure
mode this field kills. Clients MUST alert on `payment_due`/`suspended`.

### Credential grant

```jsonc
{
  "data": {
    "endpoint": "https://….r2.cloudflarestorage.com",
    "region": "auto",                    // REQUIRED — the data plane's real SigV4 region.
                                          // "auto" remains a valid value (Cloudflare R2's
                                          // profile); it is simply no longer a client-side
                                          // hardcode — every provider states its own.
    "bucket": "…",
    "prefix": "u/{id}/backup/",          // per-store isolated: "u/{id}/backup/" or "u/{id}/cas/"
    "store": "backup",                   // echoes the requested store class
    "accessKeyId": "…", "secretAccessKey": "…", "sessionToken": "…",
    "expiresAt": 1760003600,
    "mode": "read-write"
  }
}
```

Per-store isolation is normative: a `backup` grant and a `cas` grant for the
same target MUST resolve to disjoint prefixes — neither store class can see
or overwrite the other's objects, even though both live under the same
target and the same underlying bucket.

`mode: "read"` grants MUST NOT permit writes — restore/verify flows use them
so a recovery device never needs write power. Issuance MUST be refused with
`payment_required` / `quota_exceeded` when the account or budget doesn't
allow new writes (read grants SHOULD still be issued while data is retained:
a lapsed subscriber keeps the right to take their data out).

### Usage — `GET /v1/backup/vaults/:id/usage` (optional `usage` capability)

Only present when discovery's `capabilities` includes `"usage"`; a provider
that doesn't meter simply omits the capability and clients skip this route
entirely rather than expecting a stub.

```jsonc
{
  "data": {
    "backup": {
      "bytesStored": 1234,
      "objectCount": 42,
      "opCounts": { "put": 100, "get": 12 },   // OPTIONAL — provider-defined counters
      "quotaBytes": 107374182400,              // or null = unmetered
      "period": { "start": 1759000000, "end": 1760003600 }
    },
    "cas": {
      "bytesStored": 98765,
      "objectCount": 310,
      "quotaBytes": null,
      "period": { "start": 1759000000, "end": 1760003600 }
    }
  }
}
```

Keyed by store class; a provider MAY report only the store classes it
offers. This is distinct from the target list's embedded `usage` (the
`backup` store's own, always-present figure) — `usage` here is the general,
optional, per-store-class metering surface every store class can plug into.

---

## Layer 2 — `backup` store semantics

Everything in this section is scoped to targets granted the `backup` store
class. Normative text carried over unchanged from `/1`'s single-workload
design, except where the Layer 1/2 split required rewording (`vaults/{id}/`
example prefixes became `u/{id}/backup/`; discovery fields moved under
`backup`).

### Snapshot registration — `POST /v1/backup/vaults/:id/snapshots`

Request:

```jsonc
{
  "idempotencyKey": "…",             // provider MUST replay the prior result on retry
  "manifestKey": "u/{id}/backup/manifests/…", // MUST fall under the target's `backup`
                                      // store prefix (the same "u/{id}/backup/" the
                                      // credential grant's own `prefix` uses) — not a
                                      // bare "manifests/…" key relative to that prefix.
                                      // A conformant provider MUST 400
                                      // `invalid_manifest_key` on a bare key.
  "manifestHash": "sha256-hex",
  "totalBytes": 123, "objectCount": 45,
  "generation": 3,                   // fencing token, ≥ 1 (see below)
  "format": "centraid-snapshot/2",   // stored + echoed, never parsed
  "appMeta": { "gatewayVersion": "0.1.0", "vaultUserVersion": "1", "ontologyVersion": "1.2", "sourceInstanceId": "…" }
}
```

`format` and `appMeta` (string→string map, ≤ 2 KiB serialized) are **opaque
to the provider** — stored verbatim, returned in registry rows. They exist so
a restoring client can gate compatibility from the registry alone, without
downloading manifests.

Response `data`: the registry row —
`{ seq, manifestKey, manifestHash, prevManifestHash, totalBytes, objectCount, generation, format, appMeta, createdAt, prunedAt: null }`.
`seq` is provider-assigned, strictly monotonic per target. `prevManifestHash`
remains an audit breadcrumb, not enforced.

Read/list routes:

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/backup/vaults/:id/snapshots` | api-key | register a manifest already written to the `backup` store |
| `GET /v1/backup/vaults/:id/snapshots` | api-key | registry rows, newest first; `?includePruned=1` |
| `GET /v1/backup/vaults/:id/snapshots/:seq` | api-key | one registry row |

### Generation fencing (split-brain detection)

The provider is the one external rendezvous point every copy of a gateway
shares — so it is where "two gateways, one vault" gets caught.

- Each target carries `currentGeneration`, initially `0`.
- Registration with `generation >= currentGeneration` succeeds and sets
  `currentGeneration := generation`.
- Registration with `generation < currentGeneration` MUST be refused:
  `409 conflict_generation`, body `error.details.currentGeneration` set.
- A client performing a **restore/takeover** reads `currentGeneration` from
  the target and registers its next snapshot with `currentGeneration + 1`.
  The superseded gateway's next registration then 409s, and it MUST surface
  "another machine has taken over this vault" loudly and stop backing up —
  never retry with a bumped generation automatically.

Fencing protects the *backup chain*, not the vault itself — but it converts a
silent split-brain into a loud, user-visible event on the next backup tick.
`cas` has no equivalent (see Layer 2 § cas — no server-side fencing).

### Data plane rules

- Profile for `/1`: S3-compatible object storage via grants. Providers never
  read or write object content on the control plane.
- The client writes all referenced objects (manifest last), then registers.
  A registered manifest whose objects are missing is a client bug — but see
  *verification* below for why clients must not trust this either.
- **GC min-age invariant** (normative, promoted from Clawgnition's CLI
  convention): any client-side garbage collection MUST NOT delete an object
  younger than `maxCredentialTtlSeconds` — an in-flight snapshot holding a
  live grant may reference it.
- Providers SHOULD support `conditionalWrites` (If-None-Match) and declare
  it; clients SHOULD use it when available so a compromised gateway's grant
  cannot overwrite existing chunk objects (immutability is the real
  ransomware defense; registry soft-delete only protects rows).

### What the provider does NOT do

Stated so nobody re-adds them: no chunk-existence verification at commit, no
manifest parsing, no chain enforcement, no server-side content GC, no key
custody of any kind. **Consequence for clients (normative):** the client MUST
run its own periodic verification (existence + sampled hash checks) against
the data plane, and MUST surface both *backup age* and *verification age* as
first-class health signals. Under this protocol, nobody else will.

---

## Layer 2 — `cas` store semantics

Content-addressed blob replication. Centraid's vault `S3BlobStore` is the
reference client — it consumes a `cas` grant directly, with none of the
snapshot engine's chunking/manifest/keyring machinery. There is no route
table for this section: everything is a grant plus plain S3 operations
against the granted prefix. A provider that offers `"cas"` needs no new
control-plane routes beyond the Layer 1 credentials route already accepting
`store: "cas"`.

- **Key layout**: `<prefix>/blobs/<sha256-hex>` — the object's content hash,
  computed by the client over the sealed (already-encrypted) bytes. One key,
  one object; there is no separate manifest or index on the wire (the
  client's own local tier tracks what it has written).
- **Object content**: opaque, client-sealed ciphertext. The provider MUST
  NOT interpret, parse, or transform object bytes in any way — identical to
  the `backup` store's stance, just without a manifest wrapper.
- **List permission is REQUIRED on every `cas` grant, both `read` and
  `read-write`.** The client's reconciliation loop (what does the provider
  have vs. what does my local tier have) depends on listing the granted
  prefix; a grant that can `get` but not `list` is not a conformant `cas`
  grant.
- **No server-side fencing in `/1`.** Unlike `backup`, there is no registry,
  no `seq`, no generation token — the client's local tier is the
  authoritative record of what it has replicated. Two writers racing on the
  same key is not a split-brain scenario the way two `backup` gateways
  registering out-of-order generations is: worst case under `/1` is
  redundant re-replication of a blob that was already present, never data
  loss (content-addressing means two writers of the same key wrote the same
  bytes by construction).
- **Delete** is allowed via a `read-write` grant, following the same
  `mode` semantics as `backup`'s data plane (`"read"` grants MUST NOT permit
  writes or deletes).

---

## Conformance

The reference conformance kit lives in Centraid's `packages/backup`
(`conformance.ts`) and runs the same assertions against any
`BackupProvider` implementation:

- **Layer 1**: discovery shape, target lifecycle, grant modes and per-store
  isolated prefixes (region present, store echoed, disjoint prefixes),
  delete/undelete/purge tiering, error-code fidelity, and — when the
  `usage` capability is present — usage-report shape and monotonic byte
  growth after a write.
- **Layer 2 (`backup`)**: registration idempotency, generation fencing,
  pruned-row filtering.
- **Layer 2 (`cas`)**: put/list/get/delete round-trip through a grant, and
  namespace isolation from the `backup` store — run only when the `cas`
  capability is present.

Grant-layer and capability-gated cases (`requestGrant`, `usageReport`) skip
cleanly, not fail, when a provider legitimately doesn't implement them (a
provider whose data plane IS the caller's own custody has no literal grant
to hand back; a provider that doesn't meter has nothing to report).

"Certified provider" means the kit passes against the provider's live
endpoint for every capability it advertises. The kit is the definition of
this protocol; where prose and kit disagree, fix whichever is wrong loudly.
