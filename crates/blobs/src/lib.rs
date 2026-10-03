#![forbid(unsafe_code)]
//! The content store: a member's bytes on this device (#1020 wave 3 lane B,
//! [#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! Rows live in the vault file; **bytes live here**. The split is not
//! tidiness — the two have opposite shapes. A row is small, ordered and must
//! land whole in a transaction; a photograph is large, is read by a platform
//! that wants a path, and is written once and never changed.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`store`] | [`store::ByteStore`] — a directory of files named by their BLAKE3, written whole or not at all |
//! | [`door`] | [`door::ContentBytes`] — that store wearing the vault's byte door, so a device has ONE content store |
//! | [`hash`] | [`hash::ContentHash`], the `blob:blake3-<hex>` URI, and why the hash is BLAKE3 |
//!
//! ## Bytes never conflict
//!
//! Content-addressed bytes are immutable by construction: a file named by the
//! hash of its bytes cannot be edited in place, only joined by another file.
//! So the store has no merge, no lock and no index to keep in step with its
//! files — the directory is the index. Every hard question about a member's
//! data lives in the vault, where the rows are.
//!
//! ## No socket at all
//!
//! The store is files. It moves nothing over a network: the backup plane
//! (`centraid_vault::backup2`) reads a file through a path, seals it, and
//! hands the sealed parts to the core, which talks to the member's gateways.
//! The `no-listening-socket` rule holds here with nothing to find.

pub mod door;
pub mod hash;
pub mod store;

pub use door::ContentBytes;
pub use hash::{BLOB_URI_PREFIX, ContentHash, HashError};
pub use store::{Adopted, ByteStore, StoreError, Stored, Sweep, Writer};
