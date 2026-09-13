//! The seam between the core and the network (#1020, D-1020-B7).
//!
//! ## Why a trait and not a dependency
//!
//! `crates/seat-link` owns the endpoint, the sync pass and the byte plane — and
//! it depends on `crates/core`, because a page it fetches is decoded with
//! `core::convert`. So the core cannot depend on it back. This trait is the
//! inversion: the core declares what it needs a network to do, and whoever
//! builds the process — `crates/core-ffi` for a phone, `crates/centraid` for a
//! desktop seat — attaches one.
//!
//! That is also the right layering on its own merits. A core with no network
//! attached is exactly a local-first vault, which is what a seat is between
//! windows and what every unit test in this crate wants to be.
//!
//! ## What the old comment got wrong
//!
//! `Handle::start_endpoint` refused with "which runtime a shell owns is the
//! shell's decision, so the core is handed one rather than making one." **A
//! Swift shell does not own a tokio runtime and never will**, so that was not a
//! deferral — it was a requirement nothing could satisfy, and it kept the
//! endpoint unbuilt for two waves. The runtime belongs to the implementation
//! behind this trait; `centraid_seat_link::SeatLink` owns one on threads of its
//! own. See D-1020-D2C: the same shape as the `Send` comment that kept the seat
//! lane shut.

/// Why a pairing did not happen.
///
/// **A CODE AND NEVER A SENTENCE.** `CoreError::sentence` is a table keyed by
/// code and nothing else, precisely so no database text, no path and no peer's
/// words can reach a member through an error; a refusal that carried its own
/// string would be a hole in that rule. The gateway's own vocabulary is three
/// coarse values for a second reason — a member holding a screenshot of an old
/// QR must not learn from the answer whether that ticket ever existed — and
/// this adds only the two failures that happen before a gateway is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRefusal {
    /// The text was not a Centraid ticket at all. Decided locally.
    NotATicket,
    /// The gateway did not answer. Not the ticket's fault, and the member's
    /// action is different: come back in range, do not mint a new code.
    Unreachable,
    /// The gateway refused it. A wrong secret and an unknown ticket are one
    /// value here because they are one value on the wire.
    Refused,
    /// The gateway refused it as expired.
    Expired,
}

/// A gateway this seat is paired to, as the core reports it.
///
/// Deliberately not `centraid_seat_link::PairedGateway`: this crate cannot name
/// that type, and a shell only needs the two facts it would show a member plus
/// the id it persists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedGateway {
    /// The gateway's iroh endpoint id, 32 raw bytes.
    pub endpoint_id: Vec<u8>,
    pub vault_id: String,
    pub vault_name: String,
    /// The device id the gateway filed this seat under.
    pub device_id: String,
}

/// What one sync pass achieved, flattened for a shell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub rows_applied: u64,
    pub blobs_completed: u64,
    pub bytes_moved: u64,
    /// Blobs left for a later window.
    pub blobs_deferred: u64,
    /// The gateway could not be reached. **A state, not a failure**: the seat
    /// is stale, it still reads, and the next window continues.
    pub unreachable: bool,
    /// A member-facing sentence when something is worth saying. Never a detail,
    /// never a path, never a hash.
    pub sentence: String,
}

/// What the core needs a network to do. Implemented by `crates/seat-link`.
///
/// Every method is SYNCHRONOUS, because `Handle::call` is: a shell asking one
/// question wants one answer and should not need an executor in Swift. The
/// implementation blocks on its own runtime, and none of these may be called on
/// a UI thread.
pub trait SeatNetwork: Send + Sync {
    /// This seat's endpoint id — what lands in a gateway's allowlist.
    fn endpoint_id(&self) -> [u8; 32];

    /// Redeem a pairing ticket.
    fn pair(
        &self,
        encoded: &str,
        device_name: &str,
        platform: &str,
    ) -> Result<PairedGateway, PairRefusal>;

    /// The gateway this seat is paired to, if any.
    fn gateway(&self) -> Option<PairedGateway>;

    /// Run one sync pass against the replica behind `connection`.
    ///
    /// The CONNECTION IS THE CORE'S, handed down rather than opened by the
    /// network: SQLite allows one writer and the core holds it, so a connection
    /// opened on the other side of this trait would contend with its owner and
    /// the loser would be whichever asked second.
    fn sync(&self, connection: &rusqlite::Connection) -> SyncOutcome;

    /// Release the socket. What a backgrounded phone does.
    fn idle(&self);

    /// Bind again. The endpoint id survives, so every gateway that enrolled
    /// this seat still recognises it.
    fn resume(&self) -> Result<(), String>;
}

/// Lowercase hex, for an endpoint id a shell persists and shows.
///
/// The same spelling `centraid_net::allowlist::hex_lower` produces, because the
/// two values are compared by eye in logs and by string in a shell's storage.
#[must_use]
pub fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
