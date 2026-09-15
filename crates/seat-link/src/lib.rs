#![forbid(unsafe_code)]
//! The seat's network half (#1020 wave 3 lane B).
//!
//! `crates/seat` is a replica that can apply pages and queue intents but has no
//! way to reach a gateway. `crates/net` is an endpoint that can reach one but
//! knows nothing about replicas. This crate is the join, and it is what makes a
//! phone a seat rather than a local file with a nice grid on top.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`bootstrap`] | a seat with no copy, or one under the floor: the snapshot blob |
//! | [`link`] | [`link::GatewayLink`] — one stream per request, as `LogSource` and `IntentSink` |
//! | [`serve`] | the seat's half of the symmetric accept loop: `blob` streams the gateway opens |
//! | [`bytes`] | the byte pass: the replica's rows → a plan → fetched files |
//! | [`seat`] | [`seat::SeatLink`] — the runtime, the endpoint, pairing, and one synchronous door |
//!
//! ## ONE CONNECTION, TWO PLANES, FAILING SEPARATELY (#1025 S2)
//!
//! A pass dials `centraid/v1/seat` ONCE and does everything on it: rows on
//! `log` streams, writes on `intent` streams, files on `blob` streams. There is
//! no second ALPN and no second dial — a phone paid for two connection setups
//! per window and got nothing for the second one.
//!
//! The two planes are still reported apart, because they still FAIL apart. A
//! seat that got its rows and not its files is in a good state: the grid draws
//! and its cells say the file has not arrived. A seat that got neither is
//! stale, which is what being on a train looks like and is not a fault.
//! [`seat::SeatPassReport`] keeps them apart so a shell can say which.
//!
//! ## Nothing here is a listener, and the loop is still symmetric
//!
//! Every connection is DIALLED. The seat is the side that knows when it is
//! awake and the side behind the worse NAT, so it opens every window; the
//! gateway never dials. `no-listening-socket` holds here with no feature flag.
//!
//! That is a fact about DIALLING and not about direction: on a connection the
//! seat opened, the gateway may open streams, and [`serve`] answers them. It is
//! what lets S3's gateway pull a phone's photograph without the phone ever
//! binding a listening socket.

pub mod bootstrap;
pub mod bytes;
pub mod link;
pub mod seat;
pub mod serve;

pub use bootstrap::{install, is_bootstrapped};
pub use bytes::{BytePassReport, byte_pass};
pub use link::{GatewayLink, TailStop};
pub use seat::{LinkError, PairedGateway, SeatLink};
