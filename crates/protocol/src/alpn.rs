//! The three v1 ALPNs (#1020, D-1020-C7).
//!
//! New and v1-only. v0's four are listed below as `V0_ALPNS` for exactly one
//! purpose: a test asserts no v1 ALPN equals a v0 one, so a v1 endpoint can
//! never negotiate with a v0 one by accident. Drift in an ALPN fails nowhere
//! but at negotiation on a real network, which is why v0 pinned its own four
//! with a parity test across two languages
//! (`packages/tunnel/src/alpn-parity.test.ts:2-7`) and why this file pins ours.
//!
//! Routing is by ALPN ALONE, never by anything the caller says — v0's Rust
//! relay states it in one line, "the ALPN, not anything the caller says, picks
//! the lane" (`packages/tunnel/data-plane/src/iroh_relay.rs:486`).

/// Seat ↔ gateway. Everything a paired device does rides here.
pub const SEAT: &[u8] = b"centraid/v1/seat";

/// Ticket redemption, and nothing else. Separate from `SEAT` because a
/// redeeming device is not yet enrolled, so the two lanes have different
/// admission rules: `SEAT` closes an unenrolled peer before reading a frame,
/// and `PAIR` must accept one.
pub const PAIR: &[u8] = b"centraid/v1/pair";

/// Gateway ↔ gateway, for wave 4's sharing peer plane. Declared now and
/// advertised by nothing: v0's rule is "no link policy ⇒ never negotiate the
/// plane" (`packages/tunnel/src/gateway-endpoint.ts:149-154`), and an ALPN an
/// endpoint does not advertise is a plane that cannot be reached.
pub const PEER: &[u8] = b"centraid/v1/peer";

/// The three, in a stable order.
pub const ALL: [&[u8]; 3] = [SEAT, PAIR, PEER];

/// What a v1 endpoint advertises today: the seat lane and the pair lane. `PEER`
/// is deliberately absent until wave 4 lands a link policy to gate it.
pub const ADVERTISED: [&[u8]; 2] = [SEAT, PAIR];

/// v0's four, for the disjointness test only. Never advertised by a v1
/// endpoint. Sources: `packages/tunnel/src/protocol.ts:7`, `:8`, `:11` and
/// `packages/tunnel/src/gateway-endpoint.ts:51`.
pub const V0_ALPNS: [&[u8]; 4] = [
    b"centraid/tunnel/1",
    b"centraid/pair/1",
    b"centraid/gw-pair/1",
    b"centraid/gw-link/1",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn the_three_are_pairwise_distinct() {
        let unique: BTreeSet<&[u8]> = ALL.into_iter().collect();
        assert_eq!(unique.len(), ALL.len(), "two v1 ALPNs are the same bytes");
    }

    /// The whole point of the file. #1020 takes no v0 compatibility, so a v1
    /// endpoint meeting a v0 one must fail at negotiation rather than speak a
    /// protocol neither of them implements.
    #[test]
    fn no_v1_alpn_equals_a_v0_one() {
        for v1 in ALL {
            for v0 in V0_ALPNS {
                assert_ne!(
                    v1,
                    v0,
                    "{} collides with a v0 ALPN — a v1 endpoint would negotiate with a v0 one",
                    String::from_utf8_lossy(v1)
                );
            }
        }
    }

    /// The peer plane is not advertised. A test rather than a comment, because
    /// "we just do not open it yet" is the kind of claim a later commit
    /// invalidates without noticing.
    #[test]
    fn the_peer_plane_is_declared_and_not_advertised() {
        assert!(ADVERTISED.contains(&SEAT));
        assert!(ADVERTISED.contains(&PAIR));
        assert!(
            !ADVERTISED.contains(&PEER),
            "the peer plane needs a link policy first (wave 4)"
        );
    }

    /// Every one is `centraid/v1/<lane>`: one shape, so a reader can tell a v1
    /// ALPN from a v0 one by eye in a packet capture.
    #[test]
    fn every_v1_alpn_is_versioned_in_the_same_place() {
        for alpn in ALL {
            let text = std::str::from_utf8(alpn).expect("ascii");
            assert!(text.starts_with("centraid/v1/"), "{text}");
            assert_eq!(text.split('/').count(), 3, "{text}");
        }
    }
}
