//! THE ATTESTED CHECKSUM, AND WHY IT IS THE ONE EXCEPTION TO ONE HASH.
//!
//! **This is the only module in this crate that names SHA-256**, and it is
//! declared in `crates/vault/tests/one_hash.rs`'s allowlist with that reason,
//! in the same shape `crates/identity` is (W0.5-R1). The boundary is the point
//! of the carve-out: everything Centraid defines for itself — every object
//! name, every commitment, every dictionary id — stays BLAKE3 (#1025 S4).
//!
//! # Why the exception exists
//!
//! An object's name is the BLAKE3-256 of its ciphertext. A blind gateway would
//! like to check that the bytes in the store hash to the name they are filed
//! under, and on the hosted adapter it never sees those bytes at all: they go
//! straight to R2 by presigned URL. What it can ask the store for is the
//! checksum the store itself computed — and **R2, S3, B2 and MinIO attest
//! SHA-256 and nothing else**. Their API is somebody else's protocol, and a
//! checksum restated in BLAKE3 would not be that protocol any more.
//!
//! So the declaration carries both names of the same bytes, and the binding
//! between them is made at declaration time: `name` (BLAKE3) and
//! `attested_checksum` (SHA-256). See [`ChecksumMode`] for what each deployment
//! can then actually prove.
//!
//! # The two gotchas this module exists to hold
//!
//! 1. **R2 records `checksums.sha256` only if the client sent it.** So a commit
//!    must fail on *no checksum*, not only on *wrong checksum*
//!    ([`ChecksumEvidence::None`]). Without that, an object with no attestation
//!    at all commits happily and write-once is a comment.
//! 2. **B2 and MinIO differ on which checksum headers they attest.** So the
//!    standalone adapter needs a read-and-hash mode, and **both modes are rules
//!    and both are in the conformance suite** — otherwise the adapters diverge
//!    on the one rule the whole scheme rests on.

use sha2::{Digest, Sha256};

use crate::ids::ObjectName;

/// The SHA-256 of an object's sealed bytes, as an object store attests it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AttestedChecksum([u8; 32]);

impl AttestedChecksum {
    /// Wrap a value read off the wire or out of a store header.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Read it from a slice. A wrong length is `None`: a truncated checksum
    /// that compared equal to a truncated declaration would be no check at all.
    #[must_use]
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        <[u8; 32]>::try_from(bytes).ok().map(Self)
    }

    /// Compute it over bytes the gateway is holding.
    ///
    /// Only [`ChecksumMode::ReadAndHash`] reaches this: on the hosted adapter
    /// the bytes never pass through gateway code.
    #[must_use]
    pub fn of(sealed: &[u8]) -> Self {
        Self(Sha256::digest(sealed).into())
    }

    /// The raw bytes, for the wire.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lowercase hex, which is how a store header spells it.
    #[must_use]
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl core::fmt::Debug for AttestedChecksum {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "{}…", hex::encode(&self.0[..4]))
    }
}

/// How the store this adapter was pointed at can be verified.
///
/// **It is a property of the store, not of the adapter.** R2 attests; so does
/// S3; B2 and MinIO differ by configuration. That is why the standalone adapter
/// carries both and picks by what it was configured with, and why this is an
/// input to the rules rather than a branch inside them — there is no
/// `GatewayMode` in this crate and this is the closest thing to one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksumMode {
    /// The store attests the checksum and the gateway never reads the bytes.
    ///
    /// **What this proves:** the bytes in the store are the bytes whose
    /// checksum the declaration bound to this name. Since a name is declared
    /// once and a second declaration with a different checksum is refused, an
    /// object cannot be replaced after it is committed.
    ///
    /// **What it does not prove:** that the bytes hash to the *name*. Only the
    /// phone knows that, and it finds out when the object's AEAD opens. A
    /// client that declared a name with a mismatched checksum corrupts only its
    /// own vault, which is the most a blind store can offer and is written
    /// down rather than implied.
    Attest,
    /// The gateway reads the bytes and hashes them itself.
    ///
    /// **What this proves:** everything `Attest` proves, plus `name ==
    /// BLAKE3(bytes)`. It costs a full read per commit, which is why it is not
    /// the only mode.
    ReadAndHash,
}

/// What the store could say about an object's bytes at commit time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChecksumEvidence {
    /// **No attestation at all.** R2 stores `checksums.sha256` only when the
    /// client sent it, and a store that cannot attest and was not read is a
    /// store that said nothing. This is a rejection and not a shrug.
    None,
    /// The store attested this checksum, and the size it holds.
    Attested {
        checksum: AttestedChecksum,
        stored_size: u64,
    },
    /// The gateway read the bytes and computed both names itself.
    ReadAndHashed {
        checksum: AttestedChecksum,
        name: ObjectName,
        stored_size: u64,
    },
}

/// Why a commit's checksum verification failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksumFault {
    /// The store attested nothing. Gotcha 1.
    Missing,
    /// The attested checksum is not the one the declaration bound to this name.
    Mismatch,
    /// Read-and-hash mode: the bytes do not hash to the name they are filed
    /// under. Only this mode can see it.
    NameMismatch,
    /// The stored length is not the declared padded size.
    SizeMismatch,
    /// The evidence does not match the mode: an adapter in read-and-hash mode
    /// that handed over an attestation it did not verify, or the reverse. A
    /// defect in the adapter, not in the client's request, and it is refused
    /// rather than quietly downgraded to the weaker check.
    WrongMode,
}

/// THE VERIFICATION, IN BOTH MODES, ONCE.
///
/// Every adapter calls this and none reimplements it. The declaration is what
/// the client said when it asked for an upload target; the evidence is what the
/// store said at commit.
///
/// # Errors
///
/// [`ChecksumFault`], which the caller maps onto
/// `ERROR_CODE_GATEWAY_CHECKSUM_MISSING` or `…_MISMATCH`.
pub fn verify(
    mode: ChecksumMode,
    declared_name: ObjectName,
    declared_checksum: AttestedChecksum,
    declared_size: u64,
    evidence: &ChecksumEvidence,
) -> Result<(), ChecksumFault> {
    match (mode, evidence) {
        (_, ChecksumEvidence::None) => Err(ChecksumFault::Missing),
        (
            ChecksumMode::Attest,
            ChecksumEvidence::Attested {
                checksum,
                stored_size,
            },
        ) => {
            if *checksum != declared_checksum {
                return Err(ChecksumFault::Mismatch);
            }
            if *stored_size != declared_size {
                return Err(ChecksumFault::SizeMismatch);
            }
            Ok(())
        }
        (
            ChecksumMode::ReadAndHash,
            ChecksumEvidence::ReadAndHashed {
                checksum,
                name,
                stored_size,
            },
        ) => {
            if *checksum != declared_checksum {
                return Err(ChecksumFault::Mismatch);
            }
            // The half only this mode can see: the bytes really are the bytes
            // this name means.
            if *name != declared_name {
                return Err(ChecksumFault::NameMismatch);
            }
            if *stored_size != declared_size {
                return Err(ChecksumFault::SizeMismatch);
            }
            Ok(())
        }
        _ => Err(ChecksumFault::WrongMode),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed() -> Vec<u8> {
        (0..4096_u32).map(|byte| byte as u8).collect()
    }

    /// GOTCHA 1, and it is a rule and not a preference: R2 records the
    /// attestation only when the client sent it, so silence is a refusal.
    #[test]
    fn no_attestation_is_a_rejection_in_both_modes() {
        let bytes = sealed();
        for mode in [ChecksumMode::Attest, ChecksumMode::ReadAndHash] {
            assert_eq!(
                verify(
                    mode,
                    ObjectName::of(&bytes),
                    AttestedChecksum::of(&bytes),
                    bytes.len() as u64,
                    &ChecksumEvidence::None,
                ),
                Err(ChecksumFault::Missing)
            );
        }
    }

    #[test]
    fn attest_mode_accepts_the_declared_checksum_and_refuses_another() {
        let bytes = sealed();
        let good = ChecksumEvidence::Attested {
            checksum: AttestedChecksum::of(&bytes),
            stored_size: bytes.len() as u64,
        };
        assert_eq!(
            verify(
                ChecksumMode::Attest,
                ObjectName::of(&bytes),
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &good,
            ),
            Ok(())
        );
        let other = ChecksumEvidence::Attested {
            checksum: AttestedChecksum::of(b"different bytes"),
            stored_size: bytes.len() as u64,
        };
        assert_eq!(
            verify(
                ChecksumMode::Attest,
                ObjectName::of(&bytes),
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &other,
            ),
            Err(ChecksumFault::Mismatch)
        );
    }

    /// THE HALF ATTEST MODE CANNOT SEE. A client that declares a name whose
    /// bytes hash to something else gets through attest mode and is caught
    /// here, and the difference is exactly why both modes are rules.
    #[test]
    fn read_and_hash_mode_catches_bytes_that_do_not_hash_to_their_name() {
        let bytes = sealed();
        let lie = ObjectName::of(b"a name for other bytes entirely");
        let evidence = ChecksumEvidence::ReadAndHashed {
            checksum: AttestedChecksum::of(&bytes),
            name: ObjectName::of(&bytes),
            stored_size: bytes.len() as u64,
        };
        assert_eq!(
            verify(
                ChecksumMode::ReadAndHash,
                lie,
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &evidence,
            ),
            Err(ChecksumFault::NameMismatch)
        );
        // Attest mode, given the same lie, has nothing to compare against and
        // passes. That is the honest limit of a store that only attests, and
        // the conformance suite states it rather than papering over it.
        assert_eq!(
            verify(
                ChecksumMode::Attest,
                lie,
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &ChecksumEvidence::Attested {
                    checksum: AttestedChecksum::of(&bytes),
                    stored_size: bytes.len() as u64,
                },
            ),
            Ok(())
        );
    }

    /// An adapter that handed over the weaker evidence while claiming the
    /// stronger mode is refused, not silently downgraded.
    #[test]
    fn evidence_from_the_other_mode_is_refused_rather_than_downgraded() {
        let bytes = sealed();
        assert_eq!(
            verify(
                ChecksumMode::ReadAndHash,
                ObjectName::of(&bytes),
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &ChecksumEvidence::Attested {
                    checksum: AttestedChecksum::of(&bytes),
                    stored_size: bytes.len() as u64,
                },
            ),
            Err(ChecksumFault::WrongMode)
        );
    }

    #[test]
    fn a_stored_length_that_is_not_the_declared_one_is_refused() {
        let bytes = sealed();
        assert_eq!(
            verify(
                ChecksumMode::Attest,
                ObjectName::of(&bytes),
                AttestedChecksum::of(&bytes),
                bytes.len() as u64,
                &ChecksumEvidence::Attested {
                    checksum: AttestedChecksum::of(&bytes),
                    stored_size: bytes.len() as u64 + 1,
                },
            ),
            Err(ChecksumFault::SizeMismatch)
        );
    }

    #[test]
    fn a_checksum_never_prints_itself_whole() {
        let checksum = AttestedChecksum::from_bytes([0xCD; 32]);
        assert_eq!(format!("{checksum:?}"), "cdcdcdcd…");
        assert_eq!(checksum.hex().len(), 64);
    }
}
