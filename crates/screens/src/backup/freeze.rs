//! WHAT IS ONLY ON THIS PHONE WHEN A VAULT MOVED (#1029 F1, #1080): the two terms
//! the shelf's freeze takes, from a pass or from the ledger.
//!
//! **It does not freeze anything and does not decide anything** (F1:
//! cooperation, not enforcement): it reads a ledger that remembers the vault
//! moved, or a pass that stopped because it did, and answers when and how many.
//! Nothing here wipes, and nothing here takes a vault back.

use super::reading::Reading;

/// A vault that moved to another phone, in the two terms the freeze takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moved {
    /// The date the count is "since", gateway clock where there is one.
    pub since_ms: i64,
    /// What is ONLY on this phone: the items no gateway acknowledged.
    pub unacked: u64,
}

/// The terms from a pass that stopped `MOVED` at `moved_at_ms`, or a ledger
/// whose `frozen` the core remembered. `None` when neither says the vault moved.
///
/// The count is what is only on this phone and the date is the last
/// acknowledgement on the GATEWAY's clock, so the line reads "N changes since the
/// last backup"; the move's own time stands in when nothing was ever
/// acknowledged.
#[must_use]
pub fn for_reading(reading: Option<&Reading>, moved_at_ms: Option<i64>) -> Option<Moved> {
    if moved_at_ms.is_none() && !reading.is_some_and(|reading| reading.frozen) {
        return None;
    }
    Some(Moved {
        since_ms: reading
            .and_then(|reading| reading.last_ack_ms)
            .or(moved_at_ms)
            .unwrap_or(0),
        unacked: reading.map_or(0, Reading::unconfirmed),
    })
}
