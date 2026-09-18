#![forbid(unsafe_code)]
//! KEYS ARE THE IDENTITY MODEL (#1029 §0). No email addresses, no phone
//! numbers: one 24-word phrase generates every key a person has, and a vault's
//! identity public key **is** its address and its `vault_id`.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`phrase`] | the BIP39 24-word phrase and the 64-byte [`phrase::Seed`] it derives |
//! | [`derive`] | SLIP-0010 hardened derivation: the account key, and each vault's identity, box and root keys |
//! | [`safety_number`] | the digits two people read to each other to confirm they hold each other's real key |
//! | [`sealed_box`] | HPKE base mode to a box key — the primitive sealed mail and share invites are built from |
//! | [`certificate`] | "identity key K certifies device D at epoch E", and the verifier that refuses a superseded one |
//! | [`discovery`] | publish and resolve against a configurable `iroh-dns-server`, and the typed-URL fallback |
//! | [`account`] | "vault V belongs to account A", and the signed listing a fresh phone restores from |
//! | [`record`] | the signed pkarr record that makes a key findable: `mailbox=` and `cert=` under the identity key, `gateway=` under the account key |
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

//! ## THE WASM-CLEAN HALF, AND WHAT IS BEHIND A FEATURE (#1029 §3, W4C-1)
//!
//! A Cloudflare Worker must verify a [`certificate::DeviceCertificate`] and
//! must not carry a DNS client. [`discovery`] and [`record`] are therefore
//! behind the **`discovery`** feature, which is what `pkarr`, `url` and
//! `base64` hang off; the two `generate` constructors that draw operating-system
//! entropy are behind **`mint`**. Both are default-on, so nothing in this
//! workspace changes; `--no-default-features` is the half that compiles to
//! `wasm32-unknown-unknown`. `Cargo.toml` carries why this is a feature rather
//! than a second crate.

pub mod account;
pub mod certificate;
pub mod derive;
#[cfg(feature = "discovery")]
pub mod discovery;
pub mod phrase;
#[cfg(feature = "discovery")]
pub mod record;
pub mod safety_number;
pub mod sealed_box;

pub use account::{
    AccountError, VAULT_CLAIM_BYTES, VAULT_CLAIM_CONTEXT, VAULT_LISTING_CONTEXT, VaultClaim,
    VaultListing,
};
pub use certificate::{
    CERTIFICATE_CONTEXT, CertificateError, DeviceCertificate, DeviceKey, DeviceTrust, Epoch,
};
pub use derive::{
    AccountKey, BoxKey, DeriveError, VaultIdentityKey, VaultKeys, VaultMint, VaultRootKey,
};
#[cfg(feature = "discovery")]
pub use discovery::{
    DEFAULT_DNS_SERVER, Discovery, DiscoveryError, Located, ResolutionSource, SourceUsed,
};
pub use phrase::{PhraseError, RecoveryPhrase, Seed};
#[cfg(feature = "discovery")]
pub use record::{
    AccountRecord, CERT_ENTRY, GATEWAY_ENTRY, GatewayUrl, IdentityRecord, MAILBOX_ENTRY,
    RECORD_NAME, RECORD_TTL_SECONDS, RecordError,
};
pub use safety_number::{SAFETY_NUMBER_DIGITS, SAFETY_NUMBER_GROUP, SafetyNumber, safety_number};
pub use sealed_box::{AssociatedData, SealError, SealedBox};
