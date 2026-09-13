//! Key custody: three layers, three AADs, kept distinct (#1020, D-1020-R2).
//!
//! | Layer | Module | Wire form | AAD |
//! |---|---|---|---|
//! | Named secrets on disk | [`keystore`] | `CENTRAID-KEY-V1\n{envelope}\n` | — (the envelope's own) |
//! | The vault DEK (seal key) | [`seal`] | `sealed:v1:base64(nonce ‖ ct ‖ tag)` | `<physical>.<column>:<rowId>` |
//! | The Locker key `K` | [`locker_key`] format, [`member_key`] custody | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` |
//! | `K` in transit to a seat | [`member_key`] | `mk1:base64(nonce ‖ ct ‖ tag)` | `<vaultId>‖<keyId>‖<deviceId>` |
//!
//! They look similar and they are not interchangeable. Each AAD names what a
//! ciphertext is *allowed to be*, and the three name different things: a cell,
//! or a row under a particular key generation. Collapsing them into one
//! "encrypt a string" helper is how a ciphertext becomes movable between rows.
//!
//! ## The member key, and where it is not (wave 4, D-1020-L1, D-1020-L2)
//!
//! The gateway **held** `K` in v0. It does not now: [`member_key`] mints it on
//! the seat that founds the vault, relays it to a second seat in an envelope
//! the gateway cannot open, and adopts it from the recovery kit — and
//! [`member_key::MemberKeyCustody`] is the only type that opens a key file,
//! constructed from a **seat's** directory. There is no gateway constructor,
//! and the host-side path helper that used to hand one out is deleted.
//!
//! [`locker_key`] keeps the **format**: the `lk1:` wire form, the AAD, the
//! `locker_key` table of ids, and the rotation order. What wave 2 landed and
//! this wave relies on is that every seal/unseal function takes the key **by
//! value**, so there is no ambient key for a future read path to reach for.
//!
//! `crates/vault/tests/member_key_gate.rs` is the acceptance test: a gateway
//! with the door deleted produces no plaintext for any `lk1:` cell, asserted
//! behaviourally over every door, structurally over this crate's source, and
//! over the built binary's symbols.
//!
//! See `crates/vault/src/custody/README.md` for the whole picture.

pub mod keystore;
pub mod locker_key;
pub mod member_key;
/// The rotation scenario's own reads and writes — see the module header for
/// why `crates/sim` cannot hold them.
pub mod rotation_scenario;
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
