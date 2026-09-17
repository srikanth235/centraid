//! Share capabilities: what a recipient may read, exactly (#1029 §3, §7).
//!
//! A share feed is an append-only list of sealed entries, written by the owner
//! under its lease. A recipient reads it with a **per-recipient read
//! capability** and needs no account on the owner's gateway. The gateway records
//! which object ids a share references, so a capability can read exactly those
//! — and revoking one recipient takes effect immediately.
//!
//! # Scope is over whole objects AND pack ranges
//!
//! Thumbnails and page segments are small and numerous, so they are written
//! into ~16 MiB `pack` objects (F6). A share capability that could only name
//! whole objects would therefore hand the recipient **every other item in the
//! same pack** — a hundred other photographs' thumbnails, in a product whose
//! whole claim is that the gateway sees nothing. So scope carries ranges, and
//! a read that asks for a byte outside its range is refused.
//!
//! **A pack a live share references is never repacked** (F8). Repacking
//! tombstones the old pack and writes the live items into a new one, which
//! would invalidate every registered range and every recipient's cached
//! reference. One predicate removes the interaction, and it is the predicate
//! [`references`] answers.

use crate::error::Refusal;
use crate::ids::{ObjectName, VaultId};
use crate::time::ServerTime;

/// One byte range inside a pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackRange {
    pub object: ObjectName,
    pub offset: u64,
    pub length: u64,
}

impl PackRange {
    /// Does this range cover `[offset, offset + length)`?
    #[must_use]
    pub const fn covers(&self, offset: u64, length: u64) -> bool {
        let Some(wanted_end) = offset.checked_add(length) else {
            return false;
        };
        let Some(end) = self.offset.checked_add(self.length) else {
            return false;
        };
        offset >= self.offset && wanted_end <= end
    }
}

/// A capability as the gateway holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub vault: VaultId,
    pub share_id: ObjectName,
    pub recipient: VaultId,
    /// Whole objects this capability may read.
    pub objects: Vec<ObjectName>,
    /// Ranges inside pack objects it may read.
    pub ranges: Vec<PackRange>,
    pub expires_at: ServerTime,
    /// Revocation is immediate: the next read is refused.
    pub revoked: bool,
}

/// What a recipient is asking to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Read {
    /// A whole object.
    Whole(ObjectName),
    /// A range inside a pack.
    Range {
        object: ObjectName,
        offset: u64,
        length: u64,
    },
}

/// May this capability serve this read?
///
/// # Errors
///
/// [`Refusal::CapabilityScope`] for a revoked capability, an expired one, and a
/// read outside its scope. **They are one refusal on purpose**: three codes
/// would tell a holder of a revoked capability that the share still exists, and
/// that is an answer the gateway has no business giving.
pub fn authorize(capability: &Capability, read: Read, now: ServerTime) -> Result<(), Refusal> {
    if capability.revoked || now > capability.expires_at {
        return Err(Refusal::CapabilityScope);
    }
    let allowed = match read {
        Read::Whole(name) => capability.objects.contains(&name),
        Read::Range {
            object,
            offset,
            length,
        } => capability
            .ranges
            .iter()
            .any(|range| range.object == object && range.covers(offset, length)),
    };
    if allowed {
        Ok(())
    } else {
        Err(Refusal::CapabilityScope)
    }
}

/// Does any **live** capability reference this object?
///
/// F8's predicate. A pack this answers `true` for is never repacked; the phone
/// asks before it decides, and the gateway is the only party that knows every
/// recipient.
#[must_use]
pub fn references(capabilities: &[Capability], object: ObjectName, now: ServerTime) -> bool {
    capabilities.iter().any(|capability| {
        !capability.revoked
            && now <= capability.expires_at
            && (capability.objects.contains(&object)
                || capability.ranges.iter().any(|range| range.object == object))
    })
}

/// A feed entry, with the **owner-assigned** sequence number.
///
/// Owner-assigned, so a feed re-created on a new gateway continues where
/// recipients' cursors left off. A server-assigned sequence would restart at
/// one, and every recipient would either re-read the whole feed or skip it —
/// and "switch providers" is three steps in this product, so this is not a
/// hypothetical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedEntry {
    pub seq: u64,
    pub object: ObjectName,
    pub appended_at: ServerTime,
}

/// The page of a feed after a cursor. Recipients pull while the owner's phone
/// sleeps, so the cursor is theirs.
#[must_use]
pub fn page(entries: &[FeedEntry], after: u64, limit: u32) -> Vec<FeedEntry> {
    let mut page: Vec<FeedEntry> = entries
        .iter()
        .copied()
        .filter(|entry| entry.seq > after)
        .collect();
    page.sort_by_key(|entry| entry.seq);
    page.truncate(limit as usize);
    page
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Key32;

    fn name(tag: u8) -> ObjectName {
        Key32::from_bytes([tag; 32])
    }

    fn capability() -> Capability {
        Capability {
            vault: name(0),
            share_id: name(1),
            recipient: name(2),
            objects: vec![name(10)],
            ranges: vec![PackRange {
                object: name(20),
                offset: 4_096,
                length: 1_024,
            }],
            expires_at: ServerTime::from_millis(1_000),
            revoked: false,
        }
    }

    fn now() -> ServerTime {
        ServerTime::from_millis(500)
    }

    #[test]
    fn a_capability_reads_the_objects_it_names_and_nothing_else() {
        assert_eq!(
            authorize(&capability(), Read::Whole(name(10)), now()),
            Ok(())
        );
        assert_eq!(
            authorize(&capability(), Read::Whole(name(11)), now()),
            Err(Refusal::CapabilityScope)
        );
    }

    /// THE PACK LEAK THIS RULE EXISTS TO CLOSE. A capability naming a whole
    /// pack would hand over every other member's thumbnail inside it.
    #[test]
    fn a_range_capability_does_not_open_the_rest_of_the_pack() {
        let inside = Read::Range {
            object: name(20),
            offset: 4_096,
            length: 1_024,
        };
        assert_eq!(authorize(&capability(), inside, now()), Ok(()));

        for outside in [
            Read::Range {
                object: name(20),
                offset: 0,
                length: 4_096,
            },
            Read::Range {
                object: name(20),
                offset: 4_096,
                length: 1_025,
            },
            Read::Range {
                object: name(20),
                offset: 5_119,
                length: 2,
            },
            // The whole object, asked for as a whole object.
            Read::Whole(name(20)),
        ] {
            assert_eq!(
                authorize(&capability(), outside, now()),
                Err(Refusal::CapabilityScope),
                "a read outside the registered range was served: {outside:?}"
            );
        }
    }

    /// REVOCATION IS IMMEDIATE, and it looks exactly like "you were never
    /// allowed" — a distinct code would confirm the share exists.
    #[test]
    fn a_revoked_capability_is_refused_the_same_way_a_stranger_is() {
        let revoked = Capability {
            revoked: true,
            ..capability()
        };
        assert_eq!(
            authorize(&revoked, Read::Whole(name(10)), now()),
            Err(Refusal::CapabilityScope)
        );
        assert_eq!(
            authorize(&capability(), Read::Whole(name(99)), now()),
            Err(Refusal::CapabilityScope)
        );
    }

    #[test]
    fn an_expired_capability_is_refused() {
        assert_eq!(
            authorize(
                &capability(),
                Read::Whole(name(10)),
                ServerTime::from_millis(1_001)
            ),
            Err(Refusal::CapabilityScope)
        );
    }

    /// F8. A pack a live share references is never repacked; a revoked or
    /// expired one no longer holds it back.
    #[test]
    fn a_pack_a_live_share_references_is_reported_and_a_dead_one_is_not() {
        let live = vec![capability()];
        assert!(references(&live, name(20), now()));
        assert!(references(&live, name(10), now()));
        assert!(!references(&live, name(21), now()));

        let dead = vec![Capability {
            revoked: true,
            ..capability()
        }];
        assert!(!references(&dead, name(20), now()));
        assert!(!references(&live, name(20), ServerTime::from_millis(1_001)));
    }

    /// The cursor is the recipient's, and the sequence is the owner's.
    #[test]
    fn a_feed_page_continues_from_the_recipients_own_cursor() {
        let entries: Vec<FeedEntry> = (1..=10)
            .map(|seq| FeedEntry {
                seq,
                object: name(u8::try_from(seq).expect("fits")),
                appended_at: ServerTime::from_millis(seq as i64),
            })
            .collect();
        let first = page(&entries, 4, 3);
        assert_eq!(
            first.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
            vec![5, 6, 7]
        );
        assert!(page(&entries, 10, 3).is_empty());
    }
}
