//! Declaring objects, and the two rules that make storage write-once (#1029 §3).
//!
//! The phone declares objects — name, attested checksum, kind and padded size —
//! and receives an upload target for each: a presigned store URL on the hosted
//! adapter, or a URL on the server itself on the standalone default. Then it
//! `PUT`s the bytes through a background transfer.
//!
//! # Write-once follows from content addressing, but only if two rules hold
//!
//! An object's name is the hash of its bytes, so *different bytes cannot land
//! on an existing name* — provided nobody can write over a name that already
//! has bytes, and provided nobody can commit bytes whose checksum nothing
//! attested. Those are the two rules:
//!
//! 1. **Refuse to presign a committed name** — here;
//! 2. **Reject a commit without an attested checksum** — [`crate::checksum`].
//!
//! A retry with identical bytes is a no-op, which is why a committed name is
//! answered with "it is already there" rather than a refusal the phone has to
//! reason about.
//!
//! Uncommitted uploads sit at their final key under the vault's prefix — R2 has
//! no rename — and are garbage-collected by listing.

use crate::checksum::AttestedChecksum;
use crate::error::Refusal;
use crate::ids::{ObjectKind, ObjectName};
use crate::store::{ObjectState, StoredObject};

/// Every object is at most 16 MiB (F6).
///
/// The same number as `centraid_media::object::MAX_OBJECT_BYTES`, and it is
/// restated here rather than imported because `crates/media` carries zstd,
/// chacha20poly1305 and the sealing path, none of which a Worker should link to
/// learn one integer. The conformance suite is where the two are held equal in
/// practice: an object the phone can seal and the gateway refuses is a bug
/// either way round.
pub const MAX_OBJECT_BYTES: u64 = 16 * 1024 * 1024;

/// What the phone said about one object it wants to upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Declaration {
    pub name: ObjectName,
    pub checksum: AttestedChecksum,
    pub kind: ObjectKind,
    /// After zstd and Padmé. A **size class**, not a size.
    pub padded_size: u64,
}

/// What to do about one declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Give the phone an upload target.
    Presign,
    /// **Refuse to presign, and say why without making it an error.** The
    /// object is already committed; a retry with identical bytes is a no-op and
    /// the phone moves on.
    AlreadyCommitted,
}

/// Judge one declaration against what the gateway already holds.
///
/// # Errors
///
/// - [`Refusal::ObjectTooLarge`] above the cap;
/// - [`Refusal::Checksum`] with [`crate::checksum::ChecksumFault::Mismatch`]
///   when a name is re-declared with a *different* checksum. That is the rule
///   that makes the declaration a binding at all: without it a client could
///   declare a name once, commit it, and later re-declare the same name with
///   another checksum and swap the bytes an attest-only store would happily
///   accept.
pub fn disposition(
    declaration: &Declaration,
    held: Option<&StoredObject>,
) -> Result<Disposition, Refusal> {
    if declaration.padded_size > MAX_OBJECT_BYTES {
        return Err(Refusal::ObjectTooLarge {
            declared: declaration.padded_size,
            cap: MAX_OBJECT_BYTES,
        });
    }

    let Some(held) = held else {
        return Ok(Disposition::Presign);
    };

    if held.checksum != declaration.checksum || held.padded_size != declaration.padded_size {
        return Err(Refusal::Checksum(crate::checksum::ChecksumFault::Mismatch));
    }

    match held.state {
        // Committed: nothing may be written over it.
        ObjectState::Committed | ObjectState::Tombstoned { .. } => {
            Ok(Disposition::AlreadyCommitted)
        }
        // Declared but never uploaded, or an interrupted upload. A fresh target
        // for the same bytes is exactly what part-level resumption needs (F6):
        // resumability comes from the LIST, not from the transport.
        ObjectState::Declared => Ok(Disposition::Presign),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checksum::ChecksumFault;
    use crate::ids::Generation;
    use crate::time::ServerTime;

    fn declaration() -> Declaration {
        Declaration {
            name: ObjectName::of(b"sealed bytes"),
            checksum: AttestedChecksum::of(b"sealed bytes"),
            kind: ObjectKind::Base,
            padded_size: 4 * 1024 * 1024,
        }
    }

    fn held(state: ObjectState) -> StoredObject {
        let declaration = declaration();
        StoredObject {
            name: declaration.name,
            checksum: declaration.checksum,
            kind: declaration.kind,
            padded_size: declaration.padded_size,
            state,
            received_at: ServerTime::from_millis(1),
            generation: Generation::parse("0123456789abcdef0123456789abcdef").expect("hex"),
        }
    }

    #[test]
    fn a_new_name_is_presigned() {
        assert_eq!(disposition(&declaration(), None), Ok(Disposition::Presign));
    }

    /// REFUSE TO PRESIGN A COMMITTED NAME. Storage is write-once and a name is
    /// the hash of its bytes.
    #[test]
    fn a_committed_name_is_never_presigned() {
        assert_eq!(
            disposition(&declaration(), Some(&held(ObjectState::Committed))),
            Ok(Disposition::AlreadyCommitted)
        );
        assert_eq!(
            disposition(
                &declaration(),
                Some(&held(ObjectState::Tombstoned {
                    purge_after: ServerTime::from_millis(9)
                }))
            ),
            Ok(Disposition::AlreadyCommitted),
            "a tombstoned object still holds its bytes until the purge; writing \
             over it would be writing over what an undelete restores"
        );
    }

    /// An interrupted upload gets a fresh target. Part-level resumption is the
    /// list, not the transport (F6).
    #[test]
    fn a_declared_but_unuploaded_name_is_presigned_again() {
        assert_eq!(
            disposition(&declaration(), Some(&held(ObjectState::Declared))),
            Ok(Disposition::Presign)
        );
    }

    /// THE BINDING. Without this, a client could commit a name and later
    /// re-declare it with another checksum, and an attest-only store would
    /// accept the swapped bytes.
    #[test]
    fn a_name_re_declared_with_another_checksum_is_refused() {
        let mut lie = declaration();
        lie.checksum = AttestedChecksum::of(b"quite different bytes");
        assert_eq!(
            disposition(&lie, Some(&held(ObjectState::Committed))),
            Err(Refusal::Checksum(ChecksumFault::Mismatch))
        );

        let mut resized = declaration();
        resized.padded_size += 1;
        assert_eq!(
            disposition(&resized, Some(&held(ObjectState::Committed))),
            Err(Refusal::Checksum(ChecksumFault::Mismatch))
        );
    }

    #[test]
    fn an_object_above_sixteen_mebibytes_is_refused() {
        let mut huge = declaration();
        huge.padded_size = MAX_OBJECT_BYTES + 1;
        assert_eq!(
            disposition(&huge, None),
            Err(Refusal::ObjectTooLarge {
                declared: MAX_OBJECT_BYTES + 1,
                cap: MAX_OBJECT_BYTES,
            })
        );
        let mut exact = declaration();
        exact.padded_size = MAX_OBJECT_BYTES;
        assert_eq!(disposition(&exact, None), Ok(Disposition::Presign));
    }
}
