#![forbid(unsafe_code)]
//! The byte plane: `centraid-object/1` and the arithmetic the Photos app reads.
//!
//! Nothing here decides anything. It moves bytes.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`object`] | **`centraid-object/1`** — the one format every object wears (#1029 §4) |
//! | [`format`] | canonical JSON, BLAKE3 derivation, and the v0-derived seals `crates/vault/src/backup` has not been moved off yet |
//! | [`models`] | the media model lock's verify-then-fetch |
//! | [`renditions`] | JPEG derivatives |
//! | [`phash`] · [`duplicates`] | the perceptual hash and the near-duplicate clustering |
//!
//! ## WHAT THE OLD FRAME FORMAT WAS, AND WHY IT WAS REPLACED RATHER THAN REPAIRED
//!
//! The sealed-frame module deleted here held a format moved byte-for-byte out
//! of v0 (#1020, D-1020-R1). It was wrong at the byte level in two ways no
//! parameter change reaches:
//!
//! 1. **Its header carried the BLAKE3 of the plaintext, in the clear**, on every
//!    object. That is a confirmable commitment to the content printed on the
//!    outside of the envelope.
//! 2. **One key was both the nonce MAC key and the AES-GCM key**, and the nonce
//!    was a keyed MAC over the object's *address*. That is safe only if one
//!    address always maps to one set of bytes, and it did not — so the old stack
//!    had nonce reuse under a single key (Reference A, B9).
//!
//! [`object`] fixes both by construction: the name is the hash of the
//! **ciphertext**, and every nonce is 24 random bytes from the operating system.
//! Its golden vectors went with the code — D-1020-R1 was dropped pre-release,
//! so there is no artefact any member holds that has to keep opening. [`object`]'s own vectors live in `contracts/crypto/object-vectors.json`
//! and are regression vectors, not a released format.
//!
//! ## WHAT IS STILL HERE AND SHOULD NOT BE
//!
//! [`format`]'s `seal_wal_segment` and `seal_snapshot_manifest` are the other
//! two seals `centraid-object/1` replaces. They still stand because their only
//! callers are `crates/vault/src/backup/{wal,manifest}.rs`, which W3's capture
//! lane owns and is rewriting onto [`object`]; deleting them here would be an
//! edit to that lane's files. Their module header says so at the call site.

pub mod duplicates;
pub mod format;
pub mod models;
pub mod object;
pub mod phash;
pub mod renditions;
