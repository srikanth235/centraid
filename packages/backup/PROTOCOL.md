# centraid-backup-provider/1 — Backup Provider Wire Protocol

**Status:** Normative. Version string: `centraid-backup-provider/1`.

The contract between a Centraid gateway (the *client*) and any offsite backup
*provider* (Clawgnition is the first; anyone who passes the conformance kit is
a provider). The protocol standardizes the seam, not the storage:

- The **client owns all data semantics** — snapshot contents, chunking,
  encryption, manifest format, restore, and content-level GC. Providers never
  see plaintext, keys, or format internals (see `FORMAT.md`).
- The **provider owns durability and lifecycle bookkeeping** — an
  S3-compatible object namespace per target, a snapshot registry with
  monotonic `seq`, declared retention pruning of *registered manifests*,
  quota/metering, and the delete/undelete/purge lifecycle.

The protocol and the snapshot format are versioned **independently**. A
provider that stores `centraid-snapshot/1` objects today must not need any
change when the snapshot format moves to `/2` — that is the test of whether a
proposed provider feature belongs in this document at all.

## Terminology

- **Target** ("vault" on the wire, kept for Clawgnition v2 compatibility):
  one backed-up Centraid vault's namespace at one provider.
- **Snapshot**: one registered manifest (a point-in-time revision).
- **Grant**: short-lived, prefix-scoped S3 credentials for the data plane.

## Auth

Two tiers, declared per-operation:

- **`api-key`** — a bearer secret the gateway holds (`Authorization: Bearer …`).
  Sufficient for everything *except* irreversible destruction.
- **`interactive`** — an authenticated human session on the provider's own
  surface (dashboard, account portal). **`purge` MUST require this tier.**
  A provider MUST reject an api-key purge with `403 interactive_auth_required`.
  Rationale: the api-key lives on the gateway; a compromised gateway must not
  be able to irreversibly destroy the user's backup history (registry
  soft-delete alone protects rows, not the user).

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
| `payment_required` | 402 | subscription lapsed; backups will be refused |
| `interactive_auth_required` | 403 | operation needs the interactive tier |
| `quota_exceeded` | 403 | storage budget exhausted |
| `not_found` | 404 | unknown target/snapshot |
| `undelete_window_expired` | 404 | undelete after window or after purge request |
| `conflict_generation` | 409 | stale generation (see Fencing) — body includes `currentGeneration` |
| `purge_pending` | 409 | target has a pending purge; operation refused |
| `provider_error` | 502 | provider-internal upstream failure |

## Discovery — `GET /v1/backup/provider`

Bearer-authed. The capabilities document; everything a client adapts to MUST
be declared here, not discovered behaviorally:

```jsonc
{
  "data": {
    "protocol": ["centraid-backup-provider/1"],
    "dataPlane": "s3",
    "maxCredentialTtlSeconds": 86400,
    "softDeleteWindowDays": 14,
    "retention": {                       // or { "kind": "none" }
      "kind": "ladder",
      "keepAllDays": 7,                  // keep every snapshot this recent
      "dailyDays": 30,                   // then newest-per-day
      "weeklyDays": 365,                 // then newest-per-week; older pruned
      "neverPruneNewest": true           // MUST be true
    },
    "restoreCostClass": "free-egress",   // or "metered-egress"
    "objectLock": false,                 // provider can make objects immutable
    "conditionalWrites": false,          // data plane honors If-None-Match
    "purgeAuthTier": "interactive"       // MUST be "interactive"
  }
}
```

Clients MUST surface `retention` and `restoreCostClass` to the user — a
provider's prune ladder is part of the product the user bought, and a restore
that will meter 300 GB of egress must be priced before it starts.

## Routes

All responses wrap payloads as `{ "data": … }`. All timestamps on the wire
are **unix epoch seconds** (integers) — `expiresAt`, `createdAt`, `prunedAt`,
`meteredAt`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/backup/provider` | api-key | discovery/capabilities |
| `POST /v1/backup/vaults` | api-key | create target — `{ "name": "<opaque label>" }`. Clients MUST NOT send real vault names; the label is an opaque handle. |
| `GET /v1/backup/vaults` | api-key | list caller's targets + usage + `accountStatus` |
| `POST /v1/backup/vaults/:id/credentials` | api-key | issue grant — `{ "ttlSeconds": 3600, "mode": "read-write" \| "read" }` |
| `POST /v1/backup/vaults/:id/snapshots` | api-key | register a manifest already written to the data plane |
| `GET /v1/backup/vaults/:id/snapshots` | api-key | registry rows, newest first; `?includePruned=1` |
| `GET /v1/backup/vaults/:id/snapshots/:seq` | api-key | one registry row |
| `DELETE /v1/backup/vaults/:id` | api-key | soft delete (declared undelete window) |
| `POST /v1/backup/vaults/:id/undelete` | api-key | cancel soft delete |
| `POST /v1/backup/vaults/:id/purge` | **interactive** | irreversible erasure (one-way; blocks undelete forever) |

### Target list — `GET /v1/backup/vaults`

```jsonc
{
  "data": {
    "accountStatus": "ok",               // "ok" | "payment_due" | "suspended"
    "vaults": [{
      "id": "…", "name": "…", "status": "active",
      "currentGeneration": 3,
      // quotaBytes and meteredAt are OPTIONAL (a provider may not meter or cap)
      "usage": { "storedBytes": 1234, "objectCount": 42, "quotaBytes": 107374182400, "meteredAt": 1760003600 }
    }]
  }
}
```

`accountStatus` exists so the client can warn *before* credential issuance
starts failing — silent backup stoppage after a payment lapse is the failure
mode this field kills. Clients MUST alert on `payment_due`/`suspended`.

### Credential grant

```jsonc
{
  "data": {
    "endpoint": "https://….r2.cloudflarestorage.com",
    "bucket": "…", "prefix": "vaults/{id}/",
    "accessKeyId": "…", "secretAccessKey": "…", "sessionToken": "…",
    "expiresAt": 1760003600,
    "mode": "read-write"
  }
}
```

`mode: "read"` grants MUST NOT permit writes — restore/verify flows use them
so a recovery device never needs write power. Issuance MUST be refused with
`payment_required` / `quota_exceeded` when the account or budget doesn't
allow new writes (read grants SHOULD still be issued while data is retained:
a lapsed subscriber keeps the right to take their data out).

### Snapshot registration — `POST /v1/backup/vaults/:id/snapshots`

Request:

```jsonc
{
  "idempotencyKey": "…",             // provider MUST replay the prior result on retry
  "manifestKey": "manifests/…",      // MUST fall under the target's prefix
  "manifestHash": "sha256-hex",
  "totalBytes": 123, "objectCount": 45,
  "generation": 3,                   // fencing token, ≥ 1 (see below)
  "format": "centraid-snapshot/1",   // stored + echoed, never parsed
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

## Generation fencing (split-brain detection)

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

## Data plane rules

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

## What the provider does NOT do

Stated so nobody re-adds them: no chunk-existence verification at commit, no
manifest parsing, no chain enforcement, no server-side content GC, no key
custody of any kind. **Consequence for clients (normative):** the client MUST
run its own periodic verification (existence + sampled hash checks) against
the data plane, and MUST surface both *backup age* and *verification age* as
first-class health signals. Under this protocol, nobody else will.

## Conformance

The reference conformance kit lives in Centraid's `packages/backup`
(`conformance.ts`) and runs the same assertions against any
`BackupProvider` implementation — target lifecycle, grant modes, registration
idempotency, generation fencing, pruned-row filtering, delete/undelete/purge
tiering, and error-code fidelity. "Certified provider" means the kit passes
against the provider's live endpoint. The kit is the definition of this
protocol; where prose and kit disagree, fix whichever is wrong loudly.
