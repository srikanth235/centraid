//! THE ADAPTER OWNS THE CLOCK (#1029 §3).
//!
//! Nothing in `centraid-gateway-core` reads a clock: time is an *input* to
//! every rule that needs one, because a Worker's `SystemTime::now()` compiles
//! and then panics, because the retention floor spans six months and cannot be
//! tested against a clock nobody can move, and because retention is judged by
//! the **gateway's own** receipt times and a clock a rule reaches for privately
//! is a clock nobody can see is the server's (F10).
//!
//! So this is where the reach lives, in one function, and every rule that needs
//! the time is handed the result of it.

use centraid_gateway_core::time::ServerTime;

/// The server's clock, in milliseconds since the Unix epoch.
///
/// A clock before the Unix epoch is a box whose battery died; it yields a
/// negative reading rather than a panic, and [`ServerTime`] is signed for
/// exactly that reason. Every rule that compares it degrades to refusing rather
/// than to accepting.
#[must_use]
pub fn now() -> ServerTime {
    let since_epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    ServerTime::from_millis(match since_epoch {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The clock reads something after 2020 and before 2200, which is the whole
    /// of what a test can assert about a real clock without being a clock.
    #[test]
    fn the_server_clock_reads_a_plausible_millisecond() {
        let millis = now().millis();
        assert!(millis > 1_577_836_800_000, "the clock reads before 2020");
        assert!(millis < 7_258_118_400_000, "the clock reads after 2200");
    }
}
