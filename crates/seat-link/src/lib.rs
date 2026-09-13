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
//! | [`bootstrap`] | a seat that has never synced: the schema and the floor |
//! | [`link`] | [`link::GatewayLink`] — one seat-lane stream, as `LogSource` and `IntentSink` |
//! | [`bytes`] | the byte pass: the replica's rows → a plan → fetched files |
//! | [`seat`] | [`seat::SeatLink`] — the runtime, the endpoint, pairing, and one synchronous door |
//!
//! ## Two planes, dialled separately, failing separately
//!
//! A pass dials `centraid/v1/seat` for rows and `centraid/v1/byte` for files. A
//! seat that got its rows and not its files is in a good state: the grid draws
//! and its cells say the file has not arrived. A seat that got neither is
//! stale, which is what being on a train looks like and is not a fault.
//! [`seat::SeatPassReport`] keeps the two apart so a shell can say which.
//!
//! ## Nothing here is a listener
//!
//! Every connection is DIALLED. The seat is the side that knows when it is
//! awake and the side behind the worse NAT, so it opens every window; the
//! gateway only ever answers. `no-listening-socket` holds here with no feature
//! flag.

pub mod bootstrap;
pub mod bytes;
pub mod link;
pub mod seat;

pub use bootstrap::{bootstrap_from, is_bootstrapped};
pub use bytes::{BytePassReport, byte_pass};
pub use link::GatewayLink;
pub use seat::{LinkError, PairedGateway, SeatLink, SeatPassReport};
