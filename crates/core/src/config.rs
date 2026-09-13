//! What a core is opened as.

use std::path::PathBuf;

/// Which of the three this core is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// The authority. D1's vault is the truth, the doors serve seats, and the
    /// endpoint (when configured) accepts them.
    Gateway,
    /// A mirror, thin or replicated.
    Seat { kind: SeatKind, gateway: Vec<u8> },
}

/// How much of the vault a seat holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatKind {
    /// A full local mirror with its own file and its own outbox. Answers reads
    /// offline; queues writes.
    Replicated,
    /// No local rows. Every call is forwarded to the gateway **under the
    /// caller's principal**, and answered [`crate::CoreError::Unavailable`]
    /// when the gateway cannot be reached.
    ///
    /// Forwarding under the caller's principal and not the seat's is the whole
    /// security property: a thin seat is a pipe, not a deputy, and a gateway
    /// that trusted "the seat says so" would have no authority plane left.
    Thin,
}

/// How to open a core.
pub struct CoreConfig {
    /// The vault file. A gateway's authority; a replicated seat's mirror. A
    /// thin seat still has one, because `seat_state` and the outbox live in it
    /// even when no rows do.
    pub path: PathBuf,
    pub role: Role,
    /// The name the shell gave its UI thread, when it named one.
    ///
    /// A debug assertion in [`crate::Handle::call`] fires when the calling
    /// thread is this one. `None` means the shell did not say, and then no
    /// assertion is possible — which is honest, and better than asserting
    /// against a guess like "the main thread", since a gateway's main thread is
    /// exactly where `call` belongs.
    pub ui_thread_name: Option<String>,
    /// Create the file when it is not there. A gateway founding a new vault
    /// wants this; a seat installing a snapshot does not, because the file it
    /// expects is the artifact it just downloaded and a fresh empty one would
    /// be a silently empty product.
    pub create: bool,
    /// The clock this core's writes are stamped with. `None` is the system
    /// clock.
    ///
    /// Injectable because **a core on the real wall clock is not
    /// reproducible**, and `crates/sim` needs it to be: the deterministic
    /// simulation found this itself — two runs of one seed produced identical
    /// rows and different timestamps, and the receipt hashes over those
    /// timestamps then differed too. A seed that cannot be replayed byte for
    /// byte is a seed that cannot be recorded (#1020).
    pub clock: Option<Box<dyn centraid_vault::Clock>>,
    /// The id source. `None` is the build's default.
    pub ids: Option<Box<dyn centraid_vault::Ids>>,
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
    /// A gateway over `path`.
    pub fn gateway(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            role: Role::Gateway,
            ui_thread_name: None,
            create: true,
            clock: None,
            ids: None,
            expected_digest: None,
        }
    }

    /// A replicated seat over `path`, paired to `gateway`.
    pub fn replicated_seat(path: impl Into<PathBuf>, gateway: Vec<u8>) -> Self {
        Self {
            path: path.into(),
            role: Role::Seat {
                kind: SeatKind::Replicated,
                gateway,
            },
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            expected_digest: None,
        }
    }

    /// A thin seat over `path`, paired to `gateway`.
    pub fn thin_seat(path: impl Into<PathBuf>, gateway: Vec<u8>) -> Self {
        Self {
            path: path.into(),
            role: Role::Seat {
                kind: SeatKind::Thin,
                gateway,
            },
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            expected_digest: None,
        }
    }

    /// Name the shell's UI thread, so `call` can assert it is not on it.
    #[must_use]
    pub fn with_ui_thread(mut self, name: impl Into<String>) -> Self {
        self.ui_thread_name = Some(name.into());
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
    /// What makes a run reproducible. A test, a simulation and a fixture
    /// freezer all want it; a shipped gateway wants the system clock and passes
    /// neither.
    #[must_use]
    pub fn with_clock(
        mut self,
        clock: Box<dyn centraid_vault::Clock>,
        ids: Box<dyn centraid_vault::Ids>,
    ) -> Self {
        self.clock = Some(clock);
        self.ids = Some(ids);
        self
    }

    /// Whether this role holds the authority.
    #[must_use]
    pub fn is_gateway(&self) -> bool {
        self.role == Role::Gateway
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_creates_its_file_and_a_seat_does_not() {
        assert!(CoreConfig::gateway("/tmp/v.db").create);
        assert!(!CoreConfig::replicated_seat("/tmp/s.db", b"gw".to_vec()).create);
        assert!(!CoreConfig::thin_seat("/tmp/s.db", b"gw".to_vec()).create);
    }

    #[test]
    fn the_three_roles_are_distinguishable() {
        assert!(CoreConfig::gateway("/tmp/v.db").is_gateway());
        let thin = CoreConfig::thin_seat("/tmp/s.db", b"gw".to_vec());
        assert!(!thin.is_gateway());
        assert!(matches!(
            thin.role,
            Role::Seat {
                kind: SeatKind::Thin,
                ..
            }
        ));
    }
}
