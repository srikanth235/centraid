//! Sealed values: one layer, the Locker key `K`'s `lk1:` cell (#1020,
//! D-1020-R2; #1047, R-1047-D1, R-1047-D2).
//!
//! | Layer | Module | Wire form | AAD |
//! |---|---|---|---|
//! | The Locker key `K` | [`locker_key`] | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` |
//!
//! **No key material lives in this crate.** Every seal and unseal takes its key
//! by value. The Locker key `K` is the 24 words' own leaf, derived by the core
//! at open and held in its memory (#1047, D-6); the vault stores only the
//! generation's id. #1020's multi-seat file custody — the `keystore` key-file
//! envelopes, the `member_key` custody and its `mk1:` transfer envelope, the
//! recovery kit's adopt and rotation across seats — is deleted (#1047 slice
//! D1): the phone is the only seat and it derives `K`. The vault DEK's
//! `sealed:v1:` cell layer and its fingerprint stamp are deleted too (#1047
//! slice D2, R-1047-D2): the only columns it sealed were the connector
//! credentials rung five dropped, so no production path wrote or read one.
//!
//! See `crates/vault/src/custody/README.md` for the whole picture.

pub mod locker_key;

pub use locker_key::{
    LOCKER_CIPHERTEXT_PREFIX, LOCKER_KEY_BYTES, LockerKeyError, LockerKeyErrorCode, SealedItemCell,
    decrypt_under_locker_key, encrypt_under_locker_key, is_locker_ciphertext, live_locker_key_id,
    locker_aad,
};

/// Fresh bytes from the OS CSPRNG.
///
/// One helper, so there is exactly one place to look when asking "where does
/// a nonce come from". Every nonce in this module is random
/// per value, as every nonce of `centraid-sealed/2` is (#1080).
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    use rand::RngCore as _;
    let mut bytes = [0_u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}
