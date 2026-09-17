#![forbid(unsafe_code)]
//! KEYS ARE THE IDENTITY MODEL (#1029 §0). No email addresses, no phone
//! numbers: one 24-word phrase generates every key a person has, and a vault's
//! identity public key **is** its address and its `vault_id`.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`phrase`] | the BIP39 24-word phrase and the 64-byte [`phrase::Seed`] it derives |
//! | [`derive`] | SLIP-0010 hardened derivation: the account key, and each vault's identity, box and root keys |
//! | [`certificate`] | "identity key K certifies device D at epoch E", and the verifier that refuses a superseded one |
//!
//! ## WHY THREE HASH FAMILIES LIVE IN THIS CRATE AND NOWHERE ELSE (W0.5-R1)
//!
//! `blake3` is this repository's ONE HASH (D-1025-S4-2/-3), and it stays that
//! way for everything this repository defines itself. What this crate adds is
//! hashes it does not get to choose: BIP39's seed is PBKDF2-HMAC-SHA512,
//! SLIP-0010's child derivation is HMAC-SHA512, and RFC 9180's ciphersuite is
//! HKDF-SHA256. Respelling any of them in BLAKE3 produces a phrase no other
//! implementation reads, a tree no other implementation reproduces, and a
//! ciphertext no RFC 9180 peer opens. They are somebody else's protocol, the
//! same carve-out `crates/xtask` already holds for Subresource Integrity and
//! the Actions cache key.
//!
//! **Do not spend this carve-out on anything else.** A digest inside this crate
//! that is not pinned by a published specification is `blake3`.

pub mod certificate;
pub mod derive;
pub mod phrase;

pub use certificate::{
    CERTIFICATE_CONTEXT, CertificateError, DeviceCertificate, DeviceKey, DeviceTrust, Epoch,
};
pub use derive::{
    AccountKey, BoxKey, DeriveError, VaultIdentityKey, VaultKeys, VaultMint, VaultRootKey,
};
pub use phrase::{PhraseError, RecoveryPhrase, Seed};
