# `centraid-media` — the backup's one format, and the arithmetic Photos reads

No policy: `crates/vault` decides, this crate moves bytes.

| Module | What it is |
| --- | --- |
| `sealed` | **`centraid-sealed/4`** ([#1209](https://github.com/srikanth235/centraid/issues/1209), [#1212](https://github.com/srikanth235/centraid/issues/1212)) — the one format every byte a gateway stores wears. One object per chunk of at most 4 MiB of plaintext: `name = blake3_keyed(K_name, "obj4" ‖ class ‖ plaintext)`, class-aware `zstd` (`Records` uses `zstd` level 3 when strictly shorter; `Thumbnails` and `Originals` never compress), Padmé-padded `padded_inner = flags ‖ class ‖ u32be(len(body)) ‖ body ‖ 0x00*` (`64 ..= 6 + CHUNK_BYTES`), `aad = "CSB4" ‖ u8(4) ‖ class ‖ name` (neither `flags` nor `class` appears in clear in the 29-byte outer header `"CSB4" ‖ u8(4) ‖ nonce`), `nonce = blake3_keyed(K_nonce, aad ‖ blake3(padded_inner))[0..24]`, XChaCha20-Poly1305 under `K_obj` with that nonce and AAD, and `digest = blake3(object)`. Sealing is deterministic, so a chunk is rebuilt from its source and a resend is byte-identical. `open` is strict: length, digest, outer header, AEAD tag, inner flags and class, uncompressed media rule, canonical Padmé length and zero padding, derived nonce, bounded decompression and a recomputed name, and any mismatch is `Damaged`. A `Ref` is `{name, digest, len, class}`. |
| `format` | The BLAKE3 content hash, the BLAKE3 KDF, and canonical (ECMAScript-spelled) JSON. |
| `models` | `models.lock.json`: the parser, and the one verify-then-fetch (`stat` size, then digest; temp file, digest, rename). A failure is **reported, never thrown**. Fetching is a trait; this crate opens no socket. |
| `renditions` | The JPEG derivatives (thumbnail, preview) the core draws when the shell staged none. Pure: bytes in, bytes out. |

## The format is normative

**A zstd upgrade is a format decision too:** an object's digest covers the compressed bytes, so the workspace pins `zstd` exactly and `contracts/crypto/chunk-digest-vectors.json` fails when its output moves. Every context string, header field, Padmé bucket and derivation in `sealed` is a **format** decision: editing one re-keys every backup a member holds. The contexts are `centraid backup v2 root`, `… v2 name`, `… v4 object` and `… v4 nonce`.

`canonical_json` spells numbers the way `JSON.stringify` does (hence `ryu-js`), not the way `serde_json` spells integers: `1e21` is `1e+21` and `9007199254740993` is `9007199254740992`.

## The conformance boundary

Fixtures under `contracts/crypto/`, each with the test that reads it beside it:

- `contracts/crypto/sealed4-vectors.json`, read by [`tests/sealed4_vectors.rs`](tests/sealed4_vectors.rs) — `centraid-sealed/4`'s derived keys, Padmé lengths, names, nonces, whole objects and digests. Sealing is deterministic, so every value is compared, and the committed objects are also opened.
- `contracts/crypto/blake3-vectors.json`, read by [`tests/primitives.rs`](tests/primitives.rs) — the keyed hash and the KDF, as primitives.

Both regenerate with `CENTRAID_UPDATE_FIXTURES=1`, and the comparison still runs afterwards, so the variable is a generator and never a way to go green.

## Arithmetic, not format

`models` ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-P3) is not a format decision and may be changed on their merits — with one exception that is:

- **`models.lock.json`'s pins**: a digest, a byte length and an immutable upstream URL per file. Sizes today: ArcFace 249 MB, CLIP ViT-B/32 606 MB, Whisper tiny.en q8 41 MB, PP-OCRv5 21 MB, YuNet 0.2 MB.

One thing is deliberately absent:

- **the network fetcher**. `models::Fetch` is the seam and `DirectoryFetch` drives every line of `ensure` except the socket; the HTTP implementation belongs to the host that has one.

## What is not here

No consent, no journal, no handler, no policy — `crates/vault` decides, this crate moves bytes. The content store is `crates/blobs`, and the network is the phone core's, through `crates/gateway`'s client.
