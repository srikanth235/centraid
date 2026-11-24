#![forbid(unsafe_code)]
//! The byte plane: `centraid-sealed/4` and the arithmetic the Photos app reads.
//!
//! Nothing here decides anything. It moves bytes.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`sealed`] | **`centraid-sealed/4`** — the one format every backed-up byte wears: one deterministic, Padmé-padded object per chunk, named and keyed from the vault's root key ([#1209](https://github.com/srikanth235/centraid/issues/1209), [#1212](https://github.com/srikanth235/centraid/issues/1212)) |
//! | [`format`] | the BLAKE3 content hash and the canonical JSON spelling |
//! | [`models`] | the media model lock's verify-then-fetch |
//! | [`renditions`] | JPEG derivatives |
//!
//! ## ONE FORMAT
//!
//! [`sealed`] is the only sealing in this crate. The formats before it — the
//! v0 frame format ([#1020](https://github.com/srikanth235/centraid/issues/1020))
//! and `centraid-object/1` ([#1029](https://github.com/srikanth235/centraid/issues/1029))
//! — left with the planes that wrote them; no member holds an artefact in
//! either, so nothing has to keep opening one. `centraid-sealed/4`'s vectors
//! live in `contracts/crypto/sealed4-vectors.json`.

pub mod format;
pub mod models;
pub mod renditions;
pub mod sealed;
