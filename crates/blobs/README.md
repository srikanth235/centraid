# `centraid-blobs` — a member's bytes on this device

The content store ([#1080](https://github.com/srikanth235/centraid/issues/1080)): rows live in the vault file, **bytes live here**. A photograph is large, read in place by a platform that wants a path, and written once; a row is small and lands whole in a transaction. The two get two homes.

| Module | What it is |
| --- | --- |
| `store` | `ByteStore` — `<stem>.bytes/`, a directory of files named by their BLAKE3. Written temp → fsync → rename, read in place, verified on read; `put_path`, `writer` (hashing as it writes, so no photograph is held whole), `path_of`, `is_complete`, `remove`, `sweep`, `bytes_held`. No lock and no index: the directory is the index. |
| `door` | `ContentBytes` — the store wearing the vault's byte door (`centraid_vault::bytes::BlobStore`), so a device has one content store. It answers where a hash's bytes are: a file in the store, an item in the operating system's library (from the backup ledger's `local_bytes`), or nowhere. |
| `hash` | `ContentHash` and the `blob:blake3-<hex>` URI; the hash is BLAKE3 because the vault, the store and the backup name one file by one hash. |

**What it does not do.** It moves nothing over a network and opens no socket. What a transfer rule admits is the phone's pass, `centraid_core::phone::drain::Conditions`; the `plan` module that once answered it is deleted (#1080). An original the operating system's library holds is never copied in here (#1080 ruling 6): the store holds the app's own bytes and the derivatives.

`tests/eviction.rs` and `tests/reopen.rs` hold the sweep's budget and a store reopened in the same process.
