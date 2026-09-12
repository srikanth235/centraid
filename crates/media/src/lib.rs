//! The byte plane: content-addressed sealed frames and the format-normative
//! crypto the backup and snapshot artefacts are built from (#1020, D-1020-R1).
//!
//! Nothing here decides anything. It moves bytes, and it moves them in exactly
//! the shapes `contracts/golden/format-golden.json` pins: CBSF v2 sealed
//! objects, canonical snapshot JSON, HKDF derivations, AES-GCM seals and
//! hashes. Every constant and every info/AAD string in these two modules is a
//! **format** decision — editing one silently re-keys every vault that ever
//! wrote a byte, which is why they were moved rather than rewritten.

pub mod cbsf;
pub mod format;
