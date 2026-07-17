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
  class. `/1` defines three: `backup` (snapshot registry, generation fencing,
  retention, purge), `cas` (content-addressed blob replication), and
  `derived` (small, read-hot binary display derivatives — thumbnails,
  previews, posters — kept on the hot tier permanently). A provider declares
  which store classes it offers in discovery; the protocol grows additively
  as new store classes are added, and existing ones never need to change to
  make room for a new one.

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
  machinery — `backup`, `cas`, or `derived` in `/1`.
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
| `policy_unmet` | 422 | a well-formed policy asks for a guarantee the provider cannot meet; details identify the field and bound |
| `provider_error` | 502 | provider-internal upstream failure |

---

## Layer 0 — provisioning

> **STATUS — specified now, deferred build.** This section is normative
> **for-GA** but is **NOT implemented for the first-100 beta, and nobody
> should build it now.** The beta provisions an api-key by *guided key
> entry*: the user signs up on the provider's surface out-of-band, copies the
> api-key, and pastes it into the gateway's "connect a provider" flow. Layer 0
> replaces that copy/paste with an in-band handshake before GA; until then it
> exists only as this contract, so the two implementations can build to it
> deliberately rather than improvising a signup flow each.

Layer 0 answers the one thing Layer 1 assumes and never explains: **how the
gateway comes to hold an api-key for a provider it has never talked to.**
Guided key entry works but has the user handle a bearer secret by hand —
Layer 0 removes the human from the secret's path entirely with a device-code
/ signup-handoff handshake, RFC 8628-shaped (OAuth 2.0 Device Authorization
Grant) because the gateway is exactly the "input-constrained, no trusted
browser of its own" client that flow was designed for.

Shape (all routes normative-for-GA; none built for beta):

1. **Gateway initiates.** `POST /v1/storage/provision/sessions` (no auth —
   this is the pre-account entry point). Optional body
   `{ "deviceLabel": "<opaque>" }`. Response:

   ```jsonc
   {
     "data": {
       "deviceCode": "…",              // gateway-held secret; used only on the poll route
       "userCode": "WDJB-MJHT",        // short, human-transcribable; shown to the user
       "verificationUri": "https://provider.example/activate",
       "verificationUriComplete": "https://provider.example/activate?code=WDJB-MJHT", // OPTIONAL convenience
       "expiresIn": 900,               // seconds the pairing is valid
       "interval": 5                   // minimum seconds between polls
     }
   }
   ```

2. **User consents on the provider's own surface.** The gateway shows the
   user `userCode` + `verificationUri` (or opens `verificationUriComplete`).
   On that provider-hosted page the user completes **interactive** signup or
   login and approves this device — the same `interactive` tier Layer 1 § Auth
   already defines for `purge`. All account creation, payment, and identity
   live on the provider's surface; the protocol never carries a password.

3. **Gateway polls for the key.** `POST /v1/storage/provision/token` with
   `{ "deviceCode": "…" }`. Until the user finishes, the provider MUST reply
   `400` with one of the RFC 8628 codes in the error envelope's `code` field:

   | code | meaning |
   |---|---|
   | `authorization_pending` | user hasn't approved yet — keep polling at `interval` |
   | `slow_down` | polling too fast — add 5s to `interval` and continue |
   | `expired_token` | `expiresIn` elapsed before approval — restart at step 1 |
   | `access_denied` | user declined — stop, surface the refusal |

   On approval the provider returns the minted key **once**, over this
   pairing channel, so the user never sees or pastes it:

   ```jsonc
   { "data": { "apiKey": "…", "accountStatus": "ok" } }
   ```

   The gateway stores `apiKey` and proceeds to Layer 1 discovery exactly as a
   guided-entry key does — Layer 0's only job is delivering that secret.

- **Revocation** is out-of-band and provider-owned: the key MUST be revocable
  from the provider's dashboard (the `interactive` surface). A revoked key
  fails Layer 1 calls with `auth_expired` (401), the same as any expired key;
  the gateway re-runs Layer 0 to obtain a fresh one. The protocol defines no
  gateway-initiated revocation route in `/1`.
- **Conformance (for-GA).** The handshake is testable against a fake provider
  that scripts the approval: create a session, assert `authorization_pending`
  on an early poll, flip an internal "approved" flag, assert the next poll
  returns an `apiKey` that then authenticates a Layer 1 discovery call.
  `expired_token` and `access_denied` are each exercised by a fake that never
  approves / explicitly declines.

---

## Layer 1 — Account & grants

### Discovery — `GET /v1/storage/provider`

Bearer-authed. The capabilities document; everything a client adapts to MUST
be declared here, not discovered behaviorally:

```jsonc
{
  "data": {
    "protocol": ["centraid-storage-provider/1"],
    "dataPlane": "s3",
    "capabilities": ["backup", "cas", "derived", "usage", "policy", "inventory", "audit"],
    "profiles": ["home"],                        // OPTIONAL — see § Profiles
    "maxCredentialTtlSeconds": 86400,
    "purgeAuthTier": "interactive",              // MUST be "interactive"
    "storageClasses": ["STANDARD", "STANDARD_IA"],  // OPTIONAL — see below

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

`capabilities` is the additive seam. Store classes (`backup`, `cas`,
`derived`) and optional control surfaces (`usage`, `policy`, `inventory`,
`audit`) are independent flags. A provider MUST implement every route it
advertises and clients MUST skip capability-gated routes when their flag is
absent.

### Profiles

`profiles` is an OPTIONAL, additive array of named capability *bundles* — a
shorthand a provider uses to assert "I implement the whole set of flags this
named product experience requires", so a client can key one product decision
off a single token instead of re-checking a hand-list of capabilities. It
does not replace `capabilities`: capability flags remain the sole
protocol-evolution seam, and every route a profile implies is still gated by
its own flag in `capabilities`. Absent `profiles` is legal and means "no
named profile" — a bare durability sink (e.g. `capabilities: ["backup"]`) is
still a conformant provider.

`/1` defines exactly one profile:

- **`home`** — a provider fit to be a household's primary managed offsite
  home for its data (the target of the client's **"Hosted"** product option,
  as opposed to a user's own BYO bucket). A provider advertising `"home"`
  MUST also declare **all seven** of these capabilities: `backup`, `cas`,
  `derived`, `usage`, `policy`, `inventory`, and `audit`. A `home` provider
  missing any member is a conformance failure.

  `policy` is REQUIRED (not merely SHOULD) because a home provider is the
  client's staleness watchdog's counterpart: the client's five-metric
  freshness contract derives its status color (fresh / aging / stale) from
  the declared cadence a provider echoes back through the `policy` surface
  (`declaredAt` + the RPO/snapshot/verify thresholds in § Declared policy).
  A provider with no policy declaration surface gives the client nothing to
  anchor those age thresholds against, so it cannot honestly present a
  "Hosted" home the user is meant to trust with primary custody.

Clients MUST treat `profiles` as advisory-additive: an unknown profile name
is ignored (forward compatibility), and the **"Hosted"** product option is
offered only for providers whose discovery advertises `home`. The profile is
a product-menu convenience layered on top of the protocol; capability flags,
never profiles, are what the protocol grows along.

`storageClasses` is OPTIONAL: the provider-declared list of S3 storage-class
values (`x-amz-storage-class`) its data plane accepts on object-creating
requests (PUT, CreateMultipartUpload, CopyObject). When **absent**, clients
MUST NOT send the header at all; when **declared**, the data plane MUST
accept those values on those requests (e.g. R2: `["STANDARD", "STANDARD_IA"]`).

Clients MUST surface `backup.retention` and `backup.restoreCostClass` to the
user when `"backup"` is offered — a provider's prune ladder is part of the
product the user bought, and a restore that will meter 300 GB of egress must
be priced before it starts.

### Target lifecycle

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/storage/provider` | api-key | discovery/capabilities |
| `POST /v1/storage/vaults` | api-key | create target — `{ "name": "<opaque label>" }`. Clients MUST NOT send real vault names; the label is an opaque handle. |
| `GET /v1/storage/vaults` | api-key | list caller's targets + `backup` usage + `accountStatus` |
| `POST /v1/storage/vaults/:id/credentials` | api-key | issue grant — `{ "ttlSeconds": 3600, "mode": "read-write" \| "read", "store": "backup" \| "cas" \| "derived" }` |
| `GET /v1/storage/vaults/:id/usage` | api-key | per-store-class usage report — only when `capabilities` includes `"usage"` |
| `PUT`, `GET /v1/storage/vaults/:id/policy` | api-key | declare/read cadence — `policy` capability |
| `GET /v1/storage/vaults/:id/inventory` | api-key | provider-attested objects — `inventory` capability |
| `GET /v1/storage/vaults/:id/events` | api-key | append-only lifecycle audit — `audit` capability |
| `DELETE /v1/storage/vaults/:id` | api-key | soft delete (declared undelete window) — every store class under the target |
| `POST /v1/storage/vaults/:id/undelete` | api-key | cancel soft delete |
| `POST /v1/storage/vaults/:id/purge` | **interactive** | irreversible erasure of the whole target (one-way; blocks undelete forever) |

`store` and `mode` on the credentials route are REQUIRED — neither has a
default. A provider MUST reject a missing field or a grant request naming a
store class it doesn't advertise in
`capabilities` with `400 invalid_request`.

All responses wrap payloads as `{ "data": … }`. All timestamps on the wire
are **unix epoch seconds** (integers), including `expiresAt`, `createdAt`,
`declaredAt`, `storedAt`, event `at`, and usage-period bounds.

### Target list — `GET /v1/storage/vaults`

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
    "prefix": "u/{id}/backup/",          // per-store isolated: "u/{id}/backup/", "u/{id}/cas/", or "u/{id}/derived/"
    "store": "backup",                   // echoes the requested store class
    "accessKeyId": "…", "secretAccessKey": "…", "sessionToken": "…",
    "expiresAt": 1760003600,
    "mode": "read-write"
  }
}
```

Per-store isolation is normative: the `backup`, `cas`, and `derived` grants
for the same target MUST resolve to pairwise-disjoint prefixes — no store
class can see or overwrite another's objects, even though all live under the
same target and the same underlying bucket.

`mode: "read"` grants MUST NOT permit writes — restore/verify flows use them
so a recovery device never needs write power. Issuance MUST be refused with
`payment_required` / `quota_exceeded` when the account or budget doesn't
allow new writes (read grants SHOULD still be issued while data is retained:
a lapsed subscriber keeps the right to take their data out).

### Usage — `GET /v1/storage/vaults/:id/usage` (optional `usage` capability)

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
    },
    "derived": {
      "bytesStored": 4096,
      "objectCount": 8,
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

### Declared policy — `PUT`, `GET /v1/storage/vaults/:id/policy` (`policy`)

PUT accepts the client-owned cadence subset:

```json
{ "rpoSeconds": 60, "snapshotIntervalHours": 24, "verifyEveryDays": 7, "casAck": "receipt" }
```

The response and GET echo those four fields plus provider-stamped
`declaredAt`. `rpoSeconds` is an integer with a protocol floor of 30;
intervals are positive numbers; `casAck` is `receipt` or `replicated`.
Malformed input is `400 invalid_request`. A provider MAY reject a valid
declaration it cannot meet with `422 policy_unmet` and field/bound details.
`casAck` — and store-class vocabulary generally (`backup`/`cas`/`derived`,
`receipt`/`replicated`) — is a machine-to-machine wire concern: clients MUST
NOT surface it as a user-facing choice, but derive it from a protection
preset (or default it) and send the resolved value here.
If a provider implements stale alarms, their timing basis is the echoed
`declaredAt`: RPO, snapshot, and verification age thresholds are 2× their
declared cadence. PUT replaces the prior document atomically and appends a
`policy-changed` event when `audit` is offered.

### Object inventory — `GET /v1/storage/vaults/:id/inventory` (`inventory`)

Required query `store=backup|cas|derived`; optional opaque `cursor`, integer `limit`
(1–1000), and inclusive epoch-second `since`. Response:

```json
{ "data": { "store": "cas", "objects": [{ "key": "blobs/…", "sizeBytes": 123, "etagOrHash": "…", "storedAt": 1760003600, "storageClass": "STANDARD", "state": "live" }], "nextCursor": null } }
```

`state` is `live` or `soft-deleted`; `storageClass` is optional. Keys are
relative to that store's grant prefix. Pages are key-ordered and `since` is
inclusive so polling cannot miss same-second writes. The complete report
MUST match raw S3 LIST under a read grant on key and byte size; a mismatch
is a provider contract failure.

### Lifecycle audit — `GET /v1/storage/vaults/:id/events` (`audit`)

Returns `{ "data": { "events": [{ "at": 1760003600, "kind":
"policy-changed", "detail": {} }], "nextCursor": null } }`. Optional
`cursor`, `limit` (1–1000), and inclusive `since` have inventory semantics.
Rows are immutable, append-only, and oldest-first; kinds are `prune`,
`soft-delete`, `undelete`, `purge`, `credential-issued`, and
`policy-changed`. Prune detail MUST include non-empty `keys` and the
provider retention `retentionRung`; credential detail identifies store,
mode, and expiry. Audit rows remain readable after soft deletion and purge.

---

## Layer 2 — `backup` store semantics

Everything in this section is scoped to targets granted the `backup` store
class. Normative text carried over unchanged from `/1`'s single-workload
design, except where the Layer 1/2 split required rewording (`vaults/{id}/`
example prefixes became `u/{id}/backup/`; discovery fields moved under
`backup`).

### Snapshot registration — `POST /v1/storage/vaults/:id/snapshots`

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
| `POST /v1/storage/vaults/:id/snapshots` | api-key | register a manifest already written to the `backup` store |
| `GET /v1/storage/vaults/:id/snapshots` | api-key | registry rows, newest first; `?includePruned=1` |
| `GET /v1/storage/vaults/:id/snapshots/:seq` | api-key | one registry row |

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

## Layer 2 — `derived` store semantics

Binary **display derivatives**: the small, renderable artifacts a client
generates from a primary blob — thumbnails, previews, posters, and future
display rungs (scrub sprites, waveforms, low-bitrate proxies). Like `cas`,
this is a grant plus plain S3 operations against an isolated prefix; no route
table and no new control-plane routes beyond the Layer 1 credentials route
already accepting `store: "derived"`. Object bytes are opaque, client-sealed
ciphertext — the provider MUST NOT interpret, parse, or transform them,
identical to `cas` and `backup`.

- **Expected profile: small and hot.** Each object is a few KiB to a few
  hundred KiB and is re-read frequently and effectively forever — every
  eviction-ladder re-read and new-device sync fetches it again. The opposite
  of `backup`'s write-once-read-rarely profile.
- **Providers SHOULD keep the `derived` class on their hot / Standard tier
  permanently** and SHOULD NOT apply age-based cold-tiering lifecycle rules
  to it (e.g. transitioning objects to R2 Infrequent Access after N days) —
  these objects never go cold, so cold-tiering only adds first-byte latency
  and egress penalty per read. This is a SHOULD (a single-tier provider
  trivially satisfies it), but lifecycling `derived` like `backup` works
  against the class's whole purpose.
- **List permission is REQUIRED on every `derived` grant**, both `read` and
  `read-write` — the client reconciles what the provider holds against its
  local tier by listing the granted prefix, exactly as `cas` does.
- **No server-side fencing.** Like `cas`, there is no registry, `seq`, or
  generation token; the client's local tier is the authoritative record of
  what it has replicated. Derivatives are regenerable from the primary blob,
  so a lost or racing write is at worst redundant recomputation, never data
  loss. **Delete** follows `cas`/`backup` `mode` semantics (`"read"` grants
  MUST NOT permit writes or deletes).
- **Quota** shares the target's combined per-user storage pool with the other
  store classes; `derived` is not separately budgeted.

---

## Conformance

The reference conformance kit lives in Centraid's `packages/backup`
(`conformance.ts`) and runs the same assertions against any
`BackupProvider` implementation:

- **Layer 1**: discovery shape, target lifecycle, grant modes and per-store
  isolated prefixes (region present, store echoed, disjoint prefixes),
  delete/undelete/purge tiering, error-code fidelity, and — when the
  `usage` capability is present — usage-report shape and monotonic byte
  growth after a write. Discovery's `profiles`, when present, MUST contain
  only known profile names, and a declared `home` profile MUST carry all
  seven of its member capabilities (`backup`, `cas`, `derived`, `usage`,
  `policy`, `inventory`, `audit`) — a missing member is a conformance
  failure.
- **Layer 2 (`backup`)**: registration idempotency, generation fencing,
  pruned-row filtering.
- **Layer 2 (`cas`)**: put/list/get/delete round-trip through a grant, and
  namespace isolation from the `backup` store — run only when the `cas`
  capability is present.
- **Layer 2 (`derived`)**: put/list/get/delete round-trip through a grant,
  pairwise namespace isolation from `backup` and `cas`, and grant echo +
  disjoint prefix — run only when the `derived` capability is present.
- **Optional observability**: policy echo/provider clock + typed rejection;
  inventory pagination/`since` + raw-LIST equality; audit ordering,
  lifecycle coverage, and prune-reason detail.

Grant-layer and capability-gated cases skip cleanly, not fail, when a
provider legitimately doesn't implement them (a
provider whose data plane IS the caller's own custody has no literal grant
to hand back; a provider that doesn't meter has nothing to report).

"Certified provider" means the kit passes against the provider's live
endpoint for every capability it advertises. The kit is the definition of
this protocol; where prose and kit disagree, fix whichever is wrong loudly.
