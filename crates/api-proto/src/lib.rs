#![forbid(unsafe_code)]
//! The two protobuf packages and their generated Rust types (#1020).
//!
//! **Two packages, two promises** (#1020, *One protobuf schema workspace*):
//!
//! | Package | Module | `buf breaking` against | Promise |
//! |---|---|---|---|
//! | `centraid.core.v1` | [`core_v1`] | the PR base **and every released tag in the version window** | a gateway's commitment to seats that update on their own schedule |
//! | `centraid.screen.v1` | [`screen_v1`] | the PR base only | shell-internal; may change every release |
//!
//! The `.proto` files are the source of truth and carry the reasoning; this
//! crate is codegen plus the round-trip tests. See `README.md` for how to add a
//! field and what `buf breaking` refuses.
//!
//! # Unknown fields are NOT preserved by these types — and the promise still holds
//!
//! #1020's Compatibility section requires that "unknown fields are preserved,
//! unknown message types are answered with `Unsupported{type}`, never dropped
//! silently". **prost 0.14 does not implement unknown-field retention**: there
//! is no `preserve_unknown_fields` switch on `prost_build::Config` and no
//! `unknown_fields` member on a generated struct (verified against the vendored
//! sources — `grep -rn unknown prost-build-0.14.4/src/` has one hit, a panic
//! message about proto syntax, and `prost-0.14.4/src/` has none). A decode of a
//! message from a newer peer therefore drops the fields this build does not
//! know, and re-encoding it would silently shorten it.
//!
//! **D-1020-C13 — the invariant is held one layer out, at the frame.** Three
//! mechanisms, together:
//!
//! 1. **Nothing relays a decoded message.** `crates/protocol` forwards FRAMES:
//!    a length prefix and an opaque body. The only party that decodes an
//!    `Envelope` is the party that answers it, and a party that answers a
//!    message it understands has no unknown fields to lose. There is no
//!    store-and-forward hop in the v1 plane that re-encodes — wave 4's peer
//!    plane is gateway-to-gateway and terminates at each end.
//! 2. **Every payload that crosses a version boundary is `bytes`.** An intent's
//!    and a command's input, a screen's state, and a snapshot's artifact are
//!    opaque to the transport (see the `D-1020-C12` note in `intent.proto`), so
//!    content a newer peer sends arrives whole whatever this build knows about
//!    its shape.
//! 3. **An unknown message type is answered, never dropped.**
//!    [`core_v1::Unsupported`] carries the type name, which is the half of the
//!    requirement prost cannot take away.
//!
//! The residual gap is named rather than hidden: a *field* added to a
//! `centraid.core.v1` message in a future release is invisible to this build,
//! and a middlebox that decoded and re-encoded would lose it. Mechanism 1 is
//! what makes that unreachable, and `crates/protocol`'s
//! `a_relayed_frame_keeps_bytes_this_build_cannot_decode` test is what keeps it
//! true rather than merely intended.

/// `centraid.core.v1` — the gateway's compatibility commitment.
pub mod core_v1 {
    include!(concat!(env!("OUT_DIR"), "/centraid.core.v1.rs"));
}

/// `centraid.screen.v1` — shell-internal, free to change every release.
pub mod screen_v1 {
    include!(concat!(env!("OUT_DIR"), "/centraid.screen.v1.rs"));
}
