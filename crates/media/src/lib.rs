//! The byte plane: content-addressed sealed frames and the format-normative
//! crypto the backup and snapshot artefacts are built from (#1020, D-1020-R1).
//!
//! Nothing here decides anything. It moves bytes, and it moves them in exactly
//! the shapes `contracts/golden/format-golden.json` pins: CBSF v2 sealed
//! objects, canonical snapshot JSON, HKDF derivations, AES-GCM seals and
//! hashes. Every constant and every info/AAD string in these two modules is a
//! **format** decision — editing one silently re-keys every vault that ever
//! wrote a byte, which is why they were moved rather than rewritten.

//! Wave 4 added three modules that are not crypto and are not format: the
//! perceptual-hash comparison, the near-duplicate clustering the Photos app
//! reads, and the model lock's verify-then-fetch. They are here because they
//! are the byte plane's own arithmetic — the app crate that reads the result
//! holds no loop over the library and no filesystem — and `crates/media` had
//! no wave-4 owner of its own, so the Photos lane landed them (#1020,
//! D-1020-P3).

pub mod cbsf;
pub mod duplicates;
pub mod format;
pub mod models;
pub mod phash;
