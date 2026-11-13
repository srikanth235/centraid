//! HOW A SIZE IS SAID ABOUT BACKUP, in one place.
//!
//! The umbrella's UI invariant lives in [`super::line`]: **the phone never claims backup the
//! gateway has not acknowledged**, and there is deliberately no "Backing up…" that outlives a
//! pass. This module holds the byte wording the line and the rows share.

use crate::kit::quantity::{Quantity, UnitsPref};
use crate::strings::Locale;

/// Bytes in a member's units: decimal, because a phone's own storage screen is
/// decimal, and whole units, because "3.27183 MB" is a number nobody can use —
/// except gigabytes under a hundred, which keep one decimal, because "4 GB"
/// and "4.9 GB" are a phone's worth of photographs apart (#1144). Every figure
/// is rounded DOWN: a size said never claims a byte more than there is.
#[must_use]
pub fn bytes(count: u64) -> String {
    Quantity::bytes_floor(count).words(Locale::En, UnitsPref::Metric)
}
