# `centraid-media` — the byte plane

Content-addressed sealed frames, and the format-normative crypto every backup and snapshot artefact is built from. Two modules, no policy:

| Module | What it is |
| --- | --- |
| `cbsf` | **C**entraid **B**lob **S**ealed **F**rame v2: `MAGIC "CBSF"`, version `2`, a 37-byte header (4 magic + 1 version + 32-byte plaintext SHA-256), sealed frames, a sealed big-endian directory, a 13-byte trailer. Store / zstd / raw-deflate frame bodies (`algorithm` bytes `0/1/2`). |
| `phash` | Hamming distance over hex digests. Unequal widths, non-hex characters and an empty digest are all **not comparable** — `None`, never `0`. |
| `duplicates` | The near-duplicate projection `queries/duplicates.ts` reads: union-find over phash Hamming ≤ 6, the group's **lowest `asset_id`** as its deterministic cluster id, compare-then-write. Order-independent, with a property test over 63 permutations. |
| `models` | `models.lock.json`: the parser, and the one verify-then-fetch (`stat` size, then digest; temp file, digest, rename). A failure is **reported, never thrown**. Fetching is a trait; this crate opens no socket. |
| `format` | Canonical (ECMAScript-spelled) JSON, HKDF-SHA256 with an empty salt, AES-256-GCM `nonce ‖ ct ‖ tag`, SHA-256 hex, the WAL segment seal and the `centraid-snapshot/2` manifest seal. |

## Moved, not rewritten

Both modules were **moved** from `packages/tunnel/data-plane/src/` — first-party MIT code, named in a header line at the top of each file — when the byte plane became a v1 crate ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-R1). The v0 crate stays where it is as the pinned oracle until wave 6.

The reason it is a move and not a port: every constant and every info/AAD string in these files is a **format** decision. Editing one silently re-keys every vault that ever wrote a byte. The list, because it is short and load-bearing:

- CBSF frame AAD `blob:{sha}:v2:f{index}/{count}`, directory AAD `blobdir:{sha}:v2:n{count}`, and a **deterministic** nonce `HMAC(key, "cbsf-nonce\0" ‖ aad ‖ "\0" ‖ HMAC(key, plain))[..12]`.
- Directory encoding: big-endian `u32 frame_size ‖ u64 total_size ‖ u32 count ‖ count × u32 sealed_len`. Every directory integer is big-endian.
- Backup HKDF infos `centraid-backup:data:<vaultId>` and `centraid-backup:dedup:<vaultId>`; WAL nonce info and AAD carry the **full** segment address, both offsets included, so a longer crash-retry re-nonces rather than reusing one.
- `canonical_json` spells numbers the way `JSON.stringify` does (hence `ryu-js`), not the way `serde_json` spells integers. `1e21` is `1e+21` and `9007199254740993` is `9007199254740992`.

## The conformance boundary

`contracts/golden/format-golden.json` (`schema: "centraid-cross-language-golden/1"`) is the one fixture designed as the cross-language boundary, and `tests/golden.rs` reads it: CBSF store/zstd/deflate vectors, a sealed WAL segment against a fixed master key and full address, and a `centraid-snapshot/2` envelope with its `manifestHash`. Sealing is asserted **byte-for-byte**, not just round-tripped.

While the v0 tree exists the file must be the same bytes as `packages/tunnel/data-plane/fixtures/format-golden.json`, and `the_contracts_copy_is_byte_identical_to_the_v0_fixture` asserts it. The TS side reads the same vectors through `packages/vault/src/rust-golden.test.ts` and `packages/backup/src/rust-golden.test.ts`.

## Wave 4: three modules that are arithmetic, not format

`phash`, `duplicates` and `models` landed with the Photos lane ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-P3) because `crates/media` had no wave-4 owner of its own. They are not format decisions and may be changed on their merits — with three exceptions that are:

- **the Hamming threshold, 6** (`DUPLICATE_HAMMING_THRESHOLD`): moving it re-clusters every library, and the app's `duplicates` query reads the result without knowing what it was;
- **the cluster id, the group's lowest `asset_id`**: the id is what a member's review decision is keyed on, and any other choice depends on the union order;
- **`models.lock.json`'s pins**: a digest, a byte length and an immutable upstream URL per file. Sizes today: ArcFace 249 MB, CLIP ViT-B/32 606 MB, Whisper tiny.en q8 41 MB, PP-OCRv5 21 MB, YuNet 0.2 MB.

Two things are deliberately NOT ported and are named as next steps rather than omissions:

- **the multi-index banding** v0 uses to avoid the pairwise scan (`packages/vault/src/enrich/clusters.ts:100-181`). It is a cost optimisation whose answer is identical by construction, and porting a query plan without the scale rig that justified it is porting a plan nobody can check. `crates/apps/photos/tests/year3.rs` measures the pairwise cost at the year-3 photos axis.
- **the network fetcher**. `models::Fetch` is the seam and `DirectoryFetch` drives every line of `ensure` except the socket; the HTTP implementation belongs to the host that has one.

## What is not here

No consent, no journal, no replica, no handler, no policy — the v0 boundary ("TypeScript authorizes and decides; Rust moves dumb bytes") is kept, with `crates/vault` on the deciding side. The tunnel's relay, HTTP plane and blob ticket stay in v0 for now; they are transport, and wave 3 owns them.
