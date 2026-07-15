# centraid-snapshot/2 — Snapshot Format

**Status:** Normative. Version string: `centraid-snapshot/2`.

What a Centraid backup actually *is*: the object layout, key custody,
part-splitting, WAL segment stream, encryption, and manifest format the
engine writes to a provider's data plane (see `PROTOCOL.md` for the provider
seam — unchanged by this revision). Providers never parse any of this.
Centraid is unreleased v0, so there is no public predecessor to preserve.
`/1` (issue #408) introduced the authenticated base-plus-WAL design; `/2`
(issue #405 §1) adds **entropy-gated compression inside the chunk seal** —
the sealed plaintext of a chunk object is now a one-byte-tagged frame
`[algo-id][body]` rather than the bare part (see § Chunk payload framing).
That is a payload-framing change, so the version string bumps and there is
exactly ONE readable format: **a reader MUST reject every format string other
than `centraid-snapshot/2`.** A `/1` reader would mistake `/2`'s algo byte for
content, and a `/2` reader would mistake a `/1` object's first content byte
for an algo id — the formats are mutually unreadable by construction, and v0
keeps no dual-format reader. This document plus the version bump is the whole
migration story. Compatibility policy starts only after a format has shipped
to users.

The database path is **base snapshots + a continuous stream of WAL segments**
(point-in-time recovery, upload volume proportional to change, no
whole-database rewrite per backup tick). Big objects split at **fixed part
boundaries**, and every object nonce is **deterministic** (HKDF-derived) so
retries are byte-identical. Blob entries remain in the backup snapshot even
when a remote CAS tier exists: until the manifest carries authenticated proof
that each blob is durably present in that independent store, omitting it would
make restore depend on unauthenticated external state.

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
  the old epoch's snapshots. Dedup does not span epochs (part ids are keyed
  per epoch) — the first post-rotation snapshot is a full re-upload, and the
  WAL stream breaks to a fresh generation (segments are sealed under one
  epoch's `dataKey` for their whole generation). This is the deliberate
  trade: rotation is cheap to *initiate* and honest about when old-key
  ciphertext actually leaves the provider.
- Losing every epoch in the keyring means losing the backups. By design.
  Which is why the **recovery kit** (below) is a first-class artifact, not a
  power-user afterthought.

## Object layout (under the target's prefix)

```
chunks/{chunkId}                        — encrypted fixed-size part objects
manifests/{createdAtMs13}-{hash8}.json  — manifest objects
wal/{db}/{generation}/{group:08}/{start:012}-{end:012}-{tick:013}
                                        — encrypted WAL segment objects
wal/{db}/{generation}/{group:08}/closed-{end:012}
                                        — authenticated group-closer objects
wal/tick/{vaultGeneration}-{journalGeneration}/{tick:013}
                                        — authenticated pair markers
```

Manifest keys MUST live under `manifests/`; part objects under `chunks/`
(the `chunks/` name is stable across format versions — the addressing scheme
is unchanged); WAL segments, closers and pair markers under `wal/`. The
registry (provider-side) maps `seq → manifestKey`; keys otherwise carry no
provider-visible semantics.

## Parts

Fixed-size splitting: every entry's bytes are cut at exact **16 MiB**
boundaries (final part short). The part size is format-normative and MUST
NOT change within the format — same bytes must produce the same part ids
everywhere. SQLite base files update pages in place (no insert-shift), so
fixed boundaries dedup consecutive bases at ~O(changed pages); nothing else
in a snapshot is both large and shift-prone.

`chunkId = HMAC-SHA256(dedupKey, plaintextPartBytes)` (hex). Keyed ids leak
nothing to the provider while enabling client-side dedup and GC planning
against the *public* chunk index without decryption. The id is computed over
the **raw** part bytes, upstream of both compression and encryption, so it is
identical whether or not a part ends up compressed (see next section).

## Chunk payload framing (compression) — `/2`, issue #405 §1

Chunk objects compress *inside* the seal. The plaintext a chunk object seals
is not the bare part but a one-byte-tagged frame; the writer compresses, then
keeps the compressed body only if it is **strictly smaller** than storing raw:

```
sealed plaintext = [algo-id : 1 byte][body : possibly-compressed part bytes]
```

| algo-id | meaning | body |
|---|---|---|
| `0x00` | stored raw | the part bytes, verbatim |
| `0x01` | zstd | `node:zlib` zstd stream (level 3) of the part |
| `0x02` | raw-deflate | `node:zlib` deflateRaw of the part (fallback) |

**Keep-if-smaller gate.** Both candidate frames carry the same 1-byte header,
so the decision reduces to `compressedBody.length < rawPart.length`: strictly
smaller keeps the compressed body, ties and inflation store raw under `0x00`.
Consequently an incompressible part costs **at most one byte** over its raw
size, and can never inflate the stored object.

**Identity is unaffected.** `chunkId`, `blob:` addresses and dedup all key off
the raw part bytes, and the deterministic chunk nonce is derived from that
raw-plaintext id. So the same plaintext converges on the same object key and
the same nonce regardless of whether compression fired — compression changes
only how many ciphertext bytes land at that key. Restore/verify recompute the
keyed id over the *decompressed* plaintext.

**Writer vs reader obligations.** The writer prefers zstd (`0x01`) and falls
back to raw-deflate (`0x02`) only on a runtime whose `node:zlib` lacks zstd
(pre-Node-22.15). A reader **MUST** handle every id byte — `0x00`, `0x01`,
`0x02` — regardless of what the local runtime can itself produce, because a
snapshot is routinely restored on a different machine than the one that wrote
it, and **MUST** reject any other id byte as a corrupt object. Compressed-body
bytes are not guaranteed identical across zstd library versions; this never
breaks dedup or idempotency, because the object key addresses the raw
plaintext (a differing machine's write lands at the same key and is skipped via
`head()`, and a same-machine retry re-compresses identically → byte-identical
G7 PUT).

**Scope.** Only `chunks/` objects are framed. WAL segments, group closers and
pair markers are **not** compressed: segments are incremental deltas already
bounded by change volume, and their address-bound deterministic-nonce
idempotency contract (§ Encryption) is deliberately left exactly as `/1`
shipped it — the marginal ratio on a few KiB of WAL pages is not worth
perturbing that. Manifest objects are **not** framed either: the manifest's
sealed payload is small canonical JSON whose byte-exact encoding is
load-bearing for its content-addressed nonce, and its public envelope must
stay plaintext-parseable by a key-less GC/verifier. Compression buys the win
where the bulk actually is — the SQLite base files, git bundle and blobs that
all flow through `chunks/`.

## WAL segments

The two vault databases (`vault.db`, `journal.db`) ship continuously as raw
byte ranges of their SQLite write-ahead logs. The stream's correctness rests on
the shipper VERIFYING one writer-side invariant at every capture, not on
enforcing it (issue #411 action 1): the shipper is the only actor that
checkpoints, always with `TRUNCATE`, so the WAL is strictly append-only between
its checkpoints and byte offsets are never reused within a group. It confirms
this each capture by pinning the WAL salts and offset chain and re-checking the
main-file identity; ANY foreign checkpoint is detected and healed with a clean
generation break, never a silent gap. `wal_autocheckpoint = 0` on every
connection is a *performance hint* that keeps such breaks (and their base
re-clones) rare — not a correctness precondition.

- **generation** — 32 hex chars, random per stream era. Minted at first
  ship, after any detected invariant violation (foreign checkpoint, WAL
  swap/shrink), on restore-takeover, on key-epoch rotation. A generation is
  anchored by exactly one base snapshot per database.

  **The two databases break their generations TOGETHER, in one tick**, with
  journal.db `TRUNCATE`-checkpointed FIRST and both checkpoints completing
  before either base is cloned. A base's effective instant is its checkpoint
  instant (the clone reads the main file; anything committed after the
  checkpoint lands in the new generation's WAL and ships as segments), so both
  bases come from ONE capture instant. A manifest MUST NOT be registered with
  two bases from different ticks, and a restore MUST refuse one: a journal base
  minted after the vault's already contains receipts for rows that live only in
  the vault's segments, so losing any one of those segments hands back history
  asserting data the restore does not have.
- **group** — 0-based, +1 after each shipper checkpoint (`TRUNCATE`). A
  group's concatenated segments are byte-identical to the WAL file as it
  existed before that checkpoint. The checkpoint also writes a **closer**
  object recording the group's exact end offset, sealed (empty payload,
  AAD-bound address) so only the key holder can assert it. Replay advances
  to group N+1 only when group N's chain reaches its authenticated closer's
  end exactly; otherwise the group MUST be treated as unfinished — replay
  stops there and MUST NOT apply later groups (their frames are page images
  layered on this group's checkpointed state; mixing would produce a
  database that opens but is wrong).
- **segment** — `[start, end)` file bytes; `start` is 0 (includes the
  32-byte WAL header) or the previous segment's `end`; `end` sits on a
  COMMIT-frame boundary. `tick` is the capture instant (monotonic ms):
  segments of the two databases captured in the same tick share the value.
- **pair marker** — written at the end of every tick in which EITHER database's
  `(generation, group, endOffset)` changed, recording BOTH databases' positions
  at that instant. Sealed like a closer, with both generations and the tick in
  the key, the nonce and the AAD. A tick that changed nothing needs no marker
  (restoring "at T" is identical to restoring at the last marker `≤ T`), and
  neither does a tick that ended in a generation break (both databases are then
  at `(0, 0)` of fresh generations, which IS their base pair).

  **The marker is the only thing that distinguishes a database that is idle
  from a database whose segments are missing; a listing alone cannot.** Both
  are a stream that simply ends. Treating "no further segments" as "pinned at
  this tick" silently discards a busy journal's history whenever the vault goes
  quiet; treating it as "reached its own tip" lets a lost vault tail hand back a
  journal that is newer than its vault. Only the producer knows which, so the
  producer says so — and the GCM tag is why a provider cannot lie about it.

- **`walTipTickMs`** (manifest, `db` entries) — the newest pair-marker tick the
  producer WATCHED the provider ACCEPT, as of that snapshot's registration. It
  is a floor: a restore or verification that cannot reach it is looking at a
  store that has lost objects it acknowledged, and MUST say so.

  It exists because the markers themselves are deletable, and deleting them is
  the quietest failure the format has: no hole, no damage, every object the
  manifest names still present — a restore just falls back to the base pair and
  returns an hours-old vault without a word. Nothing in the object graph can see
  that, because a marker's absence is exactly what an *idle* database looks like.

  Producers MUST source it from CONFIRMED uploads, never from local intent. A
  drain interrupted between a tick's segments and its marker then yields a
  *lower* tip — never a claim the store cannot honour — so the check can be
  failed loudly without ever crying wolf. Within one base pair the value is
  monotonic; a generation break resets it (the pair is new, and its stream has
  shipped nothing yet).

  A restore that falls short of the tip still SUCCEEDS, at the older coordinated
  point — G6 is degrade-to-an-earlier-consistent-state, not refuse. It simply
  stops being silent about it.

  **What this does and does not catch.** Withholding markers is now DETECTED for
  everything up to the last registered snapshot: the manifest names a tip, and a
  store that cannot reach it is provably lossy. What remains undetectable is a
  provider withholding the newest objects written *after* the last snapshot was
  registered — you cannot prove the absence of an object no manifest ever
  promised. That residue is a **freshness** problem (`lastBackupAt`, verification
  cadence, backup interval), not a format one, and it is bounded by the backup
  interval rather than being unbounded. Markers plus the tip are still not a
  general anti-rollback mechanism; they are a *floor*.

- **restoring "at T"** selects the newest authenticated pair marker with
  `tick ≤ T` whose recorded positions BOTH databases' listed segments actually
  chain to — hole-free, and to EXACTLY that position — and cuts both databases
  there. Absent any such marker, the restore is the base pair, which (being from
  one tick) is itself a coordinated point. A chain that ends exactly at group
  N's authenticated closer has reached position `(N+1, 0)`; without that closer
  it has only reached `(N, end)` and therefore satisfies no marker claiming the
  group was finished.

Restore materializes base + segments and then lets **SQLite itself** replay:
per group, write the concatenation as `<db>-wal`, open the database
(recovery runs), `wal_checkpoint(TRUNCATE)`, close. Engines MUST NOT
re-implement frame replay or checksum validation; SQLite's recovery already
rejects invalid tails, which is what makes a damaged or missing segment
degrade to an *earlier consistent state* rather than a corrupt database.

## Encryption

All objects are AES-256-GCM: `nonce (12 bytes) || ciphertext || tag`.
**Every nonce is deterministic** — HKDF-SHA256 over `dataKey` with a
format-normative info string that is injective over everything sealed under
that key, so a retried upload is byte-identical (idempotent PUTs) and nonce
reuse with different plaintext is structurally impossible:

- Part objects: `info = "centraid-backup:chunk-nonce:" + chunkId` — the
  nonce follows the keyed content hash; identical plaintext converges on one
  identical object, different plaintext gets a different id and nonce. The
  sealed plaintext is the **framed** payload `[algo-id][body]` (§ Chunk payload
  framing), but both `chunkId` and this nonce derive from the RAW part, so
  framing never moves the object or repeats a (key, nonce) pair.
- Manifest sealed payload:
  `info = "centraid-backup:manifest-nonce:" + sha256hex(payloadPlain)`.
- WAL segments:
  `info = "centraid-backup:wal-nonce:{db}:{generation}:{group}:{start}:{end}:{tick}"`.
  Both offsets are REQUIRED in the derivation: a crash between segment-write
  and offset-persist makes the retry re-read a possibly longer range from
  the same `start` — including `end` gives that retry a fresh nonce.
  Segments are additionally bound to their full address with AAD
  `"centraid-wal/1:{vaultId}:{db}:{generation}:{group}:{start}:{end}:{tick}"`,
  so a provider that swaps two validly-sealed segment objects fails the tag
  check instead of feeding SQLite mixed WAL bytes.

  Nonce and AAD BOTH cover **every field of the object key, `tick` included**.
  `tick` is not decoration: restore parses it out of the key and it alone
  decides the point-in-time cut ("apply every segment with `tick ≤ T`") and
  the coordinated two-database cut. Were it unbound, a provider could copy a
  validly-sealed segment to a key carrying a forged `tick` and it would still
  authenticate — a restore "at T" would then apply bytes captured after T,
  and the two databases could land on different real instants while both
  claim the same tick. Engines MUST bind it in both.

  This does not weaken idempotent PUTs: the retried upload re-seals the SAME
  local segment file, whose name encodes the full address (tick included), so
  it re-derives the identical nonce and identical bytes. A capture that
  stamps a different tick is a different object key by construction.
- WAL group closers: empty payload,
  `info = "centraid-backup:wal-nonce:{db}:{generation}:{group}:{end}:closed"`,
  AAD `"centraid-wal/1:{vaultId}:{db}:{generation}:{group}:{end}:closed"` —
  the GCM tag over that AAD is the object's entire content and proof of
  origin.
- WAL pair markers: payload
  `{"journal":{"endOffset":…,"group":…},"tickMs":…,"v":1,"vault":{…}}` (that
  exact field order — the nonce is deterministic over the address, so one
  address MUST have one payload encoding),
  `info = "centraid-backup:wal-nonce:tick:{vaultGeneration}:{journalGeneration}:{tick}"`,
  AAD `"centraid-wal/1:{vaultId}:tick:{vaultGeneration}:{journalGeneration}:{tick}"`.
  A producer MUST write each `(vaultGeneration, journalGeneration, tick)` at
  most once: a second, different payload under the same address would reuse a
  (key, nonce) pair.

The cipher is agnostic to how the nonce was chosen and to what the sealed
plaintext contains — `decrypt()` recovers whatever was sealed. What separates
`/2` from `/1` is therefore not the cipher but the **sealed-plaintext
framing** of chunk objects (§ Chunk payload framing); the format-string gate,
not any in-band signal, is what refuses a `/1` object to a `/2` reader.

## Manifest

Canonical JSON (sorted keys, no insignificant whitespace); the registered
`manifestHash` is SHA-256 over the stored object bytes exactly.

```jsonc
{
  "format": "centraid-snapshot/2",
  "keyEpoch": 2,
  "createdAt": "2026-07-14T12:00:00.000Z",
  "generation": 3,                       // must equal the registered generation (fencing)
  "prevManifestHash": "…",              // or null for a chain head
  "chunkIndex": [ { "id": "…", "size": 16777216 }, … ],  // PUBLIC: every part this snapshot references
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
    { "path": "vault.db",   "kind": "db", "size": …, "chunks": ["…", …],
      "sha256": "…",                        // capture-time plaintext hash (G9 marker)
      "walGeneration": "3f2a…(32 hex)",     // the WAL stream this base anchors
      "baseTickMs": 1752480000000,          // the tick this base was cloned at
      "walTipTickMs": 1752480360000 },      // newest pair marker the provider CONFIRMED accepting
    { "path": "journal.db", "kind": "db", "size": …, "chunks": [ … ],
      "sha256": "…", "walGeneration": "…",
      "baseTickMs": 1752480000000, "walTipTickMs": 1752480360000 },
    { "path": "blobs/ab/cd…",  "kind": "blob",      "size": …, "chunks": [ … ] },  // only without a remote CAS tier
    { "path": "apps.bundle",   "kind": "git-bundle","size": …, "chunks": [ … ] },
    { "path": "seal.key",      "kind": "seal-key",  "size": …, "chunks": [ … ] }
  ]
}
```

## What a Centraid vault snapshot contains

| entry kind | source | why |
|---|---|---|
| `db` | `vault.db` + `journal.db` **base files** — copied (reflink where the filesystem supports it) immediately after a shipper `TRUNCATE` checkpoint, while the main file is guaranteed WAL-quiet | anchors the WAL stream; restore = base + segments |
| `blob` | every object in the blob CAS — **only when the vault has no remote CAS tier** (with one, custody already replicates blobs whole-file to `cas`; snapshotting them too was the #405 double-store) | attachments/media |
| `git-bundle` | `git bundle --all` of the gateway code store (`apps.git`) | installed apps snapshot into the code store; a restore without it is data with no apps |
| `seal-key` | the vault's sealed-columns DEK file | it deliberately lives *outside* the vault dir, so a snapshot without it restores sealed columns as permanent ciphertext — this entry is the difference between a backup and a placebo |

Upload parts → manifest → register, in that order. WAL segments upload
continuously between registrations; a registration happens at each base
snapshot (generation start) and whenever the non-DB entries change.

## Restore rules (normative for engines)

1. Fetch the registry row; **gate on compatibility before downloading
   anything**: refuse unknown `format`; refuse `vaultUserVersion` or
   `ontologyVersion` newer than the running code (v0 stance: no migrations —
   tell the user to update the gateway, never "best effort"). Refuse older
   than the reader guarantee. Point-in-time restore picks the newest
   snapshot with `createdAt ≤ T`.
2. Verify the manifest object against the registered `manifestHash`; decrypt
   the payload; after decrypting each part, **unframe it** (§ Chunk payload
   framing — strip the algo byte and decompress `0x01`/`0x02`), recompute its
   keyed id over the RAW plaintext and refuse mismatches; verify each `db`
   entry's `sha256` after materializing the base and BEFORE replaying anything
   onto it; reject path-traversal entries (`..`, absolute paths).
3. Materialize into a **fresh directory** — never over a live vault.
4. Replay WAL segments. The two `db` entries' `baseTickMs` MUST be
   equal; a snapshot violating that MUST be **refused, not restored** — its two
   bases were never one instant, so no coordinated restore point exists between
   them. Then: LIST `wal/{db}/{walGeneration}/` for each database and
   `wal/tick/{vaultGeneration}-{journalGeneration}/` for the pair markers,
   authenticating everything (GCM + AAD) before it is used or believed. Walk the
   markers with `tick ≤ T`, newest first, and cut BOTH databases at the first
   one whose recorded positions BOTH listings actually chain to — hole-free, and
   to exactly that position. If none is satisfiable, restore the base pair.
   A segment that fails to fetch or authenticate is REMOVED from the listing and
   the pair is re-planned at the same `T` (never "lower the cut" — the damaged
   object would stay in the listing, able to satisfy a marker while being
   unusable). After replay, `PRAGMA integrity_check` and `PRAGMA
   foreign_key_check` MUST pass.

   If the achieved cut falls short of the manifest's `walTipTickMs` (and that
   tip lies at or before `T`), the restore MUST still succeed at the achieved
   cut and MUST report itself TRUNCATED — the store has lost objects it once
   acknowledged, and a caller that is not told will believe it holds a current
   vault when it holds an old one.
5. **Side-effect quarantine**: a restored vault resurrects yesterday's
   outbox and automations. The engine marks the restore so the gateway, on
   first mount, parks all outbox rows, disables automations, and flags
   connections for re-auth review until the user re-arms them. Restoring a
   backup must never re-send an email.
6. **Fencing**: after a successful restore-takeover, register the next
   snapshot with `generation + 1` (see PROTOCOL.md) so the superseded
   machine finds out. The WAL stream also breaks to a fresh
   `walGeneration` — the superseded machine's segments can never interleave
   (random ids), and its next detector pass breaks its own generation.

## Verification (scheduled, client-side)

Because providers verify nothing (by design), the engine periodically:
- HEADs every part referenced by the newest manifest (existence), LISTs the
  WAL streams, and
- checks that **the newest pair marker is still satisfiable** — that both
  databases' listed segments still chain to the positions the producer sealed.
  A per-database hole check is NOT enough on its own: a stream whose newest (or
  every) object is gone has no hole, so an entirely-lost stream used to verify
  green while its newest hours were unrecoverable. And
- checks that the reachable coordinated cut is **at or beyond the manifest's
  `walTipTickMs`**. This is the only check that survives the markers themselves
  being deleted, where every other signal — HEADs, hole checks, sample
  decryptions — comes back perfectly clean. And
- downloads + decrypts a random sample of parts (recomputing keyed ids) and
  segments (GCM + AAD), and
- **actually restores** — a real restore from the remote into a scratch
  directory, asserting `integrity_check`, `foreign_key_check`, the base
  `sha256` markers, and cross-database consistency. A backup that has never
  been restored is a hypothesis, not a backup.

`lastVerifiedAt`, `lastBackupAt` and `lastRestoreVerifiedAt` are health
signals, not log lines.

## Traffic shape (privacy note)

Object sizes already told a provider roughly how much a vault stores; WAL
segments sharpen that into **write volume and cadence** (segment sizes and
upload timing correlate with vault activity). `/2`'s chunk compression adds a
third, smaller signal: a compressed object's *length* now reveals its
plaintext's **compressibility** (a highly redundant base is visibly smaller
than a high-entropy one of the same raw size). See `SECURITY.md` — all three
are an accepted trade for a personal single-tenant vault; padding/batching
knobs exist at the shipper, and the stored-raw escape hatch (`0x00`) is always
available, if a deployment ever needs blunting.

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
