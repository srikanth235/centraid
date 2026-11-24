# Backup plane spec (#1209)

The one design document for the backup rewrite tracked in [#1209](https://github.com/srikanth235/centraid/issues/1209). Every session working on #1209 reads this file and the seams it names, and nothing else of the old plane: the code it replaces is deleted, not read, migrated or fixed. v0 has nothing to stay compatible with: no reading old backups, no upgrade path.

The decisions that outlive this design (E1 to E14: keys and signed records, ordering, takeover, held deletes, the directory, sampling, token storage, housekeeping) live in the [`backup` skill](../../.claude/skills/backup/SKILL.md), cited here by their old numbers.

## 1. Rulings

- **R1. One vault per phone in v0.** Everything stays vault-scoped so a second vault later is a feature, not a migration: the vault id is in every key derivation, device-state file, token, gateway namespace and route; sealing keys are per vault; nothing deduplicates across vaults.
- **R2. A chunk is at most 4 MiB** (`CHUNK_BYTES`, the AEAD chunk size today). Vault ranges are 64 KiB.
- **R3. Restore order:** records first (the vault opens), then thumbnails (the library is browsable), then originals, newest first, streamed in the background or on open.
- **R4. Warn before deleting a photo no gateway holds whole.** The member can still delete. "Holds whole" is the same test as the Backup screen (§6.6).
- **R5. The core owns checkpoints.** Automatic checkpointing is off on every connection to the vault file; the core checkpoints only after a snapshot.
- **R6. Sealing is deterministic** (§2). Pending the crypto review recorded in §10; no sealing code lands before it signs off.
- **R7. Only the engine confirms.** Nothing an OS transport reports marks anything stored.
- **R8. Assert on counts, never durations.**

## 2. Objects: `centraid-sealed/3`

Every stored object (vault range, tree node, thumbnail chunk, original chunk) is one sealed chunk of at most `CHUNK_BYTES` plaintext.

Keys (per vault: `root_key` is `seed / vault'(i) / root'` from the 24 words, as today, so two vaults never share a key; `BackupKeys::from_root` kept):

```
K_backup = derive_key("centraid backup v2 root",  root_key)        (kept)
K_name   = derive_key("centraid backup v2 name",  K_backup)        (kept)
K_obj    = derive_key("centraid backup v3 object", K_backup)
K_nonce  = derive_key("centraid backup v3 nonce",  K_backup)
```

For a chunk's plaintext `p` and its class byte `c` (§3):

```
name   = blake3_keyed(K_name, "obj3" ‖ c ‖ p)                       32 bytes
body   = zstd(p) if strictly shorter, else p;  flags bit0 = compressed
aad    = "CSB3" ‖ u8(3) ‖ flags ‖ c ‖ name
nonce  = blake3_keyed(K_nonce, aad ‖ blake3(body))[0..24]
object = "CSB3" ‖ u8(3) ‖ flags ‖ c ‖ nonce ‖ XChaCha20-Poly1305(K_obj, nonce, aad, body)
digest = blake3(object)                                            32 bytes
```

- Same `p` and `c` in the same vault always give the same `name`, `object` and `digest`, so a chunk is rebuilt from its source instead of being kept, and a resend is byte-identical.
- The nonce covers the sealed body (SIV-style), so no `(K_obj, nonce)` pair ever meets two bodies, even if zstd's output changed.
- What a gateway learns: equality of chunks within one vault, at chunk granularity (shared chunks between files and between versions are visible), which the keyed names already reveal, plus the sealed length (as today). Nothing across vaults.
- `zstd` stays pinned exactly. Changing its version, level or parameters changes held objects' bodies and digests: it is a format change (`centraid-sealed/4`). `contracts/crypto/` gains `sealed3-vectors.json` (key derivations, names, nonces, objects, digests for fixed inputs, compressed and not), which pins the compressed output; the chunk-digest vectors are regenerated as a deliberate format change.
- Open an object: check `digest`; refuse an unknown flag bit, a class other than the ref's, or a length past the largest sealed chunk; decrypt with the `aad` built from the name it was fetched under; decompress, refusing output past `CHUNK_BYTES`; recompute `name` from the plaintext and `nonce` from `aad ‖ blake3(body)` and compare both. Any mismatch is "damaged".
- A ref to an object is `{name: 32, digest: 32, len: u32 (sealed length), class: u8}`.

## 3. The tree (manifest v5)

Tree nodes are objects of class `records`. Encoding: the signing scheme's canonical form (`u32be(len) ‖ bytes` per field, integers `u64be`, lists prefixed with `u32be(count)`), first field a node-kind tag and `u8(5)`.

```
Root        writes, user_version, page_size, page_count, taken_at_ms,
            census (table → rows), db_hash (or none: §5), range_leaves: [Ref],
            blobs: Ref, directory: Ref
RangeLeaf   first_range_index, [Ref] (≤ 1024 ranges, 64 KiB each, class records)
BlobsNode   depth, prefix, either children: [Ref] (≤ 256, by the next byte of h)
            or entries: [Entry] (≤ 1024, sorted by h); a leaf over 1024 splits by the next byte
Entry       h (content hash), size, media_type, taken_at_ms,
            original: [Ref] (class originals), thumbnail: [Ref] (class thumbnails, may be empty)
Directory   as the skill's E8 (phone.md, "Restore"; gateways, addresses, pins, labels; never a token)
```

- Classes: `records` = root, leaves, range chunks, blobs nodes, directory; `thumbnails` = derivative chunks; `originals` = original chunks.
- Every node is a pure function of its content, so one changed range rewrites one leaf and the root; one new photo rewrites one path of blobs nodes plus its own chunks.
- The blobs tree is built from the vault's `blob` claims (`pagesource::PinnedPages::blobs` / `naming::claims_after`, kept). A blob only lapsed entities rent is not in the tree.

## 4. Gateway protocol (revision of protocol 1)

Routes stay under `/v1/`; the protocol is unreleased, so it is revised in place and `info` keeps answering `protocol: 1`. One namespace per vault id, as today.

Kept as today: `info`, `nonce`, `pair`, `head` (GET and signed compare-and-set, E2/E3), `snapshots`, `exists`, `fetch` and ranged `GET`, `objects`, `held`, `undo`, `check` (decision 34), `revoke`, takeover and claims (E4/E5), freeze and operator verbs (E6), housekeeping (E14).

Changed:

- **`MAX_OBJECT_BYTES`** = the largest sealed object of a 4 MiB chunk (header + nonce + tag + body). One object per chunk; no parts.
- **`PUT /v1/v/{vault}/o/{name}` is removed.** The one upload is **`POST /v1/v/{vault}/bundle`**: a streamed body of frames `name ‖ digest ‖ u32be(len) ‖ object`, up to `MAX_BUNDLE_BYTES`. The gateway checks each frame's digest as it arrives and commits it on its own (stage, fsync, rename); a frame cut off mid-way is discarded. The answer lists one result per frame: `stored`, `there` (same digest, live), `held` (same digest under a hold: the hold is lifted, as a `PUT` lifts it today), `taken {digest, state: live|held|damaged}`, `full`, `too_large`. A connection that drops leaves every finished frame committed.
- **A delete names its head.** The delete preimage adds the head's root name after `generation`: `… ‖ u64be(generation) ‖ head_root ‖ names_digest`. The gateway accepts it only when that is its current head and `generation` is next in order (E3). The keep set is computed from the head read at that generation, so a rolled-back gateway refuses it.
- **A hold is lifted by need.** A bundle frame with the recorded digest lifts a hold (as above); `exists` reports a held name as missing (today's rule), which leads the phone to send it.
- **Signing vectors** in `contracts/crypto/gateway-signing-vectors.json` change only for the delete preimage.

Client (`crates/gateway/src/client/`): HTTP/2 over the pinned TLS with HTTP/1.1 fallback by ALPN; every address of a gateway dialled in parallel, the preferred one first and the rest after a 250 ms stagger, the first verified handshake wins and becomes preferred; retries bounded by count (3) for idempotent calls (`head` read, `exists`, `bundle`, `fetch`, `GET`, `snapshots`, `held`), `BUSY` honoured with its `retry_after_ms`; a typed reach: `ok`, `unreachable`, `untrusted`, `too_old`, `pair_again`, `moved`, `frozen`, `busy`.

## 5. Snapshot

- The vault is read with `pagesource::PinnedPages` (kept): one pinned WAL read, `sqlite_dbpage`, no plaintext copy on disk, `quick_check`, census, `user_version`, writes counter.
- **Dirty ranges, not the whole file.** Every connection to the vault file sets `wal_autocheckpoint = 0` (a structural rule checks it). Before the pin, the core reads the page numbers of the WAL frames written since the previous snapshot and maps them to 64 KiB ranges; only those are read, named and sealed. After the pin ends, the core checkpoints.
- **The periodic full read.** Every 4th snapshot, and at least daily, the snapshot reads and names every range and sets `db_hash`; a range the dirty set missed is caught there. Other snapshots carry `db_hash = none` and reuse the previous refs for clean ranges.
- When it runs: as today (about 30 s after the newest snapshot a head named, the conductor's debounce; never while the vault is unchanged; at once when asked or when a gateway's head went backwards). A damaged vault is refused before any root exists.

## 6. The phone engine

### 6.1 State (`<stem>.state.db`, derived; a reset is a re-pair and a re-ask)

Per gateway: pairing (id, addresses, pin, label), epoch, `conf` (the head this phone last confirmed there), `troot` and `oroot` (roots whose thumbnails and originals are confirmed whole there), reach, sample counter, scrub cursor. Plus `node(name PK, plaintext)` holding the tree nodes of every root named by `conf`, `troot`, `oroot`, the newest snapshot and the snapshots retention keeps, `staged(name, path, size)` for staging, and `local_bytes` (where a content hash's bytes are on this device; `crates/blobs` reads it). **No outbox.**

### 6.2 A pass, per gateway (a pure state machine; I/O through `Store`)

1. **Head.** Read the head. If it equals `conf`: incremental. Otherwise recovery: drop `conf`, `troot`, `oroot` and the status claims for that gateway, and use `exists` over the tree to learn what is held.
2. **Records.** Owed = the new tree's records refs minus those reachable from `conf` (incremental) or minus those `exists` reports (recovery). Send owed objects in bundles. `taken` with another digest and `state: damaged` → one signed delete frees it, then resend; `taken` live or held with another digest → wait with that reason (cannot happen with deterministic sealing unless the gateway is wrong).
3. **Commit rule (asserted).** Before the compare-and-set: every records ref reachable from the new root is either reachable from `conf` with the head unchanged, or answered `stored`/`there`/`held` in this pass, or reported held by `exists`. A violation is a bug, not a refusal: debug builds panic, release builds abort the pass and log.
4. **Set the head** (signed compare-and-set, E2/E3), then persist `conf`. The status may now say records are backed up at that gateway.
5. **Thumbnails, then originals** (newest first), each a phase like 2–3 for its class, ending in persisting `troot`, then `oroot`. A media phase first asks `exists` about its owed names, so a pass cut off mid-phase never resends gigabytes the gateway already holds; records never do. If an owed range is no longer staged, the engine stops with `Restage` and the driver takes a snapshot that stages every range again.
6. **While past records,** re-read the head at records priority every `max(4, ceil(2 × gateways / W))` windows (W = calls the window allows); if it moved, restart at 1.
7. **Read-back and retention** (E10 sampling over the kept trees; retention 7 daily, 4 weekly, 6 monthly). Collection lists the gateway's names and deletes, by one head-bound signed delete (§4), every name not reachable from: the head, `conf`, `troot`, `oroot`, every kept snapshot, the newest snapshot, and anything Undo restored this week. A kept root whose nodes will not open stops collection: doubt never deletes.

Every step is safe to repeat after a crash at any point.

### 6.3 Scheduling

One scheduler over every gateway's debt, by class: records of every gateway before thumbnails of any, before originals of any; round robin between gateways inside a class. Gateways are served in parallel over their own connections; a chunk is read and sealed once per window and sent to every gateway that owes it. The member's rule applies per class (Wi-Fi only by default; photos optionally on cellular; video originals never on a metered link; "Back up now" sends records on a metered link, never a heavy original).

### 6.4 Staging

Sealed objects are rebuilt from source when needed. Staging (`<stem>.staging/`, budget the smaller of 512 MiB and a tenth of free space) holds only: sealed vault ranges between the pin and their confirmation, originals whose bytes only the OS photo library holds (until every gateway confirms them), and bundle files handed to the OS background session. Files reach their name by rename after fsync; opening the staging area sweeps partials.

### 6.5 OS background

On iOS the core writes up to `OS_BUNDLES` (4) bundle files of at most 32 MiB each for originals or thumbnails and hands them to the shell, which uploads them through a background `URLSession`; a finished, failed or lost task only wakes a pass, which re-reads the head and diffs. Android has no such carrier: WorkManager runs the pass itself inside its window, so it writes no bundle files. Nothing the OS reports is recorded as stored.

### 6.6 Status

"Backed up" per gateway: records at `conf`; thumbnails and originals whole when `troot` / `oroot` equal `conf`'s root. The Backup line keeps today's honesty rules (backup `product.md`), now per class: "Backed up 2 minutes ago. 120 photos waiting for Wi-Fi." A photo is held whole at a gateway when every chunk of its original is reachable from `oroot` there; R4 uses that.

## 7. Restore, check, drill

- Restore: read every listed gateway's head (directory, E8), pick the greatest `(epoch, generation, writes)`, the `unproven_newest` ask and `confirm_unproven` as today. Then, per R3: records (write the pages, verify `db_hash` when the root has one, `quick_check`, census), open the vault; then thumbnails; then originals in the background, newest first, or on open. Claim at every gateway that answered with a verified head (E5).
- "Check my backup" and the drill restore into `<stem>.scratch/` from the new tree, as today.

## 8. Invariants and the simulation

`crates/vault/tests/backup_sim.rs` (wave 1): a seeded, deterministic simulation of the real engine against `Gateway<MemoryState>` behind a fault-injecting `Store`. Faults: cut bundles at and inside frames, duplicate and reordered requests, `BUSY`, unreachable, disk full, bit rot, gateway rollback, phone kill and state loss, lying OS reports, a checkpoint outside the core. Checked after every step:

- **Truthful status:** a gateway the status calls backed up at T restores exactly the vault at T (a stale claim after rot or rollback is withdrawn within a bounded number of scrubs).
- **Commit rule** (§6.2 step 3).
- **Never delete needed data:** no delete removes a name reachable from a claimed root or the current head.
- **Convergence:** with faults off, every gateway reaches the current root within a bounded number of passes.
- **Bounded work:** a one-page edit stores 3 objects and makes 0 `exists` calls; a new photo of k chunks stores at most k + r + 4 objects, r the vault ranges its rows moved (k + 5 when one range moves), and asks `exists` once per media phase.
- **Vault scope:** two vaults on one gateway: no name or connection is shared, and one vault's actions change nothing of the other's.

Planted bugs (each a feature flag in the test, each must be caught): acknowledge `taken` regardless of digest; trust an OS report; skip the head check; no periodic full read; the gateway commits a truncated frame; set the head before records are confirmed; a delete not bound to its head; one sealing key for two vaults; a namespace or head not scoped per vault. A fixed seed set runs in `pr`; `nightly` runs more.

The Python model this is ported from is attached to the design doc linked in #1209.

## 9. Kept, replaced, deleted

**Kept (read these, nothing else of the old plane):** `centraid_media::sealed::BackupKeys` and its derivations; `crates/vault/src/pagesource.rs`; `crates/vault/src/file.rs` (adds `wal_autocheckpoint = 0`); `naming::claims_after` and `content_hashes`; `crates/gateway/src/rules/signing.rs` (delete preimage changes), `ids.rs`, `nonce.rs`, `code.rs`, `state.rs`, `engine.rs` and `memory.rs` (revised, not rewritten); the gateway server skeleton, its SQL ladder and `server::harness`; `crates/gateway/src/client/tls.rs`; pairing (`phone/pair.rs`, `phone/phrase.rs`); the shell bridge envelope.

Decisions in force, now in the backup skill ([gateway.md](../../.claude/skills/backup/gateway.md), [phone.md](../../.claude/skills/backup/phone.md)): E1, E2, E3, E4, E5, E6 (delete preimage per §4), E7, E8, E10, E12, E13, E14. Replaced: E9 (by §3), E11 (by §6.1).

**Deleted:** `backup/mover.rs`, `backup/spool.rs` (replaced by staging), `backup/holdings.rs` and the outbox tables in `backup/state.rs`, `backup/snapshot.rs`, `backup/retention.rs`, `backup/verify.rs`, `backup/restore.rs`, `backup/drill.rs` (rewritten from this spec), the `PUT` route, `phone/drain/` (`os.rs` handoff, `settle`, `reconcile`, `media.rs`, `records.rs`, `plan.rs`, `policy.rs` rewritten as the engine and its driver), the vault shelf and vault switch.

**Proto:** changes are additive only (`buf breaking`). Messages the new plane no longer sends (handoff, `UploadSettled` acknowledgement fields, multi-vault holdings) stay in the schema, marked deprecated in a comment, and are ignored; new fields are added for the per-class status and the OS wake.

## 10. Reviews

- **Crypto review of §2** (2026-11-23): approved with changes, all applied above. Blocker fixed: the nonce was derived from `name` alone, so a change in zstd's output would have reused a `(key, nonce)` pair over a different body; it now derives from `aad ‖ blake3(body)`. Also applied: the open procedure refuses unknown flags, a wrong class, oversize objects and oversize decompression, and checks the nonce; a zstd change is named a format change; chunk-granular equality is stated as what the gateway learns. Key separation confirmed: `root_key` is already per vault.
