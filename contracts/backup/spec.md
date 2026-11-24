# Backup plane spec (#1209, #1212)

The one design document for the sovereign backup plane ([#1209](https://github.com/srikanth235/centraid/issues/1209), redesigned in [#1212](https://github.com/srikanth235/centraid/issues/1212)). v0 has nothing to stay compatible with: no reading old backups, no upgrade path.

The decisions that outlive this design (E1 to E14: keys and signed records, ordering, takeover, held deletes, the directory, sampling, token storage, housekeeping) live in the [`backup` skill](../../.claude/skills/backup/SKILL.md), cited here by their old numbers.

## 1. Rulings

- **R1. One vault per phone in v0.** Everything stays vault-scoped so a second vault later is a feature, not a migration: the vault id is in every key derivation, device-state file, token, gateway namespace, packfile directory and route; sealing keys are per vault; nothing deduplicates across vaults. Restore on v0 probes vault index `0` directly instead of scanning `GAP = 20` derived indices.
- **R2. A chunk is at most 4 MiB** (`CHUNK_BYTES = 4,194,304`). Vault ranges are 64 KiB (`RANGE_BYTES = 65,536`).
- **R3. Restore order:** records first (the vault opens), then thumbnails (the library is browsable), then originals, newest first (by `COALESCE(photo.taken_at, entity.created_at)`), streamed in the background or on open.
- **R4. Warn before deleting a photo no gateway holds whole.** The member can still delete. "Holds whole" is tested in `O(depth)` via `tree::lookup_entry` over each non-superseded gateway's `oroot` (§6.6).
- **R5. The core owns checkpoints.** Automatic checkpointing is off (`wal_autocheckpoint = 0`, structural rule enforced) on every connection to the vault file; the core checkpoints after a snapshot, and folds oversized WALs into the persistent `dirty_range` set when unpaired or offline (§5).
- **R6. Sealing is deterministic, length-padded, and class-aware** (§2, `centraid-sealed/4`).
- **R7. Only the engine confirms.** Nothing an OS transport reports marks anything stored, and neither `troot` nor `oroot` confirms while any in-scope entry of its class lacks sealed chunk refs.
- **R8. Assert on counts, never durations.**

## 2. Objects: `centraid-sealed/4` (`CSB4`)

Every stored object (vault range, tree node, thumbnail chunk, original chunk) is one sealed chunk of at most `CHUNK_BYTES` plaintext.

Keys (per vault: `root_key` is `seed / vault'(i) / root'` from the 24 words, so two vaults never share a key; `BackupKeys::from_root` kept):

```
K_backup = derive_key("centraid backup v2 root",   root_key)
K_name   = derive_key("centraid backup v2 name",   K_backup)
K_obj    = derive_key("centraid backup v4 object", K_backup)
K_nonce  = derive_key("centraid backup v4 nonce",  K_backup)
```

For a chunk's plaintext `p` (`len(p) <= CHUNK_BYTES`) and its class byte `c` (`1 = records`, `2 = thumbnails`, `3 = originals`):

```
name         = blake3_keyed(K_name, "obj4" ‖ c ‖ p)                            32 bytes
(body, flags)= if c == 1 && len(zstd_3(p)) < len(p) { (zstd_3(p), 0x01) }
               else                                 { (p,         0x00) }
inner_len    = 6 + len(body)
padded_len   = padme_len(inner_len)                                            64 ..= 6 + CHUNK_BYTES
padded_inner = flags (1) ‖ c (1) ‖ u32be(len(body)) (4) ‖ body ‖ 0x00 * (padded_len - inner_len)
aad          = "CSB4" ‖ u8(4) ‖ c ‖ name                                       38 bytes
nonce        = blake3_keyed(K_nonce, aad ‖ blake3(padded_inner))[0..24]        24 bytes
object       = "CSB4" ‖ u8(4) ‖ nonce ‖ XChaCha20-Poly1305(K_obj, nonce, aad, padded_inner)
digest       = blake3(object)                                                  32 bytes
```

Where `padme_len(L)` (Padmé length padding, ≤ 3% max overhead, 0% overhead at full `CHUNK_BYTES`):
- If `L <= 64`: `64`.
- Else: `e = ilog2(L)`, `s = ilog2(e) + 1`, `last_bits = e - s`, `mask = (1 << last_bits) - 1`, `((L + mask) & !mask).min(6 + CHUNK_BYTES)`.

Properties and strict verification:
- Outer wire header is `"CSB4" (4) ‖ u8(4) (1) ‖ nonce (24)` = 29 clear bytes (`OUTER_HEADER_BYTES = 29`, `TAG_BYTES = 16`). Neither `flags` nor `class` appears in clear on the wire; exact file lengths are hidden in Padmé buckets.
- Minimum object length is `MIN_OBJECT_BYTES = 29 + 64 + 16 = 109` bytes; maximum object length is `MAX_OBJECT_BYTES = CHUNK_BYTES + 51 = 4,194,355` bytes (`SEAL_OVERHEAD_BYTES = 51`).
- Class-aware compression: `Class::Thumbnails` and `Class::Originals` (already entropy-coded JPEG/HEIC/WebP/MP4/PDF) never run `zstd` (`flags` must be `0x00`). `Class::Records` uses `zstd` level 3 when strictly shorter (`flags = 0x01`).
- Same `p` and `c` in the same vault always give the same `name`, `object` and `digest`.
- `contracts/crypto/sealed4-vectors.json` and `contracts/crypto/chunk-digest-vectors.json` pin derived keys, Padmé lengths, names, nonces, objects and digests.
- `open(keys, ref, object)` checks in order: `object.len() == ref.len` within `[MIN_OBJECT_BYTES, MAX_OBJECT_BYTES]`; `blake3(object) == ref.digest`; magic `"CSB4"` and version `4`; AEAD tag under `(K_obj, nonce, aad)` with `aad` built from `ref.class` and `ref.name`; unknown `flags` bits refused; `inner_class == ref.class`; `flags == 0` when `ref.class != Records`; `body_len <= CHUNK_BYTES` and `padded_inner.len() == padme_len(6 + body_len)`; every padding byte in `padded_inner[6 + body_len..]` equal to `0`; SIV `nonce == blake3_keyed(K_nonce, aad ‖ blake3(padded_inner))[0..24]`; bounded decompression when `FLAG_ZSTD` is set with `len(plaintext) > body_len` enforced; recomputed `name == ref.name`. Any mismatch returns `Damaged`.
- A ref to an object is `{name: 32, digest: 32, len: u32 (sealed length), class: u8}` (69 bytes).

## 3. The tree (manifest v6)

Tree nodes are objects of class `records`. Encoding: the signing scheme's canonical form (`u32be(len) ‖ bytes` per field, unsigned integers `u64be`, signed timestamps `i64be`, lists prefixed with `u32be(count)`), first field a node-kind tag and `u8(6)`.

```
Root        writes, user_version, page_size, page_count, taken_at_ms (u64),
            census (table → rows), db_hash (or none: §5), range_leaves: [Ref],
            blobs: Ref, directory: Ref
RangeLeaf   first_range_index, [Ref] (≤ 1024 ranges, 64 KiB each, class records)
BlobsNode   depth, prefix, stats: BlobsStats,
            either children: [(u8, Ref)] / [Ref] (≤ 256, by the next byte of h)
            or entries: [Entry] (≤ 256, sorted by h); a leaf over 256 splits by the next byte
BlobsStats  orig_files, orig_bytes, thumb_files, thumb_bytes,
            unheld_orig_files, unheld_orig_bytes,
            unheld_thumb_files, unheld_thumb_bytes,
            excluded_orig_files, excluded_orig_bytes (all u64)
Entry       h (content hash, 32B), kind: EntryKind (u8: 1=Original, 2=Thumbnail, 3=ExcludedOriginal),
            size (u64), media_type (utf8), taken_at_ms (i64be, signed),
            original: [Ref] (class originals), thumbnail: [Ref] (class thumbnails)
Directory   as the skill's E8 (phone.md, "Restore"; gateways, addresses, pins, labels; never a token)
```

- Every `BlobsNode` carries rolled-up `BlobsStats` equal to the exact sum of its children's or entries' stats; `Node::decode` verifies leaf stats against its entries so counts are structural.
- Sublinear Merkle operations over `NodeSource`:
  - `stats_of(source, blobs_ref) -> BlobsStats`: `O(1)` (1 node read).
  - `lookup_entry(source, blobs_ref, h) -> Option<Entry>`: `O(depth)` radix walk by bytes of `h` (1–3 node reads at 90,000 photos).
  - `diff_entries(source, old_blobs, new_blobs)` and `assemble_incremental`: skips identical `Ref` subtrees in `O(Δ log N)`.
  - `reachable_names(source, roots, visited_nodes)`: memoizes visited tree node `Name`s across snapshots so retention over 17 kept roots visits shared subtrees once.
- Capture-time ordering: `Entry.taken_at_ms` is signed `i64` (preserving pre-1970 EXIF timestamps) sourced from `COALESCE(photo.taken_at, entity.created_at)` for photos and photo derivatives.

## 4. Gateway protocol & storage (`CGW4`, protocol 1)

Routes stay under `/v1/`; `info` answers `protocol: 1` and includes `label: String` (the gateway's configured `--name` or clean hostname). One namespace per vault id.

- **`MAX_OBJECT_BYTES`** = `CHUNK_BYTES + 51` (`4,194,355` bytes).
- **`POST /v1/v/{vault}/bundle`**: streamed frames `name (32) ‖ digest (32) ‖ u32be(len) ‖ object`, up to `MAX_BUNDLE_BYTES` (256 MiB).
- **Append-only packfile store (`CGW4`)**:
  - Gateway `state.db` carries `application_id = CGW4`. The `object` table records `(vault_id, name, digest, size, pack_id, pack_pos, state, created_at_ms, held_at_ms, purge_after_ms)`.
  - Bundle arrivals append sequentially into active packfiles under `packs/<vault_id>/<pack_id>.pack` (rotating around 256 MiB). On bundle stream completion or early disconnect, the active packfile is `fsync`ed once and all completed frames commit in one SQLite `BEGIN IMMEDIATE … COMMIT` transaction; any truncated trailing frame is truncated/ignored before commit so no `object` row ever points past durable bytes.
  - `GET /o/{name}`, ranged `GET`, and `POST /fetch` serve slices directly by `(pack_id, pack_pos, size)` via `pread` / positioned read without per-object `open`/`close` storms.
  - Scrub hashes pack regions sequentially, and the housekeeping sweep compacts sparse packfiles once ≥ 50% of a packfile's bytes belong to purged objects (rewriting live objects to a new packfile, `fsync`ing, atomically remapping `object` rows in SQLite, and unlinking the old packfile).
- **Operator CLI & reachability**:
  - `centraid-gateway serve` and `centraid-gateway pair` accept `--name <label>` (persisted/used as default label, falling back to clean hostname) and repeatable `--announce <host:port>` (appended to advertised addresses for Tailscale, WireGuard, port-forwarded or reverse-proxied gateways).
  - `PairPayload` carries optional `label` alongside `v`, `gw`, `addrs`, `pin`, `secret`.
  - Address discovery ranks RFC1918 LAN (`192.168.0.0/16`, `10.0.0.0/8`) and Tailscale CGNAT (`100.64.0.0/10`) ahead of `172.16.0.0/12` Docker bridges, and `refresh_destination` preserves DNS/`.local` hostnames alongside discovered IP literals.

## 5. Snapshot & WAL ownership

- **Lock-free read pin:** `snapshot::take_at_path` opens `PinnedPages` (`SQLITE_OPEN_READ_ONLY`) directly on the vault path **without** holding `handle.vault.lock()`, runs `quick_check`, census, `user_version`, `history`, live blob discovery (`content_files`), dirty-range sealing, `blob_chunks` lookup, and Merkle tree v6 assembly. Only the brief post-pin `wal_checkpoint(TRUNCATE)` acquires `vault.with_exclusive_connection`.
- **Bounded WAL folding when unpaired or offline:** Every vault connection sets `wal_autocheckpoint = 0`. Whenever the phone is unpaired or no paired gateway is reachable and `-wal` exceeds `WAL_FOLD_FRAMES` (4,096 frames, ~16 MiB), `fold_wal_if_needed` harvests `wal::dirty_ranges` into `state.db`'s persistent `dirty_range` table, runs `PRAGMA wal_checkpoint(TRUNCATE)`, and updates `disk_mark`. The next snapshot unions `dirty_range` with live WAL frames and clears `dirty_range` once recorded.
- **Periodic full read & write-behind guard:** Every 4th snapshot, at least daily, on `fresh_open`, or whenever `disk_mark` differs from the post-checkpoint mark, every range is read and `db_hash` is set.
- **Durable `blob_chunks` & cloud-only safety (`CBS2`):**
  - `state.db` (`STATE_APPLICATION_ID = CBS2`) stores `blob_chunks(hash, class)` for every sealed blob (populated on stream-in in `stage.rs`, on snapshot sealing, and hydrated from the gateway's standing `head` on `VAULT_KNOWN` re-pair before any snapshot runs).
  - Toggling `exclude_videos` switches video entries between `EntryKind::ExcludedOriginal` and `EntryKind::Original` using `blob_chunks` without erasing known chunk refs.
  - `Env::rebuild` checks local `Staging`, `ByteStore`, and finally peer gateways (`peer_stores`) so a newly paired second gateway repairs cloud-only ("Free up space") originals from Gateway 1.

## 6. The phone engine & mobile driver

- **Split-brain guard (`pair::head_is_ahead`):** Compares `(head.epoch, head.writes)` directly against local vault history; a local timestamp `last_write_ms >= head.taken_at_ms` never masks a remote head with higher `writes` or higher `epoch`.
- **Unheld media guard:** `enter_media` adds `unheld_orig_files` (for `Originals`) or `unheld_thumb_files` (for `Thumbnails`) to `phase.skipped`, preventing `oroot`/`troot` confirmation until every in-scope file has sealed refs and every ref is confirmed on the gateway.
- **Persistent `GatewayNotes`:** `collected_ms`, `held_count`, `held_purge_at_ms`, `refusal`, `damaged`, `sample_checked`, and `manifest_unreadable` live as typed columns on `gateway` in `state.db` (`CBS2`) so `retention::collect` (every 6 hours) and status notes survive mobile process suspension/termination, and `held_count` pages through all held rows without truncating at 200.
- **Concurrent multi-gateway pass & batch loops:** Reachable gateways run upload bundles concurrently in `drive::run_pass`; `"Back up now"` loops until debt is cleared or a gateway refuses/stalls (no 8-round cliff); `bring_originals` loops batches until all due originals are fetched or the pass budget/cancellation triggers; iOS `VaultFileProtection` applies `completeUntilFirstUserAuthentication` on top-level vault directories rather than walking every file in `vault.bytes/` on launch.

## 7. Invariants and simulation

`crates/vault/tests/backup_sim.rs` verifies truthful status (including unstreamed OS-only photos never claiming `"Backed up"`), the commit rule, never deleting needed data (including freed-up cloud-only originals across `state.db` reset + re-pair and `exclude_videos` toggles), convergence (including peer-repair to a second gateway), bounded work, and vault isolation across all planted bugs.
