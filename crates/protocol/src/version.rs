//! The version window (#1020, D-1020-C6, Compatibility).
//!
//! Two constants and one function. The function is v0's rule verbatim
//! (`docs/protocol.md:152-157`):
//!
//! ```text
//! ok iff peer.schema_version >= local.min_supported
//!      && local.schema_version >= peer.min_supported
//! ```
//!
//! It is symmetric, which is the property that makes "a gateway older than the
//! seat is allowed when the seat's `min_supported` admits it" fall out rather
//! than needing a special case.
//!
//! The product version is on the wire and is **display only**. v0 says so
//! explicitly — clients must not refuse to connect on it — and the reason is
//! that a seat which refuses an unfamiliar gateway version cannot be fixed from
//! the gateway side.

use centraid_api_proto::core_v1::{Hello, UpgradeRequired, UpgradeSide};

/// What this build speaks.
pub const SCHEMA_VERSION: u32 = 1;

/// The oldest peer this build speaks to. Equal to `SCHEMA_VERSION` because v1
/// has had no release yet: there is no older peer to admit, and a floor that
/// claimed to admit a version nobody ever shipped would be a promise with no
/// subject.
pub const MIN_SUPPORTED: u32 = 1;

/// How many minor releases a gateway supports seats from (open question 4's
/// ruling). Not arithmetic in `judge` — it is the POLICY that says what
/// `MIN_SUPPORTED` becomes on the next bump, and the `buf` gate step reads the
/// same number to pick the tags it checks against.
pub const WINDOW_MINORS: u32 = 3;

/// This build's `Hello`.
pub fn local_hello(product_version: &str, capabilities: &[&str]) -> Hello {
    Hello {
        schema_version: SCHEMA_VERSION,
        min_supported: MIN_SUPPORTED,
        product_version: product_version.to_owned(),
        capabilities: capabilities.iter().map(|name| (*name).to_owned()).collect(),
    }
}

/// Does the window admit the peer? `Err` carries the `UpgradeRequired` that
/// must be sent BEFORE any other message.
pub fn judge(local: &Hello, peer: &Hello) -> Result<(), UpgradeRequired> {
    let peer_too_old = peer.schema_version < local.min_supported;
    let local_too_old = local.schema_version < peer.min_supported;
    if !peer_too_old && !local_too_old {
        return Ok(());
    }
    // When BOTH ends are outside the other's floor, the peer is told to
    // upgrade: it is the only side that can act on a message it is receiving.
    let side = if peer_too_old {
        UpgradeSide::Peer
    } else {
        UpgradeSide::Local
    };
    Err(UpgradeRequired {
        schema_version: local.schema_version,
        min_supported: local.min_supported,
        peer_schema_version: peer.schema_version,
        peer_min_supported: peer.min_supported,
        side: side as i32,
    })
}

/// Capabilities the peer requires and this build does not offer.
///
/// A separate answer from `judge` on purpose: the numbers can agree while a
/// required feature is missing, and v0 carries exactly one absent-tolerant pair
/// (`automations` / `connectors`, `docs/protocol.md:143-161`) which is a policy
/// about particular names and not a property of the handshake.
pub fn missing_capabilities<'a>(local: &Hello, required: &'a [&'a str]) -> Vec<&'a str> {
    required
        .iter()
        .copied()
        .filter(|name| !local.capabilities.iter().any(|held| held == name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(schema_version: u32, min_supported: u32) -> Hello {
        Hello {
            schema_version,
            min_supported,
            product_version: "test".to_owned(),
            capabilities: Vec::new(),
        }
    }

    /// The arithmetic, as a table. Each row is a real field situation, named,
    /// because the failure mode of a version window is that it is tested with
    /// the two cases the author had in mind.
    #[test]
    fn the_window_arithmetic_is_pinned_by_a_table() {
        // (local schema, local floor, peer schema, peer floor, admitted, side)
        let table: [(u32, u32, u32, u32, bool, UpgradeSide); 8] = [
            // Two builds of the same release.
            (1, 1, 1, 1, true, UpgradeSide::Unspecified),
            // A newer gateway that still admits the old seat: the whole point
            // of a window.
            (4, 2, 2, 2, true, UpgradeSide::Unspecified),
            // A seat older than the gateway's floor: the SEAT upgrades.
            (4, 3, 2, 2, false, UpgradeSide::Peer),
            // A GATEWAY older than the seat's floor: this side upgrades. #1020
            // names the mirror case ("a gateway older than the seat is allowed
            // as long as the seat's min_supported admits it"), and this is the
            // row where it does not.
            (2, 1, 4, 3, false, UpgradeSide::Local),
            // A gateway older than the seat, admitted, because the seat's floor
            // reaches down to it.
            (2, 1, 4, 2, true, UpgradeSide::Unspecified),
            // Exactly at each other's floor, from both sides.
            (3, 3, 3, 3, true, UpgradeSide::Unspecified),
            (5, 3, 3, 5, true, UpgradeSide::Unspecified),
            // Both outside the other's floor: the PEER is told, because it is
            // the side that can act on the message it receives.
            (2, 2, 1, 3, false, UpgradeSide::Peer),
        ];
        for (ls, lf, ps, pf, admitted, side) in table {
            let verdict = judge(&hello(ls, lf), &hello(ps, pf));
            assert_eq!(
                verdict.is_ok(),
                admitted,
                "local {ls}/{lf} against peer {ps}/{pf}"
            );
            if let Err(upgrade) = verdict {
                assert_eq!(
                    upgrade.side, side as i32,
                    "local {ls}/{lf} against peer {ps}/{pf} named the wrong side"
                );
                assert_eq!(upgrade.schema_version, ls);
                assert_eq!(upgrade.min_supported, lf);
                assert_eq!(upgrade.peer_schema_version, ps);
                assert_eq!(upgrade.peer_min_supported, pf);
            }
        }
    }

    /// Symmetry is the property, not an accident of the two cases above: if A
    /// admits B then B admits A. A window that was not symmetric would let one
    /// end connect and the other refuse, which is a hung pairing rather than an
    /// error anyone can read.
    #[test]
    fn the_window_is_symmetric() {
        for ls in 1..6u32 {
            for lf in 1..=ls {
                for ps in 1..6u32 {
                    for pf in 1..=ps {
                        let forward = judge(&hello(ls, lf), &hello(ps, pf)).is_ok();
                        let backward = judge(&hello(ps, pf), &hello(ls, lf)).is_ok();
                        assert_eq!(forward, backward, "{ls}/{lf} against {ps}/{pf}");
                    }
                }
            }
        }
    }

    /// The product version never enters the decision. The test sets it to
    /// wildly different strings and asserts the verdict does not move.
    #[test]
    fn the_product_version_is_display_only() {
        let mut local = hello(2, 1);
        let mut peer = hello(2, 1);
        local.product_version = "1.0.0".to_owned();
        peer.product_version = "99.0.0-nightly+deadbeef".to_owned();
        assert!(judge(&local, &peer).is_ok());
        peer.product_version = String::new();
        assert!(judge(&local, &peer).is_ok());
    }

    #[test]
    fn a_required_capability_this_build_lacks_is_reported() {
        let local = local_hello("1.0.0", &["replica", "commands"]);
        assert!(missing_capabilities(&local, &["replica"]).is_empty());
        assert_eq!(
            missing_capabilities(&local, &["replica", "media", "search"]),
            ["media", "search"]
        );
    }

    /// This build's own two numbers admit this build. Trivial, and it is the
    /// assertion that catches a future bump that moves `MIN_SUPPORTED` above
    /// `SCHEMA_VERSION`.
    #[test]
    fn this_build_admits_itself() {
        let mine = local_hello("1.0.0-alpha.0", &[]);
        assert!(judge(&mine, &mine).is_ok());
        const {
            assert!(
                MIN_SUPPORTED <= SCHEMA_VERSION,
                "a floor above the version this build speaks admits nobody, itself included"
            );
        }
        assert_eq!(WINDOW_MINORS, 3, "open question 4's ruling");
    }
}
