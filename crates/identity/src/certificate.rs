//! "Identity key K certifies device D at epoch E" (#1029 §0, F3).
//!
//! A device key is the current phone's transport identity: it signs gateway
//! requests, and nothing dials it. It is **random and minted per phone**, never
//! derived from the seed, because it is `ThisDeviceOnly` — a restored phone has
//! the seed and therefore every vault key, and must still have a *different*
//! device key, or "which phone holds this vault now" would have no answer.
//!
//! ## THE EPOCH IS THE LEASE'S OWN COUNTER, NEVER A BACKUP GENERATION
//!
//! Supersession needs an order. Backup generation ids are 128 random bits and
//! have none (#1029 F3), so ordering certificates by generation would leave a
//! gateway unable to tell a restored phone from the phone it replaced. The
//! epoch is a monotonic `u64` the lease owns. A restore reissues at `epoch + 1`.
//!
//! ## SUPERSESSION IS A REFUSAL, NOT A PREFERENCE
//!
//! [`DeviceTrust`] holds the highest epoch it has seen and refuses an equal or
//! lower one. Equal, not just lower: two certificates at one epoch name two
//! devices with the same claim, and the second is either a replay or a bug, and
//! is a refusal either way.
//!
//! The seed is on both phones, so this is cooperation and not enforcement
//! (#1029 F1). What this module guarantees is that a *verifier* which has seen
//! the new certificate will not go back; it cannot stop the old phone from
//! signing.

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};

/// Domain separation for the signed bytes. A signature over this product's
/// device certificate must not verify as a signature over anything else the
/// identity key ever signs.
pub const CERTIFICATE_CONTEXT: &[u8] = b"centraid-device-certificate-v1";

/// Ed25519 public keys and signatures are fixed width, so a certificate is
/// `identity(32) ‖ device(32) ‖ epoch(8) ‖ signature(64)`.
pub const DEVICE_CERTIFICATE_BYTES: usize = 32 + 32 + 8 + 64;

/// The lease's monotonic counter. See the module header for why it is not a
/// backup generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Epoch(u64);

impl Epoch {
    /// The epoch a vault's first device certificate is issued at.
    pub const FIRST: Self = Self(0);

    /// Adopt an epoch read back from the lease or from a resolved record.
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// The raw counter.
    pub const fn get(self) -> u64 {
        self.0
    }

    /// The epoch a restore reissues at.
    ///
    /// Saturating: at `u64::MAX` the honest answer is "this cannot supersede
    /// anything" and [`DeviceTrust::accept`] refuses the equal epoch, which is
    /// a visible failure. Wrapping would silently reset the order to zero and
    /// hand a superseded phone the vault back.
    pub const fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// This phone's transport identity.
#[derive(Clone)]
pub struct DeviceKey(SigningKey);

impl DeviceKey {
    /// A fresh device key from operating-system entropy. Minted once per phone,
    /// and again on every restore.
    ///
    /// Behind the `mint` feature: a Worker verifies a certificate it was handed
    /// and never mints the device key inside one (#1029 §3, W4C-1).
    pub fn generate() -> Result<Self, CertificateError> {
        use rand::TryRngCore as _;

        let mut bytes = [0u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut bytes)
            .map_err(|error| CertificateError::NoEntropy {
                reason: error.to_string(),
            })?;
        Ok(Self(SigningKey::from_bytes(&bytes)))
    }

    /// The public half, which the certificate names.
    pub fn public(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    /// The signing key, for gateway requests.
    pub const fn signing(&self) -> &SigningKey {
        &self.0
    }
}

impl core::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("DeviceKey(<redacted>)")
    }
}

/// What certificate handling refuses.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CertificateError {
    /// The certificate names an identity key other than the one the verifier
    /// trusts. Checked before the signature, because a certificate for another
    /// vault is not a forgery, it is the wrong vault.
    #[error("this certificate is for another vault's identity key")]
    WrongIdentity,
    /// The signature does not verify under the identity key the certificate
    /// names.
    #[error("this certificate is not signed by the identity key it names")]
    BadSignature,
    /// A certificate at or below the highest epoch this verifier has seen. This
    /// is the old phone after a restore: the gateway answers `VAULT_MOVED`.
    #[error("epoch {offered} is superseded: this verifier has seen epoch {seen}")]
    Superseded {
        /// The epoch the certificate carries.
        offered: u64,
        /// The highest epoch this verifier has accepted.
        seen: u64,
    },
    /// The bytes are not a certificate.
    #[error("not a device certificate: {reason}")]
    Malformed {
        /// What was wrong with the bytes.
        reason: &'static str,
    },
    /// The operating system would not give us entropy for a device key.
    #[error("the operating system refused entropy for a device key: {reason}")]
    NoEntropy {
        /// The OS error, rendered.
        reason: String,
    },
}

/// "Identity key `identity` certifies device `device` at epoch `epoch`",
/// signed by `identity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceCertificate {
    identity: VerifyingKey,
    device: VerifyingKey,
    epoch: Epoch,
    signature: Signature,
}

impl DeviceCertificate {
    /// Issue one. The vault's identity key is the only signer there is.
    pub fn issue(
        identity: &crate::derive::VaultIdentityKey,
        device: &VerifyingKey,
        epoch: Epoch,
    ) -> Self {
        let signing = identity.signing();
        let public = signing.verifying_key();
        let signature = signing.sign(&signed_bytes(&public, device, epoch));
        Self {
            identity: public,
            device: *device,
            epoch,
            signature,
        }
    }

    /// The identity key this certificate is signed by, which is also the vault
    /// id and the address.
    pub const fn identity(&self) -> &VerifyingKey {
        &self.identity
    }

    /// The device key this certificate vouches for.
    pub const fn device(&self) -> &VerifyingKey {
        &self.device
    }

    /// The epoch.
    pub const fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Check the signature against the identity key the certificate names.
    ///
    /// This is **not** enough on its own: it says the certificate is genuine,
    /// not that it is current. [`DeviceTrust::accept`] is what adds the order.
    pub fn verify(&self) -> Result<(), CertificateError> {
        self.identity
            .verify(
                &signed_bytes(&self.identity, &self.device, self.epoch),
                &self.signature,
            )
            .map_err(|_| CertificateError::BadSignature)
    }

    /// `identity ‖ device ‖ epoch ‖ signature`, for the pkarr record's `cert=`
    /// entry.
    pub fn to_bytes(&self) -> [u8; DEVICE_CERTIFICATE_BYTES] {
        let mut out = [0u8; DEVICE_CERTIFICATE_BYTES];
        out[..32].copy_from_slice(self.identity.as_bytes());
        out[32..64].copy_from_slice(self.device.as_bytes());
        out[64..72].copy_from_slice(&self.epoch.get().to_be_bytes());
        out[72..].copy_from_slice(&self.signature.to_bytes());
        out
    }

    /// Read one back. The signature is **not** checked here: a caller that
    /// decodes must still [`Self::verify`] or hand it to a [`DeviceTrust`],
    /// which does.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CertificateError> {
        if bytes.len() != DEVICE_CERTIFICATE_BYTES {
            return Err(CertificateError::Malformed {
                reason: "wrong length for a device certificate",
            });
        }
        let key = |range: core::ops::Range<usize>| {
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&bytes[range]);
            VerifyingKey::from_bytes(&raw).map_err(|_| CertificateError::Malformed {
                reason: "not a valid Ed25519 public key",
            })
        };
        let mut epoch = [0u8; 8];
        epoch.copy_from_slice(&bytes[64..72]);
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[72..]);

        Ok(Self {
            identity: key(0..32)?,
            device: key(32..64)?,
            epoch: Epoch::new(u64::from_be_bytes(epoch)),
            signature: Signature::from_bytes(&signature),
        })
    }
}

/// What a gateway or a contact remembers about one vault: the identity key it
/// resolved, and the highest epoch it has accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceTrust {
    identity: VerifyingKey,
    current: Option<DeviceCertificate>,
}

impl DeviceTrust {
    /// Begin trusting a vault by its identity key, with no certificate seen
    /// yet.
    pub const fn new(identity: VerifyingKey) -> Self {
        Self {
            identity,
            current: None,
        }
    }

    /// The certificate this verifier currently believes, if it has seen one.
    pub const fn current(&self) -> Option<&DeviceCertificate> {
        self.current.as_ref()
    }

    /// The device key this verifier trusts right now.
    pub fn trusted_device(&self) -> Option<&VerifyingKey> {
        self.current.as_ref().map(DeviceCertificate::device)
    }

    /// Offer a certificate.
    ///
    /// Accepted only if it names this vault's identity key, verifies under it,
    /// and carries an epoch strictly above every epoch already accepted. A
    /// refusal leaves the verifier exactly as it was — this is the property
    /// that makes `VAULT_MOVED` safe to answer: a superseded certificate can
    /// never walk the trust backwards.
    pub fn accept(&mut self, certificate: &DeviceCertificate) -> Result<(), CertificateError> {
        if certificate.identity != self.identity {
            return Err(CertificateError::WrongIdentity);
        }
        certificate.verify()?;
        if let Some(current) = &self.current
            && certificate.epoch <= current.epoch
        {
            return Err(CertificateError::Superseded {
                offered: certificate.epoch.get(),
                seen: current.epoch.get(),
            });
        }
        self.current = Some(*certificate);
        Ok(())
    }
}

/// The bytes an identity key signs. The identity key is inside them, so a
/// certificate cannot be re-attributed to a different signer by swapping the
/// key beside it.
fn signed_bytes(identity: &VerifyingKey, device: &VerifyingKey, epoch: Epoch) -> Vec<u8> {
    let mut message = Vec::with_capacity(CERTIFICATE_CONTEXT.len() + 1 + 32 + 32 + 8);
    message.extend_from_slice(CERTIFICATE_CONTEXT);
    message.push(0);
    message.extend_from_slice(identity.as_bytes());
    message.extend_from_slice(device.as_bytes());
    message.extend_from_slice(&epoch.get().to_be_bytes());
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::{VaultKeys, VaultMint};
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    fn vault(index: u32) -> VaultKeys {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        VaultMint::fresh().mint(&seed, index).expect("a vault")
    }

    #[test]
    fn a_device_key_is_random_and_not_derived_from_the_seed() {
        let first = DeviceKey::generate().expect("OS entropy");
        let second = DeviceKey::generate().expect("OS entropy");
        assert_ne!(first.public().to_bytes(), second.public().to_bytes());
        assert_ne!(
            first.public().to_bytes(),
            vault(0).identity.public().to_bytes()
        );
    }

    #[test]
    fn a_valid_certificate_is_accepted_and_names_the_device() {
        let keys = vault(0);
        let device = DeviceKey::generate().expect("OS entropy");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::FIRST);

        let mut trust = DeviceTrust::new(keys.identity.public());
        assert_eq!(trust.trusted_device(), None);
        trust.accept(&certificate).expect("accepted");
        assert_eq!(trust.trusted_device(), Some(&device.public()));
    }

    #[test]
    fn a_certificate_signed_by_another_vault_is_refused() {
        let mine = vault(0);
        let theirs = vault(1);
        let device = DeviceKey::generate().expect("OS entropy");

        let mut trust = DeviceTrust::new(mine.identity.public());
        let foreign = DeviceCertificate::issue(&theirs.identity, &device.public(), Epoch::FIRST);
        assert_eq!(trust.accept(&foreign), Err(CertificateError::WrongIdentity));
        assert_eq!(trust.trusted_device(), None);
    }

    /// The signature is over the identity key too, so relabelling a genuine
    /// certificate with the victim's key does not make it verify.
    #[test]
    fn a_relabelled_certificate_does_not_verify() {
        let mine = vault(0);
        let theirs = vault(1);
        let device = DeviceKey::generate().expect("OS entropy");

        let mut forged = DeviceCertificate::issue(&theirs.identity, &device.public(), Epoch::FIRST);
        forged.identity = mine.identity.public();

        let mut trust = DeviceTrust::new(mine.identity.public());
        assert_eq!(trust.accept(&forged), Err(CertificateError::BadSignature));
    }

    #[test]
    fn an_equal_epoch_is_refused() {
        let keys = vault(0);
        let mut trust = DeviceTrust::new(keys.identity.public());
        let first = DeviceKey::generate().expect("OS entropy");
        let second = DeviceKey::generate().expect("OS entropy");

        trust
            .accept(&DeviceCertificate::issue(
                &keys.identity,
                &first.public(),
                Epoch::new(7),
            ))
            .expect("accepted");
        assert_eq!(
            trust.accept(&DeviceCertificate::issue(
                &keys.identity,
                &second.public(),
                Epoch::new(7)
            )),
            Err(CertificateError::Superseded {
                offered: 7,
                seen: 7
            })
        );
        assert_eq!(trust.trusted_device(), Some(&first.public()));
    }

    /// THE OLD PHONE AFTER A RESTORE (#1029 §0). The restored phone reissues at
    /// `epoch + 1`; the phone that was replaced keeps signing with a
    /// certificate at the old epoch, and every verifier that has seen the new
    /// one refuses it — which is what `VAULT_MOVED` says.
    #[test]
    fn the_old_phones_certificate_is_refused_after_a_restore() {
        let keys = vault(0);
        let mut gateway = DeviceTrust::new(keys.identity.public());

        let old_phone = DeviceKey::generate().expect("OS entropy");
        let old = DeviceCertificate::issue(&keys.identity, &old_phone.public(), Epoch::new(4));
        gateway.accept(&old).expect("the old phone was current");

        let new_phone = DeviceKey::generate().expect("OS entropy");
        let reissued =
            DeviceCertificate::issue(&keys.identity, &new_phone.public(), old.epoch().next());
        gateway.accept(&reissued).expect("the restore supersedes");
        assert_eq!(gateway.trusted_device(), Some(&new_phone.public()));

        assert_eq!(
            gateway.accept(&old),
            Err(CertificateError::Superseded {
                offered: 4,
                seen: 5
            })
        );
        assert_eq!(
            gateway.trusted_device(),
            Some(&new_phone.public()),
            "a refusal must leave the trusted device exactly as it was"
        );
    }

    #[test]
    fn an_epoch_at_the_ceiling_supersedes_nothing_rather_than_wrapping() {
        assert_eq!(Epoch::new(u64::MAX).next(), Epoch::new(u64::MAX));
    }

    #[test]
    fn a_certificate_round_trips_through_its_wire_form() {
        let keys = vault(0);
        let device = DeviceKey::generate().expect("OS entropy");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(9));
        let bytes = certificate.to_bytes();
        assert_eq!(bytes.len(), DEVICE_CERTIFICATE_BYTES);

        let decoded = DeviceCertificate::from_bytes(&bytes).expect("round trip");
        assert_eq!(decoded, certificate);
        decoded.verify().expect("still genuine");
    }

    #[test]
    fn a_flipped_bit_in_the_wire_form_does_not_verify() {
        let keys = vault(0);
        let device = DeviceKey::generate().expect("OS entropy");
        let mut bytes =
            DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(9)).to_bytes();
        // The epoch's low byte: genuine keys, genuine signature, moved counter.
        bytes[71] ^= 1;
        assert_eq!(
            DeviceCertificate::from_bytes(&bytes)
                .expect("still well formed")
                .verify(),
            Err(CertificateError::BadSignature)
        );
    }

    #[test]
    fn a_short_wire_form_is_refused() {
        assert!(matches!(
            DeviceCertificate::from_bytes(&[0u8; 8]),
            Err(CertificateError::Malformed { .. })
        ));
    }
}
