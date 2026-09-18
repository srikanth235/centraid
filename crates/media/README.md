# `centraid-media` — the byte plane's formats

Content-addressed sealed frames, the format-normative crypto every backup and snapshot artefact is built from, and the arithmetic Photos reads. No policy:

| Module | What it is |
| --- | --- |
| `cbsf` | **C**entraid **B**lob **S**ealed **F**rame v2: `MAGIC "CBSF"`, version `2`, a 37-byte header (4 magic + 1 version + 32-byte plaintext BLAKE3), sealed frames, a sealed big-endian directory, a 13-byte trailer. Store / zstd / raw-deflate frame bodies (`algorithm` bytes `0/1/2`). |
| `format` | Canonical (ECMAScript-spelled) JSON, the BLAKE3 content hash and key derivation, AES-256-GCM `nonce ‖ ct ‖ tag`, the WAL segment seal and the `centraid-snapshot/2` manifest seal. |
| `phash` | Hamming distance over hex digests. Unequal widths, non-hex characters and an empty digest are all **not comparable** — `None`, never `0`. |
| `duplicates` | The near-duplicate projection the Photos `duplicates` query reads: union-find over phash Hamming ≤ 6, the group's **lowest `asset_id`** as its deterministic cluster id, compare-then-write. Order-independent, with a property test over 63 permutations. |
| `models` | `models.lock.json`: the parser, and the one verify-then-fetch (`stat` size, then digest; temp file, digest, rename). A failure is **reported, never thrown**. Fetching is a trait; this crate opens no socket. |
| `renditions` | The two derived renditions (thumbnail, preview) a gateway makes of an image. Pure: bytes in, bytes out. |

## Formats are normative

`cbsf` and `format` are first-party MIT code (D-1020-R1), and every constant and every info/AAD string in them is a **format** decision. Editing one silently re-keys every vault that ever wrote a byte. The list, because it is short and load-bearing:

- CBSF frame AAD `blob:{sha}:v2:f{index}/{count}`, directory AAD `blobdir:{sha}:v2:n{count}`, and a **deterministic** nonce: the first 12 bytes of `keyed_blake3(key, "cbsf-nonce\0" ‖ aad ‖ "\0" ‖ keyed_blake3(key, plain))` (D-1025-S4-2).
- Content addresses are BLAKE3 (D-1025-S4-1), and keys are derived with BLAKE3's `derive_key` mode (D-1025-S4-3).
- Directory encoding: big-endian `u32 frame_size ‖ u64 total_size ‖ u32 count ‖ count × u32 sealed_len`. Every directory integer is big-endian.
- Backup derivation contexts `centraid-backup:data:<vaultId>` and `centraid-backup:dedup:<vaultId>`; the WAL nonce context and AAD carry the **full** segment address, both offsets included, so a longer crash-retry re-nonces rather than reusing one.
- `canonical_json` spells numbers the way `JSON.stringify` does (hence `ryu-js`), not the way `serde_json` spells integers. `1e21` is `1e+21` and `9007199254740993` is `9007199254740992`.

## The conformance boundary

`contracts/golden/format-golden.json` (`schema: "centraid-cross-language-golden/1"`) is the one fixture designed as the cross-language boundary, and `tests/golden.rs` reads it: CBSF store/zstd/deflate vectors, a sealed WAL segment against a fixed master key and full address, and a `centraid-snapshot/2` envelope with its `manifestHash`. Sealing is asserted **byte-for-byte**, not just round-tripped. The same test regenerates the file and diffs; `CENTRAID_UPDATE_FIXTURES=1` writes it, with the comparison still running afterwards.

## Arithmetic, not format

`phash`, `duplicates` and `models` ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-P3) are not format decisions and may be changed on their merits — with three exceptions that are:

- **the Hamming threshold, 6** (`DUPLICATE_HAMMING_THRESHOLD`): moving it re-clusters every library, and the app's `duplicates` query reads the result without knowing what it was;
- **the cluster id, the group's lowest `asset_id`**: the id is what a member's review decision is keyed on, and any other choice depends on the union order;
- **`models.lock.json`'s pins**: a digest, a byte length and an immutable upstream URL per file. Sizes today: ArcFace 249 MB, CLIP ViT-B/32 606 MB, Whisper tiny.en q8 41 MB, PP-OCRv5 21 MB, YuNet 0.2 MB.

Two things are deliberately absent:

- **multi-index banding** to avoid the pairwise scan. It is a cost optimisation whose answer is identical by construction, and a query plan without a scale rig to justify it is a plan nobody can check. `crates/apps/photos/tests/year3.rs` measures the pairwise cost at the year-3 photos axis.
- **the network fetcher**. `models::Fetch` is the seam and `DirectoryFetch` drives every line of `ensure` except the socket; the HTTP implementation belongs to the host that has one.

## What is not here

No consent, no journal, no replica, no handler, no policy — `crates/vault` decides, this crate moves bytes. Transport lives in `crates/net` and `crates/blobs`.
