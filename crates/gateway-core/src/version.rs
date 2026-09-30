//! The protocol range, judged in both directions (#1029 §3).
//!
//! Until the first release "v0, no legacy" holds and the protocol changes
//! freely. From the first release:
//!
//! - the server advertises the min and max it supports;
//! - the phone refuses a server below its minimum and shows a typed "this
//!   server needs an update" state, the successor of `Link::UpdateRequired`;
//! - the hosted adapter supports at least the last two phone releases.
//!
//! **Self-hosters upgrade late**, so this is a real constraint rather than a
//! formality — and it is why the rule lives here, where both the phone's own
//! check and the server's are the same function. A phone that carried its own
//! copy of this comparison would be a phone that disagrees with a server about
//! whose fault it is.

use crate::error::Refusal;

/// A version range, inclusive at both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub min: u32,
    pub max: u32,
}

impl Range {
    /// A range. `min > max` is not constructible through anything the rules
    /// call: both adapters build it from [`crate::PROTOCOL_MIN`] and
    /// [`crate::PROTOCOL_MAX`].
    #[must_use]
    pub const fn new(min: u32, max: u32) -> Self {
        Self { min, max }
    }

    /// Whether this range admits a version.
    #[must_use]
    pub const fn admits(self, version: u32) -> bool {
        version >= self.min && version <= self.max
    }
}

/// What a phone should do about a server's advertised range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skew {
    /// The ranges overlap. Speak the highest version both understand.
    Agreed(u32),
    /// The server is below the phone's minimum: **the server needs an update**.
    ///
    /// The phone shows the typed state and **writes nothing** — no upload, no
    /// commit, no lease claim. A write whose acknowledgement it does not
    /// understand is a write it cannot reason about later, and this is the case
    /// where a self-hoster's server is a year behind the phone in somebody's
    /// pocket.
    ServerTooOld,
    /// The phone is below the server's minimum: the phone needs an update.
    ClientTooOld,
}

/// Which side is behind, from the two ranges.
///
/// One function for both directions, because it is one comparison. The shell
/// renders whichever sentence the answer implies.
#[must_use]
pub const fn negotiate(server: Range, client: Range) -> Skew {
    if client.min > server.max {
        // Every version the phone speaks is above everything the server does.
        return Skew::ServerTooOld;
    }
    if server.min > client.max {
        return Skew::ClientTooOld;
    }
    // Overlap: the highest both understand.
    let agreed = if server.max < client.max {
        server.max
    } else {
        client.max
    };
    Skew::Agreed(agreed)
}

/// The server's half: admit this request's `Centraid-Protocol` header, or
/// refuse it with the range.
///
/// # Errors
///
/// [`Refusal::VersionWindow`], carrying the server's range so the phone can
/// render the typed state without a second round trip.
pub const fn admit(server: Range, requested: u32) -> Result<(), Refusal> {
    if server.admits(requested) {
        Ok(())
    } else {
        Err(Refusal::VersionWindow {
            server: (server.min, server.max),
            client: requested,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VERSION SKEW BOTH WAYS. The self-hoster a year behind, and the phone
    /// somebody has not updated since.
    #[test]
    fn version_skew_reads_correctly_in_both_directions() {
        let modern = Range::new(4, 6);
        let ancient = Range::new(1, 2);
        assert_eq!(negotiate(ancient, modern), Skew::ServerTooOld);
        assert_eq!(negotiate(modern, ancient), Skew::ClientTooOld);
    }

    /// Two releases of overlap is the hosted adapter's promise, and the answer
    /// is the highest both understand — not the server's max and not the
    /// phone's.
    #[test]
    fn an_overlap_agrees_on_the_highest_version_both_understand() {
        assert_eq!(
            negotiate(Range::new(1, 5), Range::new(3, 9)),
            Skew::Agreed(5)
        );
        assert_eq!(
            negotiate(Range::new(3, 9), Range::new(1, 5)),
            Skew::Agreed(5)
        );
        // Touching at one version is still an overlap.
        assert_eq!(
            negotiate(Range::new(1, 3), Range::new(3, 7)),
            Skew::Agreed(3)
        );
    }

    #[test]
    fn a_request_outside_the_server_range_is_refused_with_the_range() {
        let server = Range::new(2, 4);
        assert_eq!(admit(server, 3), Ok(()));
        assert_eq!(
            admit(server, 9),
            Err(Refusal::VersionWindow {
                server: (2, 4),
                client: 9,
            })
        );
        assert_eq!(
            admit(server, 1),
            Err(Refusal::VersionWindow {
                server: (2, 4),
                client: 1,
            })
        );
    }
}
