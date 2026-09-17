//! THE ONE v1 ALPN (#1020, D-1020-C7; #1025 S2, D-1025-S2-1; #1025 S3,
//! D-1025-S3-4).
//!
//! **ONE PLANE, ONE ALPN, ONE CONNECTION.** Everything a device says to its
//! gateway — redeeming a pairing code, a log page, an intent, a bootstrap
//! offer, a blob's bytes — rides [`PLANE`], one connection per vault, one
//! stream per request, with the stream's first frame naming which.
//!
//! ## The four-ALPN design, and then the two
//!
//! The original four (`seat`, `byte`, `pair`, a declared `peer`) had a real
//! argument: routing is by ALPN alone, so a lane carrying a different PROTOCOL
//! wanted a different lane. What it cost was worse — two dials per pass on a
//! phone, two admission sites that could disagree, a byte lane whose accept arm
//! was unreachable for a while with only a compiler warning to say so, and no
//! way for a gateway to ever pull from a seat. #1025 S2 collapsed `byte` and
//! `peer` into `seat`: the first frame answers the framing question, because
//! the accepting side reads it before deciding how to read the rest.
//!
//! S2 kept `pair`, on the argument that a redeeming device is not yet enrolled
//! and `seat` closes an unenrolled peer before a frame is read — so folding
//! pairing in would move the enrolment check to every stream.
//!
//! **That argument is wrong, and this is what replaces it.** The check does not
//! move to every stream; it moves from the TLS label to the first frame, and it
//! stays exactly where it was — once per connection, at accept. An accepted
//! connection is in one of two states and it is in that state for its whole
//! life:
//!
//! | State | How | What it may do |
//! | --- | --- | --- |
//! | **promoted** | the peer key is in the allowlist, live | every request kind |
//! | **provisional** | it is not | ONE stream, a small frame, a short deadline, and the only kind it may carry is `pair` |
//!
//! A successful redemption PROMOTES that connection in place. So a phone goes
//! pair → snapshot_head → bootstrap → log on ONE connection in ONE window,
//! instead of dialling twice and paying a second QUIC setup and a second
//! hole-punch in the middle of the one screen a member is watching.
//!
//! What the second ALPN actually bought was the label. What it cost was a
//! second admission site and a reconnect between the only two things a phone
//! does on its first day.
//!
//! Routing is by ALPN alone, never by anything the caller says. There is one
//! lane to pick, so there is nothing left for a caller to influence. Drift in
//! an ALPN fails nowhere but at negotiation on a real network, which is why
//! the tests below pin it.

/// Device ↔ gateway. **The plane**, and the only one.
///
/// Admission is decided once, at `centraid_net::Endpoint::accept`, and it is a
/// STATE rather than a refusal: an enrolled peer's connection is promoted and
/// an unenrolled peer's is provisional. A provisional connection may carry one
/// `pair` stream and nothing else; redeeming promotes it in place.
pub const PLANE: &[u8] = b"centraid/v1";

/// Every ALPN a v1 endpoint advertises. Exactly one.
pub const ADVERTISED: [&[u8]; 1] = [PLANE];

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SLICE'S CLAIM, AS A TEST (#1025 S3, D-1025-S3-4). A second constant
    /// here is a second plane, and a second plane is a second place admission
    /// can be decided — which is what `pair` was and what the two-state
    /// connection replaces. A lane's return would be visible as this assertion
    /// failing rather than as a phone dialling twice on its first screen.
    #[test]
    fn there_is_exactly_one_alpn() {
        assert_eq!(ADVERTISED.len(), 1);
        assert_eq!(ADVERTISED[0], PLANE);
        assert_eq!(PLANE, b"centraid/v1");
    }

    /// THE BYTE LANE IS GONE, and the security claim it carried is kept
    /// elsewhere rather than dropped. Under `/iroh-bytes/4` any iroh-blobs
    /// client in the world could negotiate and ask this endpoint for a hash;
    /// under [`PLANE`] only a PROMOTED connection may open a `blob` stream at
    /// all. A commit that advertised the upstream constant "for compatibility"
    /// would open the vault's bytes to anyone who learned a hash, and would
    /// fail nowhere else.
    #[test]
    fn no_v1_alpn_is_iroh_blobs_own() {
        for alpn in ADVERTISED {
            assert_ne!(alpn, b"/iroh-bytes/4");
        }
    }

    /// `centraid/v1`: the product and its major version, and nothing about a
    /// lane — because there is no lane to name.
    #[test]
    fn the_alpn_names_the_product_and_its_version_and_nothing_else() {
        let text = std::str::from_utf8(PLANE).expect("ascii");
        assert!(text.starts_with("centraid/"), "{text}");
        assert_eq!(text.split('/').count(), 2, "{text}");
    }
}
