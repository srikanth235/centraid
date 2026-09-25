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
//! 2. **Reject a commit whose stored bytes do not hash to their name** —
//!    [`crate::engine::Gateway::commit`], through
//!    [`crate::store::ByteStore::stored`]. That used to be "reject a commit
//!    without an attested checksum", which was the most a blind store could
//!    offer; with the hosted adapter struck from v0 the gateway holds the
//!    bytes and hashes them (scope amendment 2026-09-21).
//!
//! A retry with identical bytes is a no-op, which is why a committed name is
//! answered with "it is already there" rather than a refusal the phone has to
//! reason about.
//!
//! Uncommitted uploads sit at their final key under the vault's prefix — R2 has
//! no rename — and are garbage-collected by listing.

use crate::error::Refusal;
use crate::ids::{ObjectKind, ObjectName};
use crate::store::{ObjectState, StoredObject};

/// Every object is at most 16 MiB (F6).
///
/// **THE declaration.** `centraid_media::object::MAX_OBJECT_BYTES` imports and
/// casts it. It was restated there, with a comment saying a Worker should not
/// link zstd to learn one integer and that the conformance suite held the two
/// equal "in practice" — but two numbers held equal by a suite are two
/// numbers, and the Worker the reasoning protected is struck from v0 (scope
/// amendment 2026-09-21). The cap is a rule, so it lives with the rules.
pub const MAX_OBJECT_BYTES: u64 = 16 * 1024 * 1024;

/// What the phone said about one object it wants to upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Declaration {
    pub name: ObjectName,
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
/// - [`Refusal::Checksum`] with [`crate::error::ChecksumFault::Mismatch`] when
///   a name is re-declared at a *different size*. That is what makes the
///   declaration a binding: a content-addressed name means exactly one string
///   of bytes, so a second declaration claiming a different length for it is a
///   client asking the store to hold two things at one name.
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

    if held.padded_size != declaration.padded_size {
        return Err(Refusal::Checksum(crate::error::ChecksumFault::Mismatch));
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
    use crate::error::ChecksumFault;
    use crate::ids::Generation;
    use crate::time::ServerTime;

    fn declaration() -> Declaration {
        Declaration {
            name: ObjectName::of(b"sealed bytes"),
            kind: ObjectKind::Base,
            padded_size: 4 * 1024 * 1024,
        }
    }

    fn held(state: ObjectState) -> StoredObject {
        let declaration = declaration();
        StoredObject {
            name: declaration.name,
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

    /// THE BINDING. A content-addressed name means one string of bytes, so a
    /// second declaration claiming a different length for it is refused rather
    /// than quietly re-bound.
    #[test]
    fn a_name_re_declared_at_another_size_is_refused() {
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
