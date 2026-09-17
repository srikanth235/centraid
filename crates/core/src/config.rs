//! What a core is opened as.
//!
//! ## THERE IS ONE KIND OF CORE (#1029 §1)
//!
//! `Role` is gone, and with it `SeatKind` and `PairingRecord`. The phone is the
//! vault: it is the only host that opens one, so a core over a file was the
//! authority in every branch that survived and a one-variant enum is dead
//! weight. What went with it is everything that only made sense on the other
//! side of a pairing — `Role::Seat{Replicated,Thin}`, the enrolment record the
//! shell kept, the relay decision read off it, and the `is_gateway` branches
//! that asked which of the three this core was.
//!
//! A shell now opens every vault the same way, and [`CoreConfig::create`] is
//! the only thing that differs between founding one and opening one that is
//! already there.

use std::path::PathBuf;

/// How to open a core.
pub struct CoreConfig {
    /// The vault file. The phone's authority, and the only copy.
    pub path: PathBuf,
    /// The name the shell gave its UI thread, when it named one.
    ///
    /// A debug assertion in [`crate::Handle::call`] fires when the calling
    /// thread is this one. `None` means the shell did not say, and then no
    /// assertion is possible — which is honest, and better than asserting
    /// against a guess like "the main thread", since a command-line caller's
    /// main thread is exactly where `call` belongs.
    pub ui_thread_name: Option<String>,
    /// Create the file when it is not there.
    ///
    /// The shell can **create** a vault on the phone (#1029 §1), so this is a
    /// true choice and not a property of a role: founding a new vault sets it,
    /// and opening one a restore just wrote does not, because a fresh empty
    /// file where the restored one should be is a silently empty product.
    pub create: bool,
    /// The clock this core's writes are stamped with. `None` is the system
    /// clock.
    ///
    /// Injectable because **a core on the real wall clock is not
    /// reproducible**, and a test that compares two runs of one seed needs it
    /// to be: identical rows with different timestamps hash differently, and a
    /// run that cannot be replayed byte for byte cannot be recorded (#1020).
    pub clock: Option<std::sync::Arc<dyn centraid_vault::Clock>>,
    /// The id source. `None` is the build's default.
    pub ids: Option<std::sync::Arc<dyn centraid_vault::Ids>>,
    /// THE DIGEST THE SHELL WAS BUILT AGAINST (#1020 Artifacts, D-1020-G2).
    ///
    /// A shell that links a prebuilt core cannot tell by construction that the
    /// core it loaded is the one its own build expects, and a stale core is the
    /// worst failure shape in the design: it starts, it answers, and it answers
    /// from a schema the shell stopped speaking. So a shell passes the digest
    /// ITS build recorded and [`crate::Core::open`] refuses a mismatch with
    /// [`crate::CoreError::StaleCore`] — before the handle exists.
    ///
    /// `None` means the caller claimed no expectation, which is a developer
    /// running the binary by hand. **It is not treated as a match**: it is
    /// treated as "not checked", and `crate::identity::require_digest` is what
    /// says so out loud when a `dev` build is on either side.
    pub expected_digest: Option<String>,
}

impl CoreConfig {
    /// A core over `path`, creating the file when it is not there.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            ui_thread_name: None,
            create: true,
            clock: None,
            ids: None,
            expected_digest: None,
        }
    }

    /// Open `path` only if it is already there.
    #[must_use]
    pub fn opening_existing(mut self) -> Self {
        self.create = false;
        self
    }

    /// Refuse to open unless this core's digest is `digest`.
    #[must_use]
    pub fn expecting_digest(mut self, digest: impl Into<String>) -> Self {
        self.expected_digest = Some(digest.into());
        self
    }

    /// Stamp this core's writes with a given clock and id source.
    ///
    /// What makes a run reproducible. A test and a fixture freezer both want
    /// it; a shipped build wants the system clock and passes neither.
    ///
    /// `Arc` rather than `Box` since #1025 S2: the core keeps this stamp and
    /// hands it to the file that replaces the vault after a restore, so a
    /// `FixedClock` a test advances is still the same object on the other side
    /// of the swap. A `Box` could only be given away once, and the second open
    /// silently took the build's default.
    #[must_use]
    pub fn with_clock(
        mut self,
        clock: std::sync::Arc<dyn centraid_vault::Clock>,
        ids: std::sync::Arc<dyn centraid_vault::Ids>,
    ) -> Self {
        self.clock = Some(clock);
        self.ids = Some(ids);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_core_creates_its_file_unless_the_caller_says_otherwise() {
        assert!(CoreConfig::new("/tmp/v.db").create);
        assert!(!CoreConfig::new("/tmp/v.db").opening_existing().create);
    }
}
