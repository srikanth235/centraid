#![forbid(unsafe_code)]
//! KEYS ARE THE IDENTITY MODEL (#1029 §0). No email addresses, no phone
//! numbers: one 24-word phrase generates every key a person has, and a vault's
//! identity public key **is** its address and its `vault_id`.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`phrase`] | the BIP39 24-word phrase and the 64-byte [`phrase::Seed`] it derives |
//! | [`derive`] | SLIP-0010 hardened derivation: each vault's identity, box and root keys |
//! | [`safety_number`] | the digits two people read to each other to confirm they hold each other's real key |
//! | [`sealed_box`] | HPKE base mode to a box key — the primitive sealed mail and share invites are built from |
//!
//! The network half that stood beside these — device certificates, the signed
//! pkarr record, discovery against a DNS server and the pair ticket — left with
//! the iroh plane ([#1080](https://github.com/srikanth235/centraid/issues/1080)):
//! a phone pairs with its gateway from a QR naming addresses and a certificate
//! pin, and a gateway's writer epoch is the gateway's to keep
//! (`crates/gateway`).
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

pub mod derive;
pub mod phrase;
pub mod safety_number;
pub mod sealed_box;

pub use derive::{
    BoxKey, DeriveError, LockerKey, VaultIdentityKey, VaultKeys, VaultMint, VaultRootKey,
};
pub use phrase::{PhraseError, RecoveryPhrase, Seed};
pub use safety_number::{
    SAFETY_NUMBER_DIGITS, SAFETY_NUMBER_GROUP, SafetyNumber, safety_number, safety_number_of_bytes,
};
pub use sealed_box::{AssociatedData, SealError, SealedBox};
