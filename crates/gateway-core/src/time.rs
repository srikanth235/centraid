//! TIME IS AN INPUT (#1029 §3).
//!
//! Every rule in this crate that needs to know what time it is takes a
//! [`ServerTime`] argument. Nothing here calls `SystemTime::now()`, and that is
//! a hard requirement rather than a taste:
//!
//! - **It would not work.** `std::time::SystemTime::now()` compiles for
//!   `wasm32-unknown-unknown` and panics when called, so a rule that reached
//!   for it would pass `cargo test` and die inside a Worker.
//! - **It would not be testable.** The retention floor spans six months and the
//!   delete rate limit spans a day. A suite that could not move the clock could
//!   not assert either, which is the same as not having them.
//! - **It is the security property.** Retention is judged by the GATEWAY'S OWN
//!   receipt times, which a client cannot backdate (F10). A clock that a rule
//!   reaches for privately is a clock nobody can see is the server's.
//!
//! The adapter owns the clock: `Date.now()` in a Worker, `SystemTime` on the
//! standalone server, and a field the suite advances in the conformance
//! harness.

use core::ops::{Add, Sub};

/// A moment, in milliseconds since the Unix epoch, on the **server's** clock.
///
/// Signed, and `i64` rather than `u64`, because it is compared and subtracted:
/// a client timestamp before the epoch is nonsense a phone with a broken clock
/// really does send, and an unsigned subtraction would wrap it into the far
/// future instead of refusing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ServerTime(i64);

/// A span, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Duration(i64);

impl ServerTime {
    /// Wrap the adapter's clock reading.
    #[must_use]
    pub const fn from_millis(millis: i64) -> Self {
        Self(millis)
    }

    /// Milliseconds since the Unix epoch.
    #[must_use]
    pub const fn millis(self) -> i64 {
        self.0
    }

    /// How far apart two moments are, in either direction.
    ///
    /// Saturating, so a client timestamp near `i64::MIN` yields a large span
    /// and a refusal rather than an overflow panic in a Worker.
    #[must_use]
    pub const fn distance(self, other: Self) -> Duration {
        Duration(self.0.saturating_sub(other.0).saturating_abs())
    }
}

impl Duration {
    /// A span of milliseconds.
    #[must_use]
    pub const fn from_millis(millis: i64) -> Self {
        Self(millis)
    }

    /// A span of seconds.
    #[must_use]
    pub const fn from_secs(secs: i64) -> Self {
        Self(secs.saturating_mul(1_000))
    }

    /// A span of days. The retention floor and the delete rate limit are both
    /// written in days, so they say so.
    #[must_use]
    pub const fn from_days(days: i64) -> Self {
        Self::from_secs(days.saturating_mul(86_400))
    }

    /// The span in milliseconds.
    #[must_use]
    pub const fn millis(self) -> i64 {
        self.0
    }

    /// The span in whole seconds, for the wire's `replay_window_seconds`.
    #[must_use]
    pub const fn secs(self) -> i64 {
        self.0 / 1_000
    }
}

impl Add<Duration> for ServerTime {
    type Output = Self;

    fn add(self, span: Duration) -> Self {
        Self(self.0.saturating_add(span.0))
    }
}

impl Sub<Duration> for ServerTime {
    type Output = Self;

    fn sub(self, span: Duration) -> Self {
        Self(self.0.saturating_sub(span.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A phone whose clock is at `i64::MIN` is a phone with a broken clock, not
    /// a panic in a Worker somebody else is paying for.
    #[test]
    fn a_nonsense_client_clock_saturates_rather_than_overflowing() {
        let server = ServerTime::from_millis(1_770_000_000_000);
        let nonsense = ServerTime::from_millis(i64::MIN);
        assert_eq!(server.distance(nonsense).millis(), i64::MAX);
        // And the far end saturates rather than wrapping into the future.
        assert_eq!(
            (ServerTime::from_millis(i64::MIN) - Duration::from_millis(1)).millis(),
            i64::MIN
        );
        assert_eq!(
            (ServerTime::from_millis(i64::MAX) + Duration::from_millis(1)).millis(),
            i64::MAX
        );
    }

    #[test]
    fn a_day_and_six_months_are_written_as_days() {
        assert_eq!(Duration::from_days(1).millis(), 86_400_000);
        assert_eq!(Duration::from_days(180).secs(), 15_552_000);
    }
}
