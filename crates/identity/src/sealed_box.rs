//! HPKE base mode to a box key — the primitive sealed mail and share invites
//! are built from (#1029 §0; Reference B, "Keys and crypto").
//!
//! Base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM: RFC 9180's
//! `mode_base`, `kem_id = 0x0020`, `kdf_id = 0x0001`, `aead_id = 0x0001`. The
//! sender is anonymous by construction — there is no sender key in base mode,
//! so a sealed object carries no evidence of who sealed it beyond what the
//! plaintext says.
//!
//! ## THE AAD CARRIES KIND AND ROLE, AND THAT IS WHAT MAKES A HEADER
//! NON-TRANSPLANTABLE
//!
//! Without them, a header sealed for one object opens against another object of
//! the same shape: the ciphertext is bytes, and AES-GCM only refuses what its
//! associated data disagrees about. [`AssociatedData`] is bound into the AEAD,
//! so a "photo/thumbnail" wrap will not open as "photo/original" and a
//! "note/body" wrap will not open as "photo/body". The encoding is
//! length-prefixed, so `kind = "ab", role = "c"` and `kind = "a", role = "bc"`
//! are different associated data rather than one concatenation.
//!
//! ## WHERE THE VECTORS COME FROM
//!
//! `tests/rfc9180.rs` opens RFC 9180 Appendix A.1's own ciphertexts with A.1's
//! own recipient key. A vector we generated proves only that we agree with
//! ourselves; the RFC's bytes prove the key schedule, the KEM and the AEAD are
//! the ones a non-Centraid peer implements.

use hpke::aead::AesGcm128;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable as _, OpModeR, OpModeS, Serializable as _, single_shot_seal};

use crate::derive::BoxKey;

/// RFC 9180's `info`, fixed for this product.
///
/// It is bound into the key schedule, so a Centraid sealed box and a
/// same-ciphersuite ciphertext from another protocol never derive one key even
/// with the same recipient and the same encapsulated key.
pub const SEALED_BOX_INFO: &[u8] = b"centraid-sealed-box-v1";

/// DHKEM(X25519, HKDF-SHA256) encapsulated keys are 32 bytes (RFC 9180 §7.1,
/// `Nenc`).
pub const ENCAPPED_KEY_BYTES: usize = 32;

type Kem = X25519HkdfSha256;

/// What kind of object this wrap belongs to, and what part of it the key opens.
///
/// Both halves are bound into the AEAD. See the module header for why kind
/// alone is not enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssociatedData<'a> {
    /// The object's kind, as the ontology names it — `note`, `photo`, `share`.
    pub kind: &'a str,
    /// What this key opens within the object — `body`, `original`,
    /// `thumbnail`.
    pub role: &'a str,
}

impl AssociatedData<'_> {
    /// The canonical bytes handed to AES-GCM.
    ///
    /// Length-prefixed rather than delimited: a delimiter can appear in a kind
    /// or a role, and a length cannot.
    fn encode(&self) -> Vec<u8> {
        let kind = self.kind.as_bytes();
        let role = self.role.as_bytes();
        let mut out = Vec::with_capacity(8 + kind.len() + role.len());
        out.extend_from_slice(&u32::try_from(kind.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(&u32::try_from(role.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(role);
        out
    }
}

/// What sealing and opening refuse.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SealError {
    /// The recipient's published box key is not a well-formed X25519 point.
    #[error("the recipient box key is not a valid X25519 public key")]
    RecipientKey,
    /// Encapsulation or encryption failed.
    #[error("sealing failed")]
    Seal,
    /// Decapsulation, or the AEAD tag. **Deliberately one variant**: telling a
    /// caller whether the key or the tag was wrong tells an attacker which half
    /// of their guess to keep.
    #[error("this sealed box does not open with this key and associated data")]
    Open,
    /// The wire bytes are not a sealed box.
    #[error("not a sealed box: {reason}")]
    Malformed {
        /// What was wrong with the bytes.
        reason: &'static str,
    },
}

/// One HPKE base-mode message: the encapsulated key, and the ciphertext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedBox {
    encapped_key: [u8; ENCAPPED_KEY_BYTES],
    ciphertext: Vec<u8>,
}

impl SealedBox {
    /// Seal to a published box key.
    ///
    /// The ephemeral encapsulation key is drawn once per call from the
    /// operating system, inside `hpke`. It is never reused, which is what makes
    /// two seals of the same plaintext to the same recipient different
    /// ciphertexts.
    pub fn seal(
        recipient: &x25519_dalek::PublicKey,
        aad: &AssociatedData<'_>,
        plaintext: &[u8],
    ) -> Result<Self, SealError> {
        let public = <Kem as hpke::Kem>::PublicKey::from_bytes(recipient.as_bytes())
            .map_err(|_| SealError::RecipientKey)?;
        let (encapped, ciphertext) = single_shot_seal::<AesGcm128, HkdfSha256, Kem>(
            &OpModeS::Base,
            &public,
            SEALED_BOX_INFO,
            plaintext,
            &aad.encode(),
        )
        .map_err(|_| SealError::Seal)?;

        let mut encapped_key = [0u8; ENCAPPED_KEY_BYTES];
        encapped_key.copy_from_slice(&encapped.to_bytes());
        Ok(Self {
            encapped_key,
            ciphertext,
        })
    }

    /// Open with the vault's own box key.
    pub fn open(&self, box_key: &BoxKey, aad: &AssociatedData<'_>) -> Result<Vec<u8>, SealError> {
        let private = <Kem as hpke::Kem>::PrivateKey::from_bytes(&box_key.secret().to_bytes())
            .map_err(|_| SealError::Open)?;
        let encapped = <Kem as hpke::Kem>::EncappedKey::from_bytes(&self.encapped_key)
            .map_err(|_| SealError::Open)?;
        hpke::single_shot_open::<AesGcm128, HkdfSha256, Kem>(
            &OpModeR::Base,
            &private,
            &encapped,
            SEALED_BOX_INFO,
            &self.ciphertext,
            &aad.encode(),
        )
        .map_err(|_| SealError::Open)
    }

    /// `enc ‖ ct`, which is RFC 9180's own on-the-wire order.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ENCAPPED_KEY_BYTES + self.ciphertext.len());
        out.extend_from_slice(&self.encapped_key);
        out.extend_from_slice(&self.ciphertext);
        out
    }

    /// Read `enc ‖ ct` back. The AEAD tag is inside `ct`, so anything shorter
    /// than an encapsulated key plus a tag cannot be a sealed box.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, SealError> {
        /// AES-128-GCM's tag is 16 bytes (RFC 9180 §7.3, `Nt`).
        const TAG_BYTES: usize = 16;

        if bytes.len() < ENCAPPED_KEY_BYTES + TAG_BYTES {
            return Err(SealError::Malformed {
                reason: "shorter than an encapsulated key plus an AEAD tag",
            });
        }
        let mut encapped_key = [0u8; ENCAPPED_KEY_BYTES];
        encapped_key.copy_from_slice(&bytes[..ENCAPPED_KEY_BYTES]);
        Ok(Self {
            encapped_key,
            ciphertext: bytes[ENCAPPED_KEY_BYTES..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::VaultMint;
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    const BODY: AssociatedData<'static> = AssociatedData {
        kind: "note",
        role: "body",
    };

    fn box_key() -> BoxKey {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        VaultMint::fresh()
            .mint(&seed, 0)
            .expect("vault 0")
            .box_key
            .clone()
    }

    #[test]
    fn a_sealed_box_opens_with_the_vaults_box_key() {
        let key = box_key();
        let sealed = SealedBox::seal(&key.public(), &BODY, b"the plaintext").expect("seal");
        assert_eq!(sealed.open(&key, &BODY).expect("open"), b"the plaintext");
    }

    #[test]
    fn a_tampered_aad_does_not_open() {
        let key = box_key();
        let sealed = SealedBox::seal(&key.public(), &BODY, b"the plaintext").expect("seal");

        for wrong in [
            AssociatedData {
                kind: "photo",
                role: "body",
            },
            AssociatedData {
                kind: "note",
                role: "title",
            },
        ] {
            assert_eq!(sealed.open(&key, &wrong), Err(SealError::Open));
        }
    }

    /// The length prefixes are what stop `kind ‖ role` collapsing into one
    /// string that two different splits both produce.
    #[test]
    fn kind_and_role_cannot_be_reshuffled_across_the_boundary() {
        let key = box_key();
        let sealed = SealedBox::seal(
            &key.public(),
            &AssociatedData {
                kind: "ab",
                role: "c",
            },
            b"x",
        )
        .expect("seal");
        assert_eq!(
            sealed.open(
                &key,
                &AssociatedData {
                    kind: "a",
                    role: "bc"
                }
            ),
            Err(SealError::Open)
        );
    }

    #[test]
    fn another_vaults_box_key_does_not_open_it() {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let mut mint = VaultMint::fresh();
        let mine = mint.mint(&seed, 0).expect("vault 0").box_key.clone();
        let theirs = mint.mint(&seed, 1).expect("vault 1").box_key.clone();

        let sealed = SealedBox::seal(&mine.public(), &BODY, b"the plaintext").expect("seal");
        assert_eq!(sealed.open(&theirs, &BODY), Err(SealError::Open));
    }

    #[test]
    fn two_seals_of_one_plaintext_differ() {
        let key = box_key();
        let first = SealedBox::seal(&key.public(), &BODY, b"same").expect("seal");
        let second = SealedBox::seal(&key.public(), &BODY, b"same").expect("seal");
        assert_ne!(first.to_bytes(), second.to_bytes());
    }

    #[test]
    fn the_wire_form_round_trips_and_a_flipped_bit_does_not_open() {
        let key = box_key();
        let sealed = SealedBox::seal(&key.public(), &BODY, b"the plaintext").expect("seal");
        let mut wire = sealed.to_bytes();
        assert_eq!(SealedBox::from_bytes(&wire).expect("round trip"), sealed);

        let last = wire.len() - 1;
        wire[last] ^= 1;
        let tampered = SealedBox::from_bytes(&wire).expect("still well formed");
        assert_eq!(tampered.open(&key, &BODY), Err(SealError::Open));
    }

    #[test]
    fn a_truncated_wire_form_is_refused_before_any_crypto() {
        assert!(matches!(
            SealedBox::from_bytes(&[0u8; 40]),
            Err(SealError::Malformed { .. })
        ));
    }
}
