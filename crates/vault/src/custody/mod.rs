//! Key custody: three layers, three AADs, kept distinct (#1020, D-1020-R2).
//!
//! | Layer | Module | Wire form | AAD |
//! |---|---|---|---|
//! | Named secrets on disk | [`keystore`] | `CENTRAID-KEY-V1\n{envelope}\n` | — (the envelope's own) |
//! | The vault DEK (seal key) | [`seal`] | `sealed:v1:base64(nonce ‖ ct ‖ tag)` | `<physical>.<column>:<rowId>` |
//! | The Locker key `K` | [`locker_key`] | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` |
//!
//! They look similar and they are not interchangeable. Each AAD names what a
//! ciphertext is *allowed to be*, and the three name different things: a cell,
//! or a row under a particular key generation. Collapsing them into one
//! "encrypt a string" helper is how a ciphertext becomes movable between rows.
//!
//! ## Where this is going (wave 4)
//!
//! Today the gateway **holds** `K` (see [`locker_key`]), which is v0's posture.
//! The R-1020 trust premise moves `K` to a member key the gateway never holds,
//! and that is the wave 4 Locker lane's work. What wave 2 lands is the shape
//! that makes it possible: every seal/unseal API takes the key **by value**, so
//! there is no ambient key for a future code path to reach for, and the only
//! gateway paths that call unseal are the ones that deliberately reveal. The
//! acceptance test [`locker_key::tests`] proves a cell depends on `K` and on
//! nothing else that is on disk.
//!
//! See `crates/vault/src/custody/README.md` for the whole picture.

pub mod keystore;
pub mod locker_key;
pub mod member_key;
pub mod seal;

pub use keystore::{
    AES_GCM_SCHEME, AesGcmKeyProtector, FILE_SCHEME, KEY_STORE_ENVELOPE_MAGIC,
    KEY_STORE_SECRET_BYTES, KeyProtector, KeyStore, KeyStoreError, KeyStoreErrorCode,
};
pub use locker_key::{
    LOCKER_CIPHERTEXT_PREFIX, LOCKER_KEY_BYTES, LockerKeyError, LockerKeyErrorCode, LockerKeyRow,
    LockerRotation, decrypt_under_locker_key, encrypt_under_locker_key, found_locker_key,
    is_locker_ciphertext, live_locker_key_id, locker_aad, locker_key_file_name, locker_key_rows,
    rotate_locker_key, sweep_retired_locker_keys,
};
pub use member_key::{
    MEMBER_KEY_ENVELOPE_PREFIX, MemberKeyCustody, MemberKeyEnvelope, MemberKeyError,
    MemberKeyFounded, adopt_from_kit, envelope_aad, found_member_key, fresh_transfer_secret,
    is_member_key_envelope, member_key_dir_on_seat, open_member_key, seal_member_key,
};
pub use seal::{
    SEALED_PLACEHOLDER, SEALED_PREFIX, SealError, is_sealed_value, open_value,
    read_seal_key_fingerprint, seal_aad, seal_key_fingerprint, seal_value,
    stamp_seal_key_fingerprint,
};

/// Fresh bytes from the OS CSPRNG.
///
/// One helper, used by all three layers, so there is exactly one place to look
/// when asking "where does a nonce come from". Every nonce in this module is
/// random per value except CBSF's and the backup plane's, which are
/// deliberately **derived** — see `crates/media` and [`crate::backup`].
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    use rand::RngCore as _;
    let mut bytes = [0_u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}
