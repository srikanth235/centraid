# `centraid-media` — the backup's one format, and the arithmetic Photos reads

No policy: `crates/vault` decides, this crate moves bytes.

| Module | What it is |
| --- | --- |
| `sealed` | **`centraid-sealed/2`** ([#1080](https://github.com/srikanth235/centraid/issues/1080)) — the one format every byte a gateway stores wears. A file is hashed and sealed in the same stream (`FileSealer`, `PartSealer`); each part ≤ 64 MiB carries a 30-byte clear header, is keyed from its own random salt under `K_backup`, framed in 4 MiB XChaCha20-Poly1305 chunks, and named `hex(keyed_hash(K_name, h ‖ u32be(i)))`, so the gateway holds ciphertext under names it cannot invert; `Assembler` and `open_whole` check a whole file against the `h` its names were computed from. |
| `format` | The BLAKE3 content hash, the BLAKE3 KDF, and canonical (ECMAScript-spelled) JSON. |
| `phash` | Hamming distance over hex digests. Unequal widths, non-hex characters and an empty digest are all **not comparable** — `None`, never `0`. |
| `duplicates` | The near-duplicate projection the Photos `duplicates` query reads: union-find over phash Hamming ≤ 6, the group's **lowest `asset_id`** as its deterministic cluster id, compare-then-write. Order-independent, with a property test over 63 permutations. |
| `models` | `models.lock.json`: the parser, and the one verify-then-fetch (`stat` size, then digest; temp file, digest, rename). A failure is **reported, never thrown**. Fetching is a trait; this crate opens no socket. |
| `renditions` | The JPEG derivatives (thumbnail, preview) the core draws when the shell staged none. Pure: bytes in, bytes out. |

## The format is normative

Every context string, header field and framing rule in `sealed` is a **format** decision: editing one re-keys every backup a member holds. The contexts are `centraid backup v2 root`, `… name` and `… object`; the framing is canonical (every chunk but the last exactly 4 MiB, only an empty part ends in an empty chunk), so one payload has one sealed shape ([R-1080-B1–B3](../../docs/decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). The formats before it — the v0 frame format and `centraid-object/1` — left with the planes that wrote them (#1080); no member holds an artefact in either.

`canonical_json` spells numbers the way `JSON.stringify` does (hence `ryu-js`), not the way `serde_json` spells integers: `1e21` is `1e+21` and `9007199254740993` is `9007199254740992`.

## The conformance boundary

Two fixtures under `contracts/crypto/`, each with the test that reads it beside it:

- `contracts/crypto/sealed-vectors.json`, read by [`tests/sealed_vectors.rs`](tests/sealed_vectors.rs) — `centraid-sealed/2`'s derived keys, names and committed sealed samples. Sealing is deliberately not reproducible (random salts, random nonces), so the samples are **opened** and checked against their plaintext rather than resealed.
- `contracts/crypto/blake3-vectors.json`, read by [`tests/primitives.rs`](tests/primitives.rs) — the keyed hash and the KDF, as primitives.

Both regenerate with `CENTRAID_UPDATE_FIXTURES=1`, and the comparison still runs afterwards, so the variable is a generator and never a way to go green.

## Arithmetic, not format

`phash`, `duplicates` and `models` ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-P3) are not format decisions and may be changed on their merits — with three exceptions that are:

- **the Hamming threshold, 6** (`DUPLICATE_HAMMING_THRESHOLD`): moving it re-clusters every library, and the app's `duplicates` query reads the result without knowing what it was;
- **the cluster id, the group's lowest `asset_id`**: the id is what a member's review decision is keyed on, and any other choice depends on the union order;
- **`models.lock.json`'s pins**: a digest, a byte length and an immutable upstream URL per file. Sizes today: ArcFace 249 MB, CLIP ViT-B/32 606 MB, Whisper tiny.en q8 41 MB, PP-OCRv5 21 MB, YuNet 0.2 MB.

Two things are deliberately absent:

- **multi-index banding** to avoid the pairwise scan. It is a cost optimisation whose answer is identical by construction, and a query plan without a scale rig to justify it is a plan nobody can check. `crates/apps/photos/tests/year3.rs` measures the pairwise cost at the year-3 photos axis.
- **the network fetcher**. `models::Fetch` is the seam and `DirectoryFetch` drives every line of `ensure` except the socket; the HTTP implementation belongs to the host that has one.

## What is not here

No consent, no journal, no handler, no policy — `crates/vault` decides, this crate moves bytes. The content store is `crates/blobs`, and the network is the phone core's, through `crates/gateway`'s client.
